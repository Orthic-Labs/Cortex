import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { diffLedgerAgainstTree } from "../graph/merkle-ledger.mjs";
import { scanSourceMetadataPublic, scanSourcesPublic } from "../graph/static-provider.mjs";
import { closeStore, openStore } from "../graph/store-sqlite.mjs";
import { eventsSince, writeSnapshot } from "./adapter.mjs";
import { appendWatchEvents, drainJournal } from "./repo-actor.mjs";

function snapshotPath(root, outDir) { return join(resolve(root), outDir, "graph", "watch.snapshot"); }
function canonicalRoot(value) { const root = resolve(value); try { return realpathSync(root); } catch { return root; } }

function metadataEvents(db, root, scanMetadata = scanSourceMetadataPublic) {
  const recorded = new Map(db.prepare("SELECT path,size,mtime_ms,file_identity FROM file_state").all().map((row) => [row.path, row]));
  const current = new Map(scanMetadata(root).files.map((file) => [file.path, file]));
  const events = [];
  const observedMs = Date.now();
  for (const [path, file] of current) {
    const prior = recorded.get(path);
    if (!prior) events.push({ eventKind: "create", path, observedMs });
    else if (Number(prior.size) !== file.size || Number(prior.mtime_ms) !== file.mtimeMs || (prior.file_identity ?? null) !== file.identity) {
      events.push({ eventKind: "modify", path, observedMs });
    }
  }
  for (const path of recorded.keys()) if (!current.has(path)) events.push({ eventKind: "delete", path, observedMs });
  return events;
}

function coalesceRenameEvents(events) {
  const renames = events.filter((event) => event.eventKind === "rename" && event.renameTo);
  return events.filter((event) => event.eventKind === "rename" || !renames.some((rename) => (
    (event.eventKind === "delete" && event.path === rename.path)
    || (event.eventKind === "create" && event.path === rename.renameTo)
  )));
}

export async function reconcile(dbOrRoot, rootOrOptions = null, options = {}) {
  const root = canonicalRoot(typeof dbOrRoot === "string" ? dbOrRoot : rootOrOptions);
  const db = typeof dbOrRoot === "string" ? openStore(join(root, options.outDir ?? ".agent", "graph", "graph.db")) : dbOrRoot;
  const outDir = options.outDir ?? ".agent";
  const close = typeof dbOrRoot === "string";
  try {
    const adapter = options.adapter ?? { eventsSince, writeSnapshot };
    const snapshot = options.snapshotPath ?? snapshotPath(root, outDir);
    const hadSnapshot = existsSync(snapshot);
    const repairingGap = db.prepare("SELECT value FROM watch_state WHERE key='event_gap'").get()?.value === "1";
    const pending = [];
    let diff = { changed: [], added: [], removed: [] };
    if (hadSnapshot) {
      const fastEvents = await adapter.eventsSince(root, snapshot);
      pending.push(...coalesceRenameEvents([
        ...fastEvents,
        ...metadataEvents(db, root, options.scanSourceMetadata ?? scanSourceMetadataPublic),
      ]));
      diff = {
        changed: [...new Set(pending.filter((event) => event.eventKind === "modify").map((event) => event.path))].sort(),
        added: [...new Set(pending.filter((event) => event.eventKind === "create").map((event) => event.path))].sort(),
        removed: [...new Set(pending.filter((event) => ["delete", "rename"].includes(event.eventKind)).map((event) => event.path))].sort(),
      };
    } else {
      const source = scanSourcesPublic(root, 0, {});
      const ledgerRows = db.prepare("SELECT COUNT(*) AS n FROM generation_leaf WHERE kind='file'").get().n;
      diff = ledgerRows > 0
        ? diffLedgerAgainstTree(db, null, source.files ?? [])
        : { changed: [], added: [], removed: [] };
    }
    if (!hadSnapshot) {
      for (const path of diff.changed) pending.push({ eventKind: "modify", path, observedMs: Date.now() });
      for (const path of diff.added) pending.push({ eventKind: "create", path, observedMs: Date.now() });
      for (const path of diff.removed) pending.push({ eventKind: "delete", path, observedMs: Date.now() });
    }
    const unique = new Map();
    for (const event of pending) unique.set(`${event.path}:${event.renameTo ?? ""}`, event);
    if (unique.size) appendWatchEvents(db, [...unique.values()]);
    const applied = await drainJournal(db, root, { force: true, maxDependentFiles: options.maxDependentFiles });
    if ((hadSnapshot && unique.size > 0) || (!hadSnapshot && repairingGap)) await adapter.writeSnapshot(root, snapshot);
    db.exec("BEGIN;");
    try {
      db.prepare("INSERT INTO watch_state(key,value) VALUES ('event_gap','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
      db.prepare("INSERT INTO watch_state(key,value) VALUES ('last_reconcile_ms',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()));
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    return { ok: true, changed: diff.changed, added: diff.added, removed: diff.removed, queued: unique.size, applied, eventGap: 0 };
  } finally { if (close) closeStore(db); }
}
