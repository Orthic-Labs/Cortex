import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGraphGeneration } from "../graph/static-provider.mjs";
import { CortexRepositoryWorker, RepositoryActor } from "../graph/watchman.mjs";
import { closeStore, openStore } from "../graph/store-sqlite.mjs";
import { normalizeEvents } from "../watchman/adapter.mjs";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "evals/fixture-repos/typescript-commerce");

test("watch paths survive macOS /var to /private/var canonicalization", { skip: process.platform !== "darwin" }, () => {
  const repo = mkdtempSync("/var/tmp/cortex-watchman-path-");
  try {
    const eventPath = join(realpathSync(repo), "src/service.ts");
    assert.equal(normalizeEvents(repo, [{ type: "update", path: eventPath }])[0].path, "src/service.ts");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("watch worker persists source/apply clocks and applies one-file delta", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const path = join(repo, "src/service.ts");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nexport const watchmanChange = true;\n`);
    const result = new CortexRepositoryWorker({ root: repo }).ingest("src/service.ts");
    assert.equal(result.applied, true);
    assert.equal(result.sourceClock, 1);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      assert.equal(db.prepare("SELECT value FROM watch_state WHERE key='source_clock'").get().value, "1");
      assert.equal(db.prepare("SELECT applied FROM event_journal WHERE seq=?").get(result.journalSeq).applied, 1);
      assert.equal(db.prepare("SELECT value FROM watch_state WHERE key='applied_clock'").get().value, "1");
    } finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("overflow is durable and does not claim reconciliation", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-gap-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const result = new CortexRepositoryWorker({ root: repo }).ingest(".", "overflow");
    assert.equal(result.eventGap, true);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try { assert.equal(db.prepare("SELECT value FROM watch_state WHERE key='event_gap'").get().value, "1"); }
    finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("burst coalesces to one applied delta and marks superseded rows", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-burst-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const actor = new RepositoryActor({ root: repo });
    const path = join(repo, "src/service.ts");
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path, `${readFileSync(path, "utf8")}\nexport const burst${index} = true;\n`);
      actor.ingest([{ eventKind: "modify", path: "src/service.ts", observedMs: Date.now() }]);
    }
    actor.flush(true);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=1").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=2").get().n, 19);
    } finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("two files arriving during one drain are both applied", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-drain-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    writeFileSync(join(repo, "src/service.ts"), `${readFileSync(join(repo, "src/service.ts"), "utf8")}\nexport const drainService = true;\n`);
    writeFileSync(join(repo, "src/store.ts"), `${readFileSync(join(repo, "src/store.ts"), "utf8")}\nexport const drainStore = true;\n`);
    const actor = new RepositoryActor({ root: repo });
    actor.ingest([
      { eventKind: "modify", path: "src/service.ts", observedMs: Date.now() },
      { eventKind: "modify", path: "src/store.ts", observedMs: Date.now() },
    ]);
    assert.equal(actor.flush(true), 2);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=1").get().n, 2); }
    finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("failed batch remains pending and resumes on next drain", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-retry-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const actor = new RepositoryActor({ root: repo });
    actor.ingest([{ eventKind: "modify", path: "src/service.ts", observedMs: Date.now() }]);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      db.prepare("UPDATE event_journal SET applied=0 WHERE seq=1").run();
      db.prepare("UPDATE watch_state SET value='0' WHERE key='applied_clock'").run();
    } finally { closeStore(db); }
    assert.equal(actor.flush(true), 1);
    const reopened = openStore(join(repo, ".agent/graph/graph.db"));
    try { assert.equal(reopened.prepare("SELECT applied FROM event_journal WHERE seq=1").get().applied, 1); }
    finally { closeStore(reopened); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("watch subscription failure sets event_gap", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-gap-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const actor = new RepositoryActor({ root: repo, adapter: {
      writeSnapshot: async () => {},
      startWatch: async (_root, _onEvents, onGap) => { onGap(new Error("unsubscribable")); throw new Error("unsubscribable"); },
      eventsSince: async () => [],
    } });
    await assert.rejects(actor.start(), /unsubscribable/);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try { assert.equal(db.prepare("SELECT value FROM watch_state WHERE key='event_gap'").get().value, "1"); }
    finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("real Parcel watcher applies an edit within the debounce window", async () => {
  const script = `import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraphGeneration } from "./graph/static-provider.mjs";
import { RepositoryActor } from "./watchman/repo-actor.mjs";
import { closeStore, openStore } from "./graph/store-sqlite.mjs";
const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-child-"));
cpSync(${JSON.stringify(FIXTURE)}, repo, { recursive: true });
try {
  buildGraphGeneration(repo, { outDir: ".agent", persist: true });
  const actor = new RepositoryActor({ root: repo });
  await actor.start();
  const path = join(repo, "src/service.ts");
  writeFileSync(path, \`${"${readFileSync(path, \"utf8\")}"}\\nexport const liveWatch = true;\\n\`);
  const deadline = Date.now() + 3000;
  let applied = 0;
  while (Date.now() < deadline && applied !== 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pollingDb = openStore(join(repo, ".agent/graph/graph.db"));
    applied = pollingDb.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE path='src/service.ts' AND applied=1").get().n;
    closeStore(pollingDb);
  }
  await actor.stop();
  if (applied !== 1) throw new Error("live watcher applied " + applied + " rows");
  console.log("live-ok");
} finally { rmSync(repo, { recursive: true, force: true }); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", timeout: 8000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, /live-ok/);
});
