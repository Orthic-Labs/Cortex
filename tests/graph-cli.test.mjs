import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLUEPRINT = path.resolve(HERE, "..");
const CLI = path.join(BLUEPRINT, "scripts/blueprint.mjs");
const FIXTURE = path.join(BLUEPRINT, "evals/fixture-repos/typescript-commerce");

function copyFixture() {
  const dir = path.join(os.tmpdir(), `blueprint-graph-cli-${process.pid}-${Date.now()}`);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

test("blueprint graph build/status/search works from a repo root", () => {
  const repo = copyFixture();
  try {
    const build = run(["graph", "build", "--out", ".agent"], repo);
    assert.equal(build.status, 0, build.stderr);
    assert.match(build.stdout, /graph built .agent\/graph\/manifest.json/);
    assert.ok(fs.existsSync(path.join(repo, ".agent/graph/manifest.json")));

    const status = run(["graph", "status", "--out", ".agent"], repo);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /graph fresh provider=blueprint-static/);

    const search = run(["graph", "search", "--query", "placeOrder", "--out", ".agent", "--limit", "3"], repo);
    assert.equal(search.status, 0, search.stderr);
    const payload = JSON.parse(search.stdout);
    assert.equal(payload.results[0].evidence[0].path, "src/service.ts");

    const fullBuild = run(["build", "--out", ".agent"], repo);
    assert.equal(fullBuild.status, 0, fullBuild.stderr || fullBuild.stdout);
    const doctor = run(["doctor", "--out", ".agent"], repo);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.state, "ready");
    assert.deepEqual(doctorPayload.capabilities.languageCoverage.parsedExtensions, [
      "astro", "bat", "cjs", "cts", "js", "jsx", "mjs", "mts", "ps1", "py", "rs", "sh", "swift", "ts", "tsx", "vbs", "vue",
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("blueprint graph status exits distinctly when no generation exists", () => {
  const repo = copyFixture();
  try {
    const status = run(["graph", "status", "--out", ".agent"], repo);
    assert.equal(status.status, 2);
    assert.match(status.stdout, /graph missing/);

    const doctor = run(["doctor", "--out", ".agent"], repo);
    assert.equal(doctor.status, 2);
    assert.equal(JSON.parse(doctor.stdout).state, "missing");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
