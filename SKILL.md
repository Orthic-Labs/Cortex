---
name: blueprint
description: Make an LLM understand a repository. Phase 1 deterministically maps the repo (graph of docs↔claims↔code, code evidence, stale refs) via the global `blueprint` command. Phase 2 fans out parallel agents that VERIFY the extracted claims against real code and SYNTHESIZE an understanding layer (architecture, interfaces, health, security, production-readiness, and uncovered-flow inventory) grounded in the map. Output is machine-readable JSON for agents plus two generated human docs. Use before working in, inheriting, scaling, auditing, or judging the architectural completeness of any repo. Replaces both the old `maprepo` mapper and the `/architecture` doc-set skill.
allowed-tools: ["Read", "Bash", "Glob", "Grep", "Write", "Agent", "Workflow"]
---

# Blueprint

One tool to make an agent understand a repo. Deterministic mapping first (cheap, complete, grounds everything in real files), then parallel agents to verify and synthesize. Humans get `docs/product.md` and `docs/architecture.md`; agents get structured machine artifacts. This is comprehension — it never modifies application code.

Canonical ownership and workflow boundary: `D:/Claude/docs/BLUEPRINT-AUDIT-ARCHITECT-WORKFLOW.md`.

The deterministic layer cannot lie (it only reports what files/claims exist) but cannot judge. The agent layer judges but is fenced to the real files the map handed it, so it cannot hallucinate structure. That pairing is the whole design.

## Artifacts

Machine entry point (portable, content-hashable):
- `<repo>/.blueprint/manifest.json` — the canonical Blueprint manifest. Points at every other artifact,
  carries the `GraphGenerationDescriptorV1`-shaped generation block (matches
  `ContextCandidateSet.freshness.revision` and `ScopeGrantV1.manifestDigest`), and is the contract
  downstream consumers (RightContext, audit, agent handoffs) bind to. Repo-relative paths only; no
  absolute Windows/Mac paths. **This is the only machine entry point.** `map.json.entrypoint`
  references this path.

Machine, for agents (under `<repo>/.agent/`):
- `map.json` · `claims.json` · `stale.json` · `index.json` — the deterministic graph (Phase 1).
- `queue.json` — the grounded Phase-2 worklist: each claim paired with the code files its own doc references, plus the largest implementation files as `anchors`.
- `verdicts.json` — per-claim verification (Phase 2).
- `understanding.json` — the synthesized understanding layer across 5 dimensions (Phase 2), including
  `architecture.flows[]` and `architecture.coverageGaps[]` so missing paths are first-class evidence.
- `reconcile.json` — one entry per code↔doc divergence with verdict + proposed reconciliation (Phase 4); `decision` stays `null` until the user calls it.
- `graph/manifest.json` + `graph/generations/<generationId>/{nodes,edges,graph}.json` — the structural graph (deterministic Blueprint-owned provider, current name `blueprint-static`).
- `flows.json` — classified product-flow inventory (complete / broken / unsupported).
- `hygiene/manifest.json` + `hygiene/facts.json` — optional generation-bound reusable hygiene
  evidence. `blueprint hygiene refresh` runs the targeted deterministic/expensive probes once;
  `blueprint hygiene status` reports `missing|fresh|stale`. Audit consumes fresh facts instead of
  rerunning them. Structural size entries are review candidates, not quality verdicts.

Human, generated (under `<repo>/docs/`):
- `docs/product.md` — code-grounded product/marketing overview; capabilities from the complete flow
  inventory, framing only from verified doc claims, never invented.
- `docs/architecture.md` — code-grounded technical overview; components, interfaces, classified flow
  table, capability coverage, health/security synthesis, and the Code Graph operational section.

These two are the ONLY human-facing artifacts Blueprint emits. **`START-HERE.md` is retired.** Agents
read the JSON directly; humans read the two generated docs (and the optional README pointer block).

