// D08: apply → uninstall round-trip restores original host files byte-for-byte
// for Claude Code, Codex, Cursor, and generic hosts.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildInitPlan } from "../lib/init/plan.mjs";
import { applyInitPlan } from "../lib/init/apply.mjs";
import { removeBlock } from "../scripts/cortex-install.mjs";

const CORTEX = fileURLToPath(new URL("../scripts/cortex.mjs", import.meta.url));

function uninstall(root) {
  const result = spawnSync(process.execPath, [CORTEX, "uninstall", "--root", root, "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function makeRepo(host) {
  const root = mkdtempSync(join(tmpdir(), `cortex-roundtrip-${host}-`));
  mkdirSync(join(root, ".git"), { recursive: true });
  if (host === "claude-code") writeFileSync(join(root, "CLAUDE.md"), "# Existing Claude instructions\n");
  if (host === "codex") writeFileSync(join(root, "AGENTS.md"), "# Existing Codex instructions\n");
  if (host === "cursor") {
    mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(root, ".cursor", "rules", "cortex.mdc"), "# Existing Cursor rules\n");
  }
  if (host === "generic") writeFileSync(join(root, "CORTEX-AGENT.md"), "# Existing generic instructions\n");
  return root;
}

function instructionPathFor(root, host) {
  if (host === "claude-code") return join(root, "CLAUDE.md");
  if (host === "codex") return join(root, "AGENTS.md");
  if (host === "cursor") return join(root, ".cursor", "rules", "cortex.mdc");
  return join(root, "CORTEX-AGENT.md");
}

for (const host of ["claude-code", "codex", "cursor", "generic"]) {
  test(`${host} apply→uninstall restores files byte-for-byte`, () => {
    const root = makeRepo(host);
    try {
      const instruction = instructionPathFor(root, host);
      const original = readFileSync(instruction, "utf8");
      const plan = buildInitPlan({ root, host, scope: "project", mcp: "off", watch: "off", hooks: "none", build: false });
      const applied = applyInitPlan({ root, plan, build: false });
      assert.equal(applied.ok, true, applied.error ?? "");
      const afterApply = readFileSync(instruction, "utf8");
      assert.notEqual(afterApply, original, "instruction file should be modified");
      assert.ok(afterApply.includes("cortex_orient"));
      const restored = uninstall(root);
      assert.equal(restored.ok, true);
      assert.equal(readFileSync(instruction, "utf8"), original, "byte-for-byte restore");
      assert.equal(uninstall(root).idempotent, true, "second uninstall is typed and idempotent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("applyInitPlan writes the managed instruction block", () => {
  const root = makeRepo("generic");
  try {
    const plan = buildInitPlan({ root, host: "generic", scope: "project", mcp: "off", watch: "off", hooks: "none" });
    const applied = applyInitPlan({ root, plan, build: false });
    assert.equal(applied.ok, true, applied.error ?? "");
    const content = readFileSync(join(root, "CORTEX-AGENT.md"), "utf8");
    assert.ok(content.includes("<!-- cortex:start -->"));
    assert.ok(content.includes("<!-- cortex:end -->"));
    assert.ok(content.includes("cortex_orient"));
    // removeBlock must strip exactly the managed block.
    const stripped = removeBlock(content);
    assert.ok(!stripped.includes("cortex_orient"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI uninstall restores non-UTF8 host bytes", () => {
  const root = makeRepo("generic");
  try {
    const instruction = join(root, "CORTEX-AGENT.md");
    const original = Buffer.from([0, 255, 10, 128, 65]);
    writeFileSync(instruction, original);
    const applied = applyInitPlan({ root, plan: buildInitPlan({ root, host: "generic", mcp: "off", watch: "off" }), build: false });
    assert.equal(applied.ok, true, applied.error ?? "");
    assert.notDeepEqual(readFileSync(instruction), original);
    assert.equal(uninstall(root).idempotent, false);
    assert.deepEqual(readFileSync(instruction), original);
    assert.equal(uninstall(root).idempotent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
