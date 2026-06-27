---
name: blueprint
description: Make an LLM understand a repository. Phase 1 deterministically maps the repo (graph of docs↔claims↔code, code evidence, stale refs) via the global `blueprint` command. Phase 2 fans out parallel agents that VERIFY the extracted claims against real code and SYNTHESIZE an understanding layer (architecture, interfaces, health, security, production-readiness) grounded in the map. Output is machine-readable JSON for agents plus ONE human reference doc. Use before working in, inheriting, scaling, or auditing any repo. Replaces both the old `maprepo` mapper and the `/architecture` doc-set skill.
allowed-tools: ["Read", "Bash", "Glob", "Grep", "Write", "Agent", "Workflow"]
---

# Blueprint

One tool to make an agent understand a repo. Deterministic mapping first (cheap, complete, grounds everything in real files), then parallel agents to verify and synthesize. The human gets one reference doc; the LLM gets structured machine artifacts. This is comprehension — it never modifies application code.

The deterministic layer cannot lie (it only reports what files/claims exist) but cannot judge. The agent layer judges but is fenced to the real files the map handed it, so it cannot hallucinate structure. That pairing is the whole design.

## Artifacts (all under `<repo>/.agent/`)

Machine, for agents:
- `map.json` · `claims.json` · `stale.json` · `index.json` — the deterministic graph (Phase 1).
- `queue.json` — the grounded Phase-2 worklist: each claim paired with the code files its own doc references, plus the largest implementation files as `anchors`.
- `verdicts.json` — per-claim verification (Phase 2).
- `understanding.json` — the synthesized understanding layer across 5 dimensions (Phase 2).

Human, ONE file:
- `START-HERE.md` — stats, graph, key docs, and after Phase 2 a folded summary (verified facts, top risks, maturity). The only file a person opens.

## Phase 1 — deterministic map (always run first)

From the repo root:

```bash
blueprint            # build/refresh map.json, queue.json, START-HERE.md, etc.
blueprint "<task>"   # also writes a task-scoped runs/<ts>-<task>/TASK-BRIEF.md
blueprint doctor     # validate graph integrity, list missing refs
```

For a quick task orientation, Phase 1 alone is often enough — read `TASK-BRIEF.md` and stop. Run Phase 2 when the goal is full understanding, an audit, or onboarding.

## Phase 2 — verify + synthesize (parallel agents)

Drive this with a Workflow so verification and synthesis pipeline together. Read `queue.json` and `map.json` first; pass file paths to agents, never whole-file dumps.

**Models (hard):** verification = **haiku** (bounded check, one claim-batch each). Synthesis = **sonnet** (judgment). Never spawn an opus agent. The machine-minimal directive is auto-prepended to every spawn — write only the structured task body.

**2a. Verification (haiku, batched).** Take the claims worth checking — `status` in `implemented|stale|contradict|decision|canonical`, or any claim with `candidateFiles` — and split into ~6–10 batches. Each agent reads only the claim text and its `candidateFiles`, returns one verdict per claim. **Read the FULL files here — never `skel` a file you're verifying; confirming a claim needs the actual body.** Schema:

```json
[{"claimId":"...","source":"path","line":12,"verdict":"verified|contradicted|stale|unverifiable","evidence":"path:line","note":"<=160 chars"}]
```

Merge to `verdicts.json`. A `contradicted` verdict is the highest-value output — it means a doc claim the next agent would have trusted is false. For high-stakes claims (`decision`/`canonical`/`contradict`, or any "DONE / shipped / verified-on-prod" assertion), use **≥2 verifiers** and take the worst verdict if they disagree — single-verifier judgments on nuanced completion claims are noisy (observed in testing: two verifiers split verified-vs-stale on the same claim).

**2b. Synthesis (sonnet, 5 agents in one fan-out).** One agent per dimension, each grounded in `anchors` + `map.json` + `verdicts.json`. **Feed each agent `skel`'d anchors (run `skel <anchor>` — tree-sitter skeletons, ~78% fewer tokens) instead of raw files: synthesis needs structure, not every body. Agents pull the full body only for a specific span they must read closely.** Output structured JSON sections, every item `file:line`-referenced, `"Undetermined — <why>"` when unconfirmable. Merge into `understanding.json`:

- `architecture` — `summary`, `stack[]`, `components[]`, `dataFlow[]`, `entryPoints[]`, `stateStores[]`, `externalDeps[]`, `crossCutting[]`. Trace one real request/command end to end.
- `interfaces` — `publicApi[]`, `moduleInterfaces[]`, `dataContracts[]`, `configKeys[]`, `extensionPoints[]`, `fragileContracts[]`.
- `health` — `oversized[]`, `slop[]`, `hotspots[]`, `duplication[]`, `coupling[]`, `untested[]`, `deadWeight[]`, `top10[]`. Describe and rank; do not generate fix patches (that is `/audit`).
- `security` — `trustBoundaries[]`, `secrets[]` (location + presence only, redact values), `injectionSurface[]`, `authz[]`, `dataProtection[]`, `dangerousPatterns[]`, `posture[]`.
- `solid` — `dimensions[]` each `{name,status:Present|Partial|Missing,note}` over observability, resilience, config/env, testing, CI/CD, performance, scalability, data lifecycle, onboarding, accessibility, licensing; plus `scorecard[]` and `top5[]`.

## Phase 3 — fold into the one human doc (main session)

Append to `START-HERE.md`: a Verified-Facts section (claims marked `verified`), a Contradictions section (every `contradicted` claim — these are the traps), top health + security findings, and the maturity verdict. Leave the JSON as the machine source of truth. Then open it:

```bash
node D:/Claude/tools/lib/open-for-review.mjs "<repo>/.agent/START-HERE.md"
```

## Tuning

Per-repo `.agent/config.json` (written on first run) controls `budgets` (e.g. raise `maxReadFirstFiles` if files get crowded out of a brief) and `canonicalDocs`. No code changes needed.

## Hard rules

- Read real code before asserting; trace one real flow end to end; never invent component names — write `Undetermined — <why>`.
- Never modify application code. Blueprint only reads code and writes under `.agent/`.
- Every architecture claim is `file:line`-backed.
- Redact secret values — report location + presence only.
- Verification on haiku, synthesis on sonnet, never opus. Pass paths, not file dumps.
- Captures CURRENT state. Fix punch-lists are `/audit`; new designs are `architect`.
