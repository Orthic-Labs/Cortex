#!/usr/bin/env node
// D07: MCP adapter over the shared application service. The server root is
// supplied at process start (--root, --repo-id, CORTEX_REPO_ROOTS); tool
// inputs never accept an unrestricted repoRoot. Exactly six default tools.
// Every result passes through redactForEgress.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createCortexApplicationService } from "../lib/application/service.mjs";
import { RootRegistry } from "../lib/application/root-registry.mjs";
import { redactForEgress } from "../lib/redaction.mjs";

const OUT_DIR = ".agent";

function parseRootConfig() {
  const argv = process.argv.slice(2);
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") { flags.set("root", argv[index + 1]); index += 1; }
    else if (token === "--repo-id") { flags.set("repoId", argv[index + 1]); index += 1; }
    else if (token.startsWith("--root=")) flags.set("root", token.slice(7));
    else if (token.startsWith("--repo-id=")) flags.set("repoId", token.slice(10));
  }
  const envRoots = String(process.env.CORTEX_REPO_ROOTS ?? "").split(":").filter(Boolean);
  return { root: flags.get("root"), repoId: flags.get("repoId"), envRoots };
}

function buildService() {
  const { root, repoId, envRoots } = parseRootConfig();
  const entries = [];
  if (root) entries.push({ root: resolve(root), repoId });
  for (const envRoot of envRoots) entries.push({ root: resolve(envRoot) });
  if (!entries.length) {
    throw new Error("cortex-mcp requires --root, --repo-id, or CORTEX_REPO_ROOTS");
  }
  const registry = new RootRegistry(entries);
  return createCortexApplicationService({ outDir: OUT_DIR, rootRegistry: registry, allowEmbeddedRoot: false });
}

function call(fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ content: [{ type: "text", text: JSON.stringify(redactForEgress(value), null, 2) }] }))
    .catch((error) => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({
        schemaVersion: 1,
        error: { code: error.code ?? "internal_error", message: String(error.message ?? error), details: redactForEgress(error.details ?? {}) },
      }, null, 2) }],
    }));
}

export function createCortexMcpServer() {
  const service = buildService();
  const server = new McpServer({ name: "cortex", version: "0.2.0" });
  const common = { repoId: z.string().optional(), generation: z.string().optional(), allowStale: z.boolean().optional() };

  server.registerTool("cortex_orient", {
    description: "Establish current repository and generation context.",
    inputSchema: { ...common, task: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, (input) => call(() => service.orient(input)));

  server.registerTool("cortex_search", {
    description: "Search symbols, files, claims, routes, and concepts.",
    inputSchema: { ...common, query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
  }, (input) => call(() => service.search(input)));

  server.registerTool("cortex_expand", {
    description: "Expand one anchor into a bounded evidence slice.",
    inputSchema: { ...common, anchor: z.string().min(1), depth: z.number().int().min(1).max(5).optional(), budget: z.number().int().min(128).max(32000).optional(), cursor: z.string().optional() },
  }, (input) => call(() => service.expand(input)));

  server.registerTool("cortex_impact", {
    description: "Return upstream impact, tests, routes, schemas, and uncertainty.",
    inputSchema: { ...common, anchor: z.string().min(1), depth: z.number().int().min(1).max(8).optional(), budget: z.number().int().min(128).max(32000).optional(), cursor: z.string().optional() },
  }, (input) => call(() => service.impact(input)));

  server.registerTool("cortex_doc_truth", {
    description: "Return current, stale, contradicted, and unknown document claims.",
    inputSchema: { ...common, claimId: z.string().optional(), kind: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
  }, (input) => call(() => service.documentTruth(input)));

  server.registerTool("cortex_status", {
    description: "Return freshness, coverage, service health, and repair actions.",
    inputSchema: common,
  }, (input) => call(() => service.status(input)));

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = createCortexMcpServer();
  await server.connect(new StdioServerTransport());
}
