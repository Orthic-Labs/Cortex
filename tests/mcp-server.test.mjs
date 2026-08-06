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
  assert.ok(!response.isError, `unexpected error: ${response.content?.[0]?.text ?? ""}`);
  const text = response.content.find((block) => block.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

test("MCP server exposes exactly six receipt-bearing Cortex tools", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-mcp-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--root", repo], cwd: repo, stderr: "pipe" });
  const client = new Client({ name: "cortex-test", version: "1.0.0" }, { capabilities: {} });
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    buildGraphGeneration(repo, { outDir: ".agent", persist: true });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["cortex_doc_truth", "cortex_expand", "cortex_impact", "cortex_orient", "cortex_search", "cortex_status"]);
    const oriented = payload(await client.callTool({ name: "cortex_orient", arguments: { task: "placeOrder" } }));
    assert.equal(oriented.action, "allow");
    assert.ok(oriented.freshnessReceipt?.receiptId);
    const search = payload(await client.callTool({ name: "cortex_search", arguments: { query: "placeOrder", limit: 5 } }));
    assert.ok(Array.isArray(search.results));
    assert.ok(search.freshnessReceipt?.receiptId);
  } finally {
    await client.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});
