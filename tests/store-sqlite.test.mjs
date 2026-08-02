import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SCHEMA_VERSION,
  openStore,
  closeStore,
  migrate,
  getSchemaVersion,
  bulkInsertGeneration,
  countRows,
  getFile,
  getSymbol,
  listSymbolsByPath,
  listEdges,
  blastRadius,
  upsertVectors,
  searchSimilar,
  searchGenerationSymbols,
  countVectors,
} from "../graph/store-sqlite.mjs";

function sampleGeneration() {
  return {
    manifest: { generationId: "gen-1" },
    nodes: [
      fileNode("a.ts", "h-a"),
      fileNode("b.ts", "h-b"),
      fileNode("c.ts", "h-c"),
      fileNode("d.ts", "h-d"),
      symNode("a.ts", "foo", ["Function"]),
      symNode("a.ts", "Widget.render", ["Method"]),
    ],
    edges: [
      importEdge("b.ts", "a.ts"),
      importEdge("c.ts", "b.ts"),
      importEdge("d.ts", "c.ts"),
      { id: "edge:CONTAINS:file:a.ts->symbol:a.ts::foo", kind: "CONTAINS", source: "file:a.ts", target: "symbol:a.ts::foo", confidence: 1, resolved: true, evidence: [] },
    ],
    fileReports: [
      { path: "a.ts", language: "typescript", provider: "blueprint-treesitter", parseStatus: "ok", errorNodeCount: 0 },
      { path: "b.ts", language: "typescript", provider: "blueprint-treesitter", parseStatus: "ok", errorNodeCount: 0 },
    ],
  };
}

function fileNode(path, hash) {
  return { id: `file:${path}`, kind: "file", labels: ["File"], name: path, qualifiedName: path, path, confidence: 1, evidence: [{ path, startLine: 1, endLine: 3, contentHash: hash }] };
}
function symNode(path, qualifiedName, labels) {
  return { id: `symbol:${path}::${qualifiedName}`, kind: "symbol", labels, name: qualifiedName.split(".").at(-1), qualifiedName, path, confidence: 1, evidence: [{ path, startLine: 1, endLine: 2, contentHash: "h" }] };
}
function importEdge(fromPath, toPath) {
  return { id: `edge:IMPORTS:file:${fromPath}->file:${toPath}`, kind: "IMPORTS", source: `file:${fromPath}`, target: `file:${toPath}`, confidence: 1, resolved: true, specifier: `./${toPath}`, evidence: [] };
}

test("openStore creates schema and migrate() is idempotent", () => {
  const db = openStore(":memory:");
  try {
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
    const before = countRows(db);
    assert.deepEqual(before, { files: 0, symbols: 0, edges: 0 });
    // Re-running migrate must not throw and must not change the version.
    const version = migrate(db);
    assert.equal(version, SCHEMA_VERSION);
    const search = db.prepare("SELECT sql FROM sqlite_master WHERE name='symbol_search'").get();
    assert.match(search.sql, /VIRTUAL TABLE symbol_search USING fts5\(id UNINDEXED, generation_id UNINDEXED, name, qualified_name, path\)/);
    const terms = db.prepare("SELECT sql FROM sqlite_master WHERE name='symbol_terms'").get();
    assert.match(terms.sql, /CREATE TABLE symbol_terms/);
  } finally {
    closeStore(db);
  }
});

