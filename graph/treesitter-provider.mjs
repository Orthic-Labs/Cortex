// Tree-sitter AST code provider — standalone, NOT wired into the live graph
// build yet (see graph/static-provider.mjs, which remains the deterministic
// lexical provider actually driving `blueprint build`). This module exists so
// a future wiring step can swap providers without redesigning the schema: the
// node/edge shapes below intentionally mirror static-provider.mjs's output
// exactly (see "OUTPUT SHAPE" below), extended only with additive fields.
//
// Runtime: `web-tree-sitter` (WASM) + prebuilt grammars from `tree-sitter-wasms`.
// Both are workspace devDependencies already installed under tools/node_modules;
// this module installs nothing and has no native (node-gyp) dependency, so it
// runs unmodified on Windows and Mac.
//
// ---------------------------------------------------------------------------
// GRAMMAR/RUNTIME ABI MISMATCH — discovered while building this module, fixed
// in-module, documented here so nobody "fixes" it again by installing packages.
//
// tree-sitter-wasms@0.1.13's prebuilt .wasm grammars were compiled with
// tree-sitter-cli ^0.20.8 (2023-era Emscripten), which emits a LEGACY
// WebAssembly dynamic-linking custom section literally named "dylink".
// web-tree-sitter@0.26.11's loader hard-requires the modern section name
// "dylink.0" (see WASM_DYLINK_MEM_INFO handling in Language.load) and throws
// an opaque, message-less Error otherwise. Loading any grammar file as-is
// fails 100% of the time in this environment — verified against all 5 tier-1
// grammar files before writing a single line of extraction logic.
//
// Both binary section formats are part of the public, stable
// WebAssembly/tool-conventions "dylink" spec; the legacy form carries the
// exact same fields (memory size/align, table size/align, needed-library
// list) as the new WASM_DYLINK_MEM_INFO/WASM_DYLINK_NEEDED subsections, just
// packed flat instead of subsectioned. `upgradeDylinkSection` below losslessly
// transcodes legacy -> modern in memory, at load time, so no on-disk grammar
// file is modified and no new dependency is introduced. Verified empirically:
// all 5 tier-1 grammars (js/ts/tsx/python/rust) load and parse correctly
// (hasError=false on valid input) after this transcode, at reported
// language.abiVersion 14, which web-tree-sitter@0.26.11 accepts.
// ---------------------------------------------------------------------------
//
// OUTPUT SHAPE (mirrors static-provider.mjs's generation nodes/edges exactly):
//
// Node:
//   {
//     id: "file:<path>" | "symbol:<path>::<qualifiedName>",
//     kind: "file" | "symbol" | "class",
//     labels: string[],          // e.g. ["File"], ["Function"], ["Method"],
//                                 // ["Class"], ["Class","Struct"|"Trait"|"Enum"],
//                                 // ["Interface"], ["TypeAlias"], ["Test"]
//     name: string,
//     qualifiedName: string,     // dotted path within file, e.g. "Widget.render"
//     path: string,              // normalized forward-slash repo-relative path
//     confidence: number,        // 1 for an `ok` parse; discounted under `partial`
//     evidence: [{ path, startLine, endLine, contentHash }],  // 1-based, AST-derived
//   }
//
// Edge (core fields identical to static-provider; `resolved`/`specifier` are
// additive fields absent from the lexical provider — a consumer that only
// reads {id,kind,source,target,confidence,evidence} still works unmodified):
//   {
//     id: "edge:<KIND>:<sourceId>-><targetId|unresolved:specifier>",
//     kind: "CONTAINS" | "DEFINES" | "IMPORTS" | "CALLS" | "TESTS",
//     source: nodeId,
//     target: nodeId | null,     // null exactly when resolved === false
//     confidence: number,
//     resolved: boolean,         // IMPORTS only; always true for the others
//     specifier: string | null,  // IMPORTS only — the raw literal that was (not) resolved
//     evidence: [{ path, startLine, endLine, contentHash }],
//   }
//
// CONTAINS vs DEFINES (both requested by spec; static-provider emits neither,
// so there is no existing convention to match — this is where the AST
// provider is a strict superset, not a drop-in-identical replay):
//   CONTAINS — file -> its direct top-level declarations (physical nesting).
//   DEFINES  — a class/struct/trait/impl -> its member methods (type membership,
//              one level deeper than physical file nesting).
//
// Per-file parse-quality report (required by spec):
//   { path, language, provider, grammar, parseStatus, errorNodeCount }
//   parseStatus is "ok" | "partial" | "failed" for any file this provider
//   attempted to parse, PLUS "unsupported" for a file whose extension is not
//   in the tier-1/tier-2 registry at all (a file we never attempted to parse
//   is categorically not the same claim as "we tried and it broke" — reporting
//   it as failed would be dishonest in the other direction). Rule for ok vs
//   partial vs failed: errorNodeCount is ERROR nodes + MISSING nodes found by
//   the parser's own error recovery; "ok" iff 0, "failed" iff >0 AND zero
//   symbol nodes were recoverable, otherwise "partial". Symbol nodes extracted
//   under "partial" get confidence 0.6 (not 1) so downstream ranking is honest
//   about the discount; "failed" files still emit a file node (confidence 0)
//   but zero symbol nodes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { createXXHash128, xxhash128 } from "hash-wasm";
import { EDGE_CONFIDENCE_TIERS, tierConfidence } from "./confidence-tiers.mjs";
import { PRECISION_TIERS } from "./precision-tiers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// graph/ -> blueprint/ -> skills/ -> tools/ -> node_modules/
const TOOLS_ROOT = join(HERE, "..", "..", "..");
const WASM_DIR = join(TOOLS_ROOT, "node_modules", "tree-sitter-wasms", "out");
const GRAMMAR_PACKAGE_JSON = join(TOOLS_ROOT, "node_modules", "tree-sitter-wasms", "package.json");

export const PROVIDER = {
  id: "blueprint-treesitter",
  version: "standalone-v1",
  license: "workspace-owned",
  precisionTier: PRECISION_TIERS.AST,
};

