// D31: MCP resources/prompts, compatibility matrix, and host configs.

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { RESOURCE_URIS, resourceForUri } from "../mcp/resources.mjs";
import { PROMPTS, promptByName } from "../mcp/prompts.mjs";
import { MCP_COMPATIBILITY, HOSTS, mcpConfigForHost } from "../mcp/compatibility.mjs";
import { HOOK_POLICY_MODES, HOOK_POLICIES, policyBehavior } from "../lib/init/host-configs.mjs";

test("resources are URI-addressable and paginated", () => {
  assert.ok(RESOURCE_URIS.length >= 6);
  for (const uri of RESOURCE_URIS) {
    const resource = resourceForUri(uri, { limit: 50 });
    assert.equal(resource.uri, uri);
    assert.ok(resource.schemaVersion);
  }
  const claims = resourceForUri("cortex://claims", { limit: 10 });
  assert.equal(claims.pagination.limit, 10);
  const unknown = resourceForUri("cortex://nope");
  assert.equal(unknown.error.code, "resource_not_found");
});

test("prompts reference tools, not embedded prose", () => {
  assert.ok(PROMPTS.length >= 5);
  for (const prompt of PROMPTS) {
    assert.ok(prompt.toolRefs.length > 0, `${prompt.name} must reference tools`);
    for (const ref of prompt.toolRefs) {
      assert.match(ref, /^cortex_/);
    }
  }
  assert.ok(promptByName("debug"));
  assert.equal(promptByName("nope"), null);
});

test("compatibility matrix covers current and legacy SDK majors", () => {
  assert.ok(MCP_COMPATIBILITY.some((entry) => entry.major === 1 && entry.status === "supported"));
  assert.ok(MCP_COMPATIBILITY.some((entry) => entry.major === 0 && entry.status === "legacy"));
});

test("host configs generate for all seven hosts", () => {
  assert.equal(HOSTS.length, 7);
  for (const host of HOSTS) {
    const config = mcpConfigForHost(host, { root: "/repo" });
    assert.ok(config, `missing config for ${host}`);
    assert.ok(config.path);
    assert.ok(config.value);
  }
});

test("hook policies have explicit fail-open/fail-closed and recovery", () => {
  assert.deepEqual(HOOK_POLICY_MODES, ["advisory", "orient-before-read", "task-grants"]);
  assert.equal(HOOK_POLICIES.advisory.failClosed, false);
  assert.equal(HOOK_POLICIES["orient-before-read"].failClosed, true);
  assert.equal(HOOK_POLICIES["task-grants"].failClosed, true);
  assert.match(policyBehavior("orient-before-read").recoveryCommand, /cortex orient/);
  assert.match(policyBehavior("task-grants").recoveryCommand, /cortex grant issue/);
  assert.equal(policyBehavior("advisory").recoveryCommand, null);
});
