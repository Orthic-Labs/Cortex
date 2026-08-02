import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyFileDelta } from "../graph/delta-store.mjs";
import { stableRead } from "../graph/stable-read.mjs";
import { buildGraphGeneration, parseFileFacts, scanSourcesPublic } from "../graph/static-provider.mjs";
import { closeStore, getGenerationEnvelope, openStore, searchGenerationSymbols } from "../graph/store-sqlite.mjs";

const FIXTURE = join(import.meta.dirname, "..", "evals/fixture-repos/typescript-commerce");

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "cortex-delta-"));
  cpSync(FIXTURE, repo, { recursive: true });
  buildGraphGeneration(repo, { outDir: ".agent", persist: true });
  return repo;
}

function readDelta(repo, path, eventKind = "modify", renameTo = null) {
  const source = scanSourcesPublic(repo);
  const absPath = join(repo, renameTo ?? path);
  const read = eventKind === "delete" ? null : stableRead(absPath);
  const descriptor = read ? {
    absolutePath: absPath,
    path: renameTo ?? path,
    text: read.bytes.toString("utf8"),
    lines: read.bytes.toString("utf8").split(/\r?\n/),
    contentHash: read.contentDigest.replace(/^xxh128:/, ""),
    size: read.bytes.length,
  } : null;
  const files = (source.files ?? []).filter((file) => file.path !== path);
  if (descriptor) files.push(descriptor);
  return {
    eventKind,
    path,
    renameTo,
    parsed: descriptor ? parseFileFacts(repo, descriptor, { files }) : null,
    contentDigest: read?.contentDigest ?? null,
    fileIdentity: read?.fileIdentity ?? null,
    size: read?.bytes.length ?? 0,
    mtimeMs: read?.statAfter?.mtimeMs ?? null,
    provider: { id: "lexical", version: "repo-local-delta-v1" },
  };
}

function openDb(repo) { return openStore(join(repo, ".agent/graph/graph.db")); }

test("file edit replaces only owned facts and leaves unrelated rows unchanged", () => {
  const repo = makeRepo();
  const db = openDb(repo);
  try {
    const before = {
      file: db.prepare("SELECT * FROM files WHERE path='src/store.ts'").all(),
      symbols: db.prepare("SELECT * FROM symbols WHERE path='src/store.ts' ORDER BY rowid").all(),
      edges: db.prepare("SELECT * FROM edges WHERE source LIKE 'file:src/store.ts%' OR source LIKE 'symbol:src/store.ts%' ORDER BY rowid").all(),
    };
    writeFileSync(join(repo, "src/service.ts"), `${readFileSync(join(repo, "src/service.ts"), "utf8")}\nexport const changed = true;\n`);
    applyFileDelta(db, readDelta(repo, "src/service.ts"));
    assert.deepEqual({
      file: db.prepare("SELECT * FROM files WHERE path='src/store.ts'").all(),
      symbols: db.prepare("SELECT * FROM symbols WHERE path='src/store.ts' ORDER BY rowid").all(),
      edges: db.prepare("SELECT * FROM edges WHERE source LIKE 'file:src/store.ts%' OR source LIKE 'symbol:src/store.ts%' ORDER BY rowid").all(),
    }, before);
  } finally { closeStore(db); rmSync(repo, { recursive: true, force: true }); }
});

test("structural delta reindexes symbols under its resealed generation", () => {
  const repo = makeRepo();
  const db = openDb(repo);
  try {
    writeFileSync(join(repo, "src/service.ts"), `${readFileSync(join(repo, "src/service.ts"), "utf8")}\nexport const deltaSearchNeedle = true;\n`);
    applyFileDelta(db, readDelta(repo, "src/service.ts"));
    const generationId = getGenerationEnvelope(db)?.manifest?.generationId;
    const rows = searchGenerationSymbols(db, generationId, ["needle"], 4);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "deltaSearchNeedle");
    assert.equal(rows[0].generationId, generationId);
  } finally { closeStore(db); rmSync(repo, { recursive: true, force: true }); }
});