// Extension -> language descriptor. `dialect` selects which extractor runs;
// `tier` documents the spec's tier-1 set (JS/TS/TSX, Python, Rust) — anything
// else registered here is best-effort tier-2 and may extract less richly, but
// still returns a well-formed file node and an honest parseStatus rather than
// crashing (the "degrade gracefully" requirement).
const LANGUAGES = {
  ts: { id: "typescript", grammarFile: "tree-sitter-typescript.wasm", tier: 1, dialect: "ts" },
  mts: { id: "typescript", grammarFile: "tree-sitter-typescript.wasm", tier: 1, dialect: "ts" },
  cts: { id: "typescript", grammarFile: "tree-sitter-typescript.wasm", tier: 1, dialect: "ts" },
  tsx: { id: "tsx", grammarFile: "tree-sitter-tsx.wasm", tier: 1, dialect: "ts" },
  js: { id: "javascript", grammarFile: "tree-sitter-javascript.wasm", tier: 1, dialect: "js" },
  jsx: { id: "javascript", grammarFile: "tree-sitter-javascript.wasm", tier: 1, dialect: "js" },
  mjs: { id: "javascript", grammarFile: "tree-sitter-javascript.wasm", tier: 1, dialect: "js" },
  cjs: { id: "javascript", grammarFile: "tree-sitter-javascript.wasm", tier: 1, dialect: "js" },
  py: { id: "python", grammarFile: "tree-sitter-python.wasm", tier: 1, dialect: "python" },
  rs: { id: "rust", grammarFile: "tree-sitter-rust.wasm", tier: 1, dialect: "rust" },
};

export const SUPPORTED_EXTENSIONS = Object.keys(LANGUAGES).sort();
export const TIER1_LANGUAGE_IDS = [...new Set(Object.values(LANGUAGES).filter((entry) => entry.tier === 1).map((entry) => entry.id))].sort();

// ---------------------------------------------------------------------------
// WASM dylink-section transcoder (legacy "dylink" -> modern "dylink.0").
// Pure byte manipulation of a public, versioned binary format. No dependency.
// ---------------------------------------------------------------------------

function readULEB128(bytes, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, offset: pos };
}