test("bulk insert in a transaction round-trips files/symbols/edges exactly", () => {
  const db = openStore(":memory:");
  try {
    const generation = sampleGeneration();
    const result = bulkInsertGeneration(db, generation);
    assert.equal(result.generationId, "gen-1");
    assert.equal(result.fileCount, 4);
    assert.equal(result.symbolCount, 2);
    assert.equal(result.edgeCount, 4);

    const counts = countRows(db);
    assert.deepEqual(counts, { files: 4, symbols: 2, edges: 4 });

    const fileRow = getFile(db, "a.ts");
    assert.equal(fileRow.content_hash, "h-a");
    assert.equal(fileRow.language, "typescript");
    assert.equal(fileRow.parse_status, "ok");
    assert.equal(fileRow.generation_id, "gen-1");

    const symbolRow = getSymbol(db, "symbol:a.ts::foo");
    assert.deepEqual(symbolRow.labels, ["Function"]);
    assert.equal(symbolRow.qualifiedName, "foo");
    assert.equal(symbolRow.confidence, 1);
    assert.equal(symbolRow.generationId, "gen-1");

    const bySymbolPath = listSymbolsByPath(db, "a.ts");
    assert.equal(bySymbolPath.length, 2);

    const matched = searchGenerationSymbols(db, "gen-1", ["widget"], 4);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].qualifiedName, "Widget.render");
    assert.equal(matched[0].generationId, "gen-1");
    assert.match(matched[0].evidence, /a\.ts/);
    const fallback = searchGenerationSymbols(db, "gen-1", ["no_such_symbol"], 4);
    assert.equal(fallback.length, 2, "valid generation gets deterministic indexed fallback");
    assert.ok(db.prepare("SELECT 1 FROM symbol_terms WHERE generation_id='gen-1' AND token='*' LIMIT 1").get());

    const importEdges = listEdges(db, { kind: "IMPORTS" });
    assert.equal(importEdges.length, 3);
    assert.ok(importEdges.every((e) => e.generationId === "gen-1"));
  } finally {
    closeStore(db);
  }
});

test("bulkInsertGeneration mode:'replace' (default) clears prior rows; mode:'append' does not", () => {
  const db = openStore(":memory:");
  try {
    bulkInsertGeneration(db, sampleGeneration(), { generationId: "gen-1" });
    assert.equal(countRows(db).files, 4);

    // A second generation with the SAME row ids should replace, not accumulate.
    const gen2 = sampleGeneration();
    bulkInsertGeneration(db, gen2, { generationId: "gen-2", mode: "replace" });
    const counts = countRows(db);
    assert.equal(counts.files, 4, "replace mode must not accumulate duplicate rows across generations");
    assert.equal(getFile(db, "a.ts").generation_id, "gen-2");

    // append mode with disjoint ids DOES accumulate.
    const extra = { nodes: [fileNode("e.ts", "h-e")], edges: [], fileReports: [] };
    bulkInsertGeneration(db, extra, { generationId: "gen-2", mode: "append" });
    assert.equal(countRows(db).files, 5);
  } finally {
    closeStore(db);
  }
});

test("indexes exist on edges(source), edges(target), edges(kind)", () => {
  const db = openStore(":memory:");
  try {
    const rows = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'edges'").all();
    const names = rows.map((r) => r.name);
    assert.ok(names.some((n) => n.includes("source")));
    assert.ok(names.some((n) => n.includes("target")));
    assert.ok(names.some((n) => n.includes("kind")));
  } finally {
    closeStore(db);
  }
});

// ---------------------------------------------------------------------------
// Recursive-CTE blast radius — hand-built graph with a KNOWN expected answer.
//
// Chain: a.ts <- b.ts <- c.ts <- d.ts   (arrow = "imports", so an edge is
// stored as IMPORTS source=importer target=imported). Changing a.ts should
// transitively affect b.ts (depth 1), c.ts (depth 2), d.ts (depth 3) — i.e.
// walking "who points at this" backward from a.ts along IMPORTS edges.
// ---------------------------------------------------------------------------

test("blastRadius returns the exact transitive dependent set with correct depths", () => {
  const db = openStore(":memory:");
  try {
    bulkInsertGeneration(db, sampleGeneration());
    const radius = blastRadius(db, { changedNodeIds: ["file:a.ts"], maxDepth: 5 });
    const byId = new Map(radius.map((r) => [r.nodeId, r]));

    assert.equal(byId.size, 4, "expected a.ts (seed) + b.ts + c.ts + d.ts, nothing else");
    assert.equal(byId.get("file:a.ts").depth, 0);
    assert.equal(byId.get("file:a.ts").isSeed, true);
    assert.equal(byId.get("file:b.ts").depth, 1);
    assert.equal(byId.get("file:b.ts").isSeed, false);
    assert.equal(byId.get("file:c.ts").depth, 2);
    assert.equal(byId.get("file:d.ts").depth, 3);
  } finally {
    closeStore(db);
  }
});

