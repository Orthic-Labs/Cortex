import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGraphGeneration } from "../graph/static-provider.mjs";
import { closeStore, openStore } from "../graph/store-sqlite.mjs";
import { FRESHNESS, WatchSupervisor, writeWatchConfig } from "../watchman/supervisor.mjs";

// P2: one resident supervisor, one worker per enrolled repository, with
// honest freshness — a repo must never read as "current" just because
// nothing has observed it. These tests exercise the multi-repo fleet
// behavior the single-repo watchman.test.mjs suite does not cover: several
// repos under one supervisor, one repo's actor failing without stalling the
// others, and every freshness state a repo can honestly report.

const FIXTURE = join(import.meta.dirname, "..", "evals/fixture-repos/typescript-commerce");

function makeRepo(prefix, { build = true } = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cpSync(FIXTURE, repo, { recursive: true });
  if (build) buildGraphGeneration(repo, { outDir: ".agent", persist: true });
  return repo;
}

function tempConfigPath() {
  return join(mkdtempSync(join(tmpdir(), "cortex-watch-config-")), "watch.json");
}

test("a never-enrolled-and-built repo reports unwatched, not current", () => {
  const repo = makeRepo("cortex-fleet-unwatched-", { build: false });
  const configPath = tempConfigPath();
  try {
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    const supervisor = new WatchSupervisor({ configPath });
    const status = supervisor.status();
    assert.equal(status.repos.length, 1);
    assert.equal(status.repos[0].freshness, FRESHNESS.UNWATCHED);
    assert.equal(status.repos[0].reason, "no_graph_built");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a built-but-never-watched repo reports unwatched with a distinct reason", () => {
  const repo = makeRepo("cortex-fleet-neverwatched-");
  const configPath = tempConfigPath();
  try {
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    const status = new WatchSupervisor({ configPath }).status();
    assert.equal(status.repos[0].freshness, FRESHNESS.UNWATCHED);
    assert.equal(status.repos[0].reason, "watcher_never_started");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a dead watcher pid reports unwatched with watcher_process_dead, not current", () => {
  const repo = makeRepo("cortex-fleet-dead-");
  const configPath = tempConfigPath();
  try {
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      // A pid that cannot plausibly be alive in this test run.
      db.prepare("INSERT INTO watch_state(key,value) VALUES ('watcher_pid','999999999') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    } finally { closeStore(db); }
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    const status = new WatchSupervisor({ configPath }).status();
    assert.equal(status.repos[0].freshness, FRESHNESS.UNWATCHED);
    assert.equal(status.repos[0].reason, "watcher_process_dead");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("an event gap reports degraded with the recorded error, not current", () => {
  const repo = makeRepo("cortex-fleet-gap-");
  const configPath = tempConfigPath();
  try {
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      db.prepare("INSERT INTO watch_state(key,value) VALUES ('watcher_pid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(process.pid));
      db.prepare("INSERT INTO watch_state(key,value) VALUES ('event_gap','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      db.prepare("INSERT INTO watch_state(key,value) VALUES ('last_error','watcher overflow: too many events') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    } finally { closeStore(db); }
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    const status = new WatchSupervisor({ configPath }).status();
    assert.equal(status.repos[0].freshness, FRESHNESS.DEGRADED);
    assert.match(status.repos[0].reason, /watcher overflow: too many events/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("pending unapplied events report stale, not current", () => {
  const repo = makeRepo("cortex-fleet-pending-");
  const configPath = tempConfigPath();
  try {
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      db.prepare("INSERT INTO watch_state(key,value) VALUES ('watcher_pid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(process.pid));
      db.prepare("INSERT INTO event_journal(observed_ms,event_kind,path,rename_to,source_clock) VALUES (?, 'modify', 'src/service.ts', NULL, 1)").run(Date.now());
    } finally { closeStore(db); }
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    const status = new WatchSupervisor({ configPath }).status();
    assert.equal(status.repos[0].freshness, FRESHNESS.STALE);
    assert.equal(status.repos[0].reason, "events_pending_apply");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a live, caught-up watcher reports current", async () => {
  const repo = makeRepo("cortex-fleet-current-");
  const configPath = tempConfigPath();
  const supervisor = new WatchSupervisor({ configPath });
  try {
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    await supervisor.start();
    const status = supervisor.status();
    assert.equal(status.repos[0].freshness, FRESHNESS.CURRENT);
    assert.equal(status.repos[0].reason, null);
    assert.equal(status.repos[0].alive, true);
  } finally {
    await supervisor.stop();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a stopped supervisor's repos go back to unwatched — no stale 'current' claim survives shutdown", async () => {
  const repo = makeRepo("cortex-fleet-stopped-");
  const configPath = tempConfigPath();
  const supervisor = new WatchSupervisor({ configPath });
  try {
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    await supervisor.start();
    assert.equal(supervisor.status().repos[0].freshness, FRESHNESS.CURRENT);
    await supervisor.stop();
    assert.equal(supervisor.status().repos[0].freshness, FRESHNESS.UNWATCHED);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("one repository's actor failing to start does not stall the others (child isolation)", async () => {
  const goodRepo = makeRepo("cortex-fleet-good-");
  const brokenRoot = join(tmpdir(), "cortex-fleet-does-not-exist-" + Math.random().toString(36).slice(2));
  const configPath = tempConfigPath();
  const supervisor = new WatchSupervisor({ configPath });
  try {
    writeWatchConfig({ repos: [{ root: goodRepo, enabled: true }, { root: brokenRoot, enabled: true }] }, configPath);
    await supervisor.start();
    const status = supervisor.status();
    const good = status.repos.find((repo) => repo.root === goodRepo);
    const broken = status.repos.find((repo) => repo.root === brokenRoot);
    assert.equal(good.freshness, FRESHNESS.CURRENT, "the healthy repo must reach current despite its sibling failing");
    assert.equal(broken.freshness, FRESHNESS.UNWATCHED, "the broken repo must honestly report unwatched, never current");
    // The supervisor itself did not throw or stop early — reload() is still
    // tracking the actor it did manage to start.
    assert.ok(supervisor.actors.has(goodRepo));
  } finally {
    await supervisor.stop();
    rmSync(goodRepo, { recursive: true, force: true });
  }
});

test("a multi-repo supervisor watches each repo independently: an edit in one does not touch another's graph", async () => {
  const repoA = makeRepo("cortex-fleet-multi-a-");
  const repoB = makeRepo("cortex-fleet-multi-b-");
  const configPath = tempConfigPath();
  const supervisor = new WatchSupervisor({ configPath });
  try {
    writeWatchConfig({ repos: [{ root: repoA, enabled: true }, { root: repoB, enabled: true }] }, configPath);
    await supervisor.start();
    const status = supervisor.status();
    assert.equal(status.repos.length, 2);
    for (const repo of status.repos) assert.equal(repo.freshness, FRESHNESS.CURRENT);
  } finally {
    await supervisor.stop();
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});
