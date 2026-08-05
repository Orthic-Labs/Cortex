#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- cortex:start -->";
const END = "<!-- cortex:end -->";
const MESSAGE = "Run cortex_orient first — Cortex Graph has current repository truth.";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(SCRIPT_DIR, "cortex-mcp.mjs");
const CORTEX_SCRIPT = join(SCRIPT_DIR, "cortex.mjs");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project") args.scope = "project";
    else if (value === "--global") args.scope = "global";
    else if (value === "--redirect" || value === "--uninstall" || value === "--redirect-check" || value === "--grant-check") args[value.slice(2)] = true;
    else if (value.startsWith("--")) {
      const [key, inline] = value.slice(2).split("=", 2);
      args[key] = inline === undefined ? argv[++index] : inline;
    }
    else args._.push(value);
  }
  return args;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function statePath(root) { return join(root, ".agent", "graph", "cortex-install-state.json"); }
function loadState(root) {
  const path = statePath(root);
  if (!existsSync(path)) return { version: 1, files: {} };
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return { version: 1, files: {} }; }
}
function saveState(root, state) {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
function remember(state, path) {
  if (Object.hasOwn(state.files, path)) return;
  state.files[path] = { exists: existsSync(path), content: existsSync(path) ? readFileSync(path, "utf8") : null };
}
function writeManaged(state, path, content) {
  remember(state, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}
function removeBlock(content) {
  const escapedStart = START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g"), "\n").replace(/^\n+$/, "");
}
function mergeBlock(content) {
  const block = `${START}\n## Cortex Graph\nBefore reading repository files, call \`cortex_orient\` with current repository root. Use \`cortex_expand\` for bounded context and \`cortex_resolve\` for search with graph neighbors.\n${END}`;
  const without = removeBlock(content);
  return `${without.trimEnd()}${without.trimEnd() ? "\n\n" : ""}${block}\n`;
}
function mergeJsonFile(state, path, update) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  let value;
  try { value = JSON.parse(current); } catch { throw new Error(`${path} is not valid JSON`); }
  remember(state, path);
  const next = update(value);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function instructionPath(root, host) {
  if (host === "claude-code") return join(root, "CLAUDE.md");
  if (host === "codex") return join(root, "AGENTS.md");
  if (host === "cursor") return join(root, ".cursor", "rules", "cortex.mdc");
  return join(root, "CORTEX-AGENT.md");
}

function installMcpEntry(state, root) {
  const path = join(root, ".mcp.json");
  mergeJsonFile(state, path, (value) => ({
    ...value,
    mcpServers: {
      ...(value.mcpServers ?? {}),
      cortex: { command: process.execPath, args: [SERVER_SCRIPT] },
    },
  }));
}

function redirectCommand(root, grants = false) {
  return `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --${grants ? "grant-check" : "redirect-check"} --root ${shellQuote(root)}`;
}

function installRedirect(state, root, { grants = false } = {}) {
  const path = join(root, ".claude", "settings.json");
  mergeJsonFile(state, path, (value) => {
    const hooks = Array.isArray(value.hooks?.PreToolUse) ? value.hooks.PreToolUse : [];
    const filtered = hooks.filter((entry) => !JSON.stringify(entry).includes("--redirect-check") && !JSON.stringify(entry).includes("--grant-check"));
    return {
      ...value,
      hooks: {
        ...(value.hooks ?? {}),
        PreToolUse: [...filtered, {
          matcher: grants ? "^(Read|Edit)$" : "^(Read|Grep|Glob)$",
          hooks: [{ type: "command", command: redirectCommand(root, grants) }],
        }],
      },
    };
  });
}

function installGitHooks(state, root) {
  const gitPath = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
  const hooksDir = gitPath.startsWith("/") ? gitPath : resolve(root, gitPath);
  for (const name of ["post-checkout", "post-merge", "post-rewrite", "post-checkout.cmd", "post-merge.cmd", "post-rewrite.cmd"]) remember(state, join(hooksDir, name));
  execFileSync(process.execPath, [CORTEX_SCRIPT, "hooks", "install-git"], { cwd: root, stdio: "ignore" });
}

function restore(root, state) {
  for (const [path, original] of Object.entries(state.files ?? {})) {
    if (original.exists) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, original.content ?? "", "utf8");
    } else rmSync(path, { force: true });
  }
  const markerDir = join(root, ".agent", "graph");
  if (existsSync(markerDir)) for (const name of readdirSync(markerDir)) if (name.startsWith("cortex-orient-session-") && name.endsWith(".marker")) rmSync(join(markerDir, name), { force: true });
  rmSync(statePath(root), { force: true });
}

function redirectCheck(root) {
  let request = {};
  try { request = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const session = String(request.session_id ?? request.sessionId ?? "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  const marker = join(root, ".agent", "graph", `cortex-orient-session-${session}.marker`);
  const allowed = existsSync(marker);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allowed ? "allow" : "deny", permissionDecisionReason: allowed ? "Cortex orientation receipt present." : MESSAGE } }));
  return 0;
}

function grantCheck(root) {
  let request = {};
  try { request = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const task = String(request.task_id ?? request.taskId ?? request.session_id ?? request.sessionId ?? "default");
  const input = request.tool_input ?? request.input ?? {};
  const requestedPath = String(input.path ?? input.file_path ?? input.filePath ?? request.path ?? "");
  let allowed = false;
  if (requestedPath) {
    try {
      execFileSync(process.execPath, [CORTEX_SCRIPT, "grant", "check", "--task", task, "--path", requestedPath], { cwd: root, stdio: "ignore" });
      allowed = true;
    } catch {}
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allowed ? "allow" : "deny", permissionDecisionReason: allowed ? "Cortex task-scoped grant present." : "Run cortex_expand for this path to issue a widened Cortex grant." } }));
  return 0;
}

function install(root, host, args) {
  const state = loadState(root);
  const instruction = instructionPath(root, host);
  const current = existsSync(instruction) ? readFileSync(instruction, "utf8") : "";
  writeManaged(state, instruction, mergeBlock(current));
  if (host === "claude-code" && args.scope !== "global") installMcpEntry(state, root);
  if (args.redirect) installRedirect(state, root, { grants: args.redirect === "grants" });
  if (args.scope !== "global") installGitHooks(state, root);
  saveState(root, state);
  const output = { action: "installed", host, scope: args.scope, root, instruction, redirect: Boolean(args.redirect) };
  if (host === "claude-code" && args.scope === "global") output.advice = `claude mcp add cortex -- ${shellQuote(process.execPath)} ${shellQuote(SERVER_SCRIPT)}`;
  return output;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const host = args.host;
  if (args["redirect-check"]) return redirectCheck(resolve(args.root ?? process.cwd()));
  if (args["grant-check"]) return grantCheck(resolve(args.root ?? process.cwd()));
  if (!host || !["claude-code", "codex", "cursor", "generic"].includes(host)) throw new Error("--host must be claude-code, codex, cursor, or generic");
  const root = resolve(args.root ?? (args.scope === "global" ? homedir() : process.cwd()));
  if (args.uninstall) {
    const state = loadState(root);
    restore(root, state);
    return { action: "uninstalled", host, scope: args.scope ?? "project", root };
  }
  return install(root, host, args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const output = main();
    if (typeof output === "number") process.exitCode = output;
    else process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { main, mergeBlock, removeBlock, redirectCheck };
