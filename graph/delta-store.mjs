import { computeManifestDigest, resealGenerationIdentityDelta } from "./generation-identity.mjs";
import { updateLeafChain } from "./merkle-ledger.mjs";
import {
  countRows,
  deleteFactsByOwner,
  getGenerationEnvelope,
  loadFileState,
} from "./store-sqlite.mjs";

export const STRUCTURAL_PROVIDER = Object.freeze({ id: "lexical", version: "repo-local-delta-v1" });

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeDigest(value) {
  const text = String(value ?? "");
  return text.startsWith("xxh128:") ? text : `xxh128:${text}`;
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function ensureWatchState(db) {
  db.exec("CREATE TABLE IF NOT EXISTS watch_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

function clock(db, key, fallback = 0) {
  const row = db.prepare("SELECT value FROM watch_state WHERE key = ?").get(key);
  return row ? Number(row.value) : fallback;
}

function setClock(db, key, value) {
  db.prepare("INSERT INTO watch_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}

function fileNode(node, generationId, digest) {
  return {
    path: node.path,
    contentHash: String(digest).replace(/^xxh128:/, ""),
    language: null,
    provider: STRUCTURAL_PROVIDER.id,
    parseStatus: null,
    errorNodeCount: null,
    generationId,
    nodeId: node.id,
    labels: JSON.stringify(node.labels ?? ["File"]),
    name: node.name ?? node.path.split("/").at(-1),
    qualifiedName: node.qualifiedName ?? node.path,
    confidence: node.confidence ?? 1,
    evidence: JSON.stringify(node.evidence ?? []),
    extra: null,
  };
}

function insertParsedFacts(db, parsed, generationId, sourceDigest, provider) {
  const insertFile = db.prepare(`INSERT INTO files(path, content_hash, language, provider, parse_status, error_node_count, generation_id, node_id, labels, name, qualified_name, confidence, evidence, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, provider=excluded.provider, generation_id=excluded.generation_id,
      node_id=excluded.node_id, labels=excluded.labels, name=excluded.name, qualified_name=excluded.qualified_name,
      confidence=excluded.confidence, evidence=excluded.evidence, extra=excluded.extra`);
  const insertSymbol = db.prepare(`INSERT INTO symbols(id, kind, labels, name, qualified_name, path, confidence, evidence, generation_id, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, labels=excluded.labels, name=excluded.name, qualified_name=excluded.qualified_name,
      path=excluded.path, confidence=excluded.confidence, evidence=excluded.evidence, generation_id=excluded.generation_id, extra=excluded.extra`);
  const insertEdge = db.prepare(`INSERT INTO edges(id, kind, source, target, confidence, resolved, specifier, evidence, generation_id, confidence_tier, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, source=excluded.source, target=excluded.target, confidence=excluded.confidence,
      resolved=excluded.resolved, specifier=excluded.specifier, evidence=excluded.evidence, generation_id=excluded.generation_id,
      confidence_tier=excluded.confidence_tier, extra=excluded.extra`);
  const insertOwner = db.prepare("INSERT OR REPLACE INTO fact_owner(fact_id, fact_kind, source_path, source_digest, provider_id, provider_version, freshness_domain, fact_kind_detail) VALUES (?, ?, ?, ?, ?, ?, 'structural', ?)");
  const nodes = parsed?.nodes ?? [];
  for (const node of nodes) {
    if (node.kind === "file") {
      const row = fileNode(node, generationId, sourceDigest);
      insertFile.run(row.path, row.contentHash, row.language, row.provider, row.parseStatus, row.errorNodeCount, row.generationId, row.nodeId, row.labels, row.name, row.qualifiedName, row.confidence, row.evidence, row.extra);
    } else {
      insertSymbol.run(node.id, node.kind, JSON.stringify(node.labels ?? []), node.name ?? "", node.qualifiedName ?? node.name ?? "", node.path, node.confidence ?? 1, JSON.stringify(node.evidence ?? []), generationId, null);
    }
    insertOwner.run(node.id, "node", node.path, sourceDigest, provider.id, provider.version, node.kind);
  }
  for (const edge of parsed?.edges ?? []) {
    const indexed = new Set(["id", "kind", "source", "target", "confidence", "confidenceTier", "evidence"]);
    const extra = Object.fromEntries(Object.entries(edge).filter(([key]) => !indexed.has(key)));
    insertEdge.run(edge.id, edge.kind, edge.source, edge.target ?? null, edge.confidence ?? 1, edge.resolved === false ? 0 : 1, edge.specifier ?? null, JSON.stringify(edge.evidence ?? []), generationId, edge.confidenceTier ?? null, Object.keys(extra).length ? JSON.stringify(extra) : null);
    const sourceNode = nodes.find((node) => node.id === edge.source);
    if (sourceNode) insertOwner.run(edge.id, "edge", sourceNode.path, sourceDigest, provider.id, provider.version, edge.kind);
  }
}

function refreshDependencies(db, path, dependencies) {
  db.prepare("DELETE FROM dependency_index WHERE source_path = ? OR dependent_path = ?").run(path, path);
  const insert = db.prepare("INSERT OR REPLACE INTO dependency_index(source_path, dependent_path, reason) VALUES (?, ?, ?)");
  for (const dependency of dependencies ?? []) {
    insert.run(normalizePath(dependency.sourcePath), normalizePath(dependency.dependentPath), dependency.reason);
  }
}

function updateFileState(db, path, digest, sourceClock, fileIdentity = null, size = 0, mtimeMs = null, eventSeq = null) {
  db.prepare(`INSERT INTO file_state(path, content_digest, size, mtime_ms, file_identity, last_event_seq, applied_clock)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET content_digest=excluded.content_digest, size=excluded.size,
      mtime_ms=excluded.mtime_ms, file_identity=excluded.file_identity, last_event_seq=excluded.last_event_seq, applied_clock=excluded.applied_clock`)
    .run(path, normalizeDigest(digest), size, mtimeMs, fileIdentity, eventSeq, sourceClock);
}

export function applyFileDelta(db, delta) {
  const path = normalizePath(delta.path);
  const eventKind = delta.eventKind ?? "modify";
  const provider = delta.provider ?? STRUCTURAL_PROVIDER;
  const contentDigestValue = delta.contentDigest == null ? null : normalizeDigest(delta.contentDigest);
  const prior = loadFileState(db, path);
  if (contentDigestValue && prior?.content_digest === contentDigestValue && eventKind !== "delete" && eventKind !== "rename") return { noop: true, path, appliedClock: prior.applied_clock, rootDigest: null };
  ensureWatchState(db);
  const previousApplied = clock(db, "applied_clock", 0);
  const appliedClock = Number(delta.sourceClock ?? previousApplied + 1);
  const newPath = eventKind === "rename" ? normalizePath(delta.renameTo ?? delta.parsed?.nodes?.find((node) => node.kind === "file")?.path ?? path) : path;
  db.exec("BEGIN IMMEDIATE");
  try {
    const oldOwners = db.prepare("SELECT fact_id, fact_kind FROM fact_owner WHERE source_path = ?").all(path);
    const oldNodeIds = oldOwners.filter((owner) => owner.fact_kind === "node").map((owner) => owner.fact_id);
    if (eventKind === "delete" || eventKind === "rename") {
      for (const nodeId of oldNodeIds) db.prepare("UPDATE edges SET resolved = 0 WHERE target = ?").run(nodeId);
      deleteFactsByOwner(db, path, null);
      db.prepare("DELETE FROM files WHERE path = ?").run(path);
      db.prepare("DELETE FROM file_state WHERE path = ?").run(path);
    } else {
      deleteFactsByOwner(db, path, provider.id);
    }
    db.prepare("DELETE FROM dependency_index WHERE source_path = ? OR dependent_path = ?").run(path, path);
    if (eventKind !== "delete" && delta.parsed) {
      const rootBefore = getGenerationEnvelope(db);
      const rootDigest = updateLeafChain(db, newPath, contentDigestValue);
      const envelope = resealGenerationIdentityDelta(rootBefore, rootDigest, appliedClock);
      insertParsedFacts(db, delta.parsed, envelope.manifest.generationId, contentDigestValue, provider);
      refreshDependencies(db, newPath, delta.parsed.dependencies);
      updateFileState(db, newPath, contentDigestValue, appliedClock, delta.fileIdentity ?? null, delta.size ?? delta.parsed.size ?? 0, delta.mtimeMs ?? null, delta.journalSeq ?? null);
      envelope.manifest.counts = { ...envelope.manifest.counts, ...countRows(db) };
      envelope.manifest.manifestDigest = computeManifestDigest(envelope.manifest, envelope.sourceObservation);
      db.prepare("UPDATE generation SET value = ? WHERE key = 'manifest'").run(JSON.stringify(envelope.manifest));
    } else {
      const envelope = getGenerationEnvelope(db);
      const rootDigest = updateLeafChain(db, path, null);
      const resealed = resealGenerationIdentityDelta(envelope, rootDigest, appliedClock);
      resealed.manifest.counts = { ...resealed.manifest.counts, ...countRows(db) };
      resealed.manifest.manifestDigest = computeManifestDigest(resealed.manifest, resealed.sourceObservation);
      db.prepare("UPDATE generation SET value = ? WHERE key = 'manifest'").run(JSON.stringify(resealed.manifest));
    }
    setClock(db, "applied_clock", appliedClock);
    if (delta.journalSeq && hasTable(db, "event_journal")) {
      db.prepare("UPDATE event_journal SET applied = 1, applied_clock = ? WHERE seq = ?").run(appliedClock, delta.journalSeq);
    }
    db.exec("COMMIT");
    return { applied: true, path, appliedClock, rootDigest: db.prepare("SELECT digest FROM generation_leaf WHERE path = '' AND kind = 'dir'").get()?.digest ?? null };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
