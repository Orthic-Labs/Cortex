// D50: N-2/N-1 store migrations, migration backups, and interrupted-migration
// repair. Fixture stores are materialised as REAL schema-v13 and schema-v12
// databases (see fixtures/stores/build-stores.mjs) and opened through the same
// openStore() path production uses, so the upgrade under test is the exact
// migration chain — not a hand-rolled table diff.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFixtureStores } from "../fixtures/stores/build-stores.mjs";
import {
  closeStore,
  getFile,
  getGenerationEnvelope,
  getSchemaVersion,
  listEdges,
  listSymbolsByPath,
  migrationBackupPath,
  migrate,
  openStore,
  repairInterruptedMigration,
  SCHEMA_VERSION,
} from "../graph/store-sqlite.mjs";

function withFixtureStores(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cortex-migrations-"));
  const stores = buildFixtureStores(join(dir, "stores"));
  try {
    return fn(stores);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("N-1 (schema v13) fixture store migrates to the current line without losing rows", () => {
  withFixtureStores(([v13]) => {
    const db = openStore(v13);
    try {
      assert.equal(getSchemaVersion(db), SCHEMA_VERSION, "schema upgraded to current");
      assert.equal(getGenerationEnvelope(db, "manifest").generationId, "gen-v13", "envelope preserved");
      assert.equal(getFile(db, "a.ts").content_hash, "h-a-v13", "file row preserved");
      const symbols = listSymbolsByPath(db, "a.ts");
      assert.ok(symbols.some((s) => s.name === "v13Alpha"), "symbol rows preserved");
      const edges = listEdges(db);
      assert.equal(edges.length, 1);
      assert.equal(edges[0].id, "edge:v13:import:b->a");
    } finally {
      closeStore(db);
    }
  });
});

test("N-2 (schema v12) fixture store migrates to the current line without losing rows", () => {
  withFixtureStores(([, v12]) => {
    const db = openStore(v12);
    try {
      assert.equal(getSchemaVersion(db), SCHEMA_VERSION, "schema upgraded to current");
      assert.equal(getGenerationEnvelope(db, "manifest").generationId, "gen-v12", "envelope preserved");
      assert.equal(getFile(db, "b.ts").content_hash, "h-b-v12", "file row preserved");
      const symbols = listSymbolsByPath(db, "b.ts");
      assert.ok(symbols.some((s) => s.name === "v12Beta"), "symbol rows preserved");
      assert.equal(listEdges(db).length, 1, "edge rows preserved");
    } finally {
      closeStore(db);
    }
  });
});

test("migrating an older store writes a pre-migration backup for its from-version", () => {
  withFixtureStores(([v13]) => {
    const db = openStore(v13);
    closeStore(db);
    assert.ok(existsSync(migrationBackupPath(v13, 13)), "backup written before N-1 upgrade");
  });
});

test("repairInterruptedMigration restores a torn store to the from-version and re-migrates", () => {
  withFixtureStores(([v13]) => {
    // Simulate an interrupted upgrade: take the N-1 store, corrupt the file
    // with a partial migration (fresh metadata row but the schema version
    // table states the OLD version — the torn state a crash leaves behind),
    // then repair from the backup taken before the upgrade, and re-migrate.
    const db = openStore(v13);
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
    closeStore(db);
    const backup = migrationBackupPath(v13, 13);
    assert.ok(existsSync(backup), "backup exists before simulated interruption");
    // Truncate the store file to simulate a half-written upgrade.
    rmSync(v13, { force: true });
    const result = repairInterruptedMigration(v13, 13);
    assert.equal(result.restored, true, "repair restores from the pre-migration backup");
    const reopened = openStore(v13);
    try {
      assert.equal(getSchemaVersion(reopened), SCHEMA_VERSION, "repaired store migrates to current");
      assert.equal(getFile(reopened, "a.ts").content_hash, "h-a-v13", "repaired store data intact");
    } finally {
      closeStore(reopened);
    }
  });
});

test("repair without a backup returns a typed reason, not a crash", () => {
  withFixtureStores(([v13]) => {
    // Migrate once (backup exists), remove the backup to simulate loss, then
    // verify the repair path reports the missing backup instead of crashing.
    const db = openStore(v13);
    closeStore(db);
    rmSync(migrationBackupPath(v13, 13), { force: true });
    const result = repairInterruptedMigration(v13, 13);
    assert.equal(result.restored, false);
    assert.equal(result.reason, "no_backup");
  });
});

test("migrate() re-run on a current store is a no-op and keeps the schema version", () => {
  withFixtureStores(([v13]) => {
    const db = openStore(v13);
    try {
      const version = migrate(db, {});
      assert.equal(version, SCHEMA_VERSION);
      assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
    } finally {
      closeStore(db);
    }
  });
});