function writeULEB128(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return Uint8Array.from(out);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

// Exported for direct unit testing. Returns the original bytes unchanged
// (upgraded:false) for anything that isn't the exact legacy shape this
// transcoder understands — a conservative, never-corrupt fallback: if the
// shape is unrecognized, Language.load() will fail on its own terms and that
// failure surfaces honestly as parseStatus "failed" rather than silently
// producing a corrupt module.
export function upgradeDylinkSection(bytes) {
  if (bytes.length < 9 || bytes[8] !== 0) {
    return { bytes, upgraded: false, reason: "no-leading-custom-section" };
  }
  let pos = 9;
  const sizeRead = readULEB128(bytes, pos);
  pos = sizeRead.offset;
  const contentStart = pos;
  const contentEnd = contentStart + sizeRead.value;
  if (contentEnd > bytes.length) {
    return { bytes, upgraded: false, reason: "truncated-section" };
  }
  const nameRead = readULEB128(bytes, pos);
  pos = nameRead.offset;
  const name = new TextDecoder().decode(bytes.slice(pos, pos + nameRead.value));
  pos += nameRead.value;
  if (name === "dylink.0") return { bytes, upgraded: false, reason: "already-modern" };
  if (name !== "dylink") return { bytes, upgraded: false, reason: `unknown-section-name:${name}` };

  const memSize = readULEB128(bytes, pos); pos = memSize.offset;
  const memAlign = readULEB128(bytes, pos); pos = memAlign.offset;
  const tableSize = readULEB128(bytes, pos); pos = tableSize.offset;
  const tableAlign = readULEB128(bytes, pos); pos = tableAlign.offset;
  const neededCount = readULEB128(bytes, pos); pos = neededCount.offset;
  const needed = [];
  for (let i = 0; i < neededCount.value; i += 1) {
    const lenRead = readULEB128(bytes, pos); pos = lenRead.offset;
    needed.push(new TextDecoder().decode(bytes.slice(pos, pos + lenRead.value)));
    pos += lenRead.value;
  }
  if (pos !== contentEnd) {
    return { bytes, upgraded: false, reason: `length-mismatch:${pos}!=${contentEnd}` };
  }

  const memInfoPayload = concatBytes(
    writeULEB128(memSize.value),
    writeULEB128(memAlign.value),
    writeULEB128(tableSize.value),
    writeULEB128(tableAlign.value),
  );
  const memInfoSub = concatBytes(Uint8Array.of(1), writeULEB128(memInfoPayload.length), memInfoPayload);
  let neededSub = new Uint8Array(0);
  if (needed.length > 0) {
    const nameParts = [writeULEB128(needed.length)];
    for (const libName of needed) {
      const nameBytes = new TextEncoder().encode(libName);
      nameParts.push(writeULEB128(nameBytes.length), nameBytes);
    }
    const neededPayload = concatBytes(...nameParts);
    neededSub = concatBytes(Uint8Array.of(2), writeULEB128(neededPayload.length), neededPayload);
  }
  const modernNameBytes = new TextEncoder().encode("dylink.0");
  const newContent = concatBytes(writeULEB128(modernNameBytes.length), modernNameBytes, memInfoSub, neededSub);
  const newSection = concatBytes(Uint8Array.of(0), writeULEB128(newContent.length), newContent);
  const head = bytes.slice(0, 8);
  const tail = bytes.slice(contentEnd);
  return { bytes: concatBytes(head, newSection, tail), upgraded: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Runtime init + per-language grammar loading/caching.
// ---------------------------------------------------------------------------

let runtimeInit = null;
function ensureRuntimeInit() {
  if (!runtimeInit) runtimeInit = Parser.init();
  return runtimeInit;
}

function readGrammarPackageInfo() {
  try {
    const pkg = JSON.parse(readFileSync(GRAMMAR_PACKAGE_JSON, "utf8"));
    return { name: pkg.name ?? "tree-sitter-wasms", version: pkg.version ?? "unknown" };
  } catch {
    return { name: "tree-sitter-wasms", version: "unknown" };
  }
}
const GRAMMAR_PACKAGE = readGrammarPackageInfo();

const languageCache = new Map(); // languageId -> { language, parser, grammar } | { error, grammar }

async function loadLanguageRecord(languageId) {
  if (languageCache.has(languageId)) return languageCache.get(languageId);
  const entry = Object.values(LANGUAGES).find((item) => item.id === languageId);
  if (!entry) {
    const missing = { error: `no grammar registered for language "${languageId}"`, grammar: null };
    languageCache.set(languageId, missing);
    return missing;
  }
  const wasmPath = join(WASM_DIR, entry.grammarFile);
  let raw;
  try {
    raw = readFileSync(wasmPath);
  } catch (error) {
    const failed = { error: `grammar file missing: ${wasmPath}: ${error.message}`, grammar: null };
    languageCache.set(languageId, failed);
    return failed;
  }
  const grammarHash = `xxhash128:${await xxhash128(raw)}`;
  const baseGrammarInfo = {
    package: GRAMMAR_PACKAGE.name,
    packageVersion: GRAMMAR_PACKAGE.version,
    file: entry.grammarFile,
    hash: grammarHash,
  };
  try {
    await ensureRuntimeInit();
    const upgrade = upgradeDylinkSection(new Uint8Array(raw));
    const language = await Language.load(upgrade.bytes);
    const parser = new Parser();
    parser.setLanguage(language);
    const record = {
      language,
      parser,
      grammar: { ...baseGrammarInfo, abiVersion: language.abiVersion, dylinkUpgraded: upgrade.upgraded },
    };
    languageCache.set(languageId, record);
    return record;
  } catch (error) {
    const failed = { error: String(error?.message || error || "Language.load failed"), grammar: baseGrammarInfo };
    languageCache.set(languageId, failed);
    return failed;
  }
}

// ---------------------------------------------------------------------------
// Shared node/edge builders (match static-provider's exact id/shape scheme).
// ---------------------------------------------------------------------------

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

// Sync XXH3-128, matching static-provider's `xxh128` exactly (raw hex, no
// prefix, over the UTF-8 bytes of the normalized text). `ensureContentHash` is
// called from synchronous evidence builders, so the streaming hasher is
// instantiated once here rather than using hash-wasm's async one-shot.
const xxhasher = await createXXHash128();

function xxh128(bytes) {
  xxhasher.init();
  xxhasher.update(bytes);
  return xxhasher.digest("hex");
}

// A `file` input is expected to look like static-provider's internal file
// record: { path, text, contentHash }. `contentHash` is accepted as given
// (callers already computing it their own way, e.g. the repo scanner) but if
// absent we derive it ourselves with the SAME algorithm static-provider uses
// (XXH3-128 raw hex over the UTF-8 bytes) so evidence.contentHash values are
// directly comparable across providers — this is the one place hash algorithm
// choice actually matters for drop-in compatibility. It was sha256 here after
// static-provider moved to XXH3, which silently broke exactly the comparability
// this comment promises: the two providers emitted different digests for
// identical bytes, so cross-provider evidence matching never hit.
function ensureContentHash(file) {
  if (file.contentHash) return file.contentHash;
  return xxh128(Buffer.from(file.text ?? "", "utf8"));
}

function fileEvidence(file, startLine, endLine) {
  return { path: file.path, startLine, endLine, contentHash: ensureContentHash(file) };
}

function buildFileNode(file) {
  const lineCount = Math.max(1, (file.text ?? "").split(/\r?\n/).length);
  return {
    id: `file:${file.path}`,
    kind: "file",
    labels: ["File"],
    name: file.path.split("/").at(-1),
    qualifiedName: file.path,
    path: file.path,
    confidence: 1,
    evidence: [fileEvidence(file, 1, lineCount)],
  };
}

function symbolNode(kind, file, name, qualifiedName, startRow, endRow, labels, confidence) {
  return {
    id: `symbol:${file.path}::${qualifiedName}`,
    kind,
    labels,
    name,
    qualifiedName,
    path: file.path,
    confidence,
    evidence: [fileEvidence(file, startRow + 1, endRow + 1)],
  };
}

// `tier` is REQUIRED — every AST-provider edge must be derived from how it
// was actually resolved (blueprint B3), never a hardcoded default. CONTAINS
// and DEFINES are exact structural facts straight from the parse tree, so
// their call sites always pass EXACT_RESOLUTION.
function edgeRecord(kind, sourceId, targetId, evidence, tier = EDGE_CONFIDENCE_TIERS.EXACT_RESOLUTION) {
  return {
    id: `edge:${kind}:${sourceId}->${targetId}`,
    kind,
    source: sourceId,
    target: targetId,
    confidence: tierConfidence(tier),
    confidenceTier: tier,
    resolved: true,
    specifier: null,
    evidence,
  };
}

function importEdgeRecord(sourceId, targetId, specifier, resolved, evidence) {
  const tier = resolved ? EDGE_CONFIDENCE_TIERS.EXACT_RESOLUTION : EDGE_CONFIDENCE_TIERS.UNRESOLVED;
  return {
    id: `edge:IMPORTS:${sourceId}->${resolved ? targetId : `unresolved:${specifier}`}`,
    kind: "IMPORTS",
    source: sourceId,
    target: resolved ? targetId : null,
    confidence: tierConfidence(tier),
    confidenceTier: tier,
    resolved,
    specifier,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Call-name harvesting (shared across dialects): walk a subtree and collect
// every call's callee short name, using the field convention for that
// dialect's call-expression node. Mirrors static-provider's
// extractCallNames/containsCall harvesting role, but reads the exact AST
// instead of guessing from text — no false positives from calls that appear
// inside comments or string literals, which the regex approach cannot avoid.
// ---------------------------------------------------------------------------

const CALL_CONFIG = {
  ts: { callType: "call_expression", calleeField: "function", memberField: "property" },
  js: { callType: "call_expression", calleeField: "function", memberField: "property" },
  python: { callType: "call", calleeField: "function", memberField: "attribute" },
  rust: { callType: "call_expression", calleeField: "function", memberField: "field" },
};

function collectCallNames(node, dialect) {
  const config = CALL_CONFIG[dialect];
  const names = [];
  if (!node || !config) return names;
  for (const callNode of node.descendantsOfType(config.callType)) {
    const callee = callNode.childForFieldName(config.calleeField);
    if (!callee) continue;
    if (callee.type === "identifier") {
      names.push(callee.text);
      continue;
    }
    // member_expression (JS/TS), attribute (Python), field_expression (Rust)
    const member = callee.childForFieldName(config.memberField);
    if (member) names.push(member.text);
  }
  return names;
}

// ---------------------------------------------------------------------------
// JS / TS / TSX extractor.
// ---------------------------------------------------------------------------

function extractJsLike(file, tree, dialect, confidenceForNode) {
  const nodes = [];
  const containsEdges = [];
  const definesEdges = [];
  const rawImports = [];
  const callSources = []; // { symbolId, node, isTest }
  // Module-level string constants naming a resource (path, table, file).
  // Resolved into CONFIGURES edges once the whole file set is known.
  const configuresTargets = [];
  const classNameNodeType = dialect === "js" ? "identifier" : "type_identifier";
  const fileNodeId = `file:${file.path}`;

  function unwrapExport(node) {
    if (node.type !== "export_statement") return node;
    return node.childForFieldName("declaration") ?? node;
  }

  function walkTop(node) {
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const raw = node.namedChild(i);
      const decl = unwrapExport(raw);
      if (!decl) continue;
      handleTopLevel(decl);
    }
  }

  function handleTopLevel(decl) {
    if (decl.type === "import_statement") {
      const source = decl.childForFieldName("source");
      if (source) rawImports.push({ specifier: stripQuotes(source.text), evidence: fileEvidence(file, decl.startPosition.row + 1, decl.endPosition.row + 1) });
      return;
    }
    if (decl.type === "function_declaration" || decl.type === "generator_function_declaration") {
      const nameNode = decl.childForFieldName("name");
      if (!nameNode) return;
      addFunctionLike(decl, nameNode.text, nameNode.text, ["Function"], fileNodeId, "CONTAINS");
      return;
    }
    if (decl.type === "class_declaration") {
      const nameNode = decl.childForFieldName("name");
      if (!nameNode) return;
      const className = nameNode.text;
      const classSymbol = symbolNode("class", file, className, className, decl.startPosition.row, decl.endPosition.row, ["Class"], confidenceForNode);
      nodes.push(classSymbol);
      containsEdges.push({ source: fileNodeId, target: classSymbol.id, evidence: classSymbol.evidence });
      const body = decl.childForFieldName("body");
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type !== "method_definition") continue;
          const methodNameNode = member.childForFieldName("name");
          if (!methodNameNode || methodNameNode.text === "constructor") {
            if (methodNameNode?.text === "constructor") {
              addFunctionLike(member, "constructor", `${className}.constructor`, ["Method"], classSymbol.id, "DEFINES");
            }
            continue;
          }
          addFunctionLike(member, methodNameNode.text, `${className}.${methodNameNode.text}`, ["Method"], classSymbol.id, "DEFINES");
        }
      }
      return;
    }
    if (dialect === "ts" && decl.type === "interface_declaration") {
      const nameNode = decl.childForFieldName("name");
      if (!nameNode) return;
      addTypeSymbol(decl, nameNode.text, ["Interface"], fileNodeId);
      return;
    }
    if (dialect === "ts" && decl.type === "type_alias_declaration") {
      const nameNode = decl.childForFieldName("name");
      if (!nameNode) return;
      addTypeSymbol(decl, nameNode.text, ["TypeAlias"], fileNodeId);
      return;
    }
    if (dialect === "ts" && decl.type === "enum_declaration") {
      const nameNode = decl.childForFieldName("name");
      if (!nameNode) return;
      addTypeSymbol(decl, nameNode.text, ["Enum"], fileNodeId);
      return;
    }
    if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
      for (const declarator of decl.namedChildren) {
        if (declarator.type !== "variable_declarator") continue;
        const nameNode = declarator.childForFieldName("name");
        const valueNode = declarator.childForFieldName("value");
        if (!nameNode || !valueNode) continue;
        if (valueNode.type === "arrow_function" || valueNode.type === "function_expression") {
          addFunctionLike(decl, nameNode.text, nameNode.text, ["Function"], fileNodeId, "CONTAINS", valueNode);
          continue;
        }
        // Non-function module-level bindings are real symbols too — config
        // constants, path/table/env names. Dropping them loses the whole
        // config-resource class (a const holding a resource path, and the
        // CONFIGURES edge to the file it names), which the lexical provider
        // does emit. Only top-level bindings are kept; locals inside a function
        // body are noise at graph scale.
        if (decl.parent && decl.parent.type !== "program" && decl.parent.type !== "export_statement") continue;
        addTypeSymbol(decl, nameNode.text, ["Constant"], fileNodeId);
        const literal = stringLiteralValue(valueNode);
        if (literal) configuresTargets.push({ name: nameNode.text, value: literal, node: decl });
      }
      return;
    }
    if (decl.type === "expression_statement") {
      const expr = decl.namedChild(0);
      if (expr && expr.type === "call_expression") maybeTestCall(expr, fileNodeId);
    }
  }

  /**
   * First string literal at or beneath a value node.
   *
   * Walks descendants rather than requiring the value to BE a literal, because
   * the dominant config idiom is a fallback expression —
   * `process.env.X ?? "resources/orders.json"` — where the resource name is
   * nested. Matching only bare literals misses essentially every real config
   * constant.
   */
  function stringLiteralValue(node, depth = 0) {
    if (!node || depth > 4) return null;
    if (node.type === "string" || node.type === "template_string") {
      const inner = (node.text ?? "").replace(/^[`'"]/, "").replace(/[`'"]$/, "");
      return inner.length ? inner : null;
    }
    for (const child of node.namedChildren ?? []) {
      const found = stringLiteralValue(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function addTypeSymbol(node, name, labels, containerId) {
    const node2 = symbolNode("symbol", file, name, name, node.startPosition.row, node.endPosition.row, labels, confidenceForNode);
    nodes.push(node2);
    containsEdges.push({ source: containerId, target: node2.id, evidence: node2.evidence });
  }

  function addFunctionLike(spanNode, name, qualifiedName, labels, containerId, edgeKind, bodyOverrideNode) {
    const node = symbolNode("symbol", file, name, qualifiedName, spanNode.startPosition.row, spanNode.endPosition.row, labels, confidenceForNode);
    nodes.push(node);
    (edgeKind === "CONTAINS" ? containsEdges : definesEdges).push({ source: containerId, target: node.id, evidence: node.evidence });
    const body = bodyOverrideNode ?? spanNode.childForFieldName("body");
    callSources.push({ symbolId: node.id, node: body ?? spanNode, isTest: false });
  }

  function maybeTestCall(callExpr, containerId) {
    const callee = callExpr.childForFieldName("function");
    if (!callee || callee.type !== "identifier" || !["test", "it"].includes(callee.text)) return;
    const args = callExpr.childForFieldName("arguments");
    const firstArg = args?.namedChild(0);
    if (!firstArg || firstArg.type !== "string") return;
    const label = stripQuotes(firstArg.text);
    const node = symbolNode("symbol", file, label, label, callExpr.startPosition.row, callExpr.endPosition.row, ["Test"], confidenceForNode);
    nodes.push(node);
    containsEdges.push({ source: containerId, target: node.id, evidence: node.evidence });
    callSources.push({ symbolId: node.id, node: callExpr, isTest: true });
  }

  walkTop(tree.rootNode);
  return { nodes, containsEdges, definesEdges, rawImports, callSources, configuresTargets, classNameNodeType };
}

function stripQuotes(text) {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && /^["'`]/.test(trimmed) && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Python extractor.
// ---------------------------------------------------------------------------

function extractPython(file, tree, confidenceForNode) {
  const nodes = [];
  const containsEdges = [];
  const definesEdges = [];
  const rawImports = [];
  const callSources = [];
  const fileNodeId = `file:${file.path}`;

  function handleImport(node) {
    if (node.type === "import_statement") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) rawImports.push({ specifier: nameNode.text, kind: "absolute", evidence: fileEvidence(file, node.startPosition.row + 1, node.endPosition.row + 1) });
      return;
    }
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (!moduleNode) return;
      if (moduleNode.type === "relative_import") {
        rawImports.push({ specifier: moduleNode.text, kind: "relative", evidence: fileEvidence(file, node.startPosition.row + 1, node.endPosition.row + 1) });
      } else {
        rawImports.push({ specifier: moduleNode.text, kind: "absolute", evidence: fileEvidence(file, node.startPosition.row + 1, node.endPosition.row + 1) });
      }
    }
  }

  function handleFunction(node, containerId, qualifiedPrefix, labelWhenNested) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const name = nameNode.text;
    const qualifiedName = qualifiedPrefix ? `${qualifiedPrefix}.${name}` : name;
    const isTest = !qualifiedPrefix && /^test_/.test(name);
    const labels = isTest ? ["Test"] : [qualifiedPrefix ? labelWhenNested : "Function"];
    const symbol = symbolNode("symbol", file, name, qualifiedName, node.startPosition.row, node.endPosition.row, labels, confidenceForNode);
    nodes.push(symbol);
    (qualifiedPrefix ? definesEdges : containsEdges).push({ source: containerId, target: symbol.id, evidence: symbol.evidence });
    const body = node.childForFieldName("body");
    callSources.push({ symbolId: symbol.id, node: body ?? node, isTest });
  }

  function handleClass(node, containerId) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nameNode.text;
    const classSymbol = symbolNode("class", file, className, className, node.startPosition.row, node.endPosition.row, ["Class"], confidenceForNode);
    nodes.push(classSymbol);
    containsEdges.push({ source: containerId, target: classSymbol.id, evidence: classSymbol.evidence });
    const body = node.childForFieldName("body");
    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === "function_definition") handleFunction(member, classSymbol.id, className, "Method");
        else if (member.type === "decorated_definition") {
          const defNode = member.namedChildren.find((child) => child.type === "function_definition");
          if (defNode) handleFunction(defNode, classSymbol.id, className, "Method");
        }
      }
    }
  }

  function walkTop(node) {
    for (const child of node.namedChildren) {
      if (child.type === "import_statement" || child.type === "import_from_statement") handleImport(child);
      else if (child.type === "function_definition") handleFunction(child, fileNodeId, null, "Function");
      else if (child.type === "class_definition") handleClass(child, fileNodeId);
      else if (child.type === "decorated_definition") {
        const inner = child.namedChildren.find((c) => c.type === "function_definition" || c.type === "class_definition");
        if (inner?.type === "function_definition") handleFunction(inner, fileNodeId, null, "Function");
        else if (inner?.type === "class_definition") handleClass(inner, fileNodeId);
      }
    }
  }

  walkTop(tree.rootNode);
  return { nodes, containsEdges, definesEdges, rawImports, callSources };
}

