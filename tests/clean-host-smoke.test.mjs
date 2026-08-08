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
  const nativeGate = job(immutable, "native-clean-host-owner-gate");
  const sbom = job(immutable, "sbom");
  const rehearsal = job(immutable, "verify-dry-run-receipt");
  const provenance = job(immutable, "provenance");
  const smoke = job(immutable, "clean-host-install");
  const publish = job(immutable, "publish-npm");
  const header = immutable.slice(0, immutable.indexOf("\njobs:"));
  assert.match(header, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(header, /id-token|attestations|artifact-metadata/);
  assert.match(qualification, /needs:\s*\[test\]/);
  assert.match(pkg, /needs:\s*\[qualification\]/);
  assert.match(pkg, /build-candidate\.mjs --version "\$\{\{ inputs\.version \}\}" --platform current/);
  assert.match(pkg, /actions\/upload-artifact@v4[\s\S]*cortex-candidate/);
  assert.match(sbom, /actions\/download-artifact@v4[\s\S]*cortex-candidate/);
  assert.match(sbom, /node scripts\/release\/check-release\.mjs release\/candidates\/ubuntu/);
  assert.match(sbom, /sha256sum "\$\{\{ needs\.package\.outputs\.tarball \}\}"/);
  assert.match(sbom, /node scripts\/release\/sbom\.mjs release\/candidates\/ubuntu > "\$RUNNER_TEMP\/SBOM\.spdx\.json"/);
  assert.match(provenance, /name: cortex-sbom[\s\S]*path: \$\{\{ runner\.temp \}\}\/cortex-sbom/);
  assert.match(smoke, /needs:\s*\[package, sbom\]/);
  assert.match(smoke, /cortex-clean-host-receipt/);
  assert.match(rehearsal, /needs:\s*\[package\]/);
  assert.match(rehearsal, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(rehearsal, /actions: read/);
  assert.match(rehearsal, /gh api "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$RUN"/);
  assert.match(macos, /needs:\s*\[package, verify-dry-run-receipt\]/);
  assert.match(windows, /needs:\s*\[package, verify-dry-run-receipt\]/);
  assert.match(nativeGate, /needs:\s*\[macos-sign-and-notarize, windows-sign\]/);
  assert.match(nativeGate, /native_clean_host_owner_gate_missing_D17_D18_receipt/);
  assert.match(smoke, /actions\/download-artifact@v4[\s\S]*cortex-candidate/);
  assert.doesNotMatch(smoke, /macos-sign-and-notarize|windows-sign/);
  assert.match(macos, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(windows, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(provenance, /needs:\s*\[package, macos-sign-and-notarize, windows-sign, sbom, native-clean-host-owner-gate\]/);
  assert.match(provenance, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(provenance, /subject-path: \$\{\{ needs\.package\.outputs\.tarball \}\}/);
  assert.match(provenance, /node scripts\/release\/check-release\.mjs release\/candidates\/ubuntu/);
  assert.match(provenance, /sha256sum "\$\{\{ needs\.package\.outputs\.tarball \}\}"/);
  assert.match(provenance, /subject-path: \$\{\{ runner\.temp \}\}\/cortex-sbom\/SBOM\.spdx\.json/);
  assert.match(publish, /needs:\s*\[clean-host-install, provenance\]/);
  assert.match(publish, /if: \$\{\{ inputs\.dry_run != 'true' \}\}/);
  assert.match(publish, /npm publish "\$\{\{ needs\.package\.outputs\.tarball \}\}" --provenance --access public/);
  assert.match(publish, /node scripts\/release\/check-release\.mjs release\/candidates\/ubuntu/);
  assert.match(publish, /sha256sum "\$\{\{ needs\.package\.outputs\.tarball \}\}"/);
  assert.match(macos, /permissions:[\s\S]*id-token: write/);
  assert.match(windows, /permissions:[\s\S]*id-token: write/);
  assert.doesNotMatch(immutable, /NPM_TOKEN/);
  assert.match(legacy, /uses: \.\/\.github\/workflows\/immutable-release\.yml/);
  assert.doesNotMatch(legacy, /secrets: inherit/);
  assert.match(legacy, /APPLE_TEAM_ID: \$\{\{ secrets\.APPLE_TEAM_ID \}\}/);
  assert.doesNotMatch(legacy, /pnpm publish|npm publish|NPM_TOKEN/);
});

test("query evidence rejects an empty result set", async () => {
  const smoke = await import("../scripts/release/clean-host-smoke.mjs");
  assert.equal(typeof smoke.validateQueryEvidence, "function");
  assert.equal(typeof smoke.parseInitializeResponse, "function");
  if (typeof smoke.validateQueryEvidence === "function") {
    assert.throws(() => smoke.validateQueryEvidence({ results: [] }), /releaseProof/);
    assert.throws(() => smoke.validateQueryEvidence({ results: [{ id: "releaseProof", payload: {} }] }), /releaseProof/);
  }
  if (typeof smoke.parseInitializeResponse === "function") {
    assert.deepEqual(smoke.parseInitializeResponse('{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"cortex"}}}\n').serverInfo.name, "cortex");
    assert.throws(() => smoke.parseInitializeResponse('{"jsonrpc":"2.0","id":2,"result":{"serverInfo":{}}}\n'), /initialize/);
  }
});

test("clean-host rehearsal runs installed package stages", async () => {
  const out = mkdtempSync(join(tmpdir(), "cortex-clean-host-candidate-"));
  try {
    buildCandidate({ out, allowDirty: true });
    const { runCleanHostSmoke } = await import("../scripts/release/clean-host-smoke.mjs");
    const report = await runCleanHostSmoke({ candidate: out });
    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.stages).sort(), ["init", "mcp", "query", "rollback", "uninstall", "updateApply", "updateCheck", "updateTrustMissing", "verify"].sort());
    assert.ok(Object.values(report.stages).every(Boolean));
    assert.ok(report.queryEvidence.matchCount > 0);
    assert.ok(report.queryEvidence.refs.length > 0);
    assert.deepEqual(report.storeEvidence, { before: "before", after: "after", restored: "before" });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
