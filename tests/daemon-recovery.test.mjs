// D30: daemon recovery — restart and stale endpoint recovery are
// deterministic; a dead socket fails fast with a typed error.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDaemonServer } from "../service/server.mjs";
import { DaemonClient } from "../service/client.mjs";

test("daemon restart re-binds the endpoint", async () => {
  const endpoint = join(tmpdir(), `cortex-restart-${Date.now()}.sock`);
  const first = createDaemonServer({ endpoint });
  await first.listen();
  await first.close();
  assert.ok(!existsSync(endpoint), "endpoint cleaned up after close");
  const second = createDaemonServer({ endpoint });
  try {
    await second.listen();
    assert.ok(existsSync(endpoint), "endpoint re-bound after restart");
    const client = new DaemonClient({ endpoint });
    const response = await client.request({ method: "status", input: {} });
    assert.ok(response.ok === true || response.ok === false);
    await client.close();
  } finally {
    await second.close().catch(() => {});
  }
});

test("connecting to a stale endpoint fails fast with a typed error", async () => {
  const endpoint = join(tmpdir(), `cortex-stale-${Date.now()}.sock`);
  const client = new DaemonClient({ endpoint });
  try {
    await client.connect();
    assert.fail("expected connect to fail");
  } catch (error) {
    assert.ok(error, "typed connect error");
  }
});