// ---------------------------------------------------------------------------
// Rust extractor.
// ---------------------------------------------------------------------------

function rustTypeName(text) {
  // impl blocks can be `impl Foo` or `impl Trait for Foo` — the type actually
  // being extended is the LAST type_identifier-shaped token before `{`. Using
  // the AST field (`type`) below already gives us exactly this for the
  // non-trait-impl case; for `impl Trait for Foo` we fall back to a plain
  // text scan since the grammar exposes both identifiers as separate
  // positional children without distinguishing field names in this build.
  const forMatch = text.match(/impl(?:\s*<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([\w:]+)/);
  return forMatch ? forMatch[1].split("::").at(-1) : null;
}

function extractRust(file, tree, confidenceForNode) {
  const nodes = [];
  const containsEdges = [];
  const definesEdges = [];
  const rawImports = [];
  const callSources = [];
  const fileNodeId = `file:${file.path}`;

  function handleUse(node) {
    rawImports.push({ specifier: node.text.replace(/^\s*pub\s+/, ""), kind: "use", evidence: fileEvidence(file, node.startPosition.row + 1, node.endPosition.row + 1) });
  }

  function handleMod(node) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    // `mod foo;` (no body) declares an external module file; `mod foo { .. }`
    // is an inline module and has nothing to resolve to a file.
    const hasBody = node.namedChildren.some((child) => child.type === "declaration_list");
    if (!hasBody) {
      rawImports.push({ specifier: nameNode.text, kind: "mod", evidence: fileEvidence(file, node.startPosition.row + 1, node.endPosition.row + 1) });
    }
  }

  function isTestFn(node) {
    const prev = node.previousNamedSibling;
    return Boolean(prev && prev.type === "attribute_item" && /\btest\b/.test(prev.text));
  }

  function handleFunctionItem(node, containerId, qualifiedPrefix, edgeKind) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const name = nameNode.text;
    const qualifiedName = qualifiedPrefix ? `${qualifiedPrefix}.${name}` : name;
    const isTest = isTestFn(node);
    const labels = isTest ? ["Test"] : [qualifiedPrefix ? "Method" : "Function"];
    const symbol = symbolNode("symbol", file, name, qualifiedName, node.startPosition.row, node.endPosition.row, labels, confidenceForNode);
    nodes.push(symbol);
    (edgeKind === "CONTAINS" ? containsEdges : definesEdges).push({ source: containerId, target: symbol.id, evidence: symbol.evidence });
    const body = node.childForFieldName("body");
    callSources.push({ symbolId: symbol.id, node: body ?? node, isTest });
  }

  function handleTypeItem(node, labels) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const typeName = nameNode.text;
    const symbol = symbolNode("class", file, typeName, typeName, node.startPosition.row, node.endPosition.row, labels, confidenceForNode);
    nodes.push(symbol);
    containsEdges.push({ source: fileNodeId, target: symbol.id, evidence: symbol.evidence });
    return symbol;
  }

  function handleImpl(node) {
    const typeName = rustTypeName(node.text.slice(0, node.text.indexOf("{") === -1 ? node.text.length : node.text.indexOf("{")));
    // Prefer an already-extracted struct/enum node for the same type name so
    // methods attach to the ONE class node representing that type, matching
    // static-provider's impl-stack qualification behavior.
    let ownerId = typeName ? `symbol:${file.path}::${typeName}` : null;
    if (typeName && !nodes.some((n) => n.id === ownerId)) {
      // No matching struct/enum in this file (e.g. impl for an imported type,
      // or a trait-for-Type impl on a type defined elsewhere) — still record
      // methods, qualified under the type name, attached to the file so they
      // are not silently dropped. This is a deliberate scope choice: cross-
      // file impl-target resolution is out of scope for this module.
      ownerId = fileNodeId;
    }
    const body = node.namedChildren.find((child) => child.type === "declaration_list");
    if (!body || !typeName) return;
    for (const member of body.namedChildren) {
      if (member.type === "function_item") {
        handleFunctionItem(member, ownerId, typeName, ownerId === fileNodeId ? "CONTAINS" : "DEFINES");
      }
    }
  }

  function walkTop(node) {
    for (const child of node.namedChildren) {
      if (child.type === "use_declaration") handleUse(child);
      else if (child.type === "mod_item") handleMod(child);
      else if (child.type === "function_item") handleFunctionItem(child, fileNodeId, null, "CONTAINS");
      else if (child.type === "struct_item") handleTypeItem(child, ["Class", "Struct"]);
      else if (child.type === "enum_item") handleTypeItem(child, ["Class", "Enum"]);
      else if (child.type === "trait_item") handleTypeItem(child, ["Class", "Trait"]);
      else if (child.type === "impl_item") handleImpl(child);
      else if (child.type === "mod_item") handleMod(child); // inline mod with body: no-op beyond declaration
    }
  }

  walkTop(tree.rootNode);
  return { nodes, containsEdges, definesEdges, rawImports, callSources };
}

