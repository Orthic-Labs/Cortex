import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "scripts/cortex-install.mjs");
const SERVER = join(ROOT, "scripts/cortex-mcp.mjs");

function run(repo, args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], { cwd: repo, encoding: "utf8" });
}
function snapshot(paths) {
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
}
function assertSnapshot(paths, before) {
  for (const path of paths) assert.deepEqual(existsSync(path) ? readFileSync(path) : null, before.get(path), path);
}

test("installer is idempotent and uninstall restores project files byte-for-byte", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-installer-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\necho original\n");
    const mcp = join(repo, ".mcp.json");
    writeFileSync(mcp, '{"mcpServers":{"other":{"command":"other"}}}\n');
    const claude = join(repo, "CLAUDE.md");
    writeFileSync(claude, "# Existing\n\nKeep this byte sequence.\n");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const settings = join(repo, ".claude", "settings.json");
    writeFileSync(settings, '{"hooks":{"PreToolUse":[{"matcher":"Other","hooks":[]}]}}\n');
    const tracked = [claude, mcp, settings, hook, join(repo, ".git", "hooks", "post-merge"), join(repo, ".git", "hooks", "post-rewrite")];
    const original = snapshot(tracked);

    const installed = run(repo, ["--host", "claude-code", "--project", "--redirect"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal((readFileSync(claude, "utf8").match(/<!-- cortex:start -->/g) ?? []).length, 1);
    assert.equal(JSON.parse(readFileSync(mcp, "utf8")).mcpServers.cortex.args.at(-1), SERVER);
    assert.match(readFileSync(settings, "utf8"), /Read\|Grep\|Glob/);
    const denied = spawnSync(process.execPath, [INSTALLER, "--redirect-check", "--root", repo], { input: JSON.stringify({ session_id: "s1" }), encoding: "utf8" });
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    mkdirSync(join(repo, ".agent", "graph"), { recursive: true });
    writeFileSync(join(repo, ".agent", "graph", "cortex-orient-session-s1.marker"), "1\n");
    const allowed = spawnSync(process.execPath, [INSTALLER, "--redirect-check", "--root", repo], { input: JSON.stringify({ session_id: "s1" }), encoding: "utf8" });
    assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, "allow");
    const afterFirst = snapshot(tracked.concat([join(repo, ".git", "hooks", "post-checkout.cmd")]));
    const second = run(repo, ["--host", "claude-code", "--project", "--redirect"]);
    assert.equal(second.status, 0, second.stderr);
    assertSnapshot([...afterFirst.keys()], afterFirst);

    const uninstalled = run(repo, ["--host", "claude-code", "--project", "--uninstall"]);
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assertSnapshot(tracked, original);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("installer uninstall restores non-UTF8 host bytes", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-installer-bytes-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
    const file = join(repo, "CORTEX-AGENT.md");
    const original = Buffer.from([0, 255, 10, 128, 65]);
    writeFileSync(file, original);
    assert.equal(run(repo, ["--host", "generic", "--project"]).status, 0);
    assert.equal(run(repo, ["--host", "generic", "--project", "--uninstall"]).status, 0);
    assert.deepEqual(readFileSync(file), original);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("installer state validator rejects corrupt and escaping restore plans", async () => {
  const module = await import("../scripts/cortex-install.mjs");
  assert.equal(typeof module.validateInstallState, "function");
  if (typeof module.validateInstallState !== "function") return;
  const root = mkdtempSync(join(tmpdir(), "cortex-installer-state-"));
  try {
    assert.throws(() => module.validateInstallState(root, { files: { [join(root, "..", "escape")]: { exists: false } } }), /state_invalid/);
    assert.throws(() => module.validateInstallState(root, { files: { [root]: { exists: false } } }), /state_invalid/);
    assert.doesNotThrow(() => module.validateInstallState(root, { files: { [join(root, "empty")]: { exists: true, bytes: "", content: "" } } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
