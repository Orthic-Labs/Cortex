// D16: update rollback — current↔previous with fixture stores.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backupStore, stageUpdate, applyStaged } from "../lib/update/apply.mjs";
import { rollback } from "../lib/update/rollback.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "cortex-rollback-"));
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, "app-v2"), { recursive: true });
  mkdirSync(join(root, ".agent", "graph"), { recursive: true });
  writeFileSync(join(root, "app", "version.txt"), "v1");
  writeFileSync(join(root, "app-v2", "version.txt"), "v2");
  writeFileSync(join(root, ".agent", "graph", "graph.db"), "sqlite-v1");
  return root;
}

test("apply then rollback restores the prior app version", () => {
  const root = fixtureRoot();
  try {
    const appDir = join(root, "app");
    const priorDir = join(root, "app-prior");
    const staging = stageUpdate({ fromDir: join(root, "app-v2"), toDir: appDir });
    const applied = applyStaged({ stagingDir: staging, appDir, priorDir });
    assert.equal(applied.applied, true);
    assert.equal(readFileSync(join(appDir, "version.txt"), "utf8"), "v2");
    assert.equal(readFileSync(join(priorDir, "version.txt"), "utf8"), "v1");

    const result = rollback({ appDir, priorDir, root });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(appDir, "version.txt"), "utf8"), "v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback with a store backup restores the database", () => {
  const root = fixtureRoot();
  try {
    const backup = backupStore(root);
    assert.equal(backup.backedUp, true);
    writeFileSync(join(root, ".agent", "graph", "graph.db"), "sqlite-v2");
    const result = rollback({ appDir: join(root, "app"), priorDir: join(root, "app"), storeBackup: backup.path, root });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(root, ".agent", "graph", "graph.db"), "utf8"), "sqlite-v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback fails when no prior version is retained", () => {
  const root = fixtureRoot();
  try {
    const result = rollback({ appDir: join(root, "app"), priorDir: join(root, "no-prior"), root });
    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one prior version is retained after apply", () => {
  const root = fixtureRoot();
  try {
    const appDir = join(root, "app");
    const priorDir = join(root, "app-prior");
    const staging = stageUpdate({ fromDir: join(root, "app-v2"), toDir: appDir });
    applyStaged({ stagingDir: staging, appDir, priorDir });
    // Applying again replaces prior with the previous current.
    const staging2 = stageUpdate({ fromDir: join(root, "app-v2"), toDir: appDir });
    applyStaged({ stagingDir: staging2, appDir, priorDir });
    assert.equal(readFileSync(join(priorDir, "version.txt"), "utf8"), "v2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