Portable, for any agent (OKF):
- `okf/` — the understanding layer as an **Open Knowledge Format** bundle (one markdown concept per component/interface/risk; required `type` frontmatter; concepts linked as a graph; auto `index.md`), prose **compressed** structure-safely (refs/code/links preserved). **MANDATORY Phase-2 close — not optional, not agent discretion:** run `py -3.11 D:/Claude/tools/lib/skill_emit.py blueprint <repo>` — it transforms `understanding.json` → OKF concepts (one per dimension; YAML `type` frontmatter) → emits the bundle AND ingests it into the memory engine, recallable immediately. The bare `okf.py emit` is the low-level primitive; skills call `skill_emit`, never okf.py directly. Portable into CodeRight and any OKF-aware agent; the JSON stays the structured source and the generated docs stay the uncompressed human docs. Pattern + before/after: `tools/lib/OKF-OUTPUT.md`.

## Whole-repository completeness contract

Blueprint's product contract is **whole-repository understanding across code and documents**. A
large file count or a Phase-1 graph containing only `repo|doc|claim|code_ref` nodes and
`contains|mentions-code` edges is a bootstrap document-truth index, not proof that the codebase was
mapped. Do not let the word "graph" hide missing code semantics.

Before saying a repository is mapped, understood, or architecturally complete, write
`understanding.json.architecture.capabilityCoverage[]` with file-backed status for:

- document/ADR/plan claims and precedence;
- code symbols (files, modules, types, functions, methods, routes, schemas);
- code relationships (defines, contains, imports, calls, implements, reads/writes, tests);
- task retrieval across both code and documents, including semantic retrieval or an evidenced
  equivalent that can find relevant code even when docs do not name its path;
- contradiction/staleness arbitration and reversible source provenance.

Each row is `{capability,status:covered|partial|missing|undetermined,evidence,provider}`. If code
symbols, code relationships, or cross-code/document task retrieval are not covered, the Blueprint
verdict is **PARTIAL** and the gap is `CODE-FELL-SHORT`; Phase 2 agent prose cannot silently stand in
for the missing deterministic/semantic substrate. The storage/provider is implementation-neutral:
an embedded graph, SQLite-backed provider, or external local adapter is valid when measured, but the
capability cannot be deferred and still called whole-repo understanding.

For this workspace's context engine, preserve the canonical product boundary while mapping it:
MemRight means the three-family/eight-layer context economy (Compaction/PUSH layers 1–6,
Retrieval/PULL layer 7, Curation/PERSIST layer 8), not merely the durable recall store.

### Runtime ownership and current implementation truth

Blueprint is installed once by the workspace setup, then run **separately from the root of each
repository**. Its `.agent/` artifacts and any derived index/cache belong to that repository, are
regenerable, and are not MemRight storage. The only allowed integration is a bounded, source-backed
`ContextCandidateSet v1` submitted to MemRight's global admission planner, which combines it with
durable recall/other layers and emits the final `ContextPacket v1`; verified `KnowledgeEmission v1`
may enter the durable output path. Raw graph nodes, embeddings, edges, and visual layouts never
enter MemRight. Blueprint never owns the final cross-layer token budget.

As verified on 2026-07-12, the live Phase-1 implementation now writes both the original document
truth map and the Blueprint-owned code graph:

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
- `doctor` (and `doctor --json`) emit typed JSON states (`ready`, `missing`, `stale`, `broken`,
  `corrupt`) and include provider capability coverage, including the honest parsed-language list.
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

The implementation is still **PARTIAL** for final whole-repository understanding because the
provider is deterministic lexical extraction rather than compiler/AST coverage for every language,
and doc-code contradiction joins and optional visual explorer work remain incomplete. Do not
advertise an interactive visual explorer or raw graph ingestion into MemRight as live. The
implementation plan-of-record is
`D:/Claude/docs/plans/2026-07-10-blueprint-code-graph-visual-explorer-impl.md`; the qualification
evidence is `D:/Claude/docs/baselines/2026-07-10-blueprint-graph/qualification.json`.

## Phase 1 — deterministic map (always run first)

From the repo root:

```bash
blueprint            # build/refresh map.json, .blueprint/manifest.json, generated docs, etc.
blueprint "<task>"   # also writes a task-scoped runs/<ts>-<task>/TASK-BRIEF.md
blueprint doctor     # validate graph integrity, list missing refs; --json emits typed state
blueprint hygiene status --json
blueprint hygiene refresh --json  # targeted reusable facts; network-backed checks are timestamped
```

The bare `blueprint` command runs **Phase 1 only** — it exits after writing the map, so an agent that just runs the command naturally stops there. That is the right stopping point ONLY for a quick task-scoped brief (read `TASK-BRIEF.md` and go).

