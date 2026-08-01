#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createContextCandidateSet,
  graphNeighbors,
  graphStatus,
  queryGraph,
  readGeneration,
} from "../graph/static-provider.mjs";
import { buildNeighborhood } from "../graph/neighborhood.mjs";
import { syncToCurrentSourceAtPath } from "../graph/barrier.mjs";

const OUT_DIR = ".agent";
const MESSAGE = "Run cortex_orient first — Cortex Graph has current repository truth.";

function sessionKey() {
  return String(process.env.CORTEX_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? process.env.MCP_SESSION_ID ?? "default").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function markOriented(repoRoot) {
  const markerDir = join(repoRoot, OUT_DIR, "graph");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, `cortex-orient-session-${sessionKey()}.marker`), `${Date.now()}\n`, "utf8");
}

function result(payload, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

async function barrier(repoRoot) {
  const root = resolve(repoRoot);
  const dbPath = join(root, OUT_DIR, "graph", "graph.db");
  if (!existsSync(dbPath)) {
    return { root, receipt: { receiptId: null, barrierResult: "missing" }, generation: null };
  }
  const receipt = await syncToCurrentSourceAtPath(root, { outDir: OUT_DIR, timeoutMs: 2000 });
  if (receipt.barrierResult !== "caught_up") return { root, receipt, generation: null };
  return { root, receipt, generation: readGeneration(root, OUT_DIR) };
}

function orientPayload(root, generation, receipt) {
  const status = graphStatus(root, OUT_DIR);
  const map = readJson(join(root, OUT_DIR, "map.json"), {});
  const manifest = readJson(join(root, ".blueprint/manifest.json"), {});
  const flowInventory = readJson(join(root, OUT_DIR, "flows.json"), { flows: [] });
  const query = "";
  const candidates = createContextCandidateSet(generation, { task: query, query, maxCandidates: 40 });
  const flows = Array.isArray(flowInventory.flows) ? flowInventory.flows : [];
  const topCircuits = flows.slice(0, 5).map((flow, index) => ({
    name: flow.name ?? flow.entry?.name ?? flow.terminal?.name ?? flow.id ?? `circuit-${index + 1}`,
    files: [...new Set((Array.isArray(flow.path) ? flow.path : []).map((node) => node?.path).filter(Boolean))].slice(0, 10),
  }));
  return {
    schemaVersion: 1,
    product: "cortex",
    generationId: status.manifest?.generationId ?? null,
    manifestDigest: status.manifest?.manifestDigest ?? null,
    freshness: { state: status.state, checkedAt: new Date().toISOString() },
    entrypoint: map.entrypoint ?? manifest.entrypoint ?? null,
    topCircuits,
    candidates,
    freshnessReceipt: receipt,
    receiptId: receipt.receiptId,
  };
}

async function cortexOrient(repoRoot) {
  const state = await barrier(repoRoot);
  if (!state.generation) {
    const payload = { error: state.receipt.barrierResult === "missing" ? "graph_missing" : "stale_blocked", receiptId: state.receipt.receiptId, barrier: state.receipt };
    return result(payload, true);
  }
  markOriented(state.root);
  return result(orientPayload(state.root, state.generation, state.receipt));
}

async function cortexExpand(repoRoot, anchors, budgetTokens) {
  const state = await barrier(repoRoot);
  if (!state.generation) {
    const payload = { error: state.receipt.barrierResult === "missing" ? "graph_missing" : "stale_blocked", receiptId: state.receipt.receiptId, barrier: state.receipt };
    return result(payload, true);
  }
  const payload = buildNeighborhood(state.generation, anchors, { budgetTokens, receiptId: state.receipt.receiptId });
  return result(payload);
}

async function cortexResolve(repoRoot, query) {
  const state = await barrier(repoRoot);
  if (!state.generation) {
    const payload = { error: state.receipt.barrierResult === "missing" ? "graph_missing" : "stale_blocked", receiptId: state.receipt.receiptId, barrier: state.receipt };
    return result(payload, true);
  }
  const searchResults = queryGraph(state.generation, { query, limit: 20 });
  const merged = searchResults.map((match) => ({
    ...match,
    neighbors: graphNeighbors(state.generation, { nodeId: match.id, depth: 1 }),
  }));
  return result({ schemaVersion: 1, provider: state.generation.provider.id, query, receiptId: state.receipt.receiptId, results: merged, freshnessReceipt: state.receipt });
}

export function createCortexMcpServer() {
  const server = new McpServer({ name: "cortex", version: "0.2.0" });
  server.registerTool("cortex_orient", {
    description: "Orient against current repository truth before reading files.",
    inputSchema: { repoRoot: z.string().min(1) },
  }, ({ repoRoot }) => cortexOrient(repoRoot));
  server.registerTool("cortex_expand", {
    description: "Expand protected anchors into a bounded repository neighborhood.",
    inputSchema: { repoRoot: z.string().min(1), anchors: z.array(z.string()).min(1), budgetTokens: z.number().int().positive().optional() },
  }, ({ repoRoot, anchors, budgetTokens }) => cortexExpand(repoRoot, anchors, budgetTokens ?? 8000));
  server.registerTool("cortex_resolve", {
    description: "Resolve a repository query into search matches with graph neighbors.",
    inputSchema: { repoRoot: z.string().min(1), query: z.string().min(1) },
  }, ({ repoRoot, query }) => cortexResolve(repoRoot, query));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createCortexMcpServer();
  await server.connect(new StdioServerTransport());
}
