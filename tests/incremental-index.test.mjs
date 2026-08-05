// B2.2 hard gate — incremental indexing and freshness.
//
// The plan (docs/plans/2026-07-10-cortex-code-graph-visual-explorer-impl.md
// §8) named this file as B2's gate and it was never written, so B2 shipped
// ungated. These tests pin the two correctness properties the incremental path
// depends on:
//   1. extractCallNames is EXACTLY equivalent to containsCall over the domain of
//      real symbol names — otherwise the incrementally-resolved graph would differ
//      from a full rebuild.
//   2. The parse cache reuses byte-identical files, reparses changed/added files,
//      and drops deleted files (no ghost records).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXXHash128 } from "hash-wasm";

const xxhasher = await createXXHash128();

function xxh3Hex(value) {
  xxhasher.init();
  xxhasher.update(value);
  return xxhasher.digest("hex");
}
import { execFileSync } from "node:child_process";

import {
  containsCall,
  extractCallNames,
  extractSymbols,
} from "../graph/language-extractors.mjs";
import { buildGraphGeneration, readGeneration } from "../graph/static-provider.mjs";
import {
  PARSE_CACHE_VERSION,
  emptyCache,
  loadParseCache,
  writeParseCache,
  diffFiles,
  nextCache,
} from "../graph/parse-cache.mjs";

function fileOf(path, text) {
  return {
    path,
    contentHash: xxh3Hex(text),
    lines: text.split(/\r?\n/),
  };
}

// ---- Property 1: extractCallNames === containsCall over the symbol domain ------

test("extractCallNames matches containsCall for every symbol name (JS/TS)", () => {
  const text = [
    "function foo() { return 1; }",
    "const bar = () => baz();",
    "class C { method() { this.foo(); obj.bar(); } }",
    "notCalledIdentifier; alsoNot.property;",
  ].join("\n");
  const file = fileOf("a.ts", text);
  const body = file.lines.join("\n");
  const { names } = extractCallNames(file, body);
  const nameSet = new Set(names);
  for (const candidate of ["foo", "baz", "bar", "method", "notCalledIdentifier", "alsoNot", "property"]) {
    assert.equal(
      nameSet.has(candidate),
      containsCall(file, body, candidate),
      `disagreement on "${candidate}"`,
    );
  }
});

test("extractCallNames honors case-insensitive dialects (bat/vbs/nsis)", () => {
  const bat = fileOf("x.bat", "call :DoWork\ncall :Other_Thing\nrem call :nope");
  const batBody = bat.lines.join("\n");
  const batNames = extractCallNames(bat, batBody);
  assert.equal(batNames.caseInsensitive, true);
  // containsCall is case-insensitive for .bat; the harvested set must resolve the same
  for (const candidate of ["DoWork", "dowork", "DOWORK", "Other_Thing", "nope"]) {
    const got = batNames.names.some((n) => n.toLowerCase() === candidate.toLowerCase());
    assert.equal(got, containsCall(bat, batBody, candidate), `bat "${candidate}"`);
  }

  const vbs = fileOf("y.vbs", "Call DoIt(1)\nOther(2)\nCall Third()");
  const vbsBody = vbs.lines.join("\n");
  const vbsNames = extractCallNames(vbs, vbsBody);
  for (const candidate of ["DoIt", "doit", "Other", "Third"]) {
    const got = vbsNames.names.some((n) => n.toLowerCase() === candidate.toLowerCase());
    assert.equal(got, containsCall(vbs, vbsBody, candidate), `vbs "${candidate}"`);
  }
});

test("extractCallNames matches containsCall over a self-extracted symbol domain", () => {
  // Use the extractor's own symbol output as the candidate domain — the only names
  // resolution ever queries — and assert exact agreement, the real invariant.
  const text = [
    "export function alpha() { beta(); }",
    "function beta() { gamma(); }",
    "function gamma() { return alpha(); }",
    "const unusedConst = 5;",
  ].join("\n");
  const file = fileOf("m.ts", text);
  const body = file.lines.join("\n");
  const symbolNames = new Set();
  extractSymbols(file, (n) => {
    symbolNames.add(String(n.qualifiedName ?? n.name).split(".").at(-1));
    return n;
  });
  const harvested = new Set(extractCallNames(file, body).names);
  for (const name of symbolNames) {
    assert.equal(harvested.has(name), containsCall(file, body, name), `symbol "${name}"`);
  }
});