**If the intent is to UNDERSTAND / inherit / audit / onboard the repo, Phase 1 is not the deliverable — continue to Phase 2.** Do not report the repo as "mapped" or "understood" after Phase 1 alone; that only produced the deterministic skeleton, with claims still UNVERIFIED. Either run Phase 2 now, or explicitly tell the user you stopped at the cheap Phase-1 map and offer Phase 2.

## Phase 2 — verify + synthesize (parallel workers)

Drive this as a pipeline (Claude: the Workflow tool; Codex/other: an equivalent batch loop) so verification and synthesis flow together. Read `queue.json` and `map.json` first; pass file paths/excerpts, never whole-file dumps.

**Worker routing (hard) — native workers only, no external APIs.** Use the current client's native parallel-worker mechanism. Route mechanical verification to a low-cost worker and synthesis to a judgment-capable worker when the client supports tier selection; otherwise use its default native worker. Never put client-specific model names into a tool call on a client that does not support them. The old `/coder` HTTP-worker path is retired for this skill because provider limits and registration repeatedly hung runs. The main agent owns completion, merging, reconciliation, and every fallback.

**2a. Verification (parallel mechanical workers; inline fallback).** Take the claims worth checking — `status` in `implemented|stale|contradict|decision|canonical`, or any claim with `candidateFiles` — and split into ~6–10 batches. Spawn one worker per batch in one fan-out (structured task body: the claim texts + their `candidateFiles` paths), each returning one verdict per claim as JSON. If a worker returns no schema-valid JSON, launch one fresh replacement from scratch; do not repeatedly resume the stalled worker. If the replacement fails or workers are unavailable, verify that batch inline in the main session. Never stop with a recoverable batch pending and never substitute an external API. Each batch reads only its claim texts and their `candidateFiles`. **Read the FULL files here — never `skel` a file you're verifying; confirming a claim needs the actual body.** Schema:

```json
[{"claimId":"...","source":"path","line":12,"verdict":"verified|contradicted|stale|unverifiable","evidence":"path:line","note":"<=160 chars"}]
```

The MAIN agent merges to `verdicts.json` (reconciliation is never delegated). A `contradicted` verdict is the highest-value output — it means a doc claim the next agent would have trusted is false. For high-stakes claims (`decision`/`canonical`/`contradict`, or any "DONE / shipped / verified-on-prod" assertion), use **≥2 verifiers** and take the worst verdict if they disagree — single-verifier judgments on nuanced completion claims are noisy (observed in testing: two verifiers split verified-vs-stale on the same claim).

**2b. Synthesis (judgment-tier, 5 items in one fan-out).** Use native judgment-capable workers, never an external API. One item per dimension, each grounded in `anchors` + `map.json` + `verdicts.json`. **Feed each worker `prep-context`'d anchors — `memright prep <tmp> <anchors...>` (same flags `--rate`/`--min-bytes`; binary `D:/Claude/tools/bin/memright.exe`, `memright` shim on PATH) routes code→`skel` (~78% fewer tokens) and prose→`compress` (structure-safe) and returns a manifest; hand workers the prepared copies, not raw files. Synthesis needs structure, not every body; workers pull the full body only for a specific span they must read closely. SURVEY/SYNTHESIS reads only — verification (2a) reads FULL. Stack map: `tools/lib/CONTEXT-ENGINEERING.md`.** Output structured JSON sections, every item `file:line`-referenced, `"Undetermined — <why>"` when unconfirmable. If a dimension returns no schema-valid JSON, launch one fresh replacement from scratch. If that replacement fails or workers are unavailable, the main agent synthesizes that dimension inline under the same evidence and schema rules. The delegation preference never overrides the completion goal: do not leave `pending:true`, emit a stub, or stop while an inline fallback is possible. Merge all 5 dimensions into `understanding.json`:

- `architecture` — `summary`, `stack[]`, `components[]`, `dataFlow[]`, `entryPoints[]`, `stateStores[]`, `externalDeps[]`, `crossCutting[]`, `capabilityCoverage[]`, `flows[]`, `coverageGaps[]`. Trace one real request/command end to end. Inventory each material user/agent/data flow from source → transforms/stores → consumer and classify it `covered|partial|missing|undetermined` with `file:line` evidence. Every non-covered flow becomes `{flow,status,evidence,impact,existingPrimitives[],handoff:"architect"}` in `coverageGaps[]`. Include negative space: a flow named by product/docs/user intent that has no implementation is evidence, not something to omit because no file exists. Populate `capabilityCoverage[]` from the whole-repository completeness contract above; scanned-file count and Phase-2 prose are not substitutes for code-symbol/relationship coverage.
- `interfaces` — `publicApi[]`, `moduleInterfaces[]`, `dataContracts[]`, `configKeys[]`, `extensionPoints[]`, `fragileContracts[]`.
- `health` — `oversized[]`, `slop[]`, `hotspots[]`, `duplication[]`, `coupling[]`, `untested[]`, `deadWeight[]`, `top10[]`. Describe and rank signals; size alone is not a decomposition verdict. Do not generate fix patches or target designs (those are Audit + Architect).
- `security` — `trustBoundaries[]`, `secrets[]` (location + presence only, redact values), `injectionSurface[]`, `authz[]`, `dataProtection[]`, `dangerousPatterns[]`, `posture[]`.
- `solid` — `dimensions[]` each `{name,status:Present|Partial|Missing,note}` over observability, resilience, config/env, testing, CI/CD, performance, scalability, data lifecycle, onboarding, accessibility, licensing; plus `scorecard[]` and `top5[]`.

## Phase 3 — fold into the generated human docs (main session)

Append to `docs/architecture.md` (the technical doc is the natural home): a Verified-Facts section (claims marked `verified`), a Contradictions section (every `contradicted` claim — these are the traps), a Coverage Gaps table from `architecture.coverageGaps`, top health + security findings, and the maturity verdict. Leave the JSON as the machine source of truth. The Phase-4 RECONCILE block (below) goes at the **very top** of `docs/architecture.md`, above everything else — it is the one thing the user must act on. Then open it:

```bash
node D:/Claude/tools/lib/open-for-review.mjs "<repo>/docs/architecture.md"
```

## Phase 4 — doc-reconcile (the whole point: catch when agents didn't do what was expected)

Phase 2 already flags every `contradicted`/`stale` verdict — a doc claim the code disproves. **A doc
that says "planned" or "implemented" while the code doesn't reflect it is the highest-value signal
blueprint produces: it usually means an agent did NOT do what the plan expected.** Phase 4 turns each
such divergence into a decision the user must make. Run it whenever Phase 2 produced any
`contradicted`/`stale` verdict (it is cheap — it reasons over `verdicts.json` + a doc search, no new
code analysis).

**Authority order (state it; it resolves every divergence):**
`executable proof > current code > canonical docs > historical docs`. Running code beats a doc; a
recent decision doc beats an old plan; nothing beats a passing test/command.

**Per divergence (each `contradicted`/`stale` claim):**

1. **Search for a superseding doc.** Grep the repo + canonical-doc set for the topic; compare dates
   (filename date, frontmatter, `git log`). Is there a NEWER doc with a decision/plan that explains
   why the code differs? If yes → classify `SUPERSEDED-BY <newer-doc>` and the proposed reconciliation
   is "mark the old doc superseded by the new one."
2. **Classify code vs the documented plan** — is the code a *clear improvement* over the plan?
   - **`CODE-IS-BETTER`** — the code is a clear improvement; the doc is stale-but-code-won. Surface it:
     the plan was superseded in practice and the doc should catch up.
   - **`CODE-FELL-SHORT`** — the code does NOT meet the plan (missing, partial, or worse). Surface it
     LOUDLY: **this is an agent not doing what was expected** — the exact thing blueprint exists to catch.
     Do not let it read as a stale doc; it is a delivery gap.
   - **`SUPERSEDED-BY x`** — a newer doc already changed the plan (from step 1); the old doc just needs marking.

3. **Emit `reconcile.json`** (machine) — one entry per divergence:
   ```json
   {"claimId":"...","doc":"path","line":42,"claim":"<what the doc says>",
    "codeReality":"<what the code actually does> [path:line]",
    "verdict":"CODE-IS-BETTER|CODE-FELL-SHORT|SUPERSEDED-BY",
    "supersededBy":"path|null","proposedReconciliation":"<one line>","decision":null}
   ```

### The RECONCILE block — the ONE hard blocker, never buried

