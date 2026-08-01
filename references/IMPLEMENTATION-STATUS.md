# Blueprint — Runtime Ownership and Current Implementation Truth

Product is now **Cortex**: `cortex` is canonical, `blueprint` remains a compatibility alias; prose brands nodes, edges & flows as Neurons, Synapses & Circuits.

What the live implementation actually does, which commands exist, and where it is still PARTIAL.
Extracted from `SKILL.md`.

**Keep this file current.** A stale entry here is precisely the `CODE-FELL-SHORT` class Blueprint
exists to catch — a document claiming a capability the code does not have. If you change the
engine, change this file in the same commit.

## Runtime ownership

Blueprint is installed once by the workspace setup, then run **separately from the root of each
repository**. Its `.agent/` artifacts and any derived index/cache belong to that repository, are
regenerable, and are not MemRight storage. The only allowed integration is a bounded, source-backed
`ContextCandidateSet v1` submitted to MemRight's global admission planner, which combines it with
durable recall/other layers and emits the final `ContextPacket v1`; verified `KnowledgeEmission v1`
may enter the durable output path. Raw graph nodes, embeddings, edges, and visual layouts never
enter MemRight. Blueprint never owns the final cross-layer token budget.

## What Phase 1 writes (verified 2026-07-26)

The live Phase-1 implementation writes both the original document truth map and the
Blueprint-owned code graph:

- bootstrap node kinds remain `repo|doc|claim|code_ref`;
- bootstrap edge kinds remain `contains|mentions-code`;
- `blueprint build` writes `.agent/map.json`, `.agent/claims.json`, `.agent/stale.json`,
  `.agent/index.json`, `.agent/queue.json`, `.agent/flows.json`, the derived
  `.agent/graph/graph.db` SQLite store, and the portable `.blueprint/manifest.json`;
- the portable manifest stores repository identity under `repo`, generation metadata under
  `generation`, and points `artifacts.graph` at `.agent/graph/graph.db`; the bootstrap consumer
  reads that same versioned shape;
- Phase-2 queue anchors prioritize files linked by extracted document claims, then cross-file graph
  connectivity, with deterministic path ordering; file size is only a fallback when no graph file
  nodes exist;
- it also generates the two human docs `docs/product.md` and `docs/architecture.md`;
- live graph commands include `build`, `status`, `schema`, `search`, `neighbors`, `path`,
  `impact`, `resolve`, `architecture`, `flows`, and `candidates`;
- `graph candidates` emits a schema-validated `ContextCandidateSet v1` for MemRight's admission
  planner boundary;
- `graph planner-status` proves the current MemRight join state: `ready` when `memright plan-context`
  exists, `missing_command` when Blueprint can emit candidates but MemRight has not shipped the
  admission command, and `unavailable` when the local binary cannot be inspected;
- `graph mermaid` emits a bounded deterministic Mermaid view for static visual inspection;
- `graph flows --complete` asks for complete flow enumeration up to the explicit safety cap instead
  of the default bounded preview;
- `doctor` (and `doctor --json`) emit typed JSON states (`ready`, `degraded`, `stale`, `broken`,
  `corrupt`, `missing`) plus granular `reasons[]` codes, and include provider capability coverage,
  including the honest parsed-language list. `broken` = provider-version incompatible with the
  persisted graph; `corrupt` = artifacts present but unparseable; `degraded` = fresh but coverage
  incomplete (unsupported languages / truncated scan).
- the deterministic lexical provider parses the tracked first-party executable stack: JS/TS
  (including JSX/TSX/MJS/CJS/MTS/CTS and React arrow components), Python, Rust/Tauri, Swift,
  C/C++/Objective-C/Objective-C++, Vue/Astro script regions, NSIS installers, workspace
  Bash/PowerShell/BAT/VBS functions, and GraphQL/SQL schema definitions and references. Known
  opaque assets remain file nodes and do not masquerade as unsupported languages; vendor trees are
  excluded.
- `hygiene refresh` reuses Audit's existing scanner implementations but makes their reusable output
  Blueprint-owned and graph-generation-bound. Default facts cover dependency freshness, dead-code
  and duplication scanners, oversized/mechanical-split structure, binary pins, dependency pinning,
  negative space, and debt markers. Decomposition candidates carry LOC, bytes, symbol/span, and graph
  relationship metrics; crossing the configurable review threshold never proves bloat. The full
  decomposition verdict/target plan, ponytail/minimize judgment, and severity remain Audit/Architect.
- task briefs use graph retrieval as a bounded read-first source before falling back to lexical
  evidence search;
- product-flow inventory is capped and reports `truncated=true` when capped;
- **`START-HERE.md` is retired.** No build writes it. `map.json.entrypoint` and the
  `.blueprint/manifest.json` `entrypoint` field point at the portable machine manifest;
  humans read the two generated docs.

