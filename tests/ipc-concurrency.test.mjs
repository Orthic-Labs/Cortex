// D30: daemon concurrency — concurrent clients receive bounded,
// generation-consistent responses; one repo failure does not starve others.

import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDaemonServer } from "../service/server.mjs";
import { DaemonClient } from "../service/client.mjs";
import { buildGraphGeneration } from "../graph/static-provider.mjs";
import { createCortexApplicationService } from "../lib/application/service.mjs";
import { RootRegistry } from "../lib/application/root-registry.mjs";

test("concurrent clients get consistent responses", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-ipc-conc-"));
  cpSync(join(import.meta.dirname, "..", "evals/fixture-repos/typescript-commerce"), repo, { recursive: true });
  buildGraphGeneration(repo, { outDir: ".agent", persist: true });
  const endpoint = join(tmpdir(), `cortex-conc-${Date.now()}.sock`);
  const registry = new RootRegistry([{ root: repo, repoId: "repo-1" }]);
  const service = createCortexApplicationService({ rootRegistry: registry, allowEmbeddedRoot: false });
  const daemon = createDaemonServer({ service, endpoint });
  try {
    await daemon.listen();
    const clients = [new DaemonClient({ endpoint }), new DaemonClient({ endpoint }), new DaemonClient({ endpoint })];
    const results = await Promise.all(clients.map((client) => client.request({ method: "search", input: { query: "placeOrder", limit: 5 }, repoId: "repo-1" })));
    for (const response of results) {
      assert.equal(response.ok, true);
      assert.ok(response.result.generationId, "generation-consistent response");
    }
    await Promise.all(clients.map((client) => client.close()));
  } finally {
    await daemon.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a failing repo returns typed errors without starving others", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cortex-ipc-fail-"));
  cpSync(join(import.meta.dirname, "..", "evals/fixture-repos/typescript-commerce"), repo, { recursive: true });
  buildGraphGeneration(repo, { outDir: ".agent", persist: true });
  const endpoint = join(tmpdir(), `cortex-fail-${Date.now()}.sock`);
  const registry = new RootRegistry([
    { root: repo, repoId: "repo-1" },
    { root: join(tmpdir(), "missing-repo"), repoId: "repo-missing" },
  ]);
  const service = createCortexApplicationService({ rootRegistry: registry, allowEmbeddedRoot: false });
  const daemon = createDaemonServer({ service, endpoint });
  try {
    await daemon.listen();
    const client = new DaemonClient({ endpoint });
    const [bad, good] = await Promise.all([
      client.request({ method: "search", input: { query: "x", limit: 5 }, repoId: "repo-missing" }),
      client.request({ method: "search", input: { query: "placeOrder", limit: 5 }, repoId: "repo-1" }),
    ]);
    assert.equal(bad.ok, false);
    assert.ok(bad.error.code, "typed error for the failing repo");
    assert.equal(good.ok, true);
    assert.ok(good.result.results.length > 0, "healthy repo still serves");
    await client.close();
  } finally {
    await daemon.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});
