#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyCandidate } from "./check-release.mjs";
import { npmCliArgs } from "./npm-cli.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120000, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function runNode(script, args, options = {}) {
  return run(process.execPath, [script, ...args], options);
}

export function validateQueryEvidence(payload, needle = "releaseProof") {
  const matches = (Array.isArray(payload?.results) ? payload.results : []).filter((result) => JSON.stringify(result).includes(needle));
  if (!matches.length) throw new Error(`query returned no evidence for ${needle}`);
  return { matchCount: matches.length, refs: matches.map((result) => result.path ?? result.id ?? result.name ?? "result") };
}

export async function runCleanHostSmoke({ candidate } = {}) {
  const candidateDir = resolve(candidate ?? "");
  const verified = verifyCandidate(candidateDir);
  if (!verified.ok) throw new Error(`candidate verification failed: ${verified.problems.join("; ")}`);
  const tarballs = verified.compatibility.artifacts.filter((artifact) => artifact.name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error("candidate must contain one npm tarball");
  const temp = mkdtempSync(join(tmpdir(), "cortex-clean-host-"));
  const stages = { verify: true, init: false, query: false, mcp: false, updateCheck: false, updateApply: false, rollback: false, uninstall: false };
  try {
    const prefix = join(temp, "prefix");
    const tarball = join(candidateDir, tarballs[0].name);
    run(process.execPath, npmCliArgs(["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", tarball]));
    const packageRoot = join(prefix, "node_modules", "@orthic-labs", "cortex");
    if (!existsSync(packageRoot)) throw new Error("local tarball was not installed");
    const repo = join(temp, "repo");
    mkdirSync(repo);
    run("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "CORTEX-AGENT.md"), "# original\n", "utf8");
    writeFileSync(join(repo, "releaseProof.mjs"), "export function releaseProof() { return true; }\n", "utf8");
    run("git", ["-C", repo, "add", "releaseProof.mjs"]);
    const cortex = join(packageRoot, "scripts", "cortex.mjs");
    const mcp = join(packageRoot, "scripts", "cortex-mcp.mjs");
    JSON.parse(runNode(cortex, ["init", "--host", "generic", "--mcp", "off", "--watch", "off", "--json"], { cwd: repo }));
    stages.init = true;
    const query = JSON.parse(runNode(cortex, ["search", "--query", "release", "--json"], { cwd: repo }));
    const queryEvidence = validateQueryEvidence(query);
    stages.query = true;
    const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clean-host", version: "1" } } })}\n`;
    const handshake = runNode(mcp, ["--root", repo], { cwd: repo, input: request });
    if (!/serverInfo/.test(handshake)) throw new Error("installed MCP initialize handshake failed");
    stages.mcp = true;
    JSON.parse(runNode(cortex, ["update", "check", "--offline", "--json"], { cwd: repo }));
    stages.updateCheck = true;
    const { stageUpdate, applyStaged } = await import(pathToFileURL(join(packageRoot, "lib", "update", "apply.mjs")));
    const { rollback } = await import(pathToFileURL(join(packageRoot, "lib", "update", "rollback.mjs")));
    const app = join(temp, "app");
    const update = join(temp, "update");
    mkdirSync(app); mkdirSync(update);
    writeFileSync(join(app, "version.txt"), "before\n");
    writeFileSync(join(update, "version.txt"), "after\n");
    applyStaged({ stagingDir: stageUpdate({ fromDir: update, toDir: app }), appDir: app, priorDir: `${app}.prior` });
    if (readFileSync(join(app, "version.txt"), "utf8") !== "after\n") throw new Error("staged update did not apply");
    stages.updateApply = true;
    if (!rollback({ appDir: app, priorDir: `${app}.prior`, root: repo }).ok || readFileSync(join(app, "version.txt"), "utf8") !== "before\n") throw new Error("packaged rollback did not restore prior app");
    stages.rollback = true;
    const uninstalled = JSON.parse(runNode(cortex, ["uninstall", "--root", repo, "--json"], { cwd: repo }));
    if (!uninstalled.ok || readFileSync(join(repo, "CORTEX-AGENT.md"), "utf8") !== "# original\n") throw new Error("uninstall did not restore host file");
    stages.uninstall = true;
    return { schemaVersion: 1, ok: true, stages, queryEvidence };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const index = process.argv.indexOf("--candidate");
  runCleanHostSmoke({ candidate: index < 0 ? null : process.argv[index + 1] })
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
