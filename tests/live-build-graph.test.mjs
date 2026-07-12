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
    assert.ok(fs.existsSync(path.join(repo, ".agent/map.json")), "map.json must exist");
    assert.ok(fs.existsSync(path.join(repo, ".agent/graph/manifest.json")), "graph manifest must exist");
    assert.ok(fs.existsSync(path.join(repo, ".agent/flows.json")), "flows.json must exist");
    assert.ok(fs.existsSync(path.join(repo, ".blueprint/manifest.json")), ".blueprint/manifest.json must exist");
    assert.equal(fs.existsSync(path.join(repo, ".agent/START-HERE.md")), false, "START-HERE.md must NOT exist (retired)");
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".blueprint/manifest.json"), "utf8"));
    assert.equal(manifest.entrypoint, ".agent/");
    assert.equal(manifest.generation.provider ?? manifest.generation.toolVersions?.blueprint ?? null, "blueprint-static");
    const map = JSON.parse(fs.readFileSync(path.join(repo, ".agent/map.json"), "utf8"));
    assert.equal(map.entrypoint, ".blueprint/manifest.json");

    fs.rmSync(path.join(repo, ".agent/graph"), { recursive: true, force: true });
    const rerun = spawnSync(process.execPath, [CLI], { cwd: repo, encoding: "utf8" });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.match(rerun.stdout, /built .agent\/map.json/);
    assert.ok(fs.existsSync(path.join(repo, ".agent/graph/manifest.json")), "graph manifest must be rebuilt by bare command");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