// ---------------------------------------------------------------------------
// Per-file entry point.
// ---------------------------------------------------------------------------

function countErrorNodes(rootNode) {
  let count = rootNode.descendantsOfType("ERROR").length;
  // MISSING nodes (parser-inserted recovery tokens) are a second, distinct
  // error-recovery signal not covered by descendantsOfType("ERROR") — walk
  // once more for isMissing. Bounded by tree size; fine for source files.
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (node.isMissing) count += 1;
    for (let i = 0; i < node.childCount; i += 1) stack.push(node.child(i));
  }
  return count;
}

export async function extractFile(file) {
  const path = normalizePath(file.path);
  const normalizedFile = { ...file, path };
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  const entry = LANGUAGES[extension];
  const fileNode = buildFileNode(normalizedFile);

  if (!entry) {
    return {
      path, language: null, provider: PROVIDER.id, grammar: null,
      parseStatus: "unsupported", errorNodeCount: 0,
      nodes: [fileNode], edges: [],
    };
  }

  const record = await loadLanguageRecord(entry.id);
  if (!record.language) {
    return {
      path, language: entry.id, provider: PROVIDER.id, grammar: record.grammar,
      parseStatus: "failed", errorNodeCount: 0, error: record.error,
      nodes: [fileNode], edges: [],
    };
  }

  let tree;
  try {
    tree = record.parser.parse(normalizedFile.text ?? "");
  } catch (error) {
    return {
      path, language: entry.id, provider: PROVIDER.id, grammar: record.grammar,
      parseStatus: "failed", errorNodeCount: 0, error: String(error?.message || error),
      nodes: [fileNode], edges: [],
    };
  }

  const errorNodeCount = countErrorNodes(tree.rootNode);
  // Two-pass: extract once (confidence irrelevant yet) to see whether ANY
  // symbol node is recoverable, then decide parseStatus, then re-tag
  // confidence only for the "partial" case (re-running extraction is cheap —
  // these are single-file, already-parsed trees, not re-parses). "ok" reuses
  // the probe as-is (already confidence 1); "failed" reuses it too (already
  // zero nodes, so confidence is moot).
  const probe = runDialectExtractor(normalizedFile, tree, entry, 1);
  const gotSymbols = probe.nodes.length > 0;
  const parseStatus = errorNodeCount === 0 ? "ok" : gotSymbols ? "partial" : "failed";
  const confidence = parseStatus === "ok" ? 1 : parseStatus === "partial" ? 0.6 : 0;
  const extracted = parseStatus === "partial" ? runDialectExtractor(normalizedFile, tree, entry, confidence) : probe;

  const symbolNodes = parseStatus === "failed" ? [] : extracted.nodes;
  const containsEdges = parseStatus === "failed" ? [] : extracted.containsEdges;
  const definesEdges = parseStatus === "failed" ? [] : extracted.definesEdges;
  const rawImports = parseStatus === "failed" ? [] : extracted.rawImports;
  const callSources = parseStatus === "failed" ? [] : extracted.callSources;
  const configuresTargets = parseStatus === "failed" ? [] : (extracted.configuresTargets ?? []);

  const edges = [
    ...containsEdges.map((e) => edgeRecord("CONTAINS", e.source, e.target, [e.evidence])),
    ...definesEdges.map((e) => edgeRecord("DEFINES", e.source, e.target, [e.evidence])),
  ];

  const rawCalls = [];
  for (const source of callSources) {
    const names = collectCallNames(source.node, entry.dialect);
    for (const calleeName of names) rawCalls.push({ sourceId: source.symbolId, calleeName, isTest: source.isTest });
  }

  return {
    path,
    language: entry.id,
    provider: PROVIDER.id,
    grammar: record.grammar,
    parseStatus,
    errorNodeCount,
    configuresTargets,
    nodes: [fileNode, ...symbolNodes],
    edges,
    rawImports,
    rawCalls,
  };
}

