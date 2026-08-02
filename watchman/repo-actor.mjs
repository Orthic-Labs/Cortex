import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, appendFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { applyFileDelta, DOC_PROVIDER, MAX_DEPENDENT_FILES, MAX_HOPS, STRUCTURAL_PROVIDER } from "../graph/delta-store.mjs";
import { parseFileFacts } from "../graph/static-provider.mjs";
import { buildIncrementalTreeSitterFacts, SUPPORTED_EXTENSIONS } from "../graph/treesitter-provider.mjs";
import { extractDoc, isDoc, loadConfig } from "../scripts/blueprint.mjs";
import { stableRead } from "../graph/stable-read.mjs";
import { collectDependents, closeStore, listFileMetadata, listSymbolMetadata, openStore } from "../graph/store-sqlite.mjs";
import { eventsSince, startWatch, writeSnapshot } from "./adapter.mjs";

const REPAIR_BATCH = 50;
const DEBOUNCE_MS = 1000;
const MAX_DRAIN_PASSES = 5;

function normalizePath(value) { return String(value).replaceAll("\\", "/").replace(/^\.\//, ""); }
function canonicalRoot(value) { const root = resolve(value); try { return realpathSync(root); } catch { return root; } }
function dbPath(root, outDir) { return join(resolve(root), outDir, "graph", "graph.db"); }
function stateValue(db, key, fallback = null) { return db.prepare("SELECT value FROM watch_state WHERE key=?").get(key)?.value ?? fallback; }
function setState(db, key, value) { db.prepare("INSERT INTO watch_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value)); }
function sourceFilesFromStore(db) {
  return listFileMetadata(db).map((file) => ({
    path: file.path,
    contentHash: String(file.contentDigest ?? "").replace(/^xxh128:/, ""),
    size: Number(file.size ?? 0),
  }));
}

export function appendWatchEvents(db, events) {
  let clock = Number(stateValue(db, "source_clock", 0));
  const insert = db.prepare("INSERT INTO event_journal(observed_ms,event_kind,path,rename_to,source_clock) VALUES (?,?,?,?,?)");
  const result = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const event of events) {
      clock += 1;
      const info = insert.run(Number(event.observedMs ?? Date.now()), event.eventKind, normalizePath(event.path), event.renameTo ? normalizePath(event.renameTo) : null, clock);
      result.push({ seq: Number(info.lastInsertRowid), sourceClock: clock });
    }
    setState(db, "source_clock", clock);
    db.exec("COMMIT");
    return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function descriptorFor(root, sourceFiles, path, renameTo = null, readStable = stableRead) {
  const normalized = normalizePath(path);
  const target = normalizePath(renameTo ?? normalized);
  const absolute = resolve(root, target);
  if (!existsSync(absolute)) return null;
  const read = readStable(absolute);
  const text = read.bytes.toString("utf8");
  const descriptor = {
    absolutePath: absolute,
    path: target,
    text,
    lines: text.split(/\r?\n/),
    contentHash: read.contentDigest.replace(/^xxh128:/, ""),
    size: read.bytes.length,
  };
  return { descriptor, read, files: sourceFiles.filter((file) => ![normalized, target].includes(normalizePath(file.path))).concat(descriptor) };
}

async function deltaFor(db, root, event, readStable = stableRead) {
  const sourceFiles = sourceFilesFromStore(db);
  const normalized = normalizePath(event.path);
  const target = normalizePath(event.renameTo ?? normalized);
  const current = descriptorFor(root, sourceFiles, normalized, event.renameTo, readStable);
  const document = current && isDoc(target)
    ? extractDoc(root, target, new Set(current.files.map((file) => normalizePath(file.path))), loadConfig(root, ".agent"))
    : null;
  const provider = (document || isDoc(normalized) || isDoc(target)) ? DOC_PROVIDER : { id: "lexical", version: "repo-local-delta-v1" };
  if (!current) return { eventKind: event.eventKind === "rename" ? "rename" : "delete", path: normalized, renameTo: event.renameTo ?? null, parsed: null, provider, ...(provider.id === DOC_PROVIDER.id ? { domain: "doc" } : {}) };
  const lexical = parseFileFacts(root, current.descriptor, { files: current.files, symbols: listSymbolMetadata(db, "lexical") });
  const extension = target.includes(".") ? target.slice(target.lastIndexOf(".") + 1).toLowerCase() : "";
  const factBatches = [{ provider: STRUCTURAL_PROVIDER, parsed: lexical }];
  if (!document && SUPPORTED_EXTENSIONS.includes(extension)) {
    factBatches.push(await buildIncrementalTreeSitterFacts(current.descriptor, {
      filePaths: current.files.map((file) => file.path),
      symbols: listSymbolMetadata(db, "treesitter"),
    }));
  }
  return {
    eventKind: event.eventKind,
    path: normalized,
    renameTo: event.renameTo ?? null,
    parsed: lexical,
    factBatches,
    contentDigest: current.read.contentDigest,
    fileIdentity: current.read.fileIdentity,
    size: current.read.bytes.length,
    mtimeMs: current.read.statAfter.mtimeMs,
    provider: document ? provider : STRUCTURAL_PROVIDER,
    ...(document ? { domain: "doc", document } : {}),
  };
}

function writeRepairState(db, state) {
  if (state) setState(db, "repair_truncated", JSON.stringify(state));
  else db.prepare("DELETE FROM watch_state WHERE key='repair_truncated'").run();
}

async function applyRepairPaths(db, root, paths, sourceClock, inOuterTransaction, readStable = stableRead) {
  const batches = [];
  for (let index = 0; index < paths.length; index += REPAIR_BATCH) batches.push(paths.slice(index, index + REPAIR_BATCH));
  for (const batch of batches) {
    const ownBatch = !inOuterTransaction;
    if (ownBatch) db.exec("BEGIN IMMEDIATE");
    try {
      for (const path of batch) {
        applyFileDelta(db, { ...await deltaFor(db, root, { eventKind: "repair", path }, readStable), sourceClock }, { inTransaction: true, repoRoot: root, outDir: ".agent" });
      }
      if (ownBatch) db.exec("COMMIT");
    } catch (error) {
      if (ownBatch) db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function applyJournalEvent(db, root, row, maxDependentFiles = MAX_DEPENDENT_FILES, readStable = stableRead) {
  const closure = collectDependents(db, row.path, { maxHops: MAX_HOPS, maxFiles: maxDependentFiles });
  const sameOuter = closure.paths.length <= REPAIR_BATCH;
  if (sameOuter) db.exec("BEGIN IMMEDIATE");
  try {
    const event = { eventKind: row.event_kind, path: row.path, renameTo: row.rename_to };
    const base = applyFileDelta(db, { ...await deltaFor(db, root, event, readStable), sourceClock: row.source_clock, journalSeq: row.seq }, { inTransaction: sameOuter, repoRoot: root, outDir: ".agent" });
    if (base.applied && !base.noop && closure.paths.length) await applyRepairPaths(db, root, closure.paths, row.source_clock, sameOuter, readStable);
    if (closure.truncated) writeRepairState(db, { path: row.path, remaining: closure.remaining });
    else writeRepairState(db, null);
    db.prepare("UPDATE event_journal SET applied=1, applied_clock=? WHERE seq=?").run(base.appliedClock ?? row.source_clock, row.seq);
    if (sameOuter) db.exec("COMMIT");
    return base;
  } catch (error) {
    if (sameOuter) db.exec("ROLLBACK");
    throw error;
  }
}

function pendingRows(db, force = false) {
  const threshold = Date.now() - DEBOUNCE_MS;
  const rows = db.prepare("SELECT * FROM event_journal WHERE applied=0 AND (? OR observed_ms<=?) ORDER BY seq").all(force ? 1 : 0, threshold);
  const latest = new Map();
  for (const row of rows) latest.set(row.path, row);
  for (const row of rows) {
    if (latest.get(row.path)?.seq !== row.seq) db.prepare("UPDATE event_journal SET applied=2 WHERE seq=?").run(row.seq);
  }
  return [...latest.values()].sort((left, right) => left.seq - right.seq);
}

export async function drainJournal(db, root, { force = true, maxDependentFiles = MAX_DEPENDENT_FILES, readStable = stableRead } = {}) {
  let applied = 0;
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
    const rows = pendingRows(db, force);
    if (!rows.length) break;
    for (const row of rows) { await applyJournalEvent(db, root, row, maxDependentFiles, readStable); applied += 1; }
    force = true;
  }
  return applied;
}

export class RepositoryActor extends EventEmitter {
  constructor({ root, outDir = ".agent", snapshotPath = null, reconcile = null, adapter = { startWatch, writeSnapshot, eventsSince }, maxDependentFiles = MAX_DEPENDENT_FILES, readStable = stableRead }) {
    super();
    this.root = canonicalRoot(root);
    this.outDir = outDir;
    this.dbPath = dbPath(this.root, outDir);
    this.snapshotPath = snapshotPath ? resolve(snapshotPath) : join(this.root, outDir, "graph", "watch.snapshot");
    this.reconcile = reconcile ?? (async () => ({ ok: true }));
    this.autoReconcileOnGap = Boolean(reconcile);
    this.adapter = adapter;
    this.maxDependentFiles = maxDependentFiles;
    this.readStable = readStable;
    this.subscription = null;
    this.timer = null;
    this.running = false;
    this.failures = 0;
    this.retryTimer = null;
  }

  log(error) {
    const logPath = join(this.root, this.outDir, "graph", "watchman.log");
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${error?.stack ?? error}\n`);
  }

  async initialize() {
    const hadSnapshot = existsSync(this.snapshotPath);
    if (hadSnapshot && !this.autoReconcileOnGap) {
      const events = await this.adapter.eventsSince(this.root, this.snapshotPath);
      if (events.length) { this.ingest(events); await this.flush(true); }
    }
    const db = openStore(this.dbPath);
    try {
      setState(db, "watcher_pid", process.pid);
      await this.reconcile(db, this.root, { outDir: this.outDir, snapshotPath: this.snapshotPath, maxDependentFiles: this.maxDependentFiles });
      if (!existsSync(this.snapshotPath)) await this.adapter.writeSnapshot(this.root, this.snapshotPath);
      setState(db, "event_gap", 0);
      db.prepare("DELETE FROM watch_state WHERE key='last_error'").run();
    } finally { closeStore(db); }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      await this.initialize();
      this.subscription = await this.adapter.startWatch(this.root, (events) => this.ingest(events), (error) => this.markGap(error));
      this.failures = 0;
    } catch (error) {
      this.running = false;
      this.handleFailure(error);
      throw error;
    }
  }

  markGap(error) {
    const db = openStore(this.dbPath);
    try {
      setState(db, "event_gap", 1);
      if (error) setState(db, "last_error", String(error?.message ?? error).slice(0, 500));
    } finally { closeStore(db); }
    if (error) this.log(error);
    this.emit("gap", error);
    if (!this.autoReconcileOnGap) return;
    Promise.resolve().then(async () => {
      const repairDb = openStore(this.dbPath);
      try { await this.reconcile(repairDb, this.root, { outDir: this.outDir, snapshotPath: this.snapshotPath, maxDependentFiles: this.maxDependentFiles }); }
      catch (reconcileError) { this.log(reconcileError); }
      finally { closeStore(repairDb); }
    });
  }

  ingest(events) {
    if (!events?.length) return [];
    if (events.some((event) => event.eventKind === "overflow")) {
      this.markGap(new Error("watcher overflow"));
      return [];
    }
    const db = openStore(this.dbPath);
    try {
      const appended = appendWatchEvents(db, events);
      this.scheduleFlush();
      return appended;
    } finally { closeStore(db); }
  }

  async flush(force = false) {
    const db = openStore(this.dbPath);
    try {
      return await drainJournal(db, this.root, { force, maxDependentFiles: this.maxDependentFiles, readStable: this.readStable });
    } finally { closeStore(db); }
  }

  scheduleFlush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush(false).catch((error) => this.handleFailure(error));
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  handleFailure(error) {
    this.failures += 1;
    this.log(error);
    if (this.failures >= 5) this.markGap(error);
    const delay = this.failures >= 5 ? 60000 : Math.min(30000, 1000 * 2 ** (this.failures - 1));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start().catch(() => {}), delay);
    this.retryTimer.unref?.();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    if (this.subscription) await this.subscription.unsubscribe();
    this.subscription = null;
    if (existsSync(this.dbPath)) {
      const db = openStore(this.dbPath);
      try { db.prepare("DELETE FROM watch_state WHERE key='watcher_pid'").run(); } finally { closeStore(db); }
    }
  }
}

export class CortexRepositoryWorker {
  constructor(options) { this.actor = new RepositoryActor(options); }
  async ingest(path, eventKind = "modify", renameTo = null) {
    const event = { path, eventKind, renameTo, observedMs: Date.now() };
    if (eventKind === "overflow") {
      this.actor.markGap(new Error("watcher overflow"));
      return { eventGap: true, reconciled: false };
    }
    const appended = this.actor.ingest([event]);
    const appliedCount = await this.actor.flush(true);
    const db = openStore(this.actor.dbPath);
    try {
      const row = db.prepare("SELECT * FROM event_journal WHERE seq=?").get(appended[0].seq);
      return { ...appended[0], applied: appliedCount > 0, journalSeq: appended[0].seq, appliedClock: row.applied_clock, eventGap: false };
    } finally { closeStore(db); }
  }
}
