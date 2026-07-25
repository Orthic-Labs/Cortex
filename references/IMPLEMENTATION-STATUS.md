# Blueprint — Runtime Ownership and Current Implementation Truth

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

## What Phase 1 writes (verified 2026-07-12)

The live Phase-1 implementation writes both the original document truth map and the
Blueprint-owned code graph:

- bootstrap node kinds remain `repo|doc|claim|code_ref`;
- bootstrap edge kinds remain `contains|mentions-code`;
- `blueprint build` writes `.agent/map.json`, `.agent/claims.json`, `.agent/stale.json`,
  `.agent/index.json`, `.agent/queue.json`, `.agent/flows.json`, the `.agent/graph/` tree
  (manifest + immutable generation files), and the portable `.blueprint/manifest.json`;
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

The implementation is still **PARTIAL** for final whole-repository understanding because the
provider is deterministic lexical extraction rather than compiler/AST coverage for every language,
and doc-code contradiction joins and optional visual explorer work remain incomplete. Do not
advertise an interactive visual explorer or raw graph ingestion into MemRight as live.

**Confirmed 2026-07-25:** there is no Tree-sitter dependency anywhere in the workspace
(`rg -l 'tree.sitter|tree_sitter'` matches documentation only), and no SQLite graph store — storage
is immutable JSON generations. The AST-provider upgrade is accepted, prioritised, and unbuilt; see
`docs/2026-07-25-SKILL-UPDATES-CONSOLIDATION.md` §1 items B1–B4.

**The qualification harness is built and gated, and the lexical provider is the one that passed.**
`evals/run-qualification.mjs` enforces six mandatory gates (`correctness, freshness, security,
contract, portability, operability`) plus performance budgets.
`docs/baselines/2026-07-10-blueprint-graph/qualification.json` registers four providers:
`blueprint-static` (**passed**, selected), the `rg/skel-baseline` fallback (fails by design —
`correctness` can never be `true`), and `codebase-memory`/`graphify` (unavailable).
`realRepositoryMeasurements` remains empty. So the harness is not waiting for its first provider —
it is waiting for a *stronger* one: `graph/treesitter-provider.mjs` exists, is tested (162-test
suite green), and is **not yet registered or wired**; `static-provider.mjs` still drives
`blueprint build`. The next step is registering the tree-sitter provider against this harness and
letting the gates decide the swap, not prose.

*(Correction 2026-07-25: an earlier revision of this file claimed only the fallback was registered.
That came from a truncated read of the qualification JSON and was wrong.)*

Plan of record: `docs/plans/2026-07-10-blueprint-code-graph-visual-explorer-impl.md`.
Qualification evidence: `docs/baselines/2026-07-10-blueprint-graph/qualification.json`.
