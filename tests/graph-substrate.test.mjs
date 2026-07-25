import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  scanSourcesPublic,
} from "../graph/static-provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLUEPRINT = path.resolve(HERE, "..");
const REPO = path.join(BLUEPRINT, "evals/fixture-repos/typescript-commerce");

test("static graph substrate builds a complete generation with exact evidence", () => {
  const generation = buildGraphGeneration(REPO);

  assert.equal(generation.provider.id, "blueprint-static");
  assert.match(generation.manifest.generationId, /^xxh128:[a-f0-9]{32}$/);
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
  assert.match(candidates.candidates[0].sourceHash, /^xxh128:[a-f0-9]{32}$/);
});

test("graph status distinguishes missing, fresh, and stale generations", () => {
  const outDir = path.join(
    os.tmpdir(),
    `blueprint-status-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.rmSync(outDir, { recursive: true, force: true });

  assert.equal(graphStatus(REPO, outDir).state, "missing");
  const generation = buildGraphGeneration(REPO, { outDir });
  assert.equal(graphStatus(REPO, outDir).state, "fresh");

  const manifestPath = path.join(outDir, "graph", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.repo.sourceHash = "xxh128:stale";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(graphStatus(REPO, outDir).state, "stale");

  fs.rmSync(outDir, { recursive: true, force: true });
  assert.equal(generation.manifest.complete, true);
});

test("source scan reports directory-budget truncation", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-dir-cap-"));
  try {
    fs.mkdirSync(path.join(repo, "a"));
    fs.mkdirSync(path.join(repo, "b"));
    fs.writeFileSync(path.join(repo, "a", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repo, "b", "b.ts"), "export const b = 1;\n");

    const scan = scanSourcesPublic(repo, 0, { maxDirs: 1 });
    assert.equal(scan.traversalTruncated, true);
    assert.ok(scan.truncationReasons.includes("directory_limit"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("source scan excludes Git-ignored paths while preserving tracked files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-gitignore-"));
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    fs.writeFileSync(path.join(repo, ".gitignore"), [
      ".env",
      ".fastembed_cache/",
      ".gstack/",
      ".venv/",
      "generated/",
      "scratch-output/",
      "",
    ].join("\n"));
    for (const ignored of [
      ".env",
      ".fastembed_cache/model.bin",
      ".gstack/cache.ts",
      ".venv/site-packages/dependency.py",
      "scratch-output/leaked.ts",
    ]) {
      fs.mkdirSync(path.dirname(path.join(repo, ignored)), { recursive: true });
      fs.writeFileSync(path.join(repo, ignored), "ignored\n");
    }
    fs.mkdirSync(path.join(repo, "generated"), { recursive: true });
    fs.writeFileSync(path.join(repo, "generated/tracked.ts"), "export const tracked = true;\n");
    assert.equal(spawnSync("git", ["add", "-f", "generated/tracked.ts"], { cwd: repo }).status, 0);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src/legit.ts"), "export const legit = true;\n");
    assert.equal(spawnSync("git", ["add", "src/legit.ts"], { cwd: repo }).status, 0);
    // An untracked-but-unignored file: under the tracked-only portability contract
    // it must NOT enter the graph (the graph is a function of the commit, not the
    // working tree). It is surfaced via the dirty-tree warning instead.
    fs.writeFileSync(path.join(repo, "src/uncommitted.ts"), "export const wip = true;\n");

    const paths = scanSourcesPublic(repo).files.map((file) => file.path);

    assert.ok(paths.includes("src/legit.ts"));
    assert.ok(paths.includes("generated/tracked.ts"), "tracked files remain eligible even when an ignore rule matches");
    assert.ok(!paths.includes("src/uncommitted.ts"), "untracked files must be excluded from the tracked-only graph");
    for (const ignored of [
      ".env",
      ".fastembed_cache/model.bin",
      ".gstack/cache.ts",
      ".venv/site-packages/dependency.py",
      "scratch-output/leaked.ts",
    ]) {
      assert.ok(!paths.includes(ignored), `${ignored} must be excluded by Git ignore rules`);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("graph status is indeterminate when freshness traversal hits a directory cap", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-status-cap-"));
  const outDir = path.join(repo, ".agent");
  try {
    fs.mkdirSync(path.join(repo, "a"));
    fs.mkdirSync(path.join(repo, "b"));
    fs.writeFileSync(path.join(repo, "a", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repo, "b", "b.ts"), "export const b = 1;\n");
    buildGraphGeneration(repo, { outDir, maxDirs: 1 });

    const status = graphStatus(repo, outDir, { maxDirs: 1 });
    assert.equal(status.state, "indeterminate");
    assert.equal(status.scanTruncated, true);
    assert.ok(status.truncationReasons.includes("directory_limit"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("source scan bounds oversized directories and reports the skipped subtree", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-entry-cap-"));
  try {
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repo, "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(repo, "c.ts"), "export const c = 1;\n");

    const scan = scanSourcesPublic(repo, 0, { maxEntriesPerDir: 2 });
    assert.equal(scan.files.length, 0);
    assert.equal(scan.traversalTruncated, true);
    assert.ok(scan.truncationReasons.includes("directory_entry_limit"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("limited source scan selects paths deterministically in lexical order", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-order-"));
  try {
    for (const name of ["z", "a", "m"]) {
      fs.mkdirSync(path.join(repo, name));
      fs.writeFileSync(path.join(repo, name, `${name}.ts`), `export const ${name} = 1;\n`);
    }

    const scan = scanSourcesPublic(repo, 2);
    assert.deepEqual(scan.files.map((file) => file.path), ["a/a.ts", "m/m.ts"]);
    assert.equal(scan.fileLimitReached, true);
    assert.ok(scan.truncationReasons.includes("file_limit"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("limited source scan stops traversal after satisfying the file budget", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-early-stop-"));
  try {
    fs.mkdirSync(path.join(repo, "a"));
    fs.writeFileSync(path.join(repo, "a", "a.ts"), "export const a = 1;\n");
    fs.mkdirSync(path.join(repo, "z"));
    for (const name of ["one.ts", "two.ts", "three.ts"]) {
      fs.writeFileSync(path.join(repo, "z", name), `export const ${name.replace(".ts", "")} = 1;\n`);
    }

    const scan = scanSourcesPublic(repo, 1, { maxEntriesPerDir: 2 });
    assert.deepEqual(scan.files.map((file) => file.path), ["a/a.ts"]);
    assert.deepEqual(scan.truncationReasons, ["file_limit"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
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
      { id: "doc.arch", kind: "doc", path: "docs/ARCHITECTURE.md", sha1: "docsha", lifecycle: { status: "current" } },
      {
        id: "doc.old",
        kind: "doc",
        path: "docs/archive/OLD.md",
        sha1: "oldsha",
        lifecycle: { status: "superseded", supersededBy: "docs/ARCHITECTURE.md", supersededOn: "2026-07-13" },
      },
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
  assert.equal(truth.sourceDocMap.docs, 2);
  assert.ok(truth.joins.some((join) => join.kind === "supports" && join.target === "file:src/store.ts"));
  assert.ok(truth.joins.some((join) => join.kind === "contradicts" && join.evidence.docRef.line === 4));
  assert.ok(truth.joins.every((join) => join.confidenceClass && join.evidence.codeNode.contentHash === "abc123"));
  assert.ok(!truth.joins.some((join) => join.evidence.codeRef.path === "src/missing.ts"));
  assert.deepEqual(truth.supersedes, [{
    kind: "supersedes",
    source: { doc: "docs/ARCHITECTURE.md" },
    target: { doc: "docs/archive/OLD.md", supersededOn: "2026-07-13" },
    evidence: { sourceDoc: "docs/archive/OLD.md", targetMatch: "docs/ARCHITECTURE.md" },
  }]);
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
