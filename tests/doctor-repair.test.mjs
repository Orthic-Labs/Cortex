// D11: doctor repair plans — ordered, non-destructive, previewable, and
// confirmable.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildRepairPlan } from "../lib/operations/repair.mjs";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts/cortex.mjs");
const FIXTURE = join(ROOT, "evals/fixture-repos/typescript-commerce");

test("repair plan is ordered and non-destructive", () => {
  const plan = buildRepairPlan({
    root: "/repo",
    graphState: "stale",
    reasons: [
      { code: "stale_graph", severity: "blocker" },
      { code: "event_gap", severity: "blocker" },
    ],
  });
  assert.equal(plan.schemaVersion, 1);
  assert.ok(plan.actions.length >= 2);
  // Rebuild precedes reconciliation.
  assert.equal(plan.actions[0].id, "rebuild-graph");
  assert.equal(plan.actions[0].reversible, false);
  assert.ok(plan.actions.some((a) => a.id === "reconcile-watcher"));
});

test("repair plan no-ops when nothing is broken", () => {
  const plan = buildRepairPlan({ root: "/repo", graphState: "ready", reasons: [] });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].id, "no-op");
});

test("cortex doctor --repair-plan --json emits a schema-valid plan", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-doctor-repair-"));
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    const result = spawnSync(process.execPath, [CLI, "doctor", "--repair-plan", "--json"], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schemaVersion, 1);
    assert.ok(Array.isArray(plan.actions));
    for (const action of plan.actions) {
      assert.ok(action.id);
      assert.equal(typeof action.reversible, "boolean");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cortex doctor --apply-repair without --yes requires confirmation", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-doctor-confirm-"));
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    const result = spawnSync(process.execPath, [CLI, "doctor", "--repair-plan", "--apply-repair", "--json"], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /confirmation_required/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cortex doctor --repair-plan --apply-repair --yes applies the plan", () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-doctor-apply-"));
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    const result = spawnSync(process.execPath, [CLI, "doctor", "--repair-plan", "--apply-repair", "--yes", "--json"], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.applied));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
