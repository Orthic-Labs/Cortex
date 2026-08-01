// Adapter 3 — Exact paths and symbols via Blueprint resolve.
//
// Resolves named paths and symbols against the existing Blueprint graph.
// This adapter does NOT regenerate the graph; it consumes a `generation`
// (or lazily rebuilds via the portable contract) and uses Blueprint's
// `resolveGraphNode` / `queryGraph` to produce exact candidates.
//
// Resolution rules:
//   - If the task names a path that exists in the graph as a `file:*` node,
//     emit a `graph_resolve_file` candidate with full evidence.
//   - If the task names a symbol via "path#symbol" or a bare symbol token
//     that matches `symbol:path::qualName`, emit a `graph_resolve_symbol`
//     candidate with start/end lines from the graph evidence.
//   - For symbol-only tokens, fall back to `queryGraph` with the symbol
//     as the query (limit ≤ 5) and emit only those whose qualifiedName
//     matches the token exactly.
//
// If no Blueprint graph is available (no `.agent/manifest.json`, no
// `.blueprint/manifest.json`), this adapter emits a single omission with
// reason `graph_unavailable` and returns. It does not synthesise candidates
// from raw source scans — that is the live-overlay adapter's job.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openStoreReadOnly, closeStore, loadGeneration as loadStoredGeneration } from "../graph/store-sqlite.mjs";
import {
  SCOPE_PROVIDER,
  isSupportedPath,
  makeCandidate,
  normalizePath,
  safeResolve,
  xxh3Hex,
} from "./_shared.mjs";

const ADAPTER_ID = "rightcontext-sources/graph-resolve";
const ADAPTER_LAYER = 3; // Layer 3 — graph-backed file/symbol evidence

