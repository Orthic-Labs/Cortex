import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { closeStore, openStoreReadOnly } from "../graph/store-sqlite.mjs";
import { RepositoryActor } from "./repo-actor.mjs";
import { reconcile as defaultReconcile } from "./reconcile.mjs";

export function defaultConfigPath() { return resolve(homedir(), ".cortex", "watch.json"); }

export function readWatchConfig(configPath = defaultConfigPath()) {
  if (!existsSync(configPath)) return { version: 1, repos: [] };
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.repos)) throw new Error("watch config must be version 1 with repos[]");
  return { version: 1, repos: parsed.repos.filter((repo) => repo?.enabled !== false && repo.root).map((repo) => ({ root: resolve(repo.root), enabled: true })) };
}

export function writeWatchConfig(config, configPath = defaultConfigPath()) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ version: 1, repos: config.repos ?? [] }, null, 2)}\n`);
}

// Honest freshness states. A repository is "current" only when a live watcher
// owns it, no event gap is outstanding, and nothing is waiting to be applied.
// Every other case names itself explicitly — the failure mode this replaces
// is a repo silently reporting "current" because nothing had ever observed
// it (no watcher ever started, or the watcher process has since died).
export const FRESHNESS = Object.freeze({
  UNWATCHED: "unwatched",
  DEGRADED: "degraded",
  STALE: "stale",
  CURRENT: "current",
});

// Reads a repo's state without ever mutating it: a read-only handle skips
// migrate() (never upgrades another process's schema mid-flight) and never
// takes a write lock, so a status poll can never contend with an actor's own
// writes or a concurrent `cortex build` on the same 19 databases (D3). Errors
// from a corrupt store (e.g. "database disk image is malformed") are caught
// per repo — one bad store must never blank the other 18 repos' status (D2).
function repoStatus(root, outDir = ".agent") {
  const dbPath = resolve(root, outDir, "graph", "graph.db");
  if (!existsSync(dbPath)) {
    return {
      root, pid: null, alive: false, sourceClock: 0, appliedClock: 0, eventGap: 1, pendingEvents: 0,
      freshness: FRESHNESS.UNWATCHED, reason: "no_graph_built",
    };
  }
  let db;
  try {
    db = openStoreReadOnly(dbPath);
    const state = Object.fromEntries(db.prepare("SELECT key,value FROM watch_state").all().map((row) => [row.key, row.value]));
    const pid = Number(state.watcher_pid ?? 0) || null;
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }
    const eventGap = Number(state.event_gap ?? 0);
    const pendingEvents = db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=0").get().n;
    const lastError = state.last_error ?? null;
    const gapReason = state.event_gap_reason ?? null;
    let freshness = FRESHNESS.CURRENT;
    let reason = null;
    if (!pid || !alive) {
      freshness = FRESHNESS.UNWATCHED;
      reason = pid ? "watcher_process_dead" : "watcher_never_started";
    } else if (eventGap) {
      freshness = FRESHNESS.DEGRADED;
      reason = gapReason ?? (lastError ? `event_gap: ${lastError}` : "event_gap_unreconciled");
    } else if (pendingEvents > 0) {
      freshness = FRESHNESS.STALE;
      reason = "events_pending_apply";
    }
    return {
      root, pid, alive, sourceClock: Number(state.source_clock ?? 0), appliedClock: Number(state.applied_clock ?? 0),
      eventGap, pendingEvents, freshness, reason,
    };
  } catch (error) {
    return {
      root, pid: null, alive: false, sourceClock: 0, appliedClock: 0, eventGap: 1, pendingEvents: 0,
      freshness: FRESHNESS.DEGRADED, reason: "store_unreadable", error: String(error?.message ?? error),
    };
  } finally {
    if (db) { try { closeStore(db); } catch { /* already unusable; nothing left to release cleanly */ } }
  }
}

// Exact relative paths (never globs — see watchman/adapter.mjs) from `root` to
// every OTHER enrolled repo nested under it. Used so a parent actor (today,
// principally the workspace-root enrollment) excludes sibling repos' subtrees
// from its own FSEvents subscription instead of double-watching them — every
// child edit was hitting both its own actor and the root actor, and the
// resulting volume (plus each child's own `.agent` WAL churn) is what
// overflowed the root subscription in production.
function siblingIgnoreList(root, repos) {
  return repos
    .map((repo) => repo.root)
    .filter((other) => other !== root)
    .map((other) => relative(root, other))
    .filter((rel) => rel && rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel));
}

export class WatchSupervisor {
  constructor({ configPath = defaultConfigPath(), actorFactory = (options) => new RepositoryActor(options), reconcile = defaultReconcile, pollMs = 30000 } = {}) {
    this.configPath = resolve(configPath);
    this.actorFactory = actorFactory;
    this.reconcile = reconcile;
    this.pollMs = pollMs;
    this.actors = new Map();
    this.poller = null;
    this.signalHandler = null;
    this.configMtime = 0;
  }

  async reload() {
    const config = readWatchConfig(this.configPath);
    const wanted = new Map(config.repos.map((repo) => [repo.root, repo]));
    for (const [root, actor] of this.actors) {
      if (!wanted.has(root)) { await actor.stop(); this.actors.delete(root); }
    }
    for (const repo of config.repos) {
      if (this.actors.has(repo.root)) continue;
      const actor = this.actorFactory({ root: repo.root, reconcile: this.reconcile, ignore: siblingIgnoreList(repo.root, config.repos) });
      this.actors.set(repo.root, actor);
      try { await actor.start(); } catch (error) { actor.log(error); }
    }
    this.configMtime = existsSync(this.configPath) ? statSync(this.configPath).mtimeMs : 0;
    return this.status();
  }

  async start() {
    await this.reload();
    this.signalHandler = () => this.reload().catch(() => {});
    process.on("SIGHUP", this.signalHandler);
    this.poller = setInterval(() => {
      const mtime = existsSync(this.configPath) ? statSync(this.configPath).mtimeMs : 0;
      if (mtime !== this.configMtime) this.reload().catch(() => {});
    }, this.pollMs);
    return this.status();
  }

  status() {
    const config = readWatchConfig(this.configPath);
    return { version: 1, repos: config.repos.map((repo) => repoStatus(repo.root)) };
  }

  async stop() {
    clearInterval(this.poller);
    if (this.signalHandler) process.off("SIGHUP", this.signalHandler);
    for (const actor of this.actors.values()) await actor.stop();
    this.actors.clear();
  }
}
