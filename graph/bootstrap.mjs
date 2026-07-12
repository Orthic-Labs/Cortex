// Bootstrap from the tracked `.blueprint/` portable contract.
//
// If `.blueprint/manifest.json` exists in the repo, it is the authoritative
// descriptor for the canonical graph generation. Bootstrap verifies the
// recorded sourceHash against the current checkout; on match, it returns the
// tracked generation descriptor. On mismatch, it returns `null` so callers
// fall back to `buildGraphGeneration`.
//
// Per dispatch G1: "Add bootstrap behavior that reconstructs a usable local
// graph from tracked `.blueprint/` data and the current checkout without
// machine-specific paths." Tracked portable contract files:
//   .blueprint/manifest.json
//   .blueprint/schemas/*.json
//   .blueprint/coverage.json
//   .blueprint/contradictions.json
// Machine-local artifacts (kept untracked):
//   .blueprint/index.jsonl
//   .blueprint/cache/  .blueprint/tmp/  .blueprint/worktrees/
//
// The manifest itself contains no absolute paths; it identifies a generation
// by its content-hash and supported languages, and the source tree by the
// aggregated sourceHash.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSourcesPublic, sourceHashPublic, graphCapabilities } from "./static-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BLUEPRINT_DIR_NAME = ".blueprint";
export const MANIFEST_NAME = "manifest.json";

function findTrackedManifest(repoRoot) {
  const root = resolve(repoRoot);
  const directPath = join(root, BLUEPRINT_DIR_NAME, MANIFEST_NAME);
  if (existsSync(directPath)) {
    return directPath;
  }
  return null;
}

function manifestPathFor(repoRoot) {
  return join(resolve(repoRoot), BLUEPRINT_DIR_NAME, MANIFEST_NAME);
}

/**
 * Attempt to load the tracked portable contract for this repo.
 * Returns either { state: "ready", descriptor } when the tracked contract is
 * still authoritative over the current checkout, or { state: "stale",
 * manifest } when the manifest is tracked but the source tree has drifted,
 * or { state: "missing" } when no tracked contract exists.
 *
 * Never throws for absent or malformed manifests; malformed manifests are
 * reported as state="corrupt" with the parse error message.
 */
export function bootstrapFromTracked(repoRoot) {
  const manifestPath = findTrackedManifest(repoRoot);
  if (!manifestPath) return { state: "missing", manifestPath: null };
  if (!existsSync(manifestPath)) return { state: "missing", manifestPath };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      state: "corrupt",
      manifestPath,
      errors: [String(error?.message ?? error)],
    };
  }
  if (!manifest || typeof manifest !== "object") {
    return { state: "corrupt", manifestPath, errors: ["manifest is not a JSON object"] };
  }
  if (manifest.schemaVersion !== 1) {
    return {
      state: "corrupt",
      manifestPath,
      errors: [`unsupported schemaVersion ${manifest.schemaVersion}; expected 1`],
    };
  }
  // Validate that the manifest carries no absolute machine paths anywhere.
  const raw = JSON.stringify(manifest);
  const pathFindings = [];
  if (/D:[\\/]/.test(raw)) pathFindings.push("windows_drive");
  if (/C:[\\/]/.test(raw)) pathFindings.push("windows_c_drive");
  if (/\/Users\//.test(raw)) pathFindings.push("mac_users");
  if (/\/home\//.test(raw)) pathFindings.push("linux_home");
  if (pathFindings.length > 0) {
    return {
      state: "corrupt",
      manifestPath,
      errors: [`manifest contains absolute machine path indicators: ${pathFindings.join(", ")}`],
    };
  }

  const sources = scanSourcesPublic(resolve(repoRoot));
  const currentHash = sourceHashPublic(sources.files);
  const recordedHash = manifest?.repo?.sourceHash;
  if (!recordedHash) {
    return {
      state: "corrupt",
      manifestPath,
      errors: ["manifest is missing repo.sourceHash"],
    };
  }

  if (recordedHash === currentHash) {
    return {
      state: "ready",
      manifestPath,
      descriptor: {
        schemaVersion: 1,
        id: manifest.generationId,
        revision: manifest.generationId,
        indexedAt: manifest.generatedAt,
        stale: false,
        sourceKind: "blueprint-tracked",
        toolVersions: manifest.toolVersions ?? {},
        providerCapabilities: graphCapabilities().languageCoverage.parsedExtensions,
        supportedEdgeTypes: manifest.supportedEdgeTypes ?? [],
        supportedLanguages: manifest.supportedLanguages ?? [],
        fileCount: sources.files.length,
        contentHash: recordedHash,
        frozen: true,
        manifestPath,
        manifest,
      },
    };
  }

  return {
    state: "stale",
    manifestPath,
    manifest,
    recordedHash,
    currentHash,
  };
}

export { findTrackedManifest, manifestPathFor };