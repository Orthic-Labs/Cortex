# Cortex

Nodes, edges & flows are branded **Neurons**, **Synapses** & **Circuits**.

> **TL;DR:** Cortex turns code **and** documentation into a local, evidence-backed repository map, so people & agents can find what is true, stale, contradictory or still unknown before changing a system.

Cortex helps people & AI agents understand a software repository before changing it. It connects
architecture docs, plans, ADRs, source files, symbols, calls, tests & configuration, then shows which
conclusions are supported, stale, contradictory or still unknown.

It is built for a common failure mode in software work: code tells only part of the story, docs tell
another part, & neither stays trustworthy unless they are compared.

## How it works

```text
documents + code + tests + config
                 │
                 ▼
       deterministic repository map
                 │
                 ▼
       local SQLite evidence graph
                 │
                 ▼
      claim verification + synthesis
                 │
                 ├── machine artifacts for agents
                 └── product + architecture docs for humans
```

Cortex runs in two main phases:

1. **Map:** deterministic code maps documents, claims, files, symbols & relationships into a
   generation-bound graph.
2. **Understand:** evidence-bound verification checks document claims against source, then
   synthesizes architecture, interfaces, security, health, production readiness & uncovered flows.

Mapping is cheap & repeatable. Higher-level conclusions must remain attached to exact evidence.

## Documents are first-class data

Cortex is not only a code indexer. Its document-truth layer is a core part of the product.

It reads current documentation, ADRs, plans & configured archives, then:

- extracts individual claims with source paths & line evidence;
- links claims to mentioned code, symbols & candidate verification files;
- records document lifecycle: current, historical, superseded or invalidly marked;
- keeps superseded docs as provenance while excluding them from current truth;
- applies explicit precedence so an old plan cannot silently outrank current code;
- joins evidence as `supports`, `contradicts` or `supersedes`;
- emits stale references, unsupported claims & code-versus-doc disagreement;
- excludes Cortex-generated docs from future claim extraction, preventing a self-confirming loop.

Phase 2 seals each verdict to exact document/code fingerprints. If its inputs have not changed,
Cortex reuses it. If one claim or file changes, only affected verdicts & synthesis dimensions
need recomputation. Reconciliation records preserve disagreements until a human decides whether code
or docs should change.

This makes documentation queryable, testable repository knowledge—not decorative prose beside code.

## Local SQLite graph

Each mapped repository gets one derived, gitignored store:
`.agent/graph/graph.db`.

Cortex uses Node's built-in `node:sqlite`, so its core store needs no database server or native
SQLite package.

| Table | What it stores | Important indexes |
|---|---|---|
| `files` | paths, hashes, languages, parse status & file-node data | generation |
| `symbols` | functions, types, components, routes & other named code objects | path, generation |
| `edges` | imports, calls, references, containment, configuration & other relationships | source, target, kind, confidence tier, generation |
| `generation` | manifest, provider composition, document truth & source observation | key |
| `meta` | store schema version | key |
| `vectors` | optional future embeddings | model, generation |

The store runs in WAL mode. A build writes relational rows plus its generation envelope inside
transactions, so readers see either last complete generation or next complete generation—never a
half-written map. Read-only consumers never migrate database.

Queries use indexed file/symbol lookups, a compact edge core & selective hydration of full nodes or
edges. `neighbors`, `path`, `impact` & `architecture` responses are bounded by token budget,
ranked deterministically & can return continuation cursors. Every response carries freshness
information such as generation ID, source state & dirty-file count.

Vector storage exists, but embeddings are off by default & Cortex does not currently generate
them. Structural evidence remains primary.

## Code intelligence

Cortex combines several precision levels:

- **Tree-sitter / AST:** selected structural layer for supported languages.
- **Deterministic lexical extraction:** broad, portable fallback across code, scripts & schemas.
- **SCIP / compiler evidence:** optional exact-reference augmentation when repository already
  supplies a portable SCIP JSON export; Cortex never installs or runs an indexer itself.

Provider precision is explicit: `COMPILER > AST > LEXICAL`.

Each edge separately records how confidently it was resolved:

```text
EXACT_RESOLUTION
  > SAME_FILE_LEXICAL
  > CROSS_FILE_HEURISTIC
  > UNRESOLVED
```

Ambiguous relationships stay unresolved instead of being guessed. Consumers can filter by minimum
confidence tier.

## What agents can ask

