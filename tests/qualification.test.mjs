import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadTasks,
  makeFallbackProvider,
  qualifyProvider,
  schemaHash,
  selectProvider,
} from "../evals/run-qualification.mjs";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLUEPRINT = path.resolve(HERE, "..");
const TASKS = path.join(BLUEPRINT, "evals/graph-tasks.jsonl");
const REPOS = path.join(BLUEPRINT, "evals/fixture-repos");
const SCHEMA = path.resolve(BLUEPRINT, "../../lib/context-contracts.schema.json");


test("locked task rows point to real bounded evidence", () => {
  const tasks = loadTasks(TASKS);

  assert.equal(tasks.length, 12);
  assert.equal(tasks.filter((item) => item.split === "heldout").length, 3);
  assert.deepEqual(new Set(tasks.filter((item) => item.kind === "semantic_lookup").map((item) => item.repo)), new Set([
    "typescript-commerce", "rust-audio", "python-context",
  ]));
  for (const task of tasks) {
    assert.ok(task.expectedNodes.length > 0 && task.expectedEvidence.length > 0);
    assert.ok(task.maxPacketTokens > 0 && task.protectedAnchors.length > 0);
    for (const evidence of task.expectedEvidence) {
      const file = path.join(REPOS, task.repo, evidence.path);
      assert.ok(fs.existsSync(file), `${task.id}: missing ${file}`);
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      assert.ok(evidence.startLine >= 1 && evidence.endLine >= evidence.startLine);
      assert.ok(evidence.endLine <= lines.length, `${task.id}: invalid span ${evidence.path}:${evidence.endLine}`);
    }
  }
  assert.ok(tasks.filter((task) => task.oracle?.kind?.startsWith("scip-")).every((task) => task.oracle.status === "verified"));
});


test("fallback reports unsupported graph capabilities instead of empty success", async () => {
  const task = loadTasks(TASKS).find((item) => item.kind === "call_path");
  const report = await qualifyProvider(makeFallbackProvider(), [task], REPOS);

  assert.equal(report.status, "failed");
  assert.equal(report.tasks[0].state, "unsupported");
  assert.equal(report.gates.correctness, false);
});


test("provider cannot pass by reading the answer key instead of returning evidence", async () => {
  const task = loadTasks(TASKS).find((item) => item.kind === "symbol_definition");
  let calls = 0;
  const dishonest = {
    id: "dishonest",
    kind: "codebase-memory",
    capabilities: new Set(["symbol_definition"]),
    async probe() { return { available: true }; },
    async execute() { calls += 1; return { state: "ok", evidenceRefs: [] }; },
    async close() {},
  };

  const report = await qualifyProvider(dishonest, [task], REPOS);

  assert.equal(calls, 1);
  assert.equal(report.tasks[0].state, "failed");
  assert.ok(report.tasks[0].missingEvidence.includes("src/service.ts"));
});


test("selection is blocked unless one provider passes every mandatory gate", () => {
  const failed = { id: "fallback", status: "failed", gates: { correctness: false } };
  const passing = {
    id: "provider-a",
    status: "passed",
    gates: { correctness: true, freshness: true, security: true, contract: true, portability: true, operability: true },
    metrics: { fullMs: 10, incrementalMs: 2, queryP95Ms: 1, peakRssBytes: 100, indexBytes: 50 },
  };

  assert.deepEqual(selectProvider([failed]), { outcome: "no_provider_passed", selectedProvider: null });
  assert.deepEqual(selectProvider([failed, passing]), { outcome: "selected", selectedProvider: "provider-a" });
});


test("schema hash covers exact canonical bytes", () => {
  const expected = createHash("sha256").update(fs.readFileSync(SCHEMA)).digest("hex");
  assert.equal(schemaHash(SCHEMA), expected);
});