test("blastRadius respects maxDepth (bounded traversal, not full closure)", () => {
  const db = openStore(":memory:");
  try {
    bulkInsertGeneration(db, sampleGeneration());
    const radius = blastRadius(db, { changedNodeIds: ["file:a.ts"], maxDepth: 1 });
    const ids = radius.map((r) => r.nodeId).sort();
    assert.deepEqual(ids, ["file:a.ts", "file:b.ts"]);
  } finally {
    closeStore(db);
  }
});

test("blastRadius handles diamond dependencies with correct MIN depth per node (not double-counted)", () => {
  const db = openStore(":memory:");
  try {
    // diamond: root <- left <- top, root <- right <- top
    const generation = {
      nodes: [fileNode("root.ts", "h1"), fileNode("left.ts", "h2"), fileNode("right.ts", "h3"), fileNode("top.ts", "h4")],
      edges: [
        importEdge("left.ts", "root.ts"),
        importEdge("right.ts", "root.ts"),
        importEdge("top.ts", "left.ts"),
        importEdge("top.ts", "right.ts"),
      ],
      fileReports: [],
    };
    bulkInsertGeneration(db, generation);
    const radius = blastRadius(db, { changedNodeIds: ["file:root.ts"], maxDepth: 10 });
    assert.equal(radius.length, 4, "top.ts must appear exactly once despite two paths reaching it");
    const top = radius.find((r) => r.nodeId === "file:top.ts");
    assert.equal(top.depth, 2, "top.ts is reachable at depth 2 via either path; MIN must win");
  } finally {
    closeStore(db);
  }
});

test("blastRadius on an empty changed set returns an empty array, not an error", () => {
  const db = openStore(":memory:");
  try {
    bulkInsertGeneration(db, sampleGeneration());
    assert.deepEqual(blastRadius(db, { changedNodeIds: [], maxDepth: 5 }), []);
  } finally {
    closeStore(db);
  }
});

test("blastRadius on a node with no dependents returns just the seed at depth 0", () => {
  const db = openStore(":memory:");
  try {
    bulkInsertGeneration(db, sampleGeneration());
    const radius = blastRadius(db, { changedNodeIds: ["file:d.ts"], maxDepth: 5 });
    assert.equal(radius.length, 1);
    assert.equal(radius[0].nodeId, "file:d.ts");
    assert.equal(radius[0].depth, 0);
  } finally {
    closeStore(db);
  }
});

