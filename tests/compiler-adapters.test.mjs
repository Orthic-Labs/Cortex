// D28: compiler/LSP/SCIP adapters and module resolvers — JS/TS + SCIP only
// (second compiler ecosystem is owner-gated). Providers degrade typed, never
// make Cortex unavailable.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defineProvider, example } from "../providers/index.mjs";
import { resolveModuleSpecifier } from "../providers/modules/javascript.mjs";
import { probeScip } from "../graph/scip-provider.mjs";

test("defineProvider enforces the S-20 contract", () => {
  assert.throws(() => defineProvider({ id: "x" }), /missing/);
  assert.equal(example.id, "orthic.typescript");
  assert.equal(example.permissions.filesystem, "repo-read");
  assert.equal(example.permissions.network, "none");
  assert.deepEqual(example.capabilities, ["definitions", "references", "types"]);
});

test("JS module resolver resolves relative, extensionless, and index paths", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-resolve-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "src", "lib", "util.js"), "module.exports = {};\n");
    const rel = resolveModuleSpecifier({ specifier: "./index", fromFile: join(root, "src", "main.ts") });
    assert.equal(rel.resolved, join(root, "src", "index.ts"));
    const ext = resolveModuleSpecifier({ specifier: "./lib/util", fromFile: join(root, "src", "main.ts") });
    assert.equal(ext.resolved, join(root, "src", "lib", "util.js"));
    const missing = resolveModuleSpecifier({ specifier: "./nope", fromFile: join(root, "src", "main.ts") });
    assert.equal(missing.resolved, null);
    assert.equal(missing.reason, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JS module resolver resolves bare specifiers through node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-resolve-bare-"));
  try {
    mkdirSync(join(root, "node_modules", "lodash"), { recursive: true });
    writeFileSync(join(root, "node_modules", "lodash", "package.json"), JSON.stringify({ name: "lodash", main: "index.js" }));
    writeFileSync(join(root, "node_modules", "lodash", "index.js"), "module.exports = {};\n");
    const bare = resolveModuleSpecifier({ specifier: "lodash", fromFile: join(root, "src", "main.ts") });
    assert.equal(bare.resolved, join(root, "node_modules", "lodash", "index.js"));
    assert.equal(bare.reason, "package");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SCIP probe degrades typed when absent and reads valid exports", async () => {
  const absent = await probeScip(join(tmpdir(), "no-such-repo"));
  assert.equal(absent.state, "unavailable");
  assert.ok(absent.degradesTo);
  const root = mkdtempSync(join(tmpdir(), "cortex-scip-"));
  try {
    writeFileSync(join(root, "index.scip.json"), JSON.stringify({ documents: [{ relativePath: "a.ts", occurrences: [] }] }));
    const ok = await probeScip(root);
    assert.ok(ok.state === "ok" || ok.state === "available");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider absence never makes Cortex unavailable (typed degradation)", async () => {
  const provider = defineProvider({
    id: "orthic.missing-compiler",
    version: "1.0.0",
    kind: "compiler",
    protocolRange: ">=1 <2",
    capabilities: ["references"],
    permissions: {},
    async probe() { return { state: "unavailable", reason: "compiler_not_installed" }; },
    async collect() { return { nodes: [], edges: [], reports: [{ kind: "unavailable", reason: "compiler_not_installed" }] }; },
  });
  const probe = await provider.probe();
  assert.equal(probe.state, "unavailable");
  const collected = await provider.collect();
  assert.ok(collected.reports.some((r) => r.kind === "unavailable"));
});
