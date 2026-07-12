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
