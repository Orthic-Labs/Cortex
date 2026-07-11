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

test("regular blueprint build writes graph and flow artifacts beside bootstrap map", () => {
  const repo = path.join(os.tmpdir(), `blueprint-live-build-${process.pid}-${Date.now()}`);
  fs.cpSync(FIXTURE, repo, { recursive: true });
  try {
    const result = spawnSync(process.execPath, [CLI, "build", "--out", ".agent", "--check"], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(path.join(repo, ".agent/map.json")));
    assert.ok(fs.existsSync(path.join(repo, ".agent/graph/manifest.json")));
    assert.ok(fs.existsSync(path.join(repo, ".agent/flows.json")));
    const startHere = fs.readFileSync(path.join(repo, ".agent/START-HERE.md"), "utf8");
    assert.match(startHere, /Code Graph/);
    assert.match(startHere, /Provider: `blueprint-static`/);

    fs.rmSync(path.join(repo, ".agent/graph"), { recursive: true, force: true });
    const rerun = spawnSync(process.execPath, [CLI], { cwd: repo, encoding: "utf8" });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.match(rerun.stdout, /built .agent\/map.json/);
    assert.ok(fs.existsSync(path.join(repo, ".agent/graph/manifest.json")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
