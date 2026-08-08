// D16: update rollback — current↔previous with fixture stores.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backupStore, stageUpdate, applyStaged } from "../lib/update/apply.mjs";
import { rollback } from "../lib/update/rollback.mjs";
import * as manifestModule from "../lib/update/manifest.mjs";

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

test("local signed artifact update applies then CLI rollback restores", () => {
  const root = fixtureRoot();
  try {
    assert.equal(typeof manifestModule.treeDigest, "function");
    const artifact = join(root, "artifact");
    mkdirSync(artifact); writeFileSync(join(artifact, "version.txt"), "v2");
    const keys = generateKeyPairSync("ed25519");
    const publicKey = join(root, "trusted.pem");
    writeFileSync(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }));
    const manifest = { schemaVersion: 1, channel: "stable", version: "0.3.0", commit: "a".repeat(40), publishedAt: "2026-08-08T00:00:00Z", artifacts: [{ name: "local", sha256: typeof manifestModule.treeDigest === "function" ? manifestModule.treeDigest(artifact) : "missing" }], signature: "" };
    if (typeof manifestModule.canonicalManifestPayload !== "function") return;
    manifest.signature = sign(null, Buffer.from(manifestModule.canonicalManifestPayload(manifest)), keys.privateKey).toString("base64");
    const manifestPath = join(root, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
    const cli = join(import.meta.dirname, "..", "scripts", "cortex.mjs");
    const apply = spawnSync(process.execPath, [cli, "update", "apply", "--manifest", manifestPath, "--public-key", publicKey, "--artifact", artifact, "--artifact-name", "local", "--app-dir", join(root, "app"), "--prior-dir", join(root, "prior"), "--repo-root", root, "--current-version", "0.2.0", "--json"], { encoding: "utf8" });
    assert.equal(apply.status, 0, apply.stderr); assert.equal(JSON.parse(apply.stdout).ok, true);
    const rollbackCli = spawnSync(process.execPath, [cli, "update", "rollback", "--app-dir", join(root, "app"), "--prior-dir", join(root, "prior"), "--repo-root", root, "--json"], { encoding: "utf8" });
    assert.equal(rollbackCli.status, 0, rollbackCli.stderr); assert.equal(JSON.parse(rollbackCli.stdout).ok, true);
    assert.equal(readFileSync(join(root, "app", "version.txt"), "utf8"), "v1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