## Where it is still PARTIAL

The implementation is still **PARTIAL** for final whole-repository understanding because AST
coverage varies by language, dynamic relationships can require compiler/runtime evidence, optional
semantic retrieval is not active, and an interactive visual explorer is not shipped. Do not
advertise complete compiler precision, active vector search, an interactive explorer or raw graph
ingestion into MemRight as live.

**Confirmed 2026-07-26:** Blueprint uses `node:sqlite` as its sole graph store at
`.agent/graph/graph.db`. The schema persists files, symbols, edges, generation metadata and an
optional vectors table, with indexes on generation, symbol path, edge source/target/kind/confidence
tier and vector model. WAL plus transactional generation writes keep read-only consumers on the
last complete generation during a build. There is no `graph.json`; `blueprint graph export` emits
JSON on demand. Embeddings remain off by default and no Blueprint path currently generates them.

**Publish identity (P0, 2026-08-01):** `generationId` and `manifestDigest` are sealed only after
tree-sitter augmentation via `finalizeGenerationIdentity()`. `saveGeneration()` writes relational
rows and the envelope in one transaction and clears stale envelope keys. Full `blueprint build`
publishes exactly once after augmentation; `blueprint graph build` is lexical-only (labeled in CLI
output) and also publishes once. Lexical test helpers pass `persist: true` on
`buildGraphGeneration()`. Indexed query paths and source adapters open the store read-only via
`openStoreReadOnly()`. Portable manifest paths are validated through `graph/portable-manifest.mjs`;
`providerCapabilities` are persisted at build time rather than recomputed live during bootstrap.

**Orientation admission library (P1, 2026-08-01):** Decision-only API in `lib/admission.mjs`
(`orient` / `expand` / `status` / `revoke`) returns a neutral contract (`allow|continue|block|noop`)
usable by MemRight hosts. Host-owned receipts live in `lib/receipt-store.mjs` (default
`~/.blueprint/receipts` or `BLUEPRINT_RECEIPT_STORE`) keyed by session/task/repo/generation — data,
not enforcement. `lib/orientation-evidence.mjs` emits Beacon-consumable `blueprint_orientation`
evidence (+ optional JSON file). No fail-closed hooks, shell classifier, MCP server, or CodeRight
broker in this release. Standalone packaging is `@orthic-labs/cortex@0.2.0` with `bin`, `files`,
`engines`, and `exports`; `npm test` runs `tests/*.test.mjs` only; monorepo contract tests live under
`tests/workspace/` (`npm run test:workspace` / `test:all`).

**Resident watcher qualification (2026-08-01):** Parcel event roots are canonicalized before
relative-path calculation, including macOS `/var` to `/private/var` events. Full qualification
declares its Python `jsonschema` dependency in `requirements-test.txt`; CI installs it under Python
3.11 before `pnpm test:all` on macOS and Windows.

**The qualification harness is built and gated.**
`evals/run-qualification.mjs` enforces six mandatory gates (`correctness, freshness, security,
contract, portability, operability`) plus performance budgets.
`docs/baselines/2026-07-10-blueprint-graph/qualification.json` registers four providers:
`blueprint-static` (**passed**, selected), the `rg/skel-baseline` fallback (fails by design —
`correctness` can never be `true`), and `codebase-memory`/`graphify` (unavailable).
`realRepositoryMeasurements` remains empty. That baseline predates Tree-sitter promotion and must
not be read as current provider selection.

*(Correction 2026-07-25: an earlier revision of this file claimed only the fallback was registered.
That came from a truncated read of the qualification JSON and was wrong.)*

**Update (2026-07-25, evening): `blueprint-treesitter` is now registered and measured.** Result of
`node evals/run-qualification.mjs --providers blueprint-static,blueprint-treesitter`:

- tasks **12/12 passed** (initially 6/12 — registration exposed and fixed three real provider
  defects: unmapped edge endpoints, missing `labels` on endpoints, and no module-level constant
  extraction, which had made the whole config-resource class invisible);
- gates **1/6**: `correctness` TRUE; freshness/security/contract/portability/operability FALSE
  because the provider does not yet implement those qualification suites. That is the concrete,
  measured remaining work for promotion — suite implementations plus a two-platform (win32+darwin)
  portability run.
- `blueprint-treesitter` is now the selected build provider, layered over
  `blueprint-static` as its deterministic lexical fallback. The canonical baseline at
  `docs/baselines/2026-07-10-blueprint-graph/` is deliberately NOT regenerated from a Mac-only run,
  because its recorded portability evidence spans both platforms and a single-platform rerun would
  degrade it.

