import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdmission, DECISION_ACTIONS } from "../lib/admission.mjs";
import { createReceiptStore } from "../lib/receipt-store.mjs";

function makeIsolatedAdmission(overrides = {}) {
  const storeDir = mkdtempSync(join(tmpdir(), "bp-admission-store-"));
  const evidenceDir = mkdtempSync(join(tmpdir(), "bp-admission-evidence-"));
  const generation = {
    manifest: {
      generationId: "xxh128:gen-fixed",
      manifestDigest: "sha256:manifest-fixed",
      generatedAt: "gen:fixed",
    },
    provider: { id: "blueprint-static" },
    sourceObservation: { dirty: false },
    nodes: [],
    edges: [],
  };
  const candidateSet = {
    schemaVersion: 1,
    provider: "blueprint-static",
    freshness: { revision: "xxh128:gen-fixed", manifestDigest: "sha256:manifest-fixed" },
    candidates: [
      {
        id: "symbol:src/a.ts::alpha",
        sourceRef: "src/a.ts:1-3",
        sourceHash: "xxh128:aaa",
        protected: false,
        exact: true,
      },
      {
        id: "symbol:src/b.ts::beta",
        sourceRef: "src/b.ts:1-2",
        sourceHash: "xxh128:bbb",
        protected: true,
        exact: false,
      },
    ],
    omissions: [{ id: "symbol:src/c.ts::gamma", reason: "over_candidate_ceiling" }],
  };
  const api = createAdmission({
    storeDir,
    evidenceDir,
    readGeneration: () => generation,
    createContextCandidateSet: (_gen, options = {}) => {
      if (options.query === "expand-me" || options.path === "src/extra.ts") {
        return {
          ...candidateSet,
          candidates: [
            ...candidateSet.candidates,
            {
              id: "symbol:src/extra.ts::extra",
              sourceRef: "src/extra.ts:1-1",
              sourceHash: "xxh128:eee",
              protected: false,
              exact: false,
            },
          ],
        };
      }
      return candidateSet;
    },
    graphStatus: () => ({ state: "fresh", capabilities: { dirtyOverlayFileCount: 0 } }),
    ...overrides,
  });
  return { api, storeDir, evidenceDir, generation, candidateSet };
}