const SYMBOL_TOKEN_RE = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})\b/g;
const PATH_LIKE_RE =
  /(?:^|[\s,(`])([A-Za-z0-9_./-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|ya?ml|toml|md|markdown|html|css|svg|sh|ps1|bat|sql|csv|tsv|xml))(?:[:#](\S+))?/g;
const RANGE_RE = /^(\d+)-(\d+)$/;

function loadGeneration(repoRoot) {
  // Blueprint's native generation lives in the store. (The previous path here,
  // `.agent/graph.json`, was wrong even before the migration — the generation
  // was always at `.agent/graph/graph.json` — so this branch never fired and
  // every caller silently fell through to the bootstrap index.)
  const dbPath = join(repoRoot, ".agent", "graph", "graph.db");
  if (existsSync(dbPath)) {
    try {
      const db = openStoreReadOnly(dbPath);
      try {
        const generation = loadStoredGeneration(db);
        if (generation?.nodes && generation?.manifest) return generation;
      } finally {
        closeStore(db);
      }
    } catch { /* unreadable store — fall through to the bootstrap index */ }
  }
  const candidates = [
    join(repoRoot, ".blueprint", "index.jsonl"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      // .agent/graph.json holds the full generation.
      if (raw?.nodes && raw?.manifest) {
        return raw;
      }
      // .blueprint/index.jsonl holds one node per line; assemble lazily.
      if (path.endsWith("index.jsonl")) {
        const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
        const nodes = lines.map((line) => JSON.parse(line));
        return { nodes, edges: [], manifest: { generationId: "blueprint-portable", provider: { id: "blueprint-portable" }, generatedAt: null }, portable: true };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findFileNode(generation, repoPath) {
  const wanted = `file:${repoPath}`;
  return generation.nodes.find((node) => node.id === wanted) ?? null;
}

function findSymbolNode(generation, repoPath, symbol) {
  const needle = `symbol:${repoPath}::${symbol}`;
  return generation.nodes.find((node) => node.id === needle)
    ?? generation.nodes.find((node) => node.kind !== "file" && node.path === repoPath && node.qualifiedName === symbol)
    ?? null;
}

function lexTokens(task) {
  const seen = new Set();
  const out = [];
  for (const match of String(task ?? "").matchAll(SYMBOL_TOKEN_RE)) {
    const token = match[1];
    if (token.length < 3) continue;
    if (/^[A-Z]+$/.test(token)) continue; // skip all-caps acronyms
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function pathAndSymbol(task) {
  const items = [];
  for (const match of String(task ?? "").matchAll(PATH_LIKE_RE)) {
    const path = normalizePath(match[1]);
    const tail = match[2] ?? null;
    let symbol = null;
    let startLine = 1;
    let endLine = null;
    if (tail && tail.includes("#")) {
      const [range, sym] = tail.split("#", 2);
      symbol = sym || null;
      const m = range.match(RANGE_RE);
      if (m) {
        startLine = Number(m[1]);
        endLine = Number(m[2]);
      }
    } else if (tail && SYMBOL_TOKEN_RE.test(tail)) {
      symbol = tail;
    }
    items.push({ path, symbol, startLine, endLine });
  }
  return items;
}

/**
 * @param {string} task
 * @param {{ repoRoot: string, generation?: object, freshGeneration?: () => object, maxSymbolHits?: number }} scope
 */
export function produce(task, scope) {
  const repoRoot = scope?.repoRoot;
  if (!repoRoot) return { candidates: [], omissions: [] };
  const generation = scope?.generation ?? (scope?.freshGeneration ? scope.freshGeneration() : null) ?? loadGeneration(repoRoot);
  if (!generation) {
    return {
      candidates: [],
      omissions: [{ id: `${ADAPTER_ID}:graph`, layer: ADAPTER_LAYER, reason: "graph_unavailable" }],
    };
  }

  const candidates = [];
  const omissions = [];
  const used = new Set();
  const maxHits = Math.max(1, Math.min(20, Number(scope?.maxSymbolHits ?? 5)));
  const items = pathAndSymbol(task);

  for (const item of items) {
    if (!isSupportedPath(item.path)) continue;
    const safe = safeResolve(repoRoot, item.path);
    if (!safe) {
      omissions.push({ id: `${ADAPTER_ID}:${item.path}`, layer: ADAPTER_LAYER, reason: "graph_resolve_outside_scope" });
      continue;
    }
    if (item.symbol) {
      const node = findSymbolNode(generation, safe, item.symbol);
      if (node) {
        const ev = node.evidence?.[0] ?? {};
        candidates.push(
          makeCandidate({
            id: `${ADAPTER_ID}:${node.id}`,
            layer: ADAPTER_LAYER,
            sourceKind: "graph_resolve_symbol",
            sourcePath: safe,
            trustClass: "workspace_tracked",
            providerScore: 0.97,
            scoreComponents: { graph: 1.0, exact: 1.0 },
            text: node.qualifiedName ?? node.name ?? item.symbol,
            startLine: ev.startLine ?? 1,
            endLine: ev.endLine ?? 1,
            bodyHash: ev.contentHash ?? xxh3Hex(node.qualifiedName ?? item.symbol),
            estimatedTokens: Math.max(1, (ev.endLine ?? 1) - (ev.startLine ?? 1) + 1),
            resolver: `blueprint graph resolve --node ${node.id}`,
          }),
        );
        used.add(node.id);
      } else {
        omissions.push({
          id: `${ADAPTER_ID}:${safe}#${item.symbol}`,
          layer: ADAPTER_LAYER,
          reason: "graph_symbol_not_found",
        });
      }
    }
    const fileNode = findFileNode(generation, safe);
    if (fileNode) {
      const ev = fileNode.evidence?.[0] ?? {};
      candidates.push(
        makeCandidate({
          id: `${ADAPTER_ID}:${fileNode.id}`,
          layer: ADAPTER_LAYER,
          sourceKind: "graph_resolve_file",
          sourcePath: safe,
          trustClass: "workspace_tracked",
          providerScore: 0.9,
          scoreComponents: { graph: 1.0, exact: 1.0 },
          text: fileNode.qualifiedName ?? safe,
          startLine: ev.startLine ?? 1,
          endLine: ev.endLine ?? 1,
          bodyHash: ev.contentHash ?? xxh3Hex(safe),
          estimatedTokens: Math.max(1, (ev.endLine ?? 1) - (ev.startLine ?? 1) + 1),
          resolver: `blueprint graph resolve --node ${fileNode.id}`,
        }),
      );
      used.add(fileNode.id);
    } else {
      omissions.push({
        id: `${ADAPTER_ID}:file:${safe}`,
        layer: ADAPTER_LAYER,
        reason: "graph_file_not_found",
      });
    }
  }

  // Token-driven symbol query for symbols named without a path.
  const tokens = lexTokens(task);
  for (const token of tokens) {
    if (used.has(`symbol::${token}`)) continue;
    const hits = generation.nodes
      .filter((node) => node.kind !== "file" && (node.qualifiedName === token || node.name === token))
      .slice(0, maxHits);
    if (!hits.length) continue;
    for (const node of hits) {
      if (used.has(node.id)) continue;
      used.add(node.id);
      const ev = node.evidence?.[0] ?? {};
      const safe = safeResolve(repoRoot, node.path ?? "");
      if (!safe) {
        omissions.push({ id: `${ADAPTER_ID}:${node.id}`, layer: ADAPTER_LAYER, reason: "graph_resolve_outside_scope" });
        continue;
      }
      candidates.push(
        makeCandidate({
          id: `${ADAPTER_ID}:${node.id}`,
          layer: ADAPTER_LAYER,
          sourceKind: "graph_resolve_symbol",
          sourcePath: safe,
          trustClass: "workspace_tracked",
          providerScore: 0.85,
          scoreComponents: { graph: 0.9, lexical: 0.8 },
          text: node.qualifiedName ?? node.name ?? token,
          startLine: ev.startLine ?? 1,
          endLine: ev.endLine ?? 1,
          bodyHash: ev.contentHash ?? xxh3Hex(node.qualifiedName ?? token),
          estimatedTokens: Math.max(1, (ev.endLine ?? 1) - (ev.startLine ?? 1) + 1),
          resolver: `blueprint graph resolve --node ${node.id}`,
        }),
      );
    }
  }

  return { candidates, omissions };
}

export const adapterInfo = {
  id: ADAPTER_ID,
  layer: ADAPTER_LAYER,
  provider: SCOPE_PROVIDER,
  description: "Exact path and symbol resolution through Blueprint's static provider.",
};

export const _internals = { findFileNode, findSymbolNode, lexTokens, pathAndSymbol, loadGeneration };