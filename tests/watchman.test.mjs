import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGraphGeneration } from "../graph/static-provider.mjs";
import { CortexRepositoryWorker, RepositoryActor } from "../graph/watchman.mjs";
import { closeStore, openStore } from "../graph/store-sqlite.mjs";
import { MAX_SOURCE_FILE_BYTES } from "../graph/stable-read.mjs";
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

test("watch worker persists source/apply clocks and applies one-file delta", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const path = join(repo, "src/service.ts");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nexport const watchmanChange = true;\n`);
    const result = await new CortexRepositoryWorker({ root: repo }).ingest("src/service.ts");
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

test("overflow is durable and does not claim reconciliation", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-gap-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const result = await new CortexRepositoryWorker({ root: repo }).ingest(".", "overflow");
    assert.equal(result.eventGap, true);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try { assert.equal(db.prepare("SELECT value FROM watch_state WHERE key='event_gap'").get().value, "1"); }
    finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("burst coalesces to one applied delta and marks superseded rows", async () => {
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
    await actor.flush(true);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=1").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=2").get().n, 19);
    } finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("two files arriving during one drain are both applied", async () => {
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
    assert.equal(await actor.flush(true), 2);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=1").get().n, 2); }
    finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// Regression: heardright's graph was corrupted twice in one day by a file too
// large to become a JS string. descriptorFor() unconditionally did
// `read.bytes.toString("utf8")`, which throws past ~512 MB — and the throw
// landed inside applyJournalEvent's write transaction, so the store came back
// "malformed database schema" rather than merely skipping the file. The full
// build never hit this because its readers have always capped source at 2 MiB;
// the incremental watcher path was the one reader missing the bound. Asserted
// by refusing to read at all: a reader that throws if invoked proves the
// oversized file is skipped before any read, which is what keeps the write
// transaction intact.
test("a file past the source-size bound is skipped, never read, and leaves the store usable", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-oversized-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    writeFileSync(join(repo, "src/huge.ts"), `export const pad = "${"x".repeat(MAX_SOURCE_FILE_BYTES + 1)}";\n`);
    const readStable = () => { throw new Error("Cannot create a string longer than 0x1fffffe8 characters"); };
    const actor = new RepositoryActor({ root: repo, readStable });
    actor.ingest([{ eventKind: "create", path: "src/huge.ts", observedMs: Date.now() }]);
    assert.equal(await actor.flush(true), 1);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=0").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path=?").get("src/huge.ts").n, 0);
    } finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// Same corruption path, different trigger: watchers report `create` for a new
// directory, so the journal genuinely carries directory paths. existsSync() is
// true for those, and reading one throws EISDIR inside the write transaction.
// Seen live in coderight and heardright once the oversized-file fix let the
// journal drain far enough to reach them.
test("a directory in the journal is skipped, never read, and leaves the store usable", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-eisdir-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    mkdirSync(join(repo, "src/newdir"), { recursive: true });
    const readStable = () => { throw new Error("EISDIR: illegal operation on a directory, read"); };
    const actor = new RepositoryActor({ root: repo, readStable });
    actor.ingest([{ eventKind: "create", path: "src/newdir", observedMs: Date.now() }]);
    assert.equal(await actor.flush(true), 1);
    const db = openStore(join(repo, ".agent/graph/graph.db"));
    try {
      assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=0").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path=?").get("src/newdir").n, 0);
    } finally { closeStore(db); }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// Regression: the watcher invokes its callbacks outside any promise chain, so a
// throw inside one is an unhandled exception that kills the SUPERVISOR — all 19
// repos, not the one that failed. Live on 2026-08-03: one repo's "database is
// locked" inside markGap()'s setState killed the process, launchd restarted it,
// the cold sweep began again from the top and died around repo 10 — so the fleet
// sat permanently at 13 noncurrent, never converging, with no crash visible in
// `status` output at all.
test("a throw inside a watcher callback degrades that repo, never the process", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-watchman-guard-"));
  cpSync(FIXTURE, repo, { recursive: true });
  try {
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    let onEvents = null, onError = null;
    const adapter = {
      startWatch: async (_root, events, error) => { onEvents = events; onError = error; return { unsubscribe() {} }; },
      writeSnapshot: async () => {},
      eventsSince: async () => [],
    };
    const actor = new RepositoryActor({ root: repo, adapter });
    await actor.start();
    actor.markGap = () => { throw new Error("database is locked"); };
    actor.ingest = () => { throw new Error("database is locked"); };
    assert.doesNotThrow(() => onError(new Error("watch subscription failed")));
    assert.doesNotThrow(() => onEvents([{ eventKind: "modify", path: "src/service.ts", observedMs: Date.now() }]));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("failed batch remains pending and resumes on next drain", async () => {
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
    assert.equal(await actor.flush(true), 1);
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

// D1 regression guard: @parcel/watcher's `ignore` option only excludes a
// directory reliably when passed as a literal relative path (its base name
// here — "node_modules" is already in the built-in high-churn ignore set).
// Empirically confirmed 2026-08-03: the glob forms `node_modules/**` and
// `**/node_modules/**` do NOT filter at all in the installed 2.6.0 native
// build — writes inside an "ignored" directory still surface as live events.
// If adapter.mjs's ignorePatterns() is ever "cleaned up" back into globs,
// this must fail.
test("real Parcel watcher never surfaces writes inside a base-ignored directory", async () => {
  const script = `import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatch } from "./watchman/adapter.mjs";
const root = mkdtempSync(join(tmpdir(), "cortex-adapter-ignore-"));
mkdirSync(join(root, "node_modules"), { recursive: true });
try {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const events = [];
  const sub = await startWatch(root, (evs) => events.push(...evs), () => {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  writeFileSync(join(root, "node_modules", "noise.js"), "noise");
  writeFileSync(join(root, "keep.js"), "keep");
  await new Promise((resolve) => setTimeout(resolve, 800));
  await sub.unsubscribe();
  if (events.some((event) => event.path.includes("node_modules"))) throw new Error("node_modules leaked: " + JSON.stringify(events));
  if (!events.some((event) => event.path.endsWith("keep.js"))) throw new Error("keep.js was never observed: " + JSON.stringify(events));
  console.log("ignore-ok");
} finally { rmSync(root, { recursive: true, force: true }); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", timeout: 8000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, /ignore-ok/);
});
