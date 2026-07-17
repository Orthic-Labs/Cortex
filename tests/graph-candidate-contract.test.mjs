import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const BLUEPRINT = path.resolve(HERE, "..");
const CLI = path.join(BLUEPRINT, "scripts/blueprint.mjs");
const FIXTURE = path.join(BLUEPRINT, "evals/fixture-repos/typescript-commerce");
const SCHEMA = path.join(ROOT, "tools/lib/context-contracts.schema.json");
const PYTHON = process.platform === "win32" ? ["py", "-3.11"] : ["python3"];

test("graph candidates CLI validates as ContextCandidateSet v1", () => {
  const repo = path.join(os.tmpdir(), `blueprint-candidate-contract-${process.pid}-${Date.now()}`);
  fs.cpSync(FIXTURE, repo, { recursive: true });
  try {
    const build = spawnSync(process.execPath, [CLI, "graph", "build", "--out", ".agent"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const generated = spawnSync(process.execPath, [CLI, "graph", "candidates", "--query", "placeOrder", "--out", ".agent"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    const generatedPayload = JSON.parse(generated.stdout);
    assert.equal(generatedPayload.candidates.length > 0, true);
    assert.equal(
      Number.isFinite(generatedPayload?._rightcontext?.stageElapsedMs?.repo_code_scan),
      true,
      "candidate CLI must emit a content-free repo scan duration",
    );
    assert.equal(generatedPayload._rightcontext.stageElapsedMs.repo_code_scan >= 0, true);
    const validator = String.raw`
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(sys.argv[1], encoding="utf-8"))
wrapper = {"$schema": schema["$schema"], "$ref": "#/$defs/ContextCandidateSet", "$defs": schema["$defs"]}
errors = list(Draft202012Validator(wrapper).iter_errors(json.load(sys.stdin)))
print(json.dumps([e.message for e in errors]))
sys.exit(1 if errors else 0)
`;
    const result = spawnSync(PYTHON[0], [...PYTHON.slice(1), "-c", validator, SCHEMA], {
      input: generated.stdout,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("candidate set applies real tiering: anchors reserved, exact flagged, overflow receipted", async () => {
  const { buildGraphGeneration, createContextCandidateSet } = await import("../graph/static-provider.mjs");
  const repo = path.join(os.tmpdir(), `blueprint-tiering-${process.pid}-${Date.now()}`);
  fs.mkdirSync(repo, { recursive: true });
  try {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "checkout.ts"), "export function placeOrder(){ return 1; }\nexport function placeOrderDraft(){ return 2; }\n");
    fs.writeFileSync(path.join(repo, "orders.ts"), "export function placeOrderRetry(){ return 3; }\nexport function orderQueue(){ return 4; }\n");
    fs.writeFileSync(path.join(repo, "anchor.ts"), "export function unrelatedThing(){ return 5; }\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    const generation = buildGraphGeneration(repo, { outDir: ".agent" });

    // anchor a file the query does NOT match; force a small ceiling to create overflow.
    const cs = createContextCandidateSet(generation, { query: "placeOrder", anchors: ["anchor.ts"], maxCandidates: 3 });

    // Anchor reservation: the anchored file is present and protected, even though it
    // does not match "placeOrder".
    const protectedCands = cs.candidates.filter((c) => c.protected);
    assert.ok(protectedCands.length > 0, "anchored file must be a protected candidate");
    assert.ok(protectedCands.every((c) => c.sourceRef.startsWith("anchor.ts")), "protected candidates are the anchored file");

    // Tier order: protected sorts before exact before lexical.
    assert.equal(cs.candidates[0].protected, true, "protected candidate ranks first");

    // Exact vs lexical is real, not hardcoded true.
    assert.ok(cs.candidates.some((c) => c.exact === true), "an exact name match is flagged exact");
    assert.ok(cs.candidates.some((c) => c.exact === false), "a non-exact match is flagged not-exact (was hardcoded true)");

    // Omissions are real receipts, not an always-empty array.
    assert.ok(cs.candidates.length <= 3, "ceiling enforced");
    assert.ok(cs.omissions.length > 0, "overflow candidates are receipted, not silently dropped");
    assert.ok(cs.omissions.every((o) => typeof o.reason === "string" && o.reason.length > 0), "each omission carries a reason");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
