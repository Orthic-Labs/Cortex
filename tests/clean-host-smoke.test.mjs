import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildCandidate } from "../scripts/release/build-candidate.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SMOKE = fileURLToPath(new URL("../scripts/release/clean-host-smoke.mjs", import.meta.url));

function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = workflow.slice(start + 1).search(/\n  [a-z][\w-]*:\n/);
  return workflow.slice(start, end < 0 ? undefined : start + 1 + end);
}

test("clean-host harness is present as a release executable", () => {
  assert.ok(existsSync(SMOKE), "missing scripts/release/clean-host-smoke.mjs");
});

test("immutable release transfers candidate & keeps dry-run rehearsal reachable", () => {
  const immutable = readFileSync(join(ROOT, ".github", "workflows", "immutable-release.yml"), "utf8").replaceAll("\r\n", "\n");
  const legacy = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8").replaceAll("\r\n", "\n");
  const pkg = job(immutable, "package");
  const qualification = job(immutable, "qualification");
  const macos = job(immutable, "macos-sign-and-notarize");
  const windows = job(immutable, "windows-sign");
  const sbom = job(immutable, "sbom");
  const provenance = job(immutable, "provenance");
  const smoke = job(immutable, "clean-host-install");
  const publish = job(immutable, "publish-npm");
  assert.match(qualification, /needs:\s*\[test\]/);
  assert.match(pkg, /needs:\s*\[qualification\]/);
  assert.match(pkg, /actions\/upload-artifact@v4[\s\S]*cortex-candidate/);
  assert.match(sbom, /actions\/download-artifact@v4[\s\S]*cortex-candidate/);
  assert.match(sbom, /node scripts\/release\/sbom\.mjs release\/candidates\/ubuntu > release\/candidates\/ubuntu\/SBOM\.spdx\.json/);
  assert.match(smoke, /needs:\s*\[package, sbom\]/);
  assert.match(smoke, /actions\/download-artifact@v4[\s\S]*cortex-candidate/);
  assert.doesNotMatch(smoke, /macos-sign-and-notarize|windows-sign/);
  assert.match(macos, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(windows, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(provenance, /needs:\s*\[package, macos-sign-and-notarize, windows-sign, sbom\]/);
  assert.match(provenance, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(publish, /needs:\s*\[clean-host-install, provenance\]/);
  assert.match(publish, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.doesNotMatch(immutable, /NPM_TOKEN/);
  assert.match(legacy, /uses: \.\/\.github\/workflows\/immutable-release\.yml/);
  assert.doesNotMatch(legacy, /pnpm publish|npm publish|NPM_TOKEN/);
});

test("query evidence rejects an empty result set", async () => {
  const smoke = await import("../scripts/release/clean-host-smoke.mjs");
  assert.equal(typeof smoke.validateQueryEvidence, "function");
  if (typeof smoke.validateQueryEvidence === "function") assert.throws(() => smoke.validateQueryEvidence({ results: [] }), /releaseProof/);
});

test("clean-host rehearsal runs installed package stages", async () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-clean-host-candidate-"));
  try {
    buildCandidate({ out, allowDirty: true });
    const { runCleanHostSmoke } = await import("../scripts/release/clean-host-smoke.mjs");
    const report = await runCleanHostSmoke({ candidate: out });
    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.stages).sort(), ["init", "mcp", "query", "rollback", "uninstall", "updateApply", "updateCheck", "verify"].sort());
    assert.ok(Object.values(report.stages).every(Boolean));
    assert.ok(report.queryEvidence.matchCount > 0);
    assert.ok(report.queryEvidence.refs.length > 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
