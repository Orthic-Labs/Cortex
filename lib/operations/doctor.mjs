// D11: doctor diagnostics core, extracted from the CLI. Preserves the
// existing reason codes and typed state ladder
// (ready|degraded|stale|broken|corrupt|missing).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { graphStatus, graphCapabilities } from "../../graph/static-provider.mjs";

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function collectDoctorDiagnostics(root, outDir = ".agent", { full = false } = {}) {
  const startedAt = new Date().toISOString();
  const mapPath = join(root, outDir, "map.json");
  const stalePath = join(root, outDir, "stale.json");
  if (!existsSync(mapPath)) {
    return {
      schemaVersion: 1,
      state: "missing",
      generatedAt: startedAt,
      artifacts: { map: `${outDir}/map.json`, graph: `${outDir}/graph/graph.db` },
      errors: [`${outDir}/map.json missing; run build first`],
      warnings: [],
      reasons: [{ code: "missing_map", severity: "blocker", message: "Cortex map.json is not present; planner cannot retrieve candidates." }],
      capabilities: graphCapabilities(),
    };
  }
  let map;
  let stale;
  try {
    map = readJson(mapPath, null);
    stale = readJson(stalePath, { missingReferences: [] });
  } catch (error) {
    return {
      schemaVersion: 1,
      state: "corrupt",
      generatedAt: startedAt,
      artifacts: { map: `${outDir}/map.json`, graph: `${outDir}/graph/graph.db` },
      errors: [String(error?.message ?? error)],
      warnings: [],
      reasons: [{ code: "corrupt_map", severity: "blocker", message: "Cortex map.json could not be parsed." }],
      capabilities: graphCapabilities(),
    };
  }
  const errors = [];
  const warnings = [];
  const reasons = [];
  const ids = new Set();
  for (const node of map.nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  if (ids.size !== map.nodes.length) {
    reasons.push({ code: "duplicate_node_ids", severity: "blocker", message: `graph contains ${map.nodes.length - ids.size} duplicate node id(s); discovery must enforce collision-safe IDs.` });
  }
  for (const edge of map.edges) {
    if (!ids.has(edge.from)) errors.push(`edge missing from node: ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`edge missing to node: ${edge.to}`);
  }
  for (const warning of stale.missingReferences.slice(0, 10)) {
    warnings.push(`${warning.source} mentions missing ${warning.path}`);
  }
  if (stale.missingReferences.length > 0) {
    reasons.push({ code: "missing_references", severity: "warning", count: stale.missingReferences.length, message: "documents reference paths that no longer exist on disk" });
  }
  const graph = graphStatus(root, outDir);
  if (graph.state === "stale") {
    warnings.push(graph.providerMismatch ? "graph manifest was built by an older Cortex provider and must be rebuilt" : "graph manifest source hash is stale relative to current files");
    reasons.push({ code: "stale_graph", severity: "blocker", providerMismatch: Boolean(graph.providerMismatch), message: graph.providerMismatch ? "graph provider version does not match the installed Cortex extractor; rebuild required." : "graph manifest sourceHash does not match current source tree; rebuild required." });
  }
  return {
    schemaVersion: 1,
    state: errors.length ? "broken" : "degraded",
    generatedAt: startedAt,
    artifacts: { map: `${outDir}/map.json`, graph: `${outDir}/graph/graph.db` },
    errors,
    warnings,
    reasons,
    capabilities: graphCapabilities(),
    graph,
    completion: full ? { checked: true } : null,
  };
}