test("semantic-domain ownership survives structural refresh", () => {
  const repo = makeRepo();
  const db = openDb(repo);
  try {
    db.prepare("INSERT INTO fact_owner(fact_id, fact_kind, source_path, source_digest, provider_id, provider_version, freshness_domain, fact_kind_detail) VALUES (?, 'node', ?, ?, 'phase2', 'v1', 'semantic', 'verdict')").run("semantic:service", "src/service.ts", "xxh128:semantic");
    const before = db.prepare("SELECT * FROM fact_owner WHERE fact_id='semantic:service'").get();
    writeFileSync(join(repo, "src/service.ts"), `${readFileSync(join(repo, "src/service.ts"), "utf8")}\nexport const structuralRefresh = true;\n`);
    applyFileDelta(db, readDelta(repo, "src/service.ts"));
    assert.deepEqual(db.prepare("SELECT * FROM fact_owner WHERE fact_id='semantic:service'").get(), before);
  } finally { closeStore(db); rmSync(repo, { recursive: true, force: true }); }
});

test("delete removes owned facts and marks inbound Synapses unresolved", () => {
  const repo = makeRepo();
  const db = openDb(repo);
  try {
    const inbound = db.prepare("SELECT id FROM edges WHERE source='file:src/routes.ts' AND target='file:src/service.ts'").get();
    const symbolIds = db.prepare("SELECT id FROM symbols WHERE path='src/service.ts'").all().map((row) => row.id);
    assert.ok(inbound);
    applyFileDelta(db, readDelta(repo, "src/service.ts", "delete"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path='src/service.ts'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fact_owner WHERE source_path='src/service.ts'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM symbol_terms WHERE symbol_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(symbolIds)).n, 0);
    assert.equal(db.prepare("SELECT resolved FROM edges WHERE id=?").get(inbound.id).resolved, 0);
  } finally { closeStore(db); rmSync(repo, { recursive: true, force: true }); }
});

test("same-bytes delta is a no-op", () => {
  const repo = makeRepo();
  const db = openDb(repo);
  try {
    const before = db.prepare("SELECT value FROM generation WHERE key='manifest'").get().value;
    const result = applyFileDelta(db, readDelta(repo, "src/service.ts"));
    assert.equal(result.noop, true);
    assert.equal(db.prepare("SELECT value FROM generation WHERE key='manifest'").get().value, before);
  } finally { closeStore(db); rmSync(repo, { recursive: true, force: true }); }
});

test("rename removes old path and leaves inbound edge unresolved until repair", () => {
  const repo = makeRepo();
  const db = openDb(repo);
  try {
    const oldPath = join(repo, "src/service.ts");
    const newPath = join(repo, "src/service-renamed.ts");
    const contents = readFileSync(oldPath, "utf8");
    rmSync(oldPath);
    writeFileSync(newPath, contents);
    const result = applyFileDelta(db, readDelta(repo, "src/service.ts", "rename", "src/service-renamed.ts"));
    assert.equal(result.applied, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path='src/service.ts'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path='src/service-renamed.ts'").get().n, 1);
    const edge = db.prepare("SELECT resolved FROM edges WHERE source='file:src/routes.ts' AND target='file:src/service.ts'").get();
    assert.equal(edge.resolved, 0);
  } finally { closeStore(db); rmSync(repo, { recursive: true, force: true }); }
});

test("injected delta failure rolls back all rows", () => {
  const repo = makeRepo();
  const db = openDb(repo);
  try {
    const before = db.prepare("SELECT path, content_hash FROM files ORDER BY path").all();
    writeFileSync(join(repo, "src/service.ts"), `${readFileSync(join(repo, "src/service.ts"), "utf8")}\nexport const rollbackProbe = true;\n`);
    const original = db.prepare.bind(db);
    let injected = false;
    db.prepare = (sql, ...params) => {
      if (!injected && String(sql).includes("INSERT INTO symbols")) { injected = true; throw new Error("injected delta failure"); }
      return original(sql, ...params);
    };
    assert.throws(() => applyFileDelta(db, readDelta(repo, "src/service.ts")), /injected delta failure/);
    db.prepare = original;
    assert.deepEqual(db.prepare("SELECT path, content_hash FROM files ORDER BY path").all(), before);
  } finally { closeStore(db); rmSync(repo, { recursive: true, force: true }); }
});
