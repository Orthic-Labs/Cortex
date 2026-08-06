# Package managers

Cortex publishes through several channels, all converging on the same
product and exact checksums from `release/catalog.json`.

## Identities

| Channel | Identity |
|---|---|
| npm | `@orthic-labs/cortex` |
| Homebrew tap | `Orthic-Labs/homebrew-tap`, formula `cortex` |
| WinGet | `OrthicLabs.Cortex` |
| Scoop | `cortex` |
| MCP registry | `io.github.Orthic-Labs/cortex` |
| Service ID | `io.orthic.cortex` |
| Container | `ghcr.io/orthic-labs/cortex` |

## Rules

- Every URL references an immutable release asset (exact version), never
  `latest`.
- Every manifest hash is copied from `release/catalog.json` by script, never
  by hand.
- Homebrew installs the same portable archive plus completions/man page.
- WinGet uses the signed per-user installer.
- Docker is documented for CI/headless use only.
- MCP registry metadata launches `cortex mcp serve` from the published npm
  package.
- Publication runs only after release verification in protected
  environments; it may open downstream PRs but never rewrites an existing
  release.

## Validation

```sh
node --test tests/package-manager-manifests.test.mjs
ruby -c release/homebrew/cortex.rb
node -e "JSON.parse(require('fs').readFileSync('server.json','utf8'))"
```
