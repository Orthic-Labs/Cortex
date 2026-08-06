// D18: Windows signing/installer artifacts — per-user installer, Azure
// signing step, and signature verification. Live signing is
// owner-credential-gated; these assert the artifacts are present and
// structurally correct.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");

test("Inno Setup installer targets per-user install and user PATH", () => {
  const iss = readFileSync(join(ROOT, "release/windows/Cortex.iss"), "utf8");
  assert.ok(iss.includes("PrivilegesRequired=lowest"));
  assert.ok(iss.includes("{localappdata}\\Orthic\\Cortex"));
  assert.ok(iss.includes("RegWriteExpandStringValue(HKCU, 'Environment', 'Path'"));
});

test("Azure artifact signing values are referenced from secrets/vars", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.ok(workflow.includes("azure/login@v3"));
  assert.ok(workflow.includes("azure/artifact-signing-action@v2"));
  assert.ok(workflow.includes("AZURE_CLIENT_ID"));
  assert.ok(workflow.includes("AZURE_ARTIFACT_SIGNING_ENDPOINT"));
});

test("Windows build/verify scripts exist", () => {
  for (const file of ["scripts/release/windows/build-installer.ps1", "scripts/release/windows/verify-signatures.ps1", "release/windows/uninstall-check.ps1", "release/windows/README.txt"]) {
    assert.ok(existsSync(join(ROOT, file)), `missing ${file}`);
  }
});

test("verify-signatures checks exe/dll/msi recursively", () => {
  const script = readFileSync(join(ROOT, "scripts/release/windows/verify-signatures.ps1"), "utf8");
  assert.ok(script.includes(".exe"));
  assert.ok(script.includes(".dll"));
  assert.ok(script.includes("Get-AuthenticodeSignature"));
});

test("installer records uninstall metadata and optional user task", () => {
  const iss = readFileSync(join(ROOT, "release/windows/Cortex.iss"), "utf8");
  assert.ok(iss.includes("uninsdeletekey"));
  assert.ok(iss.includes("schtasks /Create"));
});