The user's reconciliation decision is the **only hard blocker** in blueprint, and it must be
**impossible to miss** — a loud banner at the TOP of `docs/architecture.md`, never a paragraph in a sea of
prose. Render it exactly like this, above the Verified-Facts/Contradictions sections:

```markdown
> ## ⚠️ RECONCILE — <N> DECISIONS NEEDED (blocker)
> The code and the docs disagree on <N> things. You decide how to reconcile each. Nothing else here matters until these are settled.
>
> | # | The doc says | The code actually does | Verdict | Proposed fix | Your call |
> |---|---|---|---|---|---|
> | 1 | "wake KWS ported to Rust app" — `roadmap.md:88` | not ported; still TODO — `wake_word.rs:12` | **CODE-FELL-SHORT** (agent didn't do it) | keep doc as TODO, OR file the gap | ☐ |
> | 2 | "uses Higgsfield Soul refs" — `pipeline.md:40` | replaced by NB2 multi-ref — `render-char-refs.mjs:8` | **CODE-IS-BETTER** | update doc to NB2 | ☐ |
> | 3 | "$69/$99 pricing" — `business-plan.md:5` | n/a (no code) — newer `hr_pricing_2026_06_28.md` | **SUPERSEDED-BY** newer doc | mark `business-plan.md` superseded | ☐ |
```

**Blueprint does NOT auto-patch.** It PROPOSES the reconciliation (including "mark <old> superseded by
<new>") and applies a doc edit ONLY on the user's per-item decision — the user owns how docs get
reconciled. Application **code** is never touched (Phase 4 keeps the read-only-code contract; it only
ever edits *docs*, and only after the user decides). After decisions, apply the chosen doc edits with
`apply_patch`/Edit, then re-open `docs/architecture.md`.

## Finalization — reseal after emission

Phase 2–4 writes understanding artifacts and documentation after the initial graph snapshot. Before reporting completion, run `blueprint` once more to refresh the graph, then run `blueprint doctor --json`. Preserve the folded `docs/architecture.md`; a typed `docs_conflict` fallback is acceptable when the fold intentionally made it human-maintained. Completion requires all 5 synthesis dimensions, no pending stubs, and a fresh graph. Doctor may report `degraded` for honest repository warnings, but never report completion in `stale`, `missing`, or `broken` state. If the final rebuild itself changes an indexed artifact, rebuild and check once more instead of handing the user a known-stale graph.

## Tuning

Per-repo `.agent/config.json` (written on first run) controls `budgets` (e.g. raise `maxReadFirstFiles` if files get crowded out of a brief) and `canonicalDocs`. No code changes needed.

## Hard rules

- Read real code before asserting; trace one real flow end to end; never invent component names — write `Undetermined — <why>`.
- Never modify application code. Blueprint only reads code and writes under `.agent/`.
- Every architecture claim is `file:line`-backed.
- Redact secret values — report location + presence only.
- Use native parallel workers with platform-supported routing; never emit unsupported client-specific model names and never use an external model API. Retry a failed worker once from scratch, then complete the batch or dimension inline. The main agent owns completion, reconciliation, and merge. Pass paths/excerpts, not file dumps.
- Captures CURRENT state. Fix punch-lists are `/audit`; new designs are `architect`.
- A size threshold only nominates a component for review. Never claim that a component needs
  decomposition without the responsibility/coupling/state/caller/test evidence and exact target plan
  required by `docs/BLUEPRINT-AUDIT-ARCHITECT-WORKFLOW.md`.
- Blueprint does not research or choose external solutions. If the user asks whether the architecture
  is the best shape or complete, Blueprint's deliverable is the evidenced coverage-gap inventory;
  hand every material gap to `architect` for the mandatory external prior-art decision matrix before
  anyone makes an optimality claim.
- Never reduce a multi-family product to the subsystem currently under inspection. For MemRight,
  explicitly verify all three families and eight layers before describing its purpose or coverage.
- **Phase 4 reconciles DOCS, never code.** A code↔doc divergence is surfaced as a user decision in the loud RECONCILE block (the only hard blocker); blueprint proposes the doc edit (incl. "superseded by") and applies it ONLY on the user's call. `CODE-FELL-SHORT` (an agent didn't do what the plan expected) must be surfaced loudly, not softened into "stale doc."
