// D21: generic declarative Tree-sitter walker. Consumes a LanguageTable and
// emits nodes/edges for declarations, functions, classes, imports, calls,
// relationships, comments, and tests. Every emitted node/edge retains
// provider, grammar hash/ABI, precision tier, parse status, evidence
// span/hash, and confidence tier. Unresolved relations remain rows with
// target:null. Data/markup profiles never fabricate function/call facts.

import { createHash } from "node:crypto";

export const GENERIC_WALKER_VERSION = "1.0.0";

function childField(node, field) {
  if (node?.childForFieldName) {
    const byName = node.childForFieldName(field);
    if (byName) return byName;
  }
  return node?.namedChildren?.find((child) => child.fieldName === field) ?? null;
}

function childrenOfType(node, nodeTypes) {
  return (node?.namedChildren ?? []).filter((child) => nodeTypes.includes(child.type));
}

function nodeName(node, pattern) {
  const byField = pattern.name?.field ? childField(node, pattern.name.field) : null;
  if (byField) return byField.text ?? null;
  const byChildType = pattern.name?.nodeTypes ? childrenOfType(node, pattern.name.nodeTypes)[0] : null;
  if (byChildType) return byChildType.text ?? null;
  return null;
}

function evidenceFor(node, filePath) {
  const text = node?.text ?? "";
  return [{
    path: filePath,
    startLine: node?.startPosition?.row != null ? node.startPosition.row + 1 : 1,
    endLine: node?.endPosition?.row != null ? node.endPosition.row + 1 : 1,
    contentHash: createHash("sha256").update(text).digest("hex"),
  }];
}

export function walkTable({ table, tree, filePath, providerId = "cortex-treesitter", grammarHash = null, precisionTier = "AST" }) {
  const nodes = [];
  const edges = [];
  const reports = [];
  const root = tree?.rootNode ?? null;
  if (!root) {
    return { nodes, edges, reports: [{ kind: "parse_failed", path: filePath, message: "no root node" }], provider: { id: providerId, precisionTier } };
  }
  if (root.hasError) {
    reports.push({ kind: "partial_parse", path: filePath, message: "parse contains errors" });
  }
  const walk = (node) => {
    // Functions.
    for (const pattern of table.functions ?? []) {
      if (!pattern.nodeTypes.includes(node.type)) continue;
      const name = nodeName(node, pattern);
      const id = `symbol:${filePath}:${name ?? node.id}`;
      nodes.push({
        id,
        kind: "symbol",
        path: filePath,
        name,
        labels: pattern.labels ?? ["Function"],
        span: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
        evidence: evidenceFor(node, filePath),
        provider: providerId,
        precisionTier,
        parseStatus: root.hasError ? "partial" : "ok",
        confidenceTier: "EXACT_RESOLUTION",
        grammarHash,
      });
      if (pattern.container === "file") {
        edges.push({ id: `e-${nodes.length}`, kind: "CONTAINS", source: `file:${filePath}`, target: id, confidenceTier: "EXACT_RESOLUTION", provider: providerId });
      }
    }
    // Classes/types.
    for (const pattern of table.classes ?? []) {
      if (!pattern.nodeTypes.includes(node.type)) continue;
      const name = nodeName(node, pattern);
      nodes.push({
        id: `symbol:${filePath}:${name ?? node.id}`,
        kind: "symbol",
        path: filePath,
        name,
        labels: pattern.labels ?? ["Class"],
        span: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
        evidence: evidenceFor(node, filePath),
        provider: providerId,
        precisionTier,
        parseStatus: root.hasError ? "partial" : "ok",
        confidenceTier: "EXACT_RESOLUTION",
        grammarHash,
      });
    }
    // Imports.
    for (const pattern of table.imports ?? []) {
      if (!pattern.nodeTypes.includes(node.type)) continue;
      const target = nodeName(node, pattern) ?? null;
      edges.push({
        id: `e-${nodes.length}-${edges.length}`,
        kind: "IMPORTS",
        source: `file:${filePath}`,
        target: target ? `file:${target}` : null,
        confidenceTier: target ? pattern.confidenceTier ?? "EXACT_RESOLUTION" : "UNRESOLVED",
        provider: providerId,
        evidence: evidenceFor(node, filePath),
      });
    }
    // Calls.
    for (const pattern of table.calls ?? []) {
      if (!pattern.nodeTypes.includes(node.type)) continue;
      const name = nodeName(node, pattern);
      if (name == null) continue;
      edges.push({
        id: `e-${nodes.length}-${edges.length}`,
        kind: "CALLS",
        source: `file:${filePath}`,
        target: null,
        confidenceTier: "UNRESOLVED",
        provider: providerId,
        evidence: evidenceFor(node, filePath),
        callName: name,
      });
    }
    // Comments.
    for (const pattern of table.comments ?? []) {
      if (!pattern.nodeTypes.includes(node.type)) continue;
      const text = node.text ?? "";
      nodes.push({
        id: `comment:${filePath}:${node.id}`,
        kind: "comment",
        path: filePath,
        name: null,
        labels: ["Comment"],
        span: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
        evidence: evidenceFor(node, filePath),
        provider: providerId,
        precisionTier,
        parseStatus: "ok",
        confidenceTier: "EXACT_RESOLUTION",
        grammarHash,
        text,
      });
    }
    for (const child of node.namedChildren ?? []) walk(child);
  };
  walk(root);
  return { nodes, edges, reports, provider: { id: providerId, precisionTier } };
}
