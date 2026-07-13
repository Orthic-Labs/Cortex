import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../scripts/blueprint.mjs");

function run(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
}

test("Blueprint hygiene facts are cached, generation-bound, and become stale with the graph", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-hygiene-"));
  try {
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "large.ts"), [
      "export function alpha() {",
      ...Array.from({ length: 207 }, (_, index) => `  // alpha ${index + 1}`),
      "}",
      "export function beta() {",
      ...Array.from({ length: 207 }, (_, index) => `  // beta ${index + 1}`),
      "}",
      "",
    ].join("\n"));
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["add", "src/large.ts"], { cwd: repo }).status, 0);

    const graphBuild = run(repo, ["graph", "build", "--out", ".agent"]);
    assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);
    const configPath = path.join(repo, ".agent", "config.json");
    fs.writeFileSync(configPath, `${JSON.stringify({ hygiene: { decompositionReviewLoc: 410 } }, null, 2)}\n`);

    const missing = run(repo, ["hygiene", "status", "--out", ".agent", "--json"]);
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).state, "missing");

    const refresh = run(repo, [
      "hygiene", "refresh", "--out", ".agent", "--only", "decomposition,debt_markers", "--json",
    ]);
    assert.equal(refresh.status, 0, refresh.stderr || refresh.stdout);
    const refreshed = JSON.parse(refresh.stdout);
    assert.equal(refreshed.state, "fresh");
    assert.deepEqual(refreshed.selectedChecks, ["decomposition", "debt_markers"]);
    assert.match(refreshed.sourceGenerationId, /^sha256:[a-f0-9]{64}$/);
    assert.ok(fs.existsSync(path.join(repo, ".agent", "hygiene", "facts.json")));
    const decomposition = refreshed.checks.find((check) => check.check === "decomposition");
    assert.equal(decomposition.findings_count, 0);
    assert.equal(decomposition.candidate_count, 1);
    assert.equal(decomposition.meta.threshold, 410);
    assert.equal(decomposition.meta.thresholdKind, "review-trigger");
    assert.equal(decomposition.meta.oversized[0].symbolCount, 2);
    assert.ok(decomposition.meta.oversized[0].bytes > 0);
    assert.ok(decomposition.meta.oversized[0].largestSymbolLines >= 200);

    const fresh = run(repo, ["hygiene", "status", "--out", ".agent", "--json"]);
    assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
    assert.equal(JSON.parse(fresh.stdout).state, "fresh");

    const offline = run(repo, [
      "hygiene", "refresh", "--out", ".agent", "--only", "outdated,cargo_outdated", "--offline", "--json",
    ]);
    assert.equal(offline.status, 0, offline.stderr || offline.stdout);
    assert.ok(JSON.parse(offline.stdout).checks.every((check) => check.status === "skipped" && check.skip_reason === "offline mode"));

    fs.appendFileSync(path.join(repo, "src", "large.ts"), "// changed\n");
    const stale = run(repo, ["hygiene", "status", "--out", ".agent", "--json"]);
    assert.equal(stale.status, 2);
    assert.equal(JSON.parse(stale.stdout).state, "stale");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
