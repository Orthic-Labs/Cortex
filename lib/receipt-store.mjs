// Host-owned orientation receipt store — data, not enforcement.
//
// Receipts live outside the agent-writable repository tree by default
// (~/.blueprint/receipts or BLUEPRINT_RECEIPT_STORE). The store records
// orientation decisions keyed by session / task / repo / generation; it does
// not block tools or classify shell commands.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const RECEIPT_SCHEMA_VERSION = 1;

export function defaultReceiptStoreDir() {
  const fromEnv = process.env.BLUEPRINT_RECEIPT_STORE;
  if (fromEnv && String(fromEnv).trim()) return resolve(String(fromEnv).trim());
  return join(homedir(), ".blueprint", "receipts");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function receiptPath(storeDir, receiptId) {
  return join(storeDir, `${receiptId}.json`);
}

function indexPath(storeDir) {
  return join(storeDir, "index.json");
}

function readIndex(storeDir) {
  const path = indexPath(storeDir);
  if (!existsSync(path)) return { schemaVersion: 1, byKey: {}, byReceipt: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { schemaVersion: 1, byKey: {}, byReceipt: {} };
  }
}

function writeIndexAtomic(storeDir, index) {
  const path = indexPath(storeDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function writeReceiptAtomic(storeDir, receipt) {
  const path = receiptPath(storeDir, receipt.receiptId);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Composite lookup key: session + task + repo + generation. */
export function receiptLookupKey({ sessionId, taskId, repoIdentity, generationId }) {
  return [
    String(sessionId ?? ""),
    String(taskId ?? ""),
    String(repoIdentity ?? ""),
    String(generationId ?? ""),
  ].join("\u001f");
}

/**
 * Create a host-owned receipt store rooted at `storeDir`.
 * @param {{ storeDir?: string }} [options]
 */
export function createReceiptStore(options = {}) {
  const storeDir = ensureDir(resolve(options.storeDir ?? defaultReceiptStoreDir()));

  function put(receipt) {
    if (!receipt?.receiptId) throw new Error("receipt.receiptId is required");
    writeReceiptAtomic(storeDir, receipt);
    const index = readIndex(storeDir);
    const key = receiptLookupKey(receipt);
    index.byKey[key] = receipt.receiptId;
    index.byReceipt[receipt.receiptId] = {
      key,
      status: receipt.status ?? "active",
      updatedAt: receipt.updatedAt ?? receipt.issuedAt ?? null,
    };
    writeIndexAtomic(storeDir, index);
    return receipt;
  }

  function get(receiptId) {
    if (!receiptId) return null;
    const path = receiptPath(storeDir, receiptId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  function findActive(query) {
    const index = readIndex(storeDir);
    const key = receiptLookupKey(query);
    const receiptId = index.byKey[key];
    if (!receiptId) return null;
    const receipt = get(receiptId);
    if (!receipt || receipt.status === "revoked") return null;
    return receipt;
  }

  function list({ includeRevoked = false } = {}) {
    const files = existsSync(storeDir)
      ? readdirSync(storeDir).filter((name) => name.endsWith(".json") && name !== "index.json")
      : [];
    const out = [];
    for (const name of files) {
      try {
        const receipt = JSON.parse(readFileSync(join(storeDir, name), "utf8"));
        if (!includeRevoked && receipt.status === "revoked") continue;
        out.push(receipt);
      } catch {
        // skip corrupt rows; host can reclaim later
      }
    }
    return out.sort((a, b) => String(a.issuedAt ?? "").localeCompare(String(b.issuedAt ?? "")));
  }

  function revoke(receiptId, { reason = "explicit_revoke", at = new Date().toISOString() } = {}) {
    const receipt = get(receiptId);
    if (!receipt) return null;
    if (receipt.status === "revoked") return receipt;
    const updated = {
      ...receipt,
      status: "revoked",
      revokedAt: at,
      revokeReason: reason,
      updatedAt: at,
    };
    return put(updated);
  }

  function clear() {
    if (!existsSync(storeDir)) return;
    for (const name of readdirSync(storeDir)) {
      rmSync(join(storeDir, name), { force: true });
    }
  }

  return {
    storeDir,
    put,
    get,
    findActive,
    list,
    revoke,
    clear,
    nextId: () => randomUUID(),
  };
}

/**
 * Build a durable orientation receipt record (not yet persisted).
 */
export function buildOrientationReceipt(fields) {
  const issuedAt = fields.issuedAt ?? new Date().toISOString();
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: "blueprint_orientation_receipt",
    receiptId: fields.receiptId ?? randomUUID(),
    status: fields.status ?? "active",
    sessionId: String(fields.sessionId ?? ""),
    taskId: String(fields.taskId ?? fields.task ?? ""),
    turnDigest: fields.turnDigest ?? null,
    repoIdentity: String(fields.repoIdentity ?? fields.repoRoot ?? ""),
    worktreeIdentity: fields.worktreeIdentity ?? null,
    generationId: fields.generationId ?? null,
    manifestDigest: fields.manifestDigest ?? null,
    sourceObservationDigest: fields.sourceObservationDigest ?? null,
    candidateSetDigest: fields.candidateSetDigest ?? null,
    explicitAnchors: [...(fields.explicitAnchors ?? [])],
    allowedPaths: [...(fields.allowedPaths ?? [])],
    allowedDirectoryScopes: [...(fields.allowedDirectoryScopes ?? [])],
    allowedOperations: [...(fields.allowedOperations ?? ["read", "search", "test", "edit"])],
    overlayRevision: Number(fields.overlayRevision ?? 0),
    omissions: [...(fields.omissions ?? [])],
    issuedAt,
    updatedAt: fields.updatedAt ?? issuedAt,
  };
}
