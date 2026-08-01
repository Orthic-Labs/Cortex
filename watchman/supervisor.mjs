import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { closeStore, openStore } from "../graph/store-sqlite.mjs";
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

function repoStatus(root, outDir = ".agent") {
  const dbPath = resolve(root, outDir, "graph", "graph.db");
  if (!existsSync(dbPath)) return { root, pid: null, alive: false, sourceClock: 0, appliedClock: 0, eventGap: 1, pendingEvents: 0 };
  const db = openStore(dbPath);
  try {
    const state = Object.fromEntries(db.prepare("SELECT key,value FROM watch_state").all().map((row) => [row.key, row.value]));
    const pid = Number(state.watcher_pid ?? 0) || null;
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }
    return { root, pid, alive, sourceClock: Number(state.source_clock ?? 0), appliedClock: Number(state.applied_clock ?? 0), eventGap: Number(state.event_gap ?? 0), pendingEvents: db.prepare("SELECT COUNT(*) AS n FROM event_journal WHERE applied=0").get().n };
  } finally { closeStore(db); }
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
      const actor = this.actorFactory({ root: repo.root, reconcile: this.reconcile });
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