test("store is regenerable: a fresh openStore on a new file has zero rows until populated", () => {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-store-sqlite-"));
  const dbPath = join(dir, "graph.sqlite");
  try {
    const db = openStore(dbPath);
    assert.deepEqual(countRows(db), { files: 0, symbols: 0, edges: 0 });
    bulkInsertGeneration(db, sampleGeneration());
    assert.equal(countRows(db).files, 4);
    closeStore(db);

    // Re-opening the same path picks up the persisted rows — proves it is a
    // real regenerable cache file, not an in-memory-only illusion.
    const reopened = openStore(dbPath);
    assert.equal(countRows(reopened).files, 4);
    closeStore(reopened);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- optional embedding layer -------------------------------------------------

test("searchSimilar on an empty vectors table returns [] rather than throwing", () => {
  const db = openStore(":memory:");
  try {
    migrate(db);
    assert.equal(countVectors(db), 0);
    const out = searchSimilar(db, [1, 0, 0]);
    assert.deepEqual(out.results, []);
    assert.equal(out.scanned, 0);
  } finally {
    closeStore(db);
  }
});

test("vectors round-trip through the BLOB exactly", () => {
  const db = openStore(":memory:");
  try {
    migrate(db);
    const v = Float32Array.from([0.5, -0.25, 0.125, 1]);
    upsertVectors(db, "gen-1", [{ nodeId: "symbol:a", vector: v }], { model: "test-model" });
    assert.equal(countVectors(db), 1);
    // An identical vector must score ~1.0, which only holds if the bytes — and the
    // BLOB's byteOffset — survived intact.
    const { results } = searchSimilar(db, v);
    assert.equal(results.length, 1);
    assert.equal(results[0].nodeId, "symbol:a");
    assert.ok(Math.abs(results[0].score - 1) < 1e-6, `expected ~1.0, got ${results[0].score}`);
    assert.equal(results[0].model, "test-model");
  } finally {
    closeStore(db);
  }
});

test("searchSimilar ranks by cosine with a known answer: identical > orthogonal > opposite", () => {
  const db = openStore(":memory:");
  try {
    migrate(db);
    upsertVectors(db, "gen-1", [
      { nodeId: "symbol:same", vector: [1, 0, 0] },
      { nodeId: "symbol:orthogonal", vector: [0, 1, 0] },
      { nodeId: "symbol:opposite", vector: [-1, 0, 0] },
    ]);
    const { results } = searchSimilar(db, [1, 0, 0]);
    assert.deepEqual(results.map((r) => r.nodeId), ["symbol:same", "symbol:orthogonal", "symbol:opposite"]);
    assert.ok(Math.abs(results[0].score - 1) < 1e-6);
    assert.ok(Math.abs(results[1].score - 0) < 1e-6);
    assert.ok(Math.abs(results[2].score + 1) < 1e-6);
  } finally {
    closeStore(db);
  }
});

test("a stored vector whose dim differs from the query is skipped, not wrongly compared", () => {
  const db = openStore(":memory:");
  try {
    migrate(db);
    upsertVectors(db, "gen-1", [
      { nodeId: "symbol:ok", vector: [1, 0, 0] },
      { nodeId: "symbol:wrongdim", vector: [1, 0, 0, 0, 0] },
    ]);
    const out = searchSimilar(db, [1, 0, 0]);
    assert.equal(out.dimMismatches, 1);
    assert.deepEqual(out.results.map((r) => r.nodeId), ["symbol:ok"]);
  } finally {
    closeStore(db);
  }
});

test("limit and minScore are both respected", () => {
  const db = openStore(":memory:");
  try {
    migrate(db);
    upsertVectors(db, "gen-1", [
      { nodeId: "symbol:a", vector: [1, 0] },
      { nodeId: "symbol:b", vector: [0.9, 0.1] },
      { nodeId: "symbol:c", vector: [0, 1] },
      { nodeId: "symbol:d", vector: [-1, 0] },
    ]);
    assert.equal(searchSimilar(db, [1, 0], { limit: 2 }).results.length, 2);
    const filtered = searchSimilar(db, [1, 0], { minScore: 0.5 }).results;
    assert.ok(filtered.every((r) => r.score >= 0.5), "minScore must exclude lower matches");
    assert.ok(!filtered.some((r) => r.nodeId === "symbol:d"), "opposite vector must be excluded");
  } finally {
    closeStore(db);
  }
});

test("upsertVectors replaces an existing node_id rather than duplicating it", () => {
  const db = openStore(":memory:");
  try {
    migrate(db);
    upsertVectors(db, "gen-1", [{ nodeId: "symbol:a", vector: [1, 0] }]);
    upsertVectors(db, "gen-2", [{ nodeId: "symbol:a", vector: [0, 1] }]);
    assert.equal(countVectors(db), 1);
    const { results } = searchSimilar(db, [0, 1]);
    assert.ok(Math.abs(results[0].score - 1) < 1e-6, "the newer vector must be the one stored");
  } finally {
    closeStore(db);
  }
});