// ---- Property 2: cache diff semantics (edit / add / delete / version) ----------

function withTempOut(run) {
  const dir = mkdtempSync(join(tmpdir(), "bp-parsecache-"));
  try {
    mkdirSync(join(dir, "graph"), { recursive: true });
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("diffFiles reuses byte-identical files and reparses changed ones", () => {
  const a1 = fileOf("a.ts", "const a = 1;");
  const b1 = fileOf("b.ts", "const b = 2;");
  const cache = nextCache([
    { path: "a.ts", record: { contentHash: a1.contentHash, symbols: [] } },
    { path: "b.ts", record: { contentHash: b1.contentHash, symbols: [] } },
  ]);

  // b changes, a unchanged, c is new
  const a2 = fileOf("a.ts", "const a = 1;");
  const b2 = fileOf("b.ts", "const b = 999;");
  const c2 = fileOf("c.ts", "const c = 3;");
  const { reused, changed } = diffFiles([a2, b2, c2], cache);

  assert.deepEqual(reused.map((r) => r.file.path), ["a.ts"]);
  assert.deepEqual(changed.map((f) => f.path).sort(), ["b.ts", "c.ts"]);
});

test("nextCache drops deleted files (no ghost records)", () => {
  const cache = nextCache([
    { path: "keep.ts", record: { contentHash: "h1", symbols: [] } },
    { path: "gone.ts", record: { contentHash: "h2", symbols: [] } },
  ]);
  // Rebuild the cache from the surviving file set only.
  const survivors = nextCache([{ path: "keep.ts", record: cache.records.get("keep.ts") }]);
  assert.ok(survivors.records.has("keep.ts"));
  assert.ok(!survivors.records.has("gone.ts"));
});

test("loadParseCache round-trips through atomic write", () => {
  withTempOut((dir) => {
    const cache = nextCache([{ path: "a.ts", record: { contentHash: "abc", symbols: [{ id: "s1" }] } }]);
    writeParseCache(dir, cache);
    const loaded = loadParseCache(dir);
    assert.equal(loaded.version, PARSE_CACHE_VERSION);
    assert.equal(loaded.records.get("a.ts").contentHash, "abc");
    assert.deepEqual(loaded.records.get("a.ts").symbols, [{ id: "s1" }]);
  });
});

test("a version mismatch invalidates the whole cache (fail closed to reparse)", () => {
  withTempOut((dir) => {
    const cache = nextCache([{ path: "a.ts", record: { contentHash: "abc" } }]);
    writeParseCache(dir, cache);
    // Corrupt the version on disk.
    const path = join(dir, "graph", "parse-cache", "records.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.version = PARSE_CACHE_VERSION + 99;
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadParseCache(dir);
    assert.equal(loaded.records.size, 0, "stale-shape cache must be discarded");
  });
});

test("a corrupt cache file loads as empty, not a throw", () => {
  withTempOut((dir) => {
    const path = join(dir, "graph", "parse-cache", "records.json");
    mkdirSync(join(dir, "graph", "parse-cache"), { recursive: true });
    writeFileSync(path, "{ not valid json ");
    const loaded = loadParseCache(dir);
    assert.equal(loaded.records.size, 0);
  });
});

test("emptyCache is a valid, empty starting point", () => {
  const cache = emptyCache();
  assert.equal(cache.version, PARSE_CACHE_VERSION);
  assert.equal(cache.records.size, 0);
});

// ---- Property 3: the generation is a single stable file, not a growing dir ------

test("the generation is one store (graph/graph.db), with no JSON twin and no content-addressed dir", () => {
  const root = mkdtempSync(join(tmpdir(), "bp-prune-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const write = (name, text) => writeFileSync(join(root, name), text);
    write("a.ts", "export function one() { return 1; }");
    execFileSync("git", ["add", "-A"], { cwd: root });
    buildGraphGeneration(root, { outDir: ".agent", persist: true });
    write("a.ts", "export function two() { return 2; }");
    execFileSync("git", ["add", "-A"], { cwd: root });
    buildGraphGeneration(root, { outDir: ".agent", persist: true });
    const graphDir = join(root, ".agent", "graph");
    // The one store exists and holds the current generation…
    assert.ok(existsSync(join(graphDir, "graph.db")), "graph/graph.db must exist");
    const generation = readGeneration(root, ".agent");
    assert.ok(generation.nodes.some((n) => n.id === "symbol:a.ts::two"), "the store holds the current generation");
    // …with no second copy of the same data in any other format…
    assert.ok(!existsSync(join(graphDir, "graph.json")), "no JSON twin of the generation");
    assert.ok(!existsSync(join(graphDir, "manifest.json")), "no JSON twin of the manifest");
    // …and the legacy per-build content-addressed directory is gone.
    assert.ok(!existsSync(join(graphDir, "generations")), "no content-addressed generations/ dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Property 4: cache-warm build is byte-identical to a cold build -------------

test("a cache-warm rebuild is byte-identical to the cold build", () => {
  const root = mkdtempSync(join(tmpdir(), "bp-identity-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.ts"), 'import { helper } from "./b";\nexport function caller() { return helper(); }\n');
    writeFileSync(join(root, "b.ts"), "export function helper() { return 1; }\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const cold = buildGraphGeneration(root, { outDir: ".agent", persist: true }); // writes cache
    const warm = buildGraphGeneration(root, { outDir: ".agent", persist: true }); // reuses cache
    assert.equal(JSON.stringify(cold.nodes), JSON.stringify(warm.nodes), "nodes drift between cold and warm");
    assert.equal(JSON.stringify(cold.edges), JSON.stringify(warm.edges), "edges drift between cold and warm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Property 5: incremental rebuild == cold rebuild of the same final state ----
// The no-ghost-edge guarantee: a rename in one file must drop the stale edge from
// an UNCHANGED caller that is served from cache.

test("incremental rebuild after a rename equals a cold rebuild (no ghost edge)", () => {
  const build = (root, files) => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    execFileSync("git", ["add", "-A"], { cwd: root });
    return buildGraphGeneration(root, { outDir: ".agent", persist: true });
  };
  const incRoot = mkdtempSync(join(tmpdir(), "bp-inc-"));
  const coldRoot = mkdtempSync(join(tmpdir(), "bp-cold-"));
  try {
    const caller = 'import { helper } from "./b";\nexport function caller() { return helper(); }\n';
    build(incRoot, { "a.ts": caller, "b.ts": "export function helper() { return 1; }\n" });
    // Rename the callee; a.ts (the caller) is untouched and will be served from cache.
    writeFileSync(join(incRoot, "b.ts"), "export function helperRenamed() { return 1; }\n");
    const incremental = buildGraphGeneration(incRoot, { outDir: ".agent", persist: true });

    const coldFinal = build(coldRoot, { "a.ts": caller, "b.ts": "export function helperRenamed() { return 1; }\n" });

    assert.deepEqual(
      incremental.edges.map((e) => e.id).sort(),
      coldFinal.edges.map((e) => e.id).sort(),
      "incremental edges diverge from a cold rebuild of the same state",
    );
    const ghost = incremental.edges.some((e) => e.kind === "CALLS" && e.id.includes("::helper") && !e.id.includes("helperRenamed"));
    assert.equal(ghost, false, "stale CALLS edge to the renamed symbol survived incrementally");
  } finally {
    rmSync(incRoot, { recursive: true, force: true });
    rmSync(coldRoot, { recursive: true, force: true });
  }
});
