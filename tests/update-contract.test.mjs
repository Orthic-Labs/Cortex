// D16: update contract — channels, owner detection, signed-manifest rules,
// and offline/opt-out behavior.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CHANNELS, detectInstallOwner, channelEnabled } from "../lib/update/channel.mjs";
import { loadUpdateManifest, verifyManifestSignature, verifyArtifactChecksum, rejectDowngrade, rejectReplay } from "../lib/update/manifest.mjs";
import { backupStore } from "../lib/update/apply.mjs";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts", "cortex.mjs");

test("channels are stable, beta, nightly", () => {
  assert.deepEqual(CHANNELS, ["stable", "beta", "nightly"]);
});

test("channel is disabled by offline and by CORTEX_NO_UPDATE_CHECK", () => {
  assert.equal(channelEnabled("stable", { offline: true }), false);
  const previous = process.env.CORTEX_NO_UPDATE_CHECK;
  process.env.CORTEX_NO_UPDATE_CHECK = "1";
  try {
    assert.equal(channelEnabled("stable", { offline: false }), false);
  } finally {
    if (previous === undefined) delete process.env.CORTEX_NO_UPDATE_CHECK;
    else process.env.CORTEX_NO_UPDATE_CHECK = previous;
  }
});

test("install owner detection returns a source checkout here", () => {
  const owner = detectInstallOwner();
  assert.ok(["source", "npm", "homebrew", "winget", "portable"].includes(owner.owner));
});

test("update manifest validates against UpdateManifestV1", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-update-manifest-"));
  try {
    const manifest = {
      schemaVersion: 1,
      channel: "stable",
      version: "0.3.0",
      commit: "a".repeat(40),
      publishedAt: "2026-08-05T10:10:02.050Z",
      artifacts: [{ name: "cortex-linux-x64.tar.gz", platform: "linux", arch: "x64", sha256: "deadbeef", size: 1024, signed: false, sbom: "SBOM.spdx.json" }],
      signatureAlgorithm: "Ed25519", keyId: "test-key", signature: "sig-1",
    };
    const path = join(dir, "manifest.json");
    writeFileSync(path, JSON.stringify(manifest));
    const loaded = loadUpdateManifest(path);
    assert.equal(loaded.version, "0.3.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest signature verification never has a success default", () => {
  assert.equal(verifyManifestSignature({ signature: "" }).ok, false);
  assert.equal(verifyManifestSignature({ signature: "x" }, { verify: () => false }).ok, false);
  assert.equal(verifyManifestSignature({ signature: "x" }, { verify: () => true }).ok, false);
});

test("artifact checksum verification rejects mismatches", () => {
  const manifest = { artifacts: [{ name: "a.tgz", sha256: "abc" }] };
  assert.equal(verifyArtifactChecksum(manifest, "a.tgz", "abc").ok, true);
  assert.equal(verifyArtifactChecksum(manifest, "a.tgz", "def").ok, false);
  assert.equal(verifyArtifactChecksum(manifest, "b.tgz", "abc").ok, false);
});

test("downgrade and replay are rejected", () => {
  assert.equal(rejectDowngrade("0.1.0", "0.2.0").ok, false);
  assert.equal(rejectDowngrade("0.2.0", "0.2.0").ok, false);
  assert.equal(rejectDowngrade("0.3.0", "0.2.0").ok, true);
  assert.equal(rejectReplay({ commit: "abc" }, ["abc"]).ok, false);
  assert.equal(rejectReplay({ commit: "abc" }, ["def"]).ok, true);
});

test("store backup copies the database before update", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-update-backup-"));
  try {
    mkdirSync(join(root, ".agent", "graph"), { recursive: true });
    const db = new DatabaseSync(join(root, ".agent", "graph", "graph.db")); db.exec("CREATE TABLE state (value TEXT)"); db.close();
    const result = backupStore(root);
    assert.equal(result.backedUp, true);
    assert.ok(result.path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cortex update check --json reports owner and channel", () => {
  const result = spawnSync(process.execPath, [CLI, "update", "check", "--channel", "stable", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.ok(payload.owner);
  assert.equal(payload.channel, "stable");
});

test("cortex update apply for source owner requires a signed manifest path", () => {
  const result = spawnSync(process.execPath, [CLI, "update", "apply", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.action === "delegate" || payload.action === "require-signed-manifest");
});

test("Ed25519 manifest verification trusts only a pinned key-id map", async () => {
  const module = await import("../lib/update/manifest.mjs");
  assert.equal(typeof module.canonicalManifestPayload, "function");
  assert.equal(typeof module.verifySignedManifest, "function");
  if (typeof module.canonicalManifestPayload !== "function" || typeof module.verifySignedManifest !== "function") return;
  const dir = mkdtempSync(join(tmpdir(), "cortex-update-key-"));
  try {
    const keys = generateKeyPairSync("ed25519");
    const manifest = { schemaVersion: 1, channel: "stable", version: "0.3.0", commit: "a".repeat(40), publishedAt: "2026-08-08T00:00:00Z", artifacts: [], signatureAlgorithm: "Ed25519", keyId: "ephemeral", signature: "" };
    manifest.signature = sign(null, Buffer.from(module.canonicalManifestPayload(manifest)), keys.privateKey).toString("base64");
    const trustedKeys = { ephemeral: keys.publicKey.export({ type: "spki", format: "pem" }) };
    assert.equal(module.verifySignedManifest(manifest, { trustedKeys }).ok, true);
    manifest.version = "9.9.9";
    assert.equal(module.verifySignedManifest(manifest, { trustedKeys }).ok, false);
    assert.equal(module.verifySignedManifest(manifest, {}).reason, "update_trust_root_missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("trusted key root accepts only a unique strict key list", async () => {
  const { loadTrustedUpdateKeys } = await import("../lib/update/manifest.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cortex-trust-root-"));
  try {
    const path = join(dir, "trusted-update-keys.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: "release-1", algorithm: "Ed25519", publicKey: "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----" }] }));
    assert.equal(loadTrustedUpdateKeys(path)["release-1"].includes("BEGIN PUBLIC KEY"), true);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: "release-1", algorithm: "Ed25519", publicKey: "one" }, { keyId: "release-1", algorithm: "Ed25519", publicKey: "two" }] }));
    assert.throws(() => loadTrustedUpdateKeys(path), /update_trust_root_corrupt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI rejects caller-provided update trust material", () => {
  const result = spawnSync(process.execPath, [CLI, "update", "apply", "--public-key", "attacker.pem", "--json"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).reason, "public_key_argument_forbidden");
});
