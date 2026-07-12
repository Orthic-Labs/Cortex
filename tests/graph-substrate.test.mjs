import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDocCodeJoins,
  buildGraphGeneration,
  createContextCandidateSet,
  graphMermaid,
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

test("doc-code truth joins are typed and evidence-backed without polluting graph edges", () => {
  const generation = {
    schemaVersion: 1,
    provider: { id: "blueprint-static" },
    nodes: [
      {
        id: "file:src/store.ts",
        kind: "file",
        path: "src/store.ts",
        evidence: [{ path: "src/store.ts", startLine: 1, endLine: 10, contentHash: "abc123" }],
      },
    ],
    edges: [],
  };
  const docMap = {
    generatedAt: "2026-07-12T00:00:00.000Z",
    nodes: [
      { id: "doc.arch", kind: "doc", path: "docs/ARCHITECTURE.md", sha1: "docsha" },
      { id: "claim.ok", kind: "claim", source: "docs/ARCHITECTURE.md", line: 3, text: "Implemented by `src/store.ts`.", status: "implemented" },
      { id: "claim.stale", kind: "claim", source: "docs/ARCHITECTURE.md", line: 4, text: "Stale Redis persistence claim for `src/store.ts`.", status: "stale" },
      { id: "claim.future", kind: "claim", source: "docs/ARCHITECTURE.md", line: 5, text: "Planned future store.", status: "planned" },
      { id: "code.store", kind: "code_ref", path: "src/store.ts", exists: true },
      { id: "code.missing", kind: "code_ref", path: "src/missing.ts", exists: false },
    ],
    edges: [
      { from: "doc.arch", to: "claim.ok", type: "contains" },
      { from: "doc.arch", to: "claim.stale", type: "contains" },
      { from: "doc.arch", to: "claim.future", type: "contains" },
      { from: "doc.arch", to: "code.store", type: "mentions-code" },
      { from: "doc.arch", to: "code.missing", type: "mentions-code" },
    ],
  };

  const truth = buildDocCodeJoins(generation, { docMap });
  assert.equal(truth.sourceDocMap.docs, 1);
  assert.ok(truth.joins.some((join) => join.kind === "supports" && join.target === "file:src/store.ts"));
  assert.ok(truth.joins.some((join) => join.kind === "contradicts" && join.evidence.docRef.line === 4));
  assert.ok(truth.joins.every((join) => join.confidenceClass && join.evidence.codeNode.contentHash === "abc123"));
  assert.ok(!truth.joins.some((join) => join.evidence.codeRef.path === "src/missing.ts"));
  assert.deepEqual(generation.edges, []);
});

test("static graph mermaid output is bounded and deterministic", () => {
  const generation = buildGraphGeneration(REPO);
  const mermaid = graphMermaid(generation, { view: "neighbors", nodeId: "symbol:src/service.ts::OrderService.placeOrder", limit: 6 });

  assert.match(mermaid, /^flowchart LR/);
  assert.match(mermaid, /%% provider: blueprint-static/);
  assert.match(mermaid, /OrderService\.placeOrder/);
  assert.ok(mermaid.split("\n").filter((line) => /^\s+n\d+\["/.test(line)).length <= 6);
});
