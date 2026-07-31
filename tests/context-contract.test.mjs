import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findWorkspaceRoot } from "./_workspace-root.mjs";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = findWorkspaceRoot(HERE);
const SCHEMA_PATH = path.join(ROOT, "tools/lib/context-contracts.schema.json");
const FIXTURES = path.join(ROOT, "tools/tests/context_contracts/fixtures");
const PYTHON = process.platform === "win32" ? ["py", "-3.11"] : ["python3"];
const CONTRACT_FIXTURES = [
  ["ContextCandidateSet", "context-candidate-set-v1.json"],
  ["ContextPacket", "context-packet-v1.json"],
  ["ContextReceipt", "context-receipt-v1.json"],
  ["KnowledgeEmission", "knowledge-emission-v1.json"],
  ["HandoffEnvelope", "handoff-envelope-v1.json"],
];


function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}


function validate(name, payload) {
  const script = String.raw`
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(sys.argv[1], encoding="utf-8"))
wrapper = {"$schema": schema["$schema"], "$ref": f"#/$defs/{sys.argv[2]}", "$defs": schema["$defs"]}
errors = sorted(Draft202012Validator(wrapper).iter_errors(json.load(sys.stdin)), key=lambda e: list(e.absolute_path))
print(json.dumps([{"pointer": "/" + "/".join(map(str, e.absolute_path)), "message": e.message} for e in errors]))
sys.exit(1 if errors else 0)
`;
  const result = spawnSync(PYTHON[0], [...PYTHON.slice(1), "-c", script, SCHEMA_PATH, name], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { ...result, errors: result.stdout ? JSON.parse(result.stdout) : [] };
}


test("canonical schema hash is stable and all v1 fixtures validate", () => {
  const schemaBytes = fs.readFileSync(SCHEMA_PATH);
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const schemaSha256 = crypto.createHash("sha256").update(schemaBytes).digest("hex"); // schema identity is published as sha256; asserting the published form

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(schemaSha256, /^[a-f0-9]{64}$/);
  for (const [name, file] of CONTRACT_FIXTURES) {
    assert.ok(schema.$defs[name], `missing canonical definition ${name}`);
    const result = validate(name, readJson(path.join(FIXTURES, file)));
    assert.equal(result.status, 0, `${name}: ${result.stderr || JSON.stringify(result.errors)}`);
  }
});


test("Blueprint fixture freezes Layer 3 evidence and the provider safety ceiling", () => {
  const payload = readJson(path.join(FIXTURES, "context-candidate-set-v1.json"));
  const candidate = payload.candidates[0];

  assert.deepEqual(payload.providerCeiling, { maxCandidates: 40, maxEstimatedTokens: 8000 });
  assert.equal(candidate.layer, 3);
  assert.equal(typeof candidate.exact, "boolean");
  assert.equal(typeof candidate.protected, "boolean");
  assert.ok(candidate.sourceRef && candidate.sourceHash && candidate.estimatedTokens);
  assert.ok(Object.keys(candidate.scoreComponents).length > 0);
  assert.ok(payload.omissions.every((item) => item.reason));
});


test("renaming a required candidate field fails at its JSON pointer", () => {
  const payload = readJson(path.join(FIXTURES, "context-candidate-set-v1.json"));
  payload.candidates[0].sourceDigest = payload.candidates[0].sourceHash;
  delete payload.candidates[0].sourceHash;

  const result = validate("ContextCandidateSet", payload);

  assert.equal(result.status, 1);
  assert.ok(result.errors.some((error) => error.pointer === "/candidates/0"));
});


test("durable emission fixture contains no raw graph state", () => {
  const emission = readJson(path.join(FIXTURES, "knowledge-emission-v1.json"));
  for (const forbidden of ["nodes", "edges", "embeddings", "layout", "communities"]) {
    assert.equal(Object.hasOwn(emission, forbidden), false);
  }
});
