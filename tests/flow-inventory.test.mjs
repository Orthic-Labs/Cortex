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

test("graph flows emits deterministic entry-to-terminal inventory", () => {
  const repo = path.join(os.tmpdir(), `blueprint-flow-${process.pid}-${Date.now()}`);
  fs.cpSync(FIXTURE, repo, { recursive: true });
  try {
    const result = spawnSync(process.execPath, [CLI, "graph", "flows", "--out", ".agent"], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.provider, "blueprint-static");
    assert.ok(payload.flows.some((flow) => (
      flow.entry.id === "symbol:src/routes.ts::registerOrderRoute"
      && flow.status === "complete"
      && flow.path.some((node) => node.id === "symbol:src/store.ts::OrderStore.save")
    )));
    assert.ok(fs.existsSync(path.join(repo, ".agent/flows.json")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
