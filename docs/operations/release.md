# Release process

## Candidates (unsigned)

`node scripts/release/build-candidate.mjs --platform current --out <dir>`
builds an unsigned release candidate:

- `compatibility.json` — product/version/commit, platform/arch, Node version,
  store/schema versions, grammar manifest digest, per-file SHA-256, signed:false
- `checksums.txt` — SHA-256 for every artifact
- `SBOM.spdx.json` — SPDX-2.3 JSON
- `THIRD_PARTY_NOTICES` — dependency license notices
- `artifact-catalog.json` — machine-readable catalog

The builder rejects dirty trees, mismatched versions, missing notices, and
non-allowlisted files. No workflow may publish.

Verify with `node scripts/release/check-release.mjs <dir>` — it re-checksums
every artifact, cross-checks `checksums.txt`, and validates the SBOM and
catalog.

## Signing and publishing

Signed macOS/Windows artifacts (D17/D18) and package-manager publication
(D19) run only behind owner credential gates and protected environments.
`release-candidate.yml` never signs or publishes.
