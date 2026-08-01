# Changelog

## Unreleased

- Renamed the product **Blueprint → Cortex**: `cortex` is the canonical CLI, `blueprint` remains a
  compatibility alias. README, SKILL, IMPLEMENTATION-STATUS, and package description rebranded; prose
  brands nodes/edges/flows as Neurons/Synapses/Circuits. Frozen for installed-agent compatibility:
  the `blueprint` bin alias, artifact paths `.agent/` and `.blueprint/manifest.json`, provider IDs
  `blueprint-treesitter`/`blueprint-static`, the `blueprint_orientation` evidence key, and the
  `<!-- blueprint:docs -->` README fence markers.

- P1 orientation admission library: `lib/admission.mjs` (`orient`/`expand`/`status`/`revoke`),
  host-owned `lib/receipt-store.mjs`, Beacon-consumable `lib/orientation-evidence.mjs` (no hooks /
  shell classifier / MCP).
- Standalone package surface: `@orthic-labs/cortex@0.2.0` with `bin`, `files`, `engines`,
  `exports`; workspace contract tests moved to `tests/workspace/`.
- Reconciled `.blueprint/manifest.json` producer and bootstrap consumer around one nested generation contract.
- Corrected every portable graph artifact reference to the sole SQLite store at `.agent/graph/graph.db`.
- Replaced largest-file Phase-2 anchors with deterministic claim-relevance and cross-file graph-connectivity ranking.
- Added build-to-bootstrap and graph-ranked anchor regressions.
- Declared exact hashing, Tree-sitter runtime, and grammar dependencies so a clean checkout can run Blueprint and its tests.
- Enforced LF text checkout so frozen evidence hashes remain identical across Windows and macOS.