```sh
cortex                         # complete Cortex workflow
cortex "<task>"                # task-focused repository understanding
cortex doctor --full --json    # freshness, coverage & artifact health

cortex graph search --query "authentication"
cortex graph neighbors --node "<node-id>"
cortex graph path --from "<node-id>" --to "<node-id>"
cortex graph impact --node "<node-id>"
cortex graph architecture
cortex graph doc-truth
cortex graph export
```

Cortex can emit a bounded `ContextCandidateSet` for a larger context planner. It sends a relevant
slice with evidence & freshness—not an entire repository graph.

## Orientation admission (decision library)

`@orthic-labs/cortex` also exports a **decision-only** admission API — not a blocking gate:

```js
import { createAdmission } from "@orthic-labs/cortex/admission";

const api = createAdmission({ storeDir, evidenceDir });
const decision = await api.orient({ task, sessionId, repoRoot });
// decision.action: allow | continue | block | noop
```

Receipts are host-owned local data. Sentinel-consumable orientation evidence is derived from those
receipts. Fail-closed hooks, shell classifiers, MCP enforcement, and CodeRight brokers are
intentionally out of scope of this core library.

## Install / test

```sh
npm install   # or pnpm install
python3 -m pip install -r requirements-test.txt
npm test                # standalone package tests (tests/*.test.mjs)
npm run test:workspace  # monorepo context-contract suite (tests/workspace/)
npm run test:all        # both, serialized for watcher/performance isolation
```

Requires Node `>=20`; full tests also require Python `>=3.11` + packages in `requirements-test.txt`
(the workspace context-contract suite shells out to `jsonschema`). CLI entry: `cortex`.

## Outputs

Machine-readable outputs under `.agent/` include:

- `map.json`, `claims.json`, `stale.json`, `index.json` — document/code map;
- `queue.json` — claims paired with likely verification evidence;
- `flows.json` — bounded product-flow inventory;
- `phase2-plan.json` — exact verification/synthesis work to reuse or recompute;
- `verdicts.json` — generation-bound claim verdicts;
- `understanding.json` — six-dimension repository understanding;
- `reconcile.json` — unresolved code↔doc divergences;
- `graph/graph.db` — complete local SQLite graph.

Portable `.blueprint/manifest.json` exposes repository identity, provider capabilities, generation &
coverage without committing local database.

Human outputs are generated at:

- `docs/product.md` — code-grounded product overview;
- `docs/architecture.md` — components, interfaces, flows, risks & gaps.

## What makes it different

Cortex's advantage is not any single parser or graph database. It is combination:

- **Code + document truth:** implementation & stated intent are mapped together.
- **Evidence lineage:** important claims retain path, span, hash, provider, generation & confidence.
- **Contradiction preservation:** disagreement is surfaced, not averaged away.
- **Freshness by construction:** commits, dirty overlays, provider versions & content fingerprints
  invalidate only evidence they affect.
- **Bounded retrieval:** agents receive task-relevant graph slices with omission/freshness metadata.
- **Honest uncertainty:** unsupported languages, truncated scans & ambiguous edges stay visible.
- **Human + machine views:** same evidence produces queryable artifacts for agents & readable docs
  for people.
- **Replaceable providers:** SQLite schema & portable manifest remain stable while parsers improve.

That combination turns repository understanding from a one-off summary into inspectable,
incrementally maintained infrastructure.

## Trust model

Repository content is untrusted data, never agent instruction. Cortex redacts secrets from
outputs, confines reads to repository scope & never treats generated prose as primary evidence.
Current code & executable proof outrank plans or historical documents.

Graph results narrow where to read; they do not replace source inspection for security-sensitive,
release or destructive changes.

## Current scope

Cortex is live as a repository mapper, SQLite graph, bounded query surface, document-truth layer,
incremental Phase-2 planner & human/machine artifact generator.

Current limits:

- parser depth varies by language; lexical fallback is broader than AST coverage;
- dynamic runtime registration can remain unresolved without executable/compiler evidence;
- optional SCIP precision requires repository-supplied export;
- embeddings & semantic vector search are not active;
- no interactive visual graph explorer is shipped;
- raw graph data is not copied into durable memory.

Full agent workflow & artifact contract: [`SKILL.md`](SKILL.md).
Current implementation truth: [`references/IMPLEMENTATION-STATUS.md`](references/IMPLEMENTATION-STATUS.md).

## License

Source-available proprietary software for internal use & evaluation; redistribution, repackaging & competing use are prohibited. See [LICENSE](LICENSE).

<!-- blueprint:docs:start -->
## Repository truth docs
- [Product overview](docs/product.md) — what this is and does (generated, code-grounded)
- [Architecture](docs/architecture.md) — components, flows, interfaces (generated, code-grounded)
<!-- blueprint:docs:end -->