test("orient blocks when graph is missing — decision only, no hooks", async () => {
  const { api, storeDir, evidenceDir } = makeIsolatedAdmission({
    graphStatus: () => ({ state: "missing" }),
    readGeneration: () => null,
  });
  try {
    const result = await api.orient({
      task: "inspect auth",
      sessionId: "sess",
      repoRoot: "/tmp/demo-repo",
    });
    assert.equal(result.action, "block");
    assert.equal(result.reasonCode, "missing_graph");
    assert.match(result.nextAction, /blueprint build/);
    assert.ok(DECISION_ACTIONS.includes(result.action));
    assert.equal(result.schemaVersion, 1);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test("orient issues a host receipt and Beacon evidence file", async () => {
  const { api, storeDir, evidenceDir } = makeIsolatedAdmission();
  try {
    const result = await api.orient({
      task: "find alpha",
      sessionId: "sess-1",
      taskId: "find alpha",
      repoRoot: "/tmp/demo-repo",
      anchors: ["src/b.ts"],
    });
    assert.equal(result.action, "allow");
    assert.equal(result.reasonCode, "oriented");
    assert.ok(result.receiptId);
    assert.ok(result.allowedScopes.includes("src/a.ts"));
    assert.ok(result.allowedScopes.includes("src/b.ts"));
    assert.equal(result.evidence.kind, "blueprint_orientation");
    assert.equal(result.evidence.locator, `blueprint://receipt/${result.receiptId}`);
    assert.ok(result.evidencePath);
    const onDisk = JSON.parse(readFileSync(result.evidencePath, "utf8"));
    assert.equal(onDisk.kind, "blueprint_orientation");
    assert.equal(result.receipt.generationId, "xxh128:gen-fixed");
    assert.equal(result.receipt.sessionId, "sess-1");

    const reused = await api.orient({
      task: "find alpha",
      sessionId: "sess-1",
      taskId: "find alpha",
      repoRoot: "/tmp/demo-repo",
    });
    assert.equal(reused.action, "continue");
    assert.equal(reused.reasonCode, "receipt_reuse");
    assert.equal(reused.receiptId, result.receiptId);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test("expand unions graph-supported paths and rejects absolute self-approval", async () => {
  const { api, storeDir, evidenceDir } = makeIsolatedAdmission();
  try {
    const oriented = await api.orient({
      task: "base",
      sessionId: "s",
      taskId: "base",
      repoRoot: "/tmp/demo-repo",
    });
    const blocked = await api.expand({
      receiptId: oriented.receiptId,
      paths: ["/etc/passwd"],
      repoRoot: "/tmp/demo-repo",
    });
    assert.equal(blocked.action, "block");
    assert.equal(blocked.reasonCode, "absolute_path_rejected");
    const blockedWindows = await api.expand({
      receiptId: oriented.receiptId,
      paths: ["C:\\Windows\\System32"],
      repoRoot: "/tmp/demo-repo",
    });
    assert.equal(blockedWindows.action, "block");
    assert.equal(blockedWindows.reasonCode, "absolute_path_rejected");

    const expanded = await api.expand({
      receiptId: oriented.receiptId,
      query: "expand-me",
      path: "src/extra.ts",
      repoRoot: "/tmp/demo-repo",
    });
    assert.equal(expanded.action, "continue");
    assert.equal(expanded.reasonCode, "expanded");
    assert.ok(expanded.allowedScopes.includes("src/extra.ts"));
    assert.equal(expanded.receipt.overlayRevision, oriented.receipt.overlayRevision + 1);
    assert.equal(
      expanded.evidence.invalidation_key,
      `${expanded.receipt.manifestDigest}:${expanded.receipt.overlayRevision}`,
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test("status and revoke round-trip", async () => {
  const { api, storeDir, evidenceDir } = makeIsolatedAdmission();
  try {
    const oriented = await api.orient({
      task: "status task",
      sessionId: "s2",
      taskId: "status task",
      repoRoot: "/tmp/demo-repo",
    });
    const st = await api.status({ receiptId: oriented.receiptId });
    assert.equal(st.action, "continue");
    assert.equal(st.reasonCode, "receipt_active");

    const revoked = await api.revoke({ receiptId: oriented.receiptId });
    assert.equal(revoked.action, "allow");
    assert.equal(revoked.reasonCode, "revoked");
    assert.equal(revoked.receipt.status, "revoked");

    const after = await api.status({ receiptId: oriented.receiptId });
    assert.equal(after.action, "block");
    assert.equal(after.reasonCode, "receipt_revoked");

    const expandBlocked = await api.expand({
      receiptId: oriented.receiptId,
      query: "anything",
      repoRoot: "/tmp/demo-repo",
    });
    assert.equal(expandBlocked.reasonCode, "receipt_revoked");
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test("generation mismatch blocks orient", async () => {
  const { api, storeDir, evidenceDir } = makeIsolatedAdmission();
  try {
    const result = await api.orient({
      task: "pin",
      sessionId: "s",
      repoRoot: "/tmp/demo-repo",
      expectedGeneration: "xxh128:other",
    });
    assert.equal(result.action, "block");
    assert.equal(result.reasonCode, "generation_mismatch");
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test("createAdmission store is injectable for MemRight-style hosts", () => {
  const storeDir = mkdtempSync(join(tmpdir(), "bp-host-store-"));
  try {
    const store = createReceiptStore({ storeDir });
    const api = createAdmission({
      store,
      readGeneration: () => null,
      createContextCandidateSet: () => ({ candidates: [], omissions: [] }),
      graphStatus: () => ({ state: "missing" }),
    });
    assert.equal(api.store.storeDir, store.storeDir);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});
