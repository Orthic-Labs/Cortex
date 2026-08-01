import ParcelWatcher from "@parcel/watcher";
import { realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { SCAN_EXCLUSIONS } from "../graph/static-provider.mjs";

const EVENT_TYPES = new Set(["create", "update", "delete"]);

function canonicalRoot(value) {
  const root = resolve(value);
  try { return realpathSync(root); } catch { return root; }
}

function normalizePath(root, value) {
  return relative(root, resolve(root, String(value))).replaceAll("\\", "/");
}

function ignorePatterns(extra = []) {
  const names = new Set([".git", "node_modules", ".agent", ".blueprint", ...SCAN_EXCLUSIONS, ...extra]);
  return [...names].sort().flatMap((name) => [`**/${name}/**`, `${name}/**`]);
}

function normalizeEvents(root, events, observedMs = Date.now()) {
  const normalizedRoot = canonicalRoot(root);
  const candidates = events
    .filter((event) => EVENT_TYPES.has(event.type))
    .map((event) => ({
      eventKind: event.type === "update" ? "modify" : event.type,
      path: normalizePath(normalizedRoot, event.path),
      renameTo: null,
      observedMs,
    }))
    .filter((event) => event.path && event.path !== ".");
  const deletes = candidates.filter((event) => event.eventKind === "delete");
  const creates = candidates.filter((event) => event.eventKind === "create");
  const paired = new Set();
  for (const deletion of deletes) {
    const match = creates.find((creation, index) => {
      if (paired.has(index) || Math.abs(creation.observedMs - deletion.observedMs) > 50) return false;
      return basename(creation.path) === basename(deletion.path);
    });
    if (!match) continue;
    const index = creates.indexOf(match);
    paired.add(index);
    deletion.eventKind = "rename";
    deletion.renameTo = match.path;
  }
  const pairedCreates = new Set([...paired].map((index) => creates[index]));
  return candidates.filter((event) => !pairedCreates.has(event));
}

function options(ignore) {
  return { ignore: ignorePatterns(ignore) };
}

export async function startWatch(root, onEvents, onGap = () => {}, ignore = []) {
  const absoluteRoot = canonicalRoot(root);
  const callback = (error, events = []) => {
    if (error) {
      onGap(error);
      return;
    }
    try { onEvents(normalizeEvents(absoluteRoot, events)); }
    catch (callbackError) { onGap(callbackError); }
  };
  try {
    return await ParcelWatcher.subscribe(absoluteRoot, callback, options(ignore));
  } catch (error) {
    onGap(error);
    throw error;
  }
}

export async function writeSnapshot(root, snapshotPath, ignore = []) {
  return ParcelWatcher.writeSnapshot(canonicalRoot(root), resolve(snapshotPath), options(ignore));
}

export async function eventsSince(root, snapshotPath, ignore = []) {
  const normalizedRoot = canonicalRoot(root);
  const events = await ParcelWatcher.getEventsSince(normalizedRoot, resolve(snapshotPath), options(ignore));
  return normalizeEvents(normalizedRoot, events);
}

export { normalizeEvents };
