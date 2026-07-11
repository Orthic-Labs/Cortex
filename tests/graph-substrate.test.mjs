import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildGraphGeneration,
  createContextCandidateSet,
  graphStatus,
  queryGraph,
} from "../graph/static-provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLUEPRINT = path.resolve(HERE, "..");
const REPO = path.join(BLUEPRINT, "evals/fixture-repos/typescript-commerce");

test("static graph substrate builds a complete generation with exact evidence", () => {
  const generation = buildGraphGeneration(REPO);

  assert.equal(generation.provider.id, "blueprint-static");
  assert.match(generation.manifest.generationId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(generation.manifest.complete, true);
  assert.ok(generation.nodes.some((node) => node.kind === "symbol" && node.qualifiedName === "OrderService.placeOrder"));
  assert.ok(generation.edges.some((edge) => edge.kind === "CALLS" && edge.source.includes("registerOrderRoute") && edge.target.includes("OrderService.placeOrder")));
  assert.ok(generation.edges.some((edge) => edge.kind === "IMPORTS" && edge.source === "file:src/routes.ts" && edge.target === "file:src/service.ts"));
  assert.ok(generation.edges.every((edge) => generation.nodes.some((node) => node.id === edge.source) && generation.nodes.some((node) => node.id === edge.target)));
});

test("static graph query returns bounded exact source-backed results", () => {
  const generation = buildGraphGeneration(REPO);
  const results = queryGraph(generation, { query: "placeOrder", limit: 5 });

  assert.ok(results.length >= 1);
  assert.equal(results[0].evidence[0].path, "src/service.ts");
  assert.equal(results[0].evidence[0].startLine, 6);
  assert.equal(results[0].evidence[0].endLine, 9);
  assert.equal(results[0].fresh, true);
});

test("static graph candidate set conforms to ContextCandidateSet v1 shape", () => {
  const generation = buildGraphGeneration(REPO);
  const candidates = createContextCandidateSet(generation, {
    task: "find placeOrder",
    query: "placeOrder",
    maxCandidates: 3,
  });

  assert.equal(candidates.schemaVersion, 1);
  assert.equal(candidates.provider, "blueprint-static");
  assert.deepEqual(candidates.providerCeiling, { maxCandidates: 3, maxEstimatedTokens: 8000 });
  assert.equal(candidates.candidates[0].layer, 3);
  assert.equal(candidates.candidates[0].sourceKind, "repo_code");
  assert.match(candidates.candidates[0].sourceHash, /^sha256:[a-f0-9]{64}$/);
});

test("graph status distinguishes missing, fresh, and stale generations", () => {
  const outDir = path.join(REPO, ".agent-test-graph");
  fs.rmSync(outDir, { recursive: true, force: true });

  assert.equal(graphStatus(REPO, outDir).state, "missing");
  const generation = buildGraphGeneration(REPO, { outDir });
  assert.equal(graphStatus(REPO, outDir).state, "fresh");

  const manifestPath = path.join(outDir, "graph", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.repo.sourceHash = "sha256:stale";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(graphStatus(REPO, outDir).state, "stale");

  fs.rmSync(outDir, { recursive: true, force: true });
  assert.equal(generation.manifest.complete, true);
});
