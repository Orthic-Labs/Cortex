// D50: build N-2 / N-1 fixture stores for migration testing.
//
// SCHEMA_VERSION is 14 today; "read/migrate the previous two minor lines"
// means a store at schema v12 and a store at schema v13 must both migrate to
// the current line without data loss. SQLite stores are binary, so the
// fixtures are MATERIALISED BY THIS SCRIPT into a temp directory rather than
// committed as blobs: `node fixtures/stores/build-stores.mjs <outDir>` writes
// v13.db and v12.db, each seeded with one deterministic generation. Tests
// then open those files with openStore() (which migrates to the latest line)
// and assert every row survived.
//
// The seed is generated with the REAL saveGeneration() at a capped schema
// version (openStore upToVersion), so fixture stores are byte-identical to
// what a real past-version cortex would have written — not hand-rolled tables.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeStore, openStore, saveGeneration } from "../../graph/store-sqlite.mjs";

function fileNode(path, hash, language = "typescript") {
  return { id: `file:${path}`, kind: "file", name: path, path, labels: ["file"], language, confidence: 1, evidence: [{ contentHash: hash }] };
}

function symNode(path, name, kinds) {
  return { id: `symbol:${path}::${name}`, kind: kinds[0], name, qualifiedName: `${path}::${name}`, path, labels: kinds, confidence: 1, evidence: [] };
}

function seedGeneration(version) {
  // Version-tagged source so a mis-wired test cannot pass by accident: the
  // symbol names differ per version, and every assertion checks its own tag.
  const prefix = `v${version}`;
  return {
    schemaVersion: version,
    provider: { id: "cortex-treesitter", version: "9.9.9" },
    manifest: { generationId: `gen-${prefix}`, complete: true, repo: "fixture-stores" },
    repoRoot: "/fixture/stores",
    nodes: [
      fileNode("a.ts", `h-a-${prefix}`),
      fileNode("b.ts", `h-b-${prefix}`),
      symNode("a.ts", `${prefix}Alpha`, ["Function"]),
      symNode("b.ts", `${prefix}Beta`, ["Class"]),
    ],
    edges: [
      { id: `edge:${prefix}:import:b->a`, kind: "IMPORT", source: "file:b.ts", target: "file:a.ts", confidence: 1, resolved: true, evidence: [] },
    ],
    fileReports: [
      { path: "a.ts", language: "typescript", provider: "cortex-treesitter", parseStatus: "ok", errorNodeCount: 0 },
      { path: "b.ts", language: "typescript", provider: "cortex-treesitter", parseStatus: "ok", errorNodeCount: 0 },
    ],
  };
}

/**
 * Materialise the N-1 (13) and N-2 (12) fixture stores into `outDir`.
 * Returns the list of written store files. Deterministic: the same outDir
 * always yields the same seeds and schema versions.
 */
export function buildFixtureStores(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const versions = [13, 12];
  return versions.map((version) => {
    const dbPath = join(outDir, `v${version}.db`);
    rmSync(dbPath, { force: true });
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = dbPath + suffix;
      if (existsSync(sidecar)) rmSync(sidecar, { force: true });
    }
    const db = openStore(dbPath, { upToVersion: version });
    // mode:"append" — the replace-mode cleanup deletes the migration-14 docTruth
    // tables, which a v12/v13 store correctly does not have yet. Fixture stores
    // are seeded, not rebuilt over an existing generation.
    saveGeneration(db, seedGeneration(version), { mode: "append" });
    closeStore(db);
    return dbPath;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.url)) {
  const outDir = process.argv[2] ?? join(".", ".fixture-stores");
  for (const path of buildFixtureStores(outDir)) console.log(`fixture store ready: ${path}`);
}