function runDialectExtractor(file, tree, entry, confidence) {
  if (entry.dialect === "ts" || entry.dialect === "js") return extractJsLike(file, tree, entry.dialect, confidence);
  if (entry.dialect === "python") return extractPython(file, tree, confidence);
  if (entry.dialect === "rust") return extractRust(file, tree, confidence);
  return { nodes: [], containsEdges: [], definesEdges: [], rawImports: [], callSources: [] };
}

// ---------------------------------------------------------------------------
// Repo-level assembly: resolve imports against the given file set and resolve
// CALLS/TESTS edges against the global symbol index. Mirrors the resolution
// heuristic in static-provider.mjs's addCallEdges (same-file match preferred,
// then an imported-file match, then a single unambiguous global match),
// reimplemented independently here rather than imported, so this module has
// no runtime coupling to files owned by other in-flight work.
// ---------------------------------------------------------------------------

function resolveJsImport(sourcePath, specifier, filePathSet) {
  if (!specifier.startsWith(".")) return null;
  const baseDir = sourcePath.split("/").slice(0, -1);
  const raw = [...baseDir, ...specifier.split("/")].filter((part) => part && part !== ".");
  const parts = [];
  for (const part of raw) part === ".." ? parts.pop() : parts.push(part);
  const base = parts.join("/").replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, "");
  const candidates = [
    base,
    ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((ext) => `${base}.${ext}`),
    ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((ext) => `${base}/index.${ext}`),
  ];
  return candidates.find((candidate) => filePathSet.has(candidate)) ?? null;
}

