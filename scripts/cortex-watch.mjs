#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { WatchSupervisor, defaultConfigPath, readWatchConfig, writeWatchConfig } from "../watchman/supervisor.mjs";

const configPath = defaultConfigPath();
const pidPath = join(dirname(configPath), "watchman.pid");
const command = process.argv[2] ?? "status";
const args = process.argv.slice(3);

function json(value) { console.log(JSON.stringify(value, null, 2)); }

function enroll(root) {
  const absolute = resolve(root ?? process.cwd());
  const config = readWatchConfig(configPath);
  if (!config.repos.some((repo) => repo.root === absolute)) config.repos.push({ root: absolute, enabled: true });
  writeWatchConfig(config, configPath);
  json({ enrolled: absolute, config: configPath });
}

function unenroll(root) {
  const absolute = resolve(root ?? process.cwd());
  const config = readWatchConfig(configPath);
  config.repos = config.repos.filter((repo) => repo.root !== absolute);
  writeWatchConfig(config, configPath);
  json({ unenrolled: absolute, config: configPath });
}

async function start() {
  if (args.includes("--daemon")) {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "start"], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(pidPath, String(child.pid));
    json({ started: true, daemon: true, pid: child.pid });
    return;
  }
  writeFileSync(pidPath, String(process.pid));
  const supervisor = new WatchSupervisor({ configPath });
  await supervisor.start();
  const stop = async () => { await supervisor.stop(); try { unlinkSync(pidPath); } catch {} process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  json(supervisor.status());
}

async function stop() {
  if (!existsSync(pidPath)) return json({ stopped: false, reason: "not_running" });
  const pid = Number(readFileSync(pidPath, "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch {}
  try { unlinkSync(pidPath); } catch {}
  json({ stopped: true, pid });
}

async function main() {
  if (command === "enroll") return enroll(args[0]);
  if (command === "unenroll") return unenroll(args[0]);
  if (command === "status") return json(new WatchSupervisor({ configPath }).status());
  if (command === "logs") {
    const lines = Number(args[args.indexOf("-n") + 1] ?? 50);
    const repos = readWatchConfig(configPath).repos;
    return repos.forEach((repo) => {
      const path = join(repo.root, ".agent", "graph", "watchman.log");
      if (existsSync(path)) console.log(readFileSync(path, "utf8").trim().split("\n").slice(-lines).join("\n"));
    });
  }
  if (command === "start") return start();
  if (command === "stop") return stop();
  throw new Error(`unknown cortex-watch command: ${command}`);
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
