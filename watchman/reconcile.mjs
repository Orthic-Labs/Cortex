import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { diffLedgerAgainstTree } from "../graph/merkle-ledger.mjs";
import { scanSourcesPublic } from "../graph/static-provider.mjs";
import { closeStore, openStore } from "../graph/store-sqlite.mjs";
import { eventsSince, writeSnapshot } from "./adapter.mjs";
import { appendWatchEvents, drainJournal } from "./repo-actor.mjs";

function snapshotPath(root, outDir) { return join(resolve(root), outDir, "graph", "watch.snapshot"); }
function canonicalRoot(value) { const root = resolve(value); try { return realpathSync(root); } catch { return root; } }

export async function reconcile(dbOrRoot, rootOrOptions = null, options = {}) {
  const root = canonicalRoot(typeof dbOrRoot === "string" ? dbOrRoot : rootOrOptions);
  const db = typeof dbOrRoot === "string" ? openStore(join(root, options.outDir ?? ".agent", "graph", "graph.db")) : dbOrRoot;
  const outDir = options.outDir ?? ".agent";
  const close = typeof dbOrRoot === "string";
  try {
    const snapshot = options.snapshotPath ?? snapshotPath(root, outDir);
    const hadSnapshot = existsSync(snapshot);
    const pending = [];
    if (hadSnapshot) {
      const fastEvents = await eventsSince(root, snapshot);
      pending.push(...fastEvents);
    }
    const source = scanSourcesPublic(root, 0, {});
    const ledgerRows = db.prepare("SELECT COUNT(*) AS n FROM generation_leaf WHERE kind='file'").get().n;
    const diff = ledgerRows > 0
      ? diffLedgerAgainstTree(db, null, source.files ?? [])
      : { changed: [], added: [], removed: [] };
    for (const path of diff.changed) pending.push({ eventKind: "modify", path, observedMs: Date.now() });
    for (const path of diff.added) pending.push({ eventKind: "create", path, observedMs: Date.now() });
    for (const path of diff.removed) pending.push({ eventKind: "delete", path, observedMs: Date.now() });
    const unique = new Map();
    for (const event of pending) unique.set(`${event.path}:${event.renameTo ?? ""}`, event);
    if (unique.size) appendWatchEvents(db, [...unique.values()]);
    const applied = drainJournal(db, root, { force: true, maxDependentFiles: options.maxDependentFiles });
    if (hadSnapshot) await writeSnapshot(root, snapshot);
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
