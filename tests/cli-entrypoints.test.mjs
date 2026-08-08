import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SOAK = join(ROOT, "scripts", "run-soak.mjs");
const FAULT_INJECT = join(ROOT, "scripts", "fault-inject.mjs");
const CHECK_RELEASE = join(ROOT, "scripts", "release", "check-release.mjs");
const SBOM = join(ROOT, "scripts", "release", "sbom.mjs");

test("soak CLI writes its requested report", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-soak-cli-"));
  const report = join(dir, "report.json");
  try {
    const result = spawnSync(process.execPath, [SOAK, "--seed", "1", "--duration-events", "3", "--repos", "1", "--report", report], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /soak report written to/);
    assert.ok(existsSync(report), "requested report exists");
    assert.equal(JSON.parse(readFileSync(report, "utf8")).schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fault injector CLI emits a report", () => {
  const result = spawnSync(process.execPath, [FAULT_INJECT, "--seed", "1", "--duration", "1", "--repos", "1"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(Array.isArray(JSON.parse(result.stdout).events));
});

test("SBOM CLI emits SPDX for a candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-sbom-cli-"));
  try {
    writeFileSync(join(dir, "compatibility.json"), JSON.stringify({ version: "0.0.0", commit: "deadbeef" }));
    const result = spawnSync(process.execPath, [SBOM, dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).spdxVersion, "SPDX-2.3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release check CLI reports a valid candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-release-cli-"));
  try {
    const tarball = "orthic-labs-cortex-0.0.0.tgz", files = { "SBOM.spdx.json": JSON.stringify({ spdxVersion: "SPDX-2.3" }), THIRD_PARTY_NOTICES: "fixture notices" };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    mkdirSync(join(dir, "package"));
    writeFileSync(join(dir, "package", "package.json"), JSON.stringify({ name: "@orthic-labs/cortex", version: "0.0.0" }));
    execFileSync("tar", ["-czf", join(dir, tarball), "-C", dir, "package"]);
    rmSync(join(dir, "package"), { recursive: true, force: true });
    const artifacts = [tarball, ...Object.keys(files)].map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") }));
    writeFileSync(join(dir, "compatibility.json"), JSON.stringify({ packageName: "@orthic-labs/cortex", version: "0.0.0", platform: `${process.platform}-${process.arch}`, artifacts }));
    writeFileSync(join(dir, "checksums.txt"), `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`);
    writeFileSync(join(dir, "artifact-catalog.json"), JSON.stringify({ version: "0.0.0", platform: `${process.platform}-${process.arch}`, files: artifacts.map((artifact) => artifact.name), checksums: "checksums.txt" }));
    const result = spawnSync(process.execPath, [CHECK_RELEASE, dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /check-release OK:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release check CLI rejects an incomplete candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-release-cli-"));
  try {
    const result = spawnSync(process.execPath, [CHECK_RELEASE, dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /check-release FAILED:/);
    assert.match(result.stderr, /missing compatibility\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