function resolvePythonImport(sourcePath, specifier, kind, filePathSet) {
  const baseDir = sourcePath.split("/").slice(0, -1);
  if (kind === "relative") {
    const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
    const rest = specifier.slice(leadingDots).replace(/^\./, "");
    const moduleParts = rest.split(".").filter(Boolean);
    const relativeBase = baseDir.slice(0, Math.max(0, baseDir.length - (leadingDots - 1)));
    const candidateBase = [...relativeBase, ...moduleParts].join("/");
    const candidates = [`${candidateBase}.py`, `${candidateBase}/__init__.py`];
    return candidates.find((candidate) => filePathSet.has(candidate)) ?? null;
  }
  const moduleParts = specifier.split(".").filter(Boolean);
  const candidateBase = moduleParts.join("/");
  const candidates = [`${candidateBase}.py`, `${candidateBase}/__init__.py`];
  const direct = candidates.find((candidate) => filePathSet.has(candidate));
  if (direct) return direct;
  // Fall back to a suffix match anywhere in the tree (mirrors static-provider's
  // suffixModuleCandidates, for src-layout packages where the import root
  // isn't the repo root).
  const suffix = `/${candidateBase}.py`;
  const suffixInit = `/${candidateBase}/__init__.py`;
  for (const path of filePathSet) {
    if (path.endsWith(suffix) || path.endsWith(suffixInit)) return path;
  }
  return null;
}

function resolveRustImport(sourcePath, specifier, kind, filePathSet) {
  const baseDir = sourcePath.split("/").slice(0, -1);
  if (kind === "mod") {
    const candidates = [[...baseDir, `${specifier}.rs`].join("/"), [...baseDir, specifier, "mod.rs"].join("/")];
    return candidates.find((candidate) => filePathSet.has(candidate)) ?? null;
  }
  // kind === "use": take the first path segment after use/pub, skipping
  // crate/self/super, and look for a same-named module file anywhere in the
  // tree — a best-effort match, same scope limit static-provider accepts.
  const match = specifier.match(/^\s*use\s+(?:(?:crate|self|super)::)?([A-Za-z_]\w*)/);
  if (!match) return null;
  const name = match[1];
  const suffix = `/${name}.rs`;
  const suffixMod = `/${name}/mod.rs`;
  for (const path of filePathSet) {
    if (path === `${name}.rs` || path.endsWith(suffix) || path.endsWith(suffixMod)) return path;
  }
  return null;
}

