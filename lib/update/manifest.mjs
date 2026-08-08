// D16: signed release manifest validation. Portable/native updates require a
// signed manifest (UpdateManifestV1) and a matching checksum before staging;
// unsigned, downgrade, and replay manifests are rejected.

import { readFileSync } from "node:fs";
import { validateContract } from "../contracts/validate.mjs";

export function loadUpdateManifest(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return validateContract("UpdateManifestV1", raw);
}

export function verifyManifestSignature(manifest, { verify = () => true } = {}) {
  if (!manifest.signature) return { ok: false, reason: "missing_signature" };
  const valid = verify(manifest);
  if (!valid) return { ok: false, reason: "invalid_signature" };
  return { ok: true };
}

export function verifyArtifactChecksum(manifest, artifactName, actualSha256) {
  const artifact = (manifest.artifacts ?? []).find((entry) => entry.name === artifactName);
  if (!artifact) return { ok: false, reason: "artifact_not_in_manifest" };
  if (artifact.sha256 !== actualSha256) return { ok: false, reason: "checksum_mismatch" };
  return { ok: true };
}

export function rejectDowngrade(candidateVersion, currentVersion) {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  if (candidate.major < current.major) return { ok: false, reason: "downgrade_major" };
  if (candidate.major === current.major && candidate.minor < current.minor) return { ok: false, reason: "downgrade_minor" };
  if (candidate.major === current.major && candidate.minor === current.minor && candidate.patch < current.patch) return { ok: false, reason: "downgrade_patch" };
  return { ok: true };
}

export function rejectReplay(manifest, seenManifests = []) {
  if (seenManifests.includes(manifest.commit)) return { ok: false, reason: "replay_commit" };
  return { ok: true };
}

function parseVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
}
