import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildNeighborhood } from "../graph/neighborhood.mjs";
import { buildGraphGeneration, readGeneration } from "../graph/static-provider.mjs";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts/blueprint.mjs");
const FIXTURE = join(ROOT, "evals/fixture-repos/typescript-commerce");
const SCHEMA = join(ROOT, "schemas/repository-neighborhood-v1.schema.json");
const PYTHON = process.platform === "win32" ? ["py", "-3.11"] : ["python3"];

function handFixture() {
  return {
    manifest: { generationId: "generation-test" },
    nodes: [
      { id: "file:src/a.ts", kind: "file", path: "src/a.ts", name: "a.ts", evidence: [{ startLine: 1, endLine: 2 }] },
      { id: "file:src/b.ts", kind: "file", path: "src/b.ts", name: "b.ts", evidence: [{ startLine: 1, endLine: 3 }] },
      { id: "file:src/c.ts", kind: "file", path: "src/c.ts", name: "c.ts", evidence: [{ startLine: 1, endLine: 4 }] },
      { id: "file:src/d.ts", kind: "file", path: "src/d.ts", name: "d.ts", evidence: [{ startLine: 1, endLine: 5 }] },
      { id: "file:src/remote.ts", kind: "file", path: "src/remote.ts", name: "remote.ts", evidence: [{ startLine: 1, endLine: 6 }] },
    ],
    edges: [
      { id: "edge:a-b", kind: "imports", source: "file:src/a.ts", target: "file:src/b.ts", resolved: true, confidenceTier: "high" },
      { id: "edge:b-c", kind: "imports", source: "file:src/b.ts", target: "file:src/c.ts", resolved: true, confidenceTier: "high" },
      { id: "edge:c-d", kind: "imports", source: "file:src/c.ts", target: "file:src/d.ts", resolved: true, confidenceTier: "high" },
      { id: "edge:unresolved", kind: "imports", source: "file:src/a.ts", target: null, resolved: false, confidenceTier: "low" },
    ],
  };
}

function run(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
}

test("anchors survive budget 1 and PageRank output is deterministic", () => {
  const generation = handFixture();
  const first = buildNeighborhood(generation, ["src/a.ts"], { budgetTokens: 1, receiptId: "receipt-test" });
  const second = buildNeighborhood(generation, ["src/a.ts"], { budgetTokens: 1, receiptId: "receipt-test" });
  assert.deepEqual(first, second);
  assert.deepEqual(first.anchors, [{ path: "src/a.ts", symbol: null, protected: true }]);
  assert.ok(first.neurons.some((neuron) => neuron.path === "src/a.ts"));
  assert.deepEqual(first.omissions, [
    { reason: "budget", count: 2, recovery: "raise --budget-tokens | cortex neighborhood <path>" },
    { reason: "hops", count: 2, recovery: "cortex neighborhood <path>" },
    { reason: "unresolved", count: 1, recovery: "cortex neighborhood <path>" },
  ]);
});

test("neighborhood CLI emits a barrier receipt and schema-valid output", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-neighborhood-"));
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    const result = run(repo, ["neighborhood", "src/service.ts", "--budget-tokens", "1", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.kind, "RepositoryNeighborhoodV1");
    assert.ok(payload.receiptId);
    assert.ok(payload.repoId);
    assert.equal(payload.repoRoot, realpathSync(repo).replaceAll("\\", "/"));
    assert.equal(payload.generationId, readGeneration(repo, ".agent").manifest.generationId);
    assert.ok(payload.anchors.some((anchor) => anchor.path === "src/service.ts"));
    const validation = spawnSync(PYTHON[0], [...PYTHON.slice(1), "-c", [
      "import json, sys",
      "from jsonschema import Draft202012Validator",
      "schema = json.load(open(sys.argv[1], encoding='utf-8'))",
      "payload = json.load(sys.stdin)",
      "errors = sorted(Draft202012Validator(schema).iter_errors(payload), key=lambda error: list(error.path))",
      "print('\\n'.join(error.message for error in errors))",
      "raise SystemExit(1 if errors else 0)",
    ].join(";"), SCHEMA], { input: JSON.stringify(payload), encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("admission preserves an attached neighborhood", async () => {
  const { createAdmission } = await import("../lib/admission.mjs");
  const generation = handFixture();
  const storeDir = mkdtempSync(join(tmpdir(), "cortex-neighborhood-admission-"));
  const admission = createAdmission({
    storeDir,
    readGeneration: () => generation,
    createContextCandidateSet: () => ({ schemaVersion: 1, candidates: [], omissions: [] }),
  });
  try {
    const neighborhood = buildNeighborhood(generation, ["src/a.ts"], { receiptId: "receipt-test" });
    const result = await admission.orient({ task: "trace a", neighborhood, sessionId: "neighborhood-session", force: true });
    assert.deepEqual(result.candidateSet.neighborhood, neighborhood);
  } finally { rmSync(storeDir, { recursive: true, force: true }); }
});
