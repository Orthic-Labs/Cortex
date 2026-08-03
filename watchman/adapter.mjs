import ParcelWatcher from "@parcel/watcher";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { SCAN_EXCLUSIONS } from "../graph/static-provider.mjs";

const EVENT_TYPES = new Set(["create", "update", "delete"]);

function canonicalRoot(value) {
  const root = resolve(value);
  try { return realpathSync(root); } catch { return root; }
}

function canonicalAbsolute(value) {
  const absolute = resolve(value);
  try { return realpathSync(absolute); }
  catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : resolve(canonicalAbsolute(parent), basename(absolute));
  }
}

function normalizePath(root, value) {
  return relative(root, canonicalAbsolute(resolve(root, String(value)))).replaceAll("\\", "/");
}

// @parcel/watcher's `ignore` option (typed GlobPattern in its own .d.ts) does NOT
// glob-match in the installed native build (2.6.0, fs-events backend) — confirmed
// empirically 2026-08-03: `node_modules/**` and `**/node_modules/**` pass every
// event through unfiltered. What actually excludes a subtree is an EXACT literal
// path relative to the watched root: a bare single-segment name (e.g.
// "node_modules") excludes that name only where it sits directly under the
// watched root, and a multi-segment relative path (e.g. "child-repo" or
// "nested/child-repo") excludes that exact target at any depth. Neither form is
// a glob; do not reintroduce `**` or trailing `/**` here, it silently no-ops.
// `extra` therefore carries exact relative paths — the caller (repo-actor via
// the supervisor) resolves them from its own root before passing them in.
function ignorePatterns(extra = []) {
  return [...new Set([".git", "node_modules", ".agent", ".blueprint", ...SCAN_EXCLUSIONS, ...extra])];
}

function normalizeEvents(root, events, observedMs = Date.now()) {
  const normalizedRoot = canonicalRoot(root);
  const candidates = events
    .filter((event) => EVENT_TYPES.has(event.type))
    .filter((event) => {
      if (event.type === "delete") return true;
      try { return statSync(event.path).isFile(); }
      catch { return true; }
    })
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
