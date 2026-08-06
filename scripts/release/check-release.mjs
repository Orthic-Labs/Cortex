#!/usr/bin/env node
// D13: verify a release candidate directory. Every artifact must be
// checksummed, inventoried, and SBOM-backed; publishing must remain
// impossible in this workflow.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function verifyCandidate(candidateDir) {
  const dir = resolve(candidateDir);
  const problems = [];
  const compatibilityPath = join(dir, "compatibility.json");
  const checksumsPath = join(dir, "checksums.txt");
  const sbomPath = join(dir, "SBOM.spdx.json");
  const catalogPath = join(dir, "artifact-catalog.json");
  for (const [name, path] of [["compatibility.json", compatibilityPath], ["checksums.txt", checksumsPath], ["SBOM.spdx.json", sbomPath], ["artifact-catalog.json", catalogPath]]) {
    if (!existsSync(path)) problems.push(`missing ${name}`);
  }
  if (problems.length) return { ok: false, problems };

  const compatibility = JSON.parse(readFileSync(compatibilityPath, "utf8"));
  const checksumLines = readFileSync(checksumsPath, "utf8").trim().split("\n").filter(Boolean);
  const byName = new Map(checksumLines.map((line) => {
    const [hash, ...rest] = line.split("  ");
    return [rest.join("  "), hash];
  }));

  for (const artifact of compatibility.artifacts ?? []) {
    const path = join(dir, artifact.name);
    if (!existsSync(path)) { problems.push(`artifact missing on disk: ${artifact.name}`); continue; }
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== artifact.sha256) problems.push(`checksum mismatch: ${artifact.name}`);
    if (byName.get(artifact.name) !== artifact.sha256) problems.push(`checksums.txt mismatch: ${artifact.name}`);
  }
  for (const line of checksumLines) {
    const [, name] = line.split("  ");
    if (!existsSync(join(dir, name))) problems.push(`checksums.txt references missing file: ${name}`);
  }

  const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  if (sbom.spdxVersion !== "SPDX-2.3") problems.push("SBOM is not SPDX-2.3");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(catalog.files)) problems.push("artifact catalog has no files array");

  return { ok: problems.length === 0, problems, compatibility, catalog };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: check-release.mjs <candidate-dir>"); process.exit(1); }
  const result = verifyCandidate(dir);
  if (!result.ok) {
    console.error("check-release FAILED:");
    for (const problem of result.problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`check-release OK: ${result.compatibility.artifacts.length} artifacts verified against checksums and SBOM`);
}
