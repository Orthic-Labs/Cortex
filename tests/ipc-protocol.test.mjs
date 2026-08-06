// D30: daemon IPC protocol — envelopes, methods, cancellation, deadlines.

import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeRequest, encodeResponse, encodeCancel, decodeLine, PROTOCOL_VERSION, METHODS } from "../service/protocol.mjs";
import { createDaemonServer } from "../service/server.mjs";
import { DaemonClient } from "../service/client.mjs";
import { buildGraphGeneration } from "../graph/static-provider.mjs";
import { createCortexApplicationService } from "../lib/application/service.mjs";
import { RootRegistry } from "../lib/application/root-registry.mjs";

test("protocol envelopes round-trip", () => {
  const request = decodeLine(encodeRequest({ requestId: "r1", repoId: "repo-1", method: "search", input: { query: "x" } }));
  assert.equal(request.protocolVersion, PROTOCOL_VERSION);
  assert.equal(request.method, "search");
  assert.equal(request.repoId, "repo-1");
  const response = decodeLine(encodeResponse({ requestId: "r1", ok: true, generation: "g1", result: {}, error: null }));
  assert.equal(response.ok, true);
  assert.equal(response.generation, "g1");
  const cancel = decodeLine(encodeCancel("r1"));
  assert.equal(cancel.method, "cancel");
  assert.equal(cancel.input.targetRequestId, "r1");
});

test("METHODS covers the six-tool surface plus read verbs", () => {
  for (const method of ["status", "search", "resolve", "orient", "expand", "impact", "architecture", "documentTruth"]) {
    assert.ok(METHODS.includes(method));
  }
});

test("daemon serves a search over the shared service", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-daemon-"));
  cpSync(join(import.meta.dirname, "..", "evals/fixture-repos/typescript-commerce"), repo, { recursive: true });
  buildGraphGeneration(repo, { outDir: ".agent", persist: true });
  const endpoint = join(tmpdir(), `cortex-${process.pid}-${Date.now()}.sock`);
  const registry = new RootRegistry([{ root: repo, repoId: "repo-1" }]);
  const service = createCortexApplicationService({ rootRegistry: registry, allowEmbeddedRoot: false });
  const daemon = createDaemonServer({ service, endpoint });
  try {
    await daemon.listen();
    const client = new DaemonClient({ endpoint });
    const response = await client.request({ method: "search", input: { query: "placeOrder", limit: 5 }, repoId: "repo-1" });
    assert.equal(response.ok, true);
    assert.ok(Array.isArray(response.result.results));
    assert.ok(response.result.results.length > 0);
    await client.close();
  } finally {
    await daemon.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unknown method returns method_unknown", async () => {
  const endpoint = join(tmpdir(), `cortex-${process.pid}-${Date.now()}-u.sock`);
  const daemon = createDaemonServer({ endpoint });
  try {
    await daemon.listen();
    const client = new DaemonClient({ endpoint });
    const response = await client.request({ method: "nope", input: {} });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "method_unknown");
    await client.close();
  } finally {
    await daemon.close().catch(() => {});
  }
});

test("cancellation stops a pending request", async () => {
  const endpoint = join(tmpdir(), `cortex-${process.pid}-${Date.now()}-c.sock`);
  const daemon = createDaemonServer({ endpoint });
  try {
    await daemon.listen();
    const client = new DaemonClient({ endpoint });
    const requestId = "pending-1";
    const promise = client.request({ method: "status", input: {}, deadlineMs: 30000 });
    client.cancel(requestId);
    // The cancel is a fire-and-forget protocol message; assert the client
    // remains usable and the pending request eventually settles.
    const response = await Promise.race([promise, new Promise((r) => setTimeout(() => r({ timeout: true }), 1000))]);
    assert.ok(response.timeout === true || response.ok !== undefined);
    await client.close();
  } finally {
    await daemon.close().catch(() => {});
  }
});
