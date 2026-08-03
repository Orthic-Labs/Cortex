import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGraphGeneration } from "../graph/static-provider.mjs";
import { closeStore, openStore } from "../graph/store-sqlite.mjs";
import { RepositoryActor } from "../watchman/repo-actor.mjs";
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

// D1 soak fix: the root actor was drowning in FSEvents overflow because it
// watched its whole tree, which contains every other enrolled repo plus that
// repo's own `.agent` WAL churn. Enrolling a child repo nested inside a
// parent must exclude the child's subtree (and the parent's own .agent
// output) from the parent's own subscription — the child already has its
// own actor for that.
test("a parent repo's actor ignores its enrolled child's subtree and its own .agent output (fleet scope)", async () => {
  const parent = makeRepo("cortex-fleet-scope-parent-");
  const child = join(parent, "child-repo");
  cpSync(FIXTURE, child, { recursive: true });
  buildGraphGeneration(child, { outDir: ".agent", persist: true });
  const configPath = tempConfigPath();
  const supervisor = new WatchSupervisor({ configPath });
  try {
    writeWatchConfig({ repos: [{ root: parent, enabled: true }, { root: child, enabled: true }] }, configPath);
    await supervisor.start();
    const startStatus = supervisor.status();
    assert.ok(startStatus.repos.every((repo) => repo.freshness === FRESHNESS.CURRENT), "both actors must reach current before the probe edits");

    // Noise the parent actor must never observe: an edit inside the enrolled
    // child's own subtree, and a direct write into the parent's own .agent
    // output directory (simulating the actor's own graph/WAL churn).
    writeFileSync(join(child, "src/service.ts"), `${readFileSync(join(child, "src/service.ts"), "utf8")}\nexport const childOnly = true;\n`);
    mkdirSync(join(parent, ".agent", "graph"), { recursive: true });
    writeFileSync(join(parent, ".agent", "graph", "scope-probe.tmp"), "self-observed noise\n");
    // A genuine edit in the parent's own tree, proving its actor still works.
    writeFileSync(join(parent, "src/service.ts"), `${readFileSync(join(parent, "src/service.ts"), "utf8")}\nexport const parentOwn = true;\n`);

    const deadline = Date.now() + 5000;
    let parentApplied = 0;
    while (Date.now() < deadline && parentApplied !== 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const pollingDb = openStore(join(parent, ".agent/graph/graph.db"));
      try { parentApplied = pollingDb.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE path='src/service.ts' AND applied=1").get().n; }
      finally { closeStore(pollingDb); }
    }
    assert.equal(parentApplied, 1, "the parent actor must still apply edits under its own root");

    const parentDb = openStore(join(parent, ".agent/graph/graph.db"));
    try {
      const childLeak = parentDb.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE path LIKE 'child-repo%'").get().n;
      const agentLeak = parentDb.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE path LIKE '.agent%'").get().n;
      assert.equal(childLeak, 0, "the parent actor must never journal paths under its enrolled child's root");
      assert.equal(agentLeak, 0, "the parent actor must never journal its own .agent output directory");
    } finally { closeStore(parentDb); }
  } finally {
    await supervisor.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

// D1 soak fix: an FSEvents "must be re-scanned" overflow must be treated as a
// typed, honestly-reported condition — mark stale(event_overflow), run
// exactly one full reconcile, and never let status claim "current" while
// that gap is still open.
test("an overflow marks the actor stale(event_overflow), runs exactly one reconcile, and never reports current mid-gap", async () => {
  const repo = makeRepo("cortex-fleet-overflow-");
  const configPath = tempConfigPath();
  let gapReconcileCalls = 0;
  let releaseReconcile;
  const gate = new Promise((resolve) => { releaseReconcile = resolve; });
  let triggerOverflow;
  const supervisor = new WatchSupervisor({
    configPath,
    actorFactory: (options) => new RepositoryActor({
      ...options,
      adapter: {
        startWatch: async (_root, _onEvents, onGap) => {
          triggerOverflow = () => onGap(new Error("Events were dropped by the FSEvents client. File system must be re-scanned."));
          return { unsubscribe: async () => {} };
        },
        eventsSince: async () => [],
        writeSnapshot: async () => {},
      },
      // The bootstrap reconcile in initialize() always runs once before any
      // gap exists; only count/gate the repair reconcile markGap schedules
      // (recognizable because it always runs after event_gap is set to '1').
      reconcile: async (db) => {
        const gapValue = db.prepare("SELECT value FROM watch_state WHERE key='event_gap'").get()?.value;
        if (gapValue !== "1") return { ok: true };
        gapReconcileCalls += 1;
        await gate;
        db.prepare("INSERT INTO watch_state(key,value) VALUES ('event_gap','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
        return { ok: true };
      },
    }),
  });
  try {
    writeWatchConfig({ repos: [{ root: repo, enabled: true }] }, configPath);
    await supervisor.start();
    assert.equal(supervisor.status().repos[0].freshness, FRESHNESS.CURRENT);

    triggerOverflow();
    await new Promise((resolve) => setImmediate(resolve));
    const midGap = supervisor.status().repos[0];
    assert.equal(midGap.freshness, FRESHNESS.DEGRADED, "status must never say current mid-gap");
    assert.equal(midGap.reason, "event_overflow");
    assert.equal(gapReconcileCalls, 1, "exactly one reconcile must run for the gap");

    releaseReconcile();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(supervisor.status().repos[0].freshness, FRESHNESS.CURRENT, "resumes current once the one reconcile completes");
    assert.equal(gapReconcileCalls, 1, "still exactly one reconcile ran for the gap");
  } finally {
    await supervisor.stop();
    rmSync(repo, { recursive: true, force: true });
  }
});

// D2 soak fix: one repo's malformed graph.db must degrade only that repo's
// row, never blank status for the other enrolled repos.
test("one repo's corrupted graph.db reports degraded/store_unreadable without blanking the fleet (status isolation)", () => {
  const good = makeRepo("cortex-fleet-good-status-");
  const bad = makeRepo("cortex-fleet-corrupt-");
  const configPath = tempConfigPath();
  try {
    writeFileSync(join(bad, ".agent/graph/graph.db"), "not a sqlite file, definitely garbage bytes");
    writeWatchConfig({ repos: [{ root: good, enabled: true }, { root: bad, enabled: true }] }, configPath);
    const status = new WatchSupervisor({ configPath }).status();
    assert.equal(status.repos.length, 2, "status must return one row per enrolled repo even when one store is corrupt");
    const goodRow = status.repos.find((repo) => repo.root === good);
    const badRow = status.repos.find((repo) => repo.root === bad);
    assert.ok(goodRow, "the healthy repo's row must still be present");
    assert.equal(goodRow.freshness, FRESHNESS.UNWATCHED);
    assert.equal(goodRow.reason, "watcher_never_started");
    assert.equal(badRow.freshness, FRESHNESS.DEGRADED);
    assert.equal(badRow.reason, "store_unreadable");
    assert.match(badRow.error, /database|file is not a database/i);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});
