// D13: release candidate contract — unsigned artifacts only, checksummed,
// inventoried, and SBOM-backed; no publishing.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SCHEMA_VERSION } from "../graph/store-sqlite.mjs";
import { buildCandidate } from "../scripts/release/build-candidate.mjs";
import { verifyCandidate } from "../scripts/release/check-release.mjs";

const compatibilityFiles = ["compatibility.json", "compatibility.template.json"];

test("release store contracts match current runtime schema", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-schema-"));
  try {
    const candidate = buildCandidate({ out, allowDirty: true });
    assert.equal(candidate.compatibility.contracts.store, SCHEMA_VERSION);
    for (const file of compatibilityFiles) {
      const compatibility = JSON.parse(readFileSync(new URL(`../release/${file}`, import.meta.url), "utf8"));
      assert.equal(compatibility.contracts.store, SCHEMA_VERSION, file);
      assert.equal(compatibility.storeMigration.currentSchemaVersion, SCHEMA_VERSION, file);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("candidate build emits compatibility, checksums, SBOM, and catalog", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-"));
  try {
    const result = buildCandidate({ out, allowDirty: true });
    assert.ok(result.compatibility);
    assert.equal(result.compatibility.schemaVersion, 1);
    assert.equal(result.compatibility.product, "Orthic Cortex");
    assert.ok(result.compatibility.commit.length === 40);
    for (const file of ["compatibility.json", "checksums.txt", "SBOM.spdx.json", "artifact-catalog.json", "THIRD_PARTY_NOTICES"]) {
      assert.ok(existsSync(join(out, file)), `missing ${file}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("candidate inventories one installable npm tarball", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-tarball-"));
  try {
    const result = buildCandidate({ out, allowDirty: true });
    const tarballs = result.compatibility.artifacts.filter((artifact) => artifact.name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    assert.equal(result.compatibility.packageName, "@orthic-labs/cortex");
    assert.equal(result.compatibility.platform, `${process.platform}-${process.arch}`);
    assert.ok(existsSync(join(out, tarballs[0].name)));
    assert.equal(verifyCandidate(out).ok, true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("candidate verification rejects an unlisted extra file", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-extra-"));
  try {
    buildCandidate({ out, allowDirty: true });
    writeFileSync(join(out, "extra.bin"), "unexpected");
    assert.equal(verifyCandidate(out).ok, false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("candidate build rejects a nonempty output directory", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-nonempty-"));
  try {
    writeFileSync(join(out, "leftover.txt"), "leftover");
    assert.throws(() => buildCandidate({ out, allowDirty: true }), /empty output/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("candidate build rejects any repository output outside release candidates", () => {
  const out = join(import.meta.dirname, "candidate-output");
  try {
    rmSync(out, { recursive: true, force: true });
    assert.throws(() => buildCandidate({ out, allowDirty: true }), /release\/candidates/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("candidate verification rejects duplicate checksum names", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-duplicate-"));
  try {
    buildCandidate({ out, allowDirty: true });
    const checksums = join(out, "checksums.txt");
    writeFileSync(checksums, `${readFileSync(checksums, "utf8")}${readFileSync(checksums, "utf8").split("\n")[0]}\n`);
    assert.equal(verifyCandidate(out).ok, false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("candidate verification rejects a tarball symlink entry", (t) => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-tar-symlink-"));
  try {
    const candidate = buildCandidate({ out, allowDirty: true }), tarball = candidate.compatibility.artifacts.find((artifact) => artifact.name.endsWith(".tgz")).name;
    const stage = join(out, "tar-stage"); mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "package.json"), JSON.stringify({ name: candidate.compatibility.packageName, version: candidate.compatibility.version }));
    try { symlinkSync("elsewhere", join(stage, "package", "escape")); } catch { t.skip("symlink privilege unavailable"); return; }
    execFileSync("tar", ["-czf", join(out, tarball), "-C", stage, "package"]); rmSync(stage, { recursive: true, force: true });
    const hash = createHash("sha256").update(readFileSync(join(out, tarball))).digest("hex"), compatibility = JSON.parse(readFileSync(join(out, "compatibility.json"), "utf8"));
    compatibility.artifacts.find((artifact) => artifact.name === tarball).sha256 = hash;
    writeFileSync(join(out, "compatibility.json"), JSON.stringify(compatibility));
    writeFileSync(join(out, "checksums.txt"), readFileSync(join(out, "checksums.txt"), "utf8").replace(/^([a-f0-9]{64})(  .*\.tgz)$/m, `${hash}$2`));
    assert.equal(verifyCandidate(out).ok, false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("candidate verification passes for a fresh build", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-verify-"));
  try {
    buildCandidate({ out, allowDirty: true });
    const result = verifyCandidate(out);
    assert.equal(result.ok, true, result.problems?.join("; "));
    assert.ok(result.compatibility.artifacts.length > 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("candidate verification fails on a tampered checksum", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-tamper-"));
  try {
    buildCandidate({ out, allowDirty: true });
    const checksumsPath = join(out, "checksums.txt");
    const text = readFileSync(checksumsPath, "utf8");
    const tampered = text.replace(/^[a-f0-9]{64}/, `${"a".repeat(64)}`);
    writeFileSync(checksumsPath, tampered);
    const result = verifyCandidate(out);
    assert.equal(result.ok, false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("candidate build rejects a dirty tree", () => {
  // The worktree is dirty by design during dispatch; assert the guard fires.
  assert.throws(() => buildCandidate({ out: "/tmp/should-not-run" }), /clean working tree/);
});

test("candidate CLI accepts omitted optional version", () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-rc-cli-"));
  try {
    const script = join(import.meta.dirname, "..", "scripts", "release", "build-candidate.mjs");
    const result = spawnSync(process.execPath, [script, "--allow-dirty", "--platform", "current", "--out", out], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(verifyCandidate(out).ok, true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
