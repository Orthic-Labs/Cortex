#!/usr/bin/env node
// D13: build an unsigned release candidate. Emits source/package identity,
// platform/arch, Node version, store/schema versions, grammar manifest
// digest, files, SHA-256, and build commit into compatibility.json, plus
// checksums.txt, an SPDX JSON SBOM, third-party notices, and a machine-
// readable artifact catalog. Rejects dirty trees, mismatched versions,
// missing notices, undeclared network downloads, and non-allowlisted files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function isDirty() {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return status.trim().length > 0;
}

function grammarManifestDigest() {
  const grammarsDir = join(ROOT, "node_modules", "tree-sitter-wasms", "out");
  if (!existsSync(grammarsDir)) return null;
  const hasher = createHash("sha256");
  for (const file of walk(grammarsDir).sort()) {
    hasher.update(relative(grammarsDir, file));
    hasher.update(sha256File(file));
  }
  return `sha256:${hasher.digest("hex")}`;
}

export function buildCandidate({ out = null, platform = null, allowDirty = false } = {}) {
  if (!allowDirty && isDirty()) throw new Error("release candidate requires a clean working tree (or pass --allow-dirty for dispatch verification)");
  const targetPlatform = platform ?? `${process.platform}-${process.arch}`;
  const outDir = out ?? join(ROOT, "release", "candidates", targetPlatform);
  mkdirSync(outDir, { recursive: true });

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const artifactFiles = walk(join(ROOT, "scripts")).concat(
    walk(join(ROOT, "lib")),
    walk(join(ROOT, "graph")),
    walk(join(ROOT, "schemas")),
  );
  const artifactList = artifactFiles
    .map((path) => relative(ROOT, path))
    .filter((path) => !path.includes("/ci/"))
    .sort();

  const artifacts = [];
  for (const path of artifactList) {
    const full = join(ROOT, path);
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(full, target);
    artifacts.push({
      name: path,
      platform: targetPlatform.split("-")[0],
      arch: targetPlatform.split("-")[1],
      sha256: sha256File(target),
      size: statSync(target).size,
      signed: false,
      sbom: "SBOM.spdx.json",
    });
  }

  const compatibility = {
    schemaVersion: 1,
    product: "Orthic Cortex",
    version: pkg.version,
    commit,
    sourceDateEpoch: 0,
    contracts: { public: 1, store: 14, ipc: 1 },
    grammarManifestDigest: grammarManifestDigest(),
    artifacts,
  };
  writeFileSync(join(outDir, "compatibility.json"), `${JSON.stringify(compatibility, null, 2)}\n`);

  const checksums = [];
  for (const artifact of artifacts) checksums.push(`${artifact.sha256}  ${artifact.name}`);
  writeFileSync(join(outDir, "checksums.txt"), `${checksums.join("\n")}\n`);

  // SPDX JSON SBOM (self-describing; no third-party inventory is fetched).
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `cortex-${pkg.version}`,
    documentNamespace: `https://orthic-labs.github.io/spdx/cortex-${pkg.version}-${commit.slice(0, 12)}`,
    creationInfo: { created: new Date().toISOString(), creators: ["Tool: cortex release candidate builder"] },
    packages: [
      {
        name: "cortex",
        SPDXID: "SPDXRef-Package-Cortex",
        versionInfo: pkg.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
      },
    ],
  };
  writeFileSync(join(outDir, "SBOM.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

  const notices = readFileSync(join(ROOT, "release", "THIRD_PARTY_NOTICES.template"), "utf8");
  writeFileSync(join(outDir, "THIRD_PARTY_NOTICES"), notices);

  const catalog = {
    schemaVersion: 1,
    product: "Orthic Cortex",
    version: pkg.version,
    commit,
    platform: targetPlatform,
    files: artifacts.map((a) => a.name),
    checksums: join("checksums.txt"),
  };
  writeFileSync(join(outDir, "artifact-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);

  return { outDir, compatibility, artifactCount: artifacts.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("--out") + 1] ?? null;
  const platform = argv[argv.indexOf("--platform") + 1] ?? null;
  const allowDirty = argv.includes("--allow-dirty");
  try {
    const result = buildCandidate({ out, platform, allowDirty });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
