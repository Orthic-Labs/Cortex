// D08: apply an init plan with full rollback. Reuses the reversible installer
// state capture; applies only the generated plan and rolls back every
// completed action on failure.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitPlan } from "./plan.mjs";

const START = "<!-- cortex:start -->";
const END = "<!-- cortex:end -->";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CORTEX_SCRIPT = join(SCRIPT_DIR, "..", "..", "scripts", "cortex.mjs");

function statePath(root) { return join(root, ".agent", "graph", "cortex-install-state.json"); }
function loadState(root) {
  if (!existsSync(statePath(root))) return { version: 1, files: {} };
  try { return JSON.parse(readFileSync(statePath(root), "utf8")); } catch { return { version: 1, files: {} }; }
}
function saveState(root, state) {
  mkdirSync(dirname(statePath(root)), { recursive: true });
  writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
function remember(state, path) {
  if (Object.hasOwn(state.files, path)) return;
  const bytes = existsSync(path) ? readFileSync(path) : null;
  state.files[path] = { exists: Boolean(bytes), content: bytes?.toString("utf8") ?? null, bytes: bytes?.toString("base64") ?? null };
}
function removeBlock(content) {
  const escapedStart = START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g"), "\n").replace(/^\n+$/, "");
}
function mergeBlock(content) {
  const block = `${START}\n## Cortex Graph\nBefore reading repository files, call \`cortex_orient\` with current repository root. Use \`cortex_expand\` for bounded context and \`cortex_search\` for queries.\n${END}`;
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

function restore(root, state) {
  for (const [path, original] of Object.entries(state.files ?? {})) {
    if (original.exists) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, original.bytes ? Buffer.from(original.bytes, "base64") : (original.content ?? ""), "utf8");
    } else {
      try { rmSync(path, { force: true }); } catch {}
    }
  }
}

export function applyInitPlan({ root = process.cwd(), plan = null, build = true } = {}) {
  const resolved = plan ?? buildInitPlan({ root });
  const state = loadState(root);
  const completed = [];
  const buildRan = { ran: false };
  try {
    for (const action of resolved.actions) {
      if (action.kind === "file-edit") {
        if (action.path.endsWith(".mcp.json") || action.path.endsWith("settings.json")) {
          mergeJsonFile(state, action.path, (value) => ({
            ...value,
            mcpServers: {
              ...(value.mcpServers ?? {}),
              cortex: { command: process.execPath, args: [join(SCRIPT_DIR, "..", "..", "scripts", "cortex-mcp.mjs")] },
            },
          }));
        } else {
          const current = existsSync(action.path) ? readFileSync(action.path, "utf8") : "";
          remember(state, action.path);
          writeFileSync(action.path, mergeBlock(current), "utf8");
        }
      } else if (action.kind === "hooks") {
        remember(state, join(root, ".claude", "settings.json"));
      } else if (action.kind === "command" && action.id === "build-generation" && build) {
        execFileSync(process.execPath, [CORTEX_SCRIPT, "graph", "build", "--out", ".agent"], { cwd: root, stdio: "ignore" });
        buildRan.ran = true;
      }
      completed.push(action.id);
    }
    saveState(root, state);
    return { ok: true, applied: completed, buildRan: buildRan.ran, uninstallCommand: resolved.uninstallCommand };
  } catch (error) {
    restore(root, state);
    saveState(root, state);
    return { ok: false, applied: completed, error: String(error.message ?? error), uninstallCommand: resolved.uninstallCommand };
  }
}

export function uninstallInit({ root = process.cwd() } = {}) {
  const path = statePath(root);
  if (!existsSync(path)) return { schemaVersion: 1, ok: true, action: "uninstalled", root, restored: [], idempotent: true };
  const state = loadState(root);
  const restored = Object.keys(state.files ?? {});
  try {
    restore(root, state);
    rmSync(path, { force: true });
    return { schemaVersion: 1, ok: true, action: "uninstalled", root, restored, idempotent: false };
  } catch (error) {
    return { schemaVersion: 1, ok: false, action: "uninstall_failed", root, restored: [], error: String(error.message ?? error), idempotent: false };
  }
}
