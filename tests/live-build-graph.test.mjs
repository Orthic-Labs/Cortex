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
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.name", "Test"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo }).status, 0);
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
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
    assert.equal(manifest.generation.baseCommit, baseCommit);
    const map = JSON.parse(fs.readFileSync(path.join(repo, ".agent/map.json"), "utf8"));
    assert.equal(map.entrypoint, ".blueprint/manifest.json");

    fs.appendFileSync(path.join(repo, "src/service.ts"), "\n// dirty overlay\n", "utf8");
    const dirtyBuild = spawnSync(process.execPath, [CLI, "build", "--out", ".agent", "--check"], { cwd: repo, encoding: "utf8" });
    assert.notEqual(dirtyBuild.status, 0);
    assert.match(dirtyBuild.stderr, /graph_build_deferred_dirty/);
    const dirtyManifest = JSON.parse(fs.readFileSync(path.join(repo, ".blueprint/manifest.json"), "utf8"));
    assert.equal(dirtyManifest.generation.baseCommit, baseCommit);
    assert.equal(dirtyManifest.generation.sourceState, "clean");

    assert.equal(spawnSync("git", ["restore", "src/service.ts"], { cwd: repo }).status, 0);
    fs.rmSync(path.join(repo, ".agent/graph"), { recursive: true, force: true });
    const rerun = spawnSync(process.execPath, [CLI], { cwd: repo, encoding: "utf8" });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.match(rerun.stdout, /built .agent\/map.json/);
    assert.ok(fs.existsSync(path.join(repo, ".agent/graph/manifest.json")), "graph manifest must be rebuilt by bare command");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("build stays fresh when tracked generated docs are rewritten", () => {
  const repo = path.join(os.tmpdir(), `blueprint-generated-docs-${process.pid}-${Date.now()}`);
  fs.cpSync(FIXTURE, repo, { recursive: true });
  try {
    fs.renameSync(path.join(repo, "docs/ARCHITECTURE.md"), path.join(repo, "docs/design.md"));
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.name", "Test"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo }).status, 0);

    const first = spawnSync(process.execPath, [CLI, "build", "--out", ".agent"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(spawnSync("git", [
      "add", "-f", ".agent", ".blueprint", "docs/product.md", "docs/architecture.md",
    ], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["commit", "--quiet", "-m", "track generated docs"], { cwd: repo }).status, 0);

    fs.appendFileSync(path.join(repo, "src/service.ts"), "\nexport const changed = true;\n", "utf8");
    assert.equal(spawnSync("git", ["add", "src/service.ts"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["commit", "--quiet", "-m", "change source"], { cwd: repo }).status, 0);

    const second = spawnSync(process.execPath, [CLI, "build", "--out", ".agent"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const status = spawnSync(process.execPath, [CLI, "graph", "status", "--out", ".agent"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".blueprint/manifest.json"), "utf8"));
    assert.equal(manifest.generation.sourceState, "clean");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