function resolveImportSpecifier(sourcePath, imp, dialect, filePathSet) {
  if (dialect === "ts" || dialect === "js") return resolveJsImport(sourcePath, imp.specifier, filePathSet);
  if (dialect === "python") return resolvePythonImport(sourcePath, imp.specifier, imp.kind, filePathSet);
  if (dialect === "rust") return resolveRustImport(sourcePath, imp.specifier, imp.kind, filePathSet);
  return null;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Builds a full multi-file generation: parses every file, resolves imports
// against the given file set, and resolves CALLS/TESTS edges against the
// global symbol index. `files` = [{ path, text, contentHash? }, ...].
export async function buildTreeSitterGraph(files) {
  const normalizedFiles = files.map((file) => ({ ...file, path: normalizePath(file.path) }));
  const filePathSet = new Set(normalizedFiles.map((file) => file.path));
  const perFile = new Map(); // path -> extractFile() result
  const nodes = [];
  const edges = [];
  const fileReports = [];
  const symbolsByShortName = new Map();

  for (const file of normalizedFiles) {
    const report = await extractFile(file);
    perFile.set(file.path, report);
    nodes.push(...report.nodes);
    edges.push(...report.edges);
    fileReports.push({
      path: report.path,
      language: report.language,
      provider: report.provider,
      grammar: report.grammar,
      parseStatus: report.parseStatus,
      errorNodeCount: report.errorNodeCount,
      ...(report.error ? { error: report.error } : {}),
    });
    for (const node of report.nodes.slice(1)) {
      const shortName = node.qualifiedName.split(".").at(-1);
      const list = symbolsByShortName.get(shortName) ?? [];
      list.push(node);
      symbolsByShortName.set(shortName, list);
    }
  }

  const importedByFile = new Map();
  for (const file of normalizedFiles) {
    const report = perFile.get(file.path);
    const entry = LANGUAGES[file.path.includes(".") ? file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase() : ""];
    const dialect = entry?.dialect;
    const sourceId = `file:${file.path}`;
    const resolvedSet = new Set();
    for (const imp of report.rawImports ?? []) {
      const targetPath = dialect ? resolveImportSpecifier(file.path, imp, dialect, filePathSet) : null;
      const resolved = Boolean(targetPath);
      if (resolved) resolvedSet.add(targetPath);
      edges.push(importEdgeRecord(sourceId, resolved ? `file:${targetPath}` : null, imp.specifier, resolved, [imp.evidence]));
    }

    // CONFIGURES: a module-level string constant that names a real file in the
    // repo is a config->resource relationship. Only emitted when the literal
    // resolves to a tracked path — a constant holding an arbitrary string is
    // not a resource edge, and guessing would fabricate structure.
    for (const target of report.configuresTargets ?? []) {
      const literal = normalizePath(String(target.value).replace(/^\.\//, ""));
      const match = filePathSet.has(literal)
        ? literal
        : [...filePathSet].find((candidate) => candidate.endsWith(`/${literal}`) || candidate === literal);
      if (!match) continue;
      const constNode = report.nodes.find((n) => n.qualifiedName === target.name || n.name === target.name);
      if (!constNode) continue;
      // String-literal-to-filename match — a heuristic, not a resolved
      // binding (blueprint B3).
      const tier = EDGE_CONFIDENCE_TIERS.CROSS_FILE_HEURISTIC;
      edges.push({
        id: `edge:CONFIGURES:${constNode.id}->file:${match}`,
        kind: "CONFIGURES",
        source: constNode.id,
        target: `file:${match}`,
        confidence: tierConfidence(tier),
        confidenceTier: tier,
        resolved: true,
        evidence: constNode.evidence,
      });
    }
    importedByFile.set(file.path, resolvedSet);
  }

  for (const file of normalizedFiles) {
    const report = perFile.get(file.path);
    const imported = importedByFile.get(file.path) ?? new Set();
    const fileSymbolIds = new Set(report.nodes.slice(1).map((n) => n.id));
    for (const call of report.rawCalls ?? []) {
      const candidates = symbolsByShortName.get(call.calleeName) ?? [];
      const eligible = candidates.filter((c) => c.labels.includes("Function") || c.labels.includes("Method"));
      const sameFile = eligible.filter((c) => c.path === file.path && c.id !== call.sourceId);
      const importedMatches = eligible.filter((c) => imported.has(c.path) && c.id !== call.sourceId);
      const uniqueFallback = eligible.length === 1 && eligible[0].id !== call.sourceId ? eligible : [];
      // Tier DERIVED from which resolution strategy actually matched
      // (blueprint B3) — same-file name match is bounded; import-linked or
      // repo-wide-unique match crosses file boundaries on a heuristic.
      const [resolvedTargets, tier] = sameFile.length > 0
        ? [sameFile, EDGE_CONFIDENCE_TIERS.SAME_FILE_LEXICAL]
        : importedMatches.length > 0
          ? [importedMatches, EDGE_CONFIDENCE_TIERS.CROSS_FILE_HEURISTIC]
          : uniqueFallback.length > 0
            ? [uniqueFallback, EDGE_CONFIDENCE_TIERS.CROSS_FILE_HEURISTIC]
            : [[], null];
      const sourceNode = report.nodes.find((n) => n.id === call.sourceId);
      if (!sourceNode || !fileSymbolIds.has(call.sourceId)) continue;
      const kind = call.isTest ? "TESTS" : "CALLS";
      for (const target of resolvedTargets) {
        edges.push(edgeRecord(kind, sourceNode.id, target.id, sourceNode.evidence, tier));
      }
      // Ambiguous call: 2+ OTHER (non-self) candidates share this name and
      // none could be preferred. Tag UNRESOLVED and keep it — never silently
      // drop, never guess a candidate (blueprint B3). Excludes self so a
      // recursive call (a function calling itself, correctly unresolved to
      // "no OTHER candidate") isn't misreported as ambiguity.
      const otherEligible = eligible.filter((c) => c.id !== call.sourceId);
      if (resolvedTargets.length === 0 && otherEligible.length > 1) {
        edges.push({
          id: `edge:${kind}:${sourceNode.id}->unresolved:${call.calleeName}`,
          kind,
          source: sourceNode.id,
          target: null,
          confidence: tierConfidence(EDGE_CONFIDENCE_TIERS.UNRESOLVED),
          confidenceTier: EDGE_CONFIDENCE_TIERS.UNRESOLVED,
          resolved: false,
          specifier: call.calleeName,
          reason: `${otherEligible.length} candidate symbol(s) named "${call.calleeName}" exist repo-wide; none is in the same file or an imported file`,
          evidence: sourceNode.evidence,
        });
      }
    }
  }

  const cleanNodes = dedupeBy(nodes, (node) => node.id);
  const cleanEdges = dedupeBy(edges, (item) => `${item.kind}:${item.source}:${item.target ?? item.specifier}:${item.evidence?.[0]?.path ?? ""}`);

  return {
    schemaVersion: 1,
    provider: PROVIDER,
    nodes: cleanNodes,
    edges: cleanEdges,
    fileReports,
  };
}

export function graphCapabilities() {
  return {
    schemaVersion: 1,
    provider: PROVIDER,
    precisionTier: PROVIDER.precisionTier,
    grammarPackage: GRAMMAR_PACKAGE,
    supportedExtensions: SUPPORTED_EXTENSIONS,
    tier1Languages: TIER1_LANGUAGE_IDS,
    edgeKinds: ["CONTAINS", "DEFINES", "IMPORTS", "CALLS", "TESTS"],
  };
}

/**
 * Enrich a lexical graph generation with tree-sitter AST nodes/edges.
 *
 * UNION merge, never replacement: tree-sitter ids live in their own namespace
 * (`symbol:<path>::<name>` vs the lexical provider's `<path>::<name>`), so
 * nothing that references an existing lexical node — doc-code joins, verdict
 * evidence, candidate sets — can break. The AST layer is added alongside, with
 * per-file parse quality recorded honestly. Id unification is a listed
 * follow-up, not smuggled into this merge.
 *
 * The generation's identity (manifest.generationId) is computed from SOURCE
 * hashes, which augmentation does not change — so freshness semantics are
 * untouched.
 */
export async function augmentGeneration(generation, repoRoot) {
  const fileNodes = (generation?.nodes ?? []).filter((node) => node.kind === "file");
  const candidates = [];
  for (const node of fileNodes) {
    const path = node.path ?? node.name;
    if (!path) continue;
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
    if (!LANGUAGES[ext]) continue;
    try {
      candidates.push({ path, text: readFileSync(join(repoRoot, path), "utf8") });
    } catch {
      // File listed in the generation but unreadable now — skip; the lexical
      // layer still carries it and the summary records the miss.
      candidates.push({ path, text: null });
    }
  }
  const readable = candidates.filter((file) => typeof file.text === "string");
  const summary = {
    provider: PROVIDER.id,
    grammarPackage: GRAMMAR_PACKAGE,
    candidateFiles: candidates.length,
    parsedFiles: 0,
    parseStatus: { ok: 0, partial: 0, failed: 0, unsupported: 0 },
    unreadableFiles: candidates.length - readable.length,
    nodesAdded: 0,
    edgesAdded: 0,
  };
  if (readable.length === 0) return { generation, summary };

  const graph = await buildTreeSitterGraph(readable);
  const existingIds = new Set((generation.nodes ?? []).map((node) => node.id));
  const existingEdgeIds = new Set((generation.edges ?? []).map((edge) => edge.id));
  for (const node of graph.nodes) {
    if (existingIds.has(node.id)) continue;
    existingIds.add(node.id);
    generation.nodes.push(node);
    summary.nodesAdded += 1;
  }
  for (const edge of graph.edges) {
    if (edge.id && existingEdgeIds.has(edge.id)) continue;
    if (edge.id) existingEdgeIds.add(edge.id);
    generation.edges.push(edge);
    summary.edgesAdded += 1;
  }
  for (const report of graph.fileReports ?? []) {
    summary.parsedFiles += 1;
    if (report.parseStatus in summary.parseStatus) summary.parseStatus[report.parseStatus] += 1;
  }
  generation.augmentation = { treesitter: summary };
  return { generation, summary };
}
