import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildGraphGeneration } from "../graph/static-provider.mjs";

const ROOT = join(import.meta.dirname, "..");
const SERVER = join(ROOT, "scripts/cortex-mcp.mjs");
const FIXTURE = join(ROOT, "evals/fixture-repos/typescript-commerce");

function payload(response) {
  assert.equal(response.isError, false);
  const text = response.content.find((block) => block.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

test("MCP server exposes exactly three receipt-bearing Cortex tools", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-mcp-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: repo, stderr: "pipe" });
  const client = new Client({ name: "cortex-test", version: "1.0.0" }, { capabilities: {} });
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["cortex_expand", "cortex_orient", "cortex_resolve"]);
    const oriented = payload(await client.callTool({ name: "cortex_orient", arguments: { repoRoot: repo } }));
    assert.equal(oriented.product, "cortex");
    assert.ok(oriented.receiptId);
    const expanded = payload(await client.callTool({ name: "cortex_expand", arguments: { repoRoot: repo, anchors: ["src/service.ts"], budgetTokens: 1 } }));
    assert.equal(expanded.kind, "RepositoryNeighborhoodV1");
    assert.ok(expanded.receiptId);
    const resolved = payload(await client.callTool({ name: "cortex_resolve", arguments: { repoRoot: repo, query: "placeOrder" } }));
    assert.ok(resolved.receiptId);
    assert.ok(Array.isArray(resolved.results));
  } finally {
    await client.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});