Measurement discipline note: three intermediate qualification runs showed a phantom
`ts-config-resource` failure that disappeared in a quiet environment and could not be reproduced in
isolation, solo, either provider order, or against a pristine fixture copy. Cause: the runs shared
the machine with parallel test suites/agents. **Do not diagnose a qualification failure observed
while other workloads run on the workspace; re-verify quiet first.**

Plan of record: `docs/plans/2026-07-10-blueprint-code-graph-visual-explorer-impl.md`.
Qualification evidence: `docs/baselines/2026-07-10-blueprint-graph/qualification.json`.

## B3 — per-edge confidence tiers (implemented)

`graph/confidence-tiers.mjs` defines the tier vocabulary, ordered most -> least certain:
`EXACT_RESOLUTION` (1.0) > `SAME_FILE_LEXICAL` (0.75) > `CROSS_FILE_HEURISTIC` (0.5) >
`UNRESOLVED` (0). Numeric `confidence` is a pure function of the tier (`tierConfidence()`), never a
per-finding subjective score. Both `graph/static-provider.mjs` and `graph/treesitter-provider.mjs`
tag every edge they emit with `confidenceTier`, DERIVED from the resolution path that actually
produced it (never hardcoded per provider):

- resolved import specifier -> `EXACT_RESOLUTION`; unresolved relative import -> `UNRESOLVED`
  (`target: null`, kept, never dropped — `extractUnresolvedImportSpecifiers()` in
  `graph/language-extractors.mjs` covers JS/TS and Python; Rust/native/script/nsis are honestly
  uncovered rather than guessed at).
- a call resolved to a same-file symbol -> `SAME_FILE_LEXICAL`; resolved via an already-resolved
  import link, or a repo-wide unique-name fallback -> `CROSS_FILE_HEURISTIC`; a genuinely ambiguous
  call (2+ OTHER, non-self candidates, none preferred) -> `UNRESOLVED`, tagged and kept, never
  guessed. Self is excluded from the ambiguity count on purpose: the lexical provider's
  `containsCall`/`extractCallNames` regex can match a function's own declaration line as a call to
  itself, and reporting that pre-existing extraction quirk as "N candidates, none preferred" would
  be a false claim — it stays silent rather than fabricating a tag.
- schema (`GraphQL`/`Sql`) `REFERENCES` edges and `CONFIGURES` edges (string-literal-to-filename
  match) are `CROSS_FILE_HEURISTIC`.

`EDGE_CONFIDENCE_TIER_ORDER`/`filterEdgesByMinTier()`/`isTierAtLeast()` are exported for consumers
to filter by minimum tier. Covered by `tests/confidence-precision-tiers.test.mjs` plus updated
assertions in `tests/graph-substrate.test.mjs` (which now explicitly tolerates `target: null` on
unresolved edges instead of assuming every edge resolves).

## B4 — SCIP/compiler precision tier (implemented, honestly degraded)

`graph/precision-tiers.mjs` defines `COMPILER > AST > LEXICAL`, a property of a PROVIDER (its
ceiling), orthogonal to the per-edge confidence tier above. `static-provider.mjs`'s `PROVIDER`
declares `LEXICAL`; `treesitter-provider.mjs`'s `PROVIDER` declares `AST`; both surface
`precisionTier` on their `graphCapabilities()` probe output.

`graph/scip-provider.mjs` is the `COMPILER` tier. Blueprint never vendors, installs, or invokes a
SCIP indexer — it only READS a portable JSON export (`{ documents: [{ relativePath, occurrences:
[{ symbol, roles, range }] }] }`, e.g. from `scip print --json`) if the repo already produced one at
`index.scip.json`, `.blueprint/index.scip.json`, or `$BLUEPRINT_SCIP_INDEX`. `probeScip()` reports
`state: "unavailable"` with an honest `reason` and `degradesTo: "AST"` on absence, unreadable JSON,
or an unrecognized shape — mirroring `augmentGenerationWithTreeSitter`'s WASM-load degrade contract.
`augmentGenerationWithScip()` mirrors that async-at-the-build-boundary pattern and only ever adds
`REFERENCES` edges (tagged `EXACT_RESOLUTION`) that are literally present in the index's occurrence
list, joined against nodes already in the generation — it never fabricates a node or reference.
`graphPrecisionProbe(repoRoot)` in `static-provider.mjs` composes all three tiers into one probe
(`LEXICAL`/`AST` always `ok`, `COMPILER` reflecting the live `probeScip()` result) for a
consumer-facing "highest precision actually available" answer. Covered by
`tests/confidence-precision-tiers.test.mjs` (absence, malformed JSON, wrong shape, and
presence-with-real-join paths, plus the combined probe).
