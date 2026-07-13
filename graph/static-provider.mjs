import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  CODE_EXTENSIONS,
  PARSED_LANGUAGE_EXTENSIONS,
  containsCall,
  extractImports,
  extractSymbols,
} from "./language-extractors.mjs";
import { addSchemaReferenceEdges } from "./schema-extractors.mjs";

const PROVIDER = {
  id: "blueprint-static",
  version: "repo-local-deterministic-v2",
  license: "workspace-owned",
};

const IGNORED = new Set([
  // VCS internals — git refs, codex checkpoints, branch metadata. Walking
  // these on a real repo overflows both the stack and memory because they
  // contain transient file handles that disappear between scans.
  ".git",
  ".codex-tmp",
  // Portable contract surface — tracked `.blueprint/` contains manifests and
  // schemas but never source code. Excluded at every nesting depth.
  ".blueprint",
  // Local graph/build caches and generated internals.
  ".agent",
  ".agent-test-graph",
  ".audit",
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".pytest_cache",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".worktrees",
  // Python / Java / Node caches and package metadata.
  "__pycache__",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".vscode",
  ".yarn",
  ".pnpm-store",
  "coverage",
  "htmlcov",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  ".serverless",
]);
const IGNORED_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  // Blueprint's own generated docs. They must not be re-indexed or they
  // would perturb the graph's source hash between rebuilds.
  "product.md",
  "architecture.md",
]);
// Extensions that are tracked as file nodes without symbol/import extraction.
// These do NOT trigger `degraded` because the provider handles them honestly.
const FILE_ONLY_EXTENSIONS = new Set([
  "md", "markdown", "txt",
  "json", "jsonl", "yaml", "yml", "toml",
  "html", "css", "svg",
  "sql", "csv", "tsv",
  "xml",
]);
const OPAQUE_FILE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "ico", "bmp", "avif",
  "ttf", "otf", "woff", "woff2",
  "wav", "mp3", "flac", "ogg", "mp4", "mov", "webm",
  "pdf", "zip", "gz", "tar", "dmg", "exe", "dll", "so", "dylib", "wasm", "pdb",
  "onnx", "safetensors", "gguf", "bin",
  "mtlx", "tres", "srt", "lock", "hash", "sha256", "gitignore",
]);
const SUPPORTED_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...FILE_ONLY_EXTENSIONS, ...OPAQUE_FILE_EXTENSIONS]);

export function scanSourcesPublic(root, fileLimit = 0, walkOptions = {}) {
  return scanSources(root, fileLimit, walkOptions);
}

export function sourceHashPublic(files) {
  return sourceHash(files);
}

export function buildGraphGeneration(repoRoot, options = {}) {
  const root = resolve(repoRoot);
  const outDir = options.outDir ? resolve(root, options.outDir) : null;
  const source = scanSources(root, options.fileLimit || 0, options);
  const generation = buildGenerationFromSources(root, source, options);
  if (outDir) writeGeneration(outDir, generation);
  return generation;
}

export function graphStatus(repoRoot, outDir, options = {}) {
  const root = resolve(repoRoot);
  const manifestPath = join(resolve(root, outDir), "graph", "manifest.json");
  if (!existsSync(manifestPath)) return { state: "missing", manifestPath };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.complete) return { state: "incomplete", manifestPath, manifest };
  // Staleness detection re-walks the source tree with the same fileLimit
  // the build used (default unlimited). If the walk itself OOMs or hits the
  // directory cap, we trust the manifest and surface scanTruncated so the
  // caller knows the comparison was skipped rather than silently trusting
  // a stale comparison.
  const manifestFileLimit = Number(manifest.fileLimit ?? 0);
  const rescanLimit = options.fileLimit ?? manifestFileLimit ?? 0;
  const sources = scanSources(root, rescanLimit, options);
  const scanned = sources.files.length > 0;
  const scanTruncated = Boolean(sources.traversalTruncated);
  const currentHash = scanned && !scanTruncated ? sourceHash(sources.files) : manifest.repo?.sourceHash;
  const unsupportedExtensions = new Set();
  let unsupportedFileCount = 0;
  let dirtyOverlayFileCount = 0;
  if (scanned) {
    for (const file of sources.files) {
      const dot = file.path.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = file.path.slice(dot + 1).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext) && /^[a-z0-9_+\-.]+$/.test(ext)) {
        unsupportedExtensions.add(ext);
        unsupportedFileCount += 1;
      }
    }
    const recordedHashes = new Map();
    const generationId = String(manifest.generationId ?? "");
    const generationDirName = generationId.startsWith("sha256:") ? generationId.slice("sha256:".length) : generationId;
    const generationDir = join(resolve(root, outDir), "graph", "generations", generationDirName);
    const nodesPath = join(generationDir, "nodes.json");
    if (existsSync(nodesPath)) {
      const nodes = JSON.parse(readFileSync(nodesPath, "utf8"));
      for (const node of nodes) {
        const evidence = node.evidence?.[0];
        if (evidence?.path && evidence?.contentHash) {
          recordedHashes.set(evidence.path, evidence.contentHash);
        }
      }
    }
    for (const file of sources.files) {
      const recorded = recordedHashes.get(file.path);
      if (recorded && recorded !== file.contentHash) {
        dirtyOverlayFileCount += 1;
      }
    }
  }
  const providerMismatch = manifest.provider?.id !== PROVIDER.id || manifest.provider?.version !== PROVIDER.version;
  const fresh = !providerMismatch && (scanned && !scanTruncated ? manifest.repo?.sourceHash === currentHash : true);
  return {
    state: scanTruncated ? "indeterminate" : fresh ? "fresh" : "stale",
    manifestPath,
    manifest,
    providerMismatch,
    scanTruncated,
    truncationReasons: sources.truncationReasons,
    capabilities: {
      parsedExtensions: PARSED_LANGUAGE_EXTENSIONS,
      opaqueFileExtensions: [...OPAQUE_FILE_EXTENSIONS].sort(),
      unsupportedExtensions: [...unsupportedExtensions].sort(),
      unsupportedFileCount,
      dirtyOverlayFileCount,
    },
  };
}

export function graphCapabilities() {
  return {
    schemaVersion: 1,
    provider: PROVIDER,
    languageCoverage: {
      parsedExtensions: PARSED_LANGUAGE_EXTENSIONS,
      opaqueFileExtensions: [...OPAQUE_FILE_EXTENSIONS].sort(),
      parserMode: "deterministic-lexical-v1",
      fallback: "Text/config and known opaque assets are represented as file nodes; unsupported source languages do not get symbol/call extraction.",
      ignoredDirectories: [...IGNORED].sort(),
      maxFileBytes: 2 * 1024 * 1024,
    },
    outputs: ["graph", "flows", "docTruth", "mermaid", "ContextCandidateSet"],
  };
}

export function queryGraph(generation, options = {}) {
  const query = String(options.query ?? "").toLowerCase();
  const terms = queryTerms(query);
  const limit = Number(options.limit ?? 20);
  const nodes = generation.nodes
    .map((node) => ({ node, score: scoreNode(node, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    .slice(0, limit);
  return nodes.map(({ node }, index) => ({
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    provider: generation.provider.id,
    confidence: node.confidence ?? 1,
    evidence: node.evidence,
    fresh: evidenceFresh(generation, node.evidence),
    rank: index + 1,
  }));
}

export function createContextCandidateSet(generation, options = {}) {
  const maxCandidates = Number(options.maxCandidates ?? 40);
  const queryResults = queryGraph(generation, { query: options.query ?? options.task ?? "", limit: maxCandidates });
  return {
    schemaVersion: 1,
    traceId: options.traceId ?? randomUUID(),
    task: String(options.task ?? options.query ?? "Blueprint graph retrieval"),
    mode: options.mode ?? "survey",
    provider: generation.provider.id,
    freshness: {
      revision: generation.manifest.generationId,
      indexedAt: generation.manifest.generatedAt,
      stale: false,
    },
    providerCeiling: {
      maxCandidates,
      maxEstimatedTokens: Number(options.maxEstimatedTokens ?? 8000),
    },
    candidates: queryResults.map((result) => {
      const ev = result.evidence[0];
      return {
        id: result.id,
        layer: 3,
        sourceKind: "repo_code",
        sourceRef: `${ev.path}:${ev.startLine}-${ev.endLine}`,
        sourceHash: `sha256:${ev.contentHash}`,
        trustClass: "workspace_tracked",
        instructionPolicy: "data_only",
        providerScore: Math.max(0, Math.min(1, 1 / result.rank)),
        scoreComponents: { structural: 1 },
        estimatedTokens: estimateTokens(ev),
        protected: false,
        exact: true,
        recoverable: true,
        resolver: `blueprint graph resolve --node ${result.id}`,
        text: result.qualifiedName || result.name,
      };
    }),
    omissions: [],
  };
}

export function resolveGraphNode(generation, nodeId) {
  const node = generation.nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  return {
    schemaVersion: 1,
    provider: generation.provider.id,
    node: {
      ...node,
      fresh: evidenceFresh(generation, node.evidence),
    },
  };
}

export function graphNeighbors(generation, options = {}) {
  const nodeId = String(options.nodeId ?? "");
  const direction = options.direction ?? "both";
  const maxDepth = Math.max(1, Number(options.depth ?? 1));
  const seenNodes = new Set([nodeId]);
  const seenEdges = new Set();
  let frontier = new Set([nodeId]);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next = new Set();
    for (const edge of generation.edges) {
      const out = direction !== "in" && frontier.has(edge.source);
      const incoming = direction !== "out" && frontier.has(edge.target);
      if (!out && !incoming) continue;
      seenEdges.add(edge.id);
      const other = out ? edge.target : edge.source;
      if (!seenNodes.has(other)) next.add(other);
      seenNodes.add(other);
    }
    frontier = next;
    if (!frontier.size) break;
  }
  return {
    schemaVersion: 1,
    provider: generation.provider.id,
    root: nodeId,
    nodes: generation.nodes.filter((node) => seenNodes.has(node.id)),
    edges: generation.edges.filter((edge) => seenEdges.has(edge.id)),
    truncated: false,
  };
}

export function graphPath(generation, options = {}) {
  const from = String(options.from ?? "");
  const to = String(options.to ?? "");
  const maxDepth = Math.max(1, Number(options.maxDepth ?? 5));
  const queue = [[from]];
  const visited = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    const current = path.at(-1);
    if (current === to) {
      return pathPayload(generation, path);
    }
    if (path.length > maxDepth) continue;
    for (const edge of generation.edges.filter((item) => item.source === current)) {
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      queue.push([...path, edge.target]);
    }
  }
  return { schemaVersion: 1, provider: generation.provider.id, from, to, path: [], edges: [], found: false };
}

export function graphArchitecture(generation) {
  const nodes = generation.nodes;
  const incoming = new Set(generation.edges.map((edge) => edge.target));
  const outgoing = new Set(generation.edges.map((edge) => edge.source));
  const entryPoints = nodes.filter((node) => node.kind === "symbol" && outgoing.has(node.id) && !incoming.has(node.id));
  const terminals = nodes.filter((node) => incoming.has(node.id) && !outgoing.has(node.id));
  return {
    schemaVersion: 1,
    provider: generation.provider.id,
    summary: {
      files: nodes.filter((node) => node.kind === "file").length,
      symbols: nodes.filter((node) => node.kind === "symbol").length,
      edges: generation.edges.length,
    },
    entryPoints,
    terminals,
    edgeKinds: [...new Set(generation.edges.map((edge) => edge.kind))].sort(),
  };
}

export function graphImpact(generation, options = {}) {
  const nodeId = String(options.nodeId ?? "");
  const depth = Math.max(1, Number(options.depth ?? 3));
  const neighborhood = graphNeighbors(generation, { nodeId, direction: "in", depth });
  return {
    schemaVersion: 1,
    provider: generation.provider.id,
    target: generation.nodes.find((node) => node.id === nodeId) ?? { id: nodeId },
    direction: "upstream",
    impacted: neighborhood.nodes.filter((node) => node.id !== nodeId),
    edges: neighborhood.edges,
    truncated: neighborhood.truncated,
  };
}

export function graphMermaid(generation, options = {}) {
  const view = String(options.view ?? "architecture");
  const limit = Math.max(1, Number(options.limit ?? 60));
  let payload;
  if (view === "neighbors") {
    payload = graphNeighbors(generation, {
      nodeId: String(options.nodeId ?? ""),
      direction: options.direction ?? "both",
      depth: Number(options.depth ?? 1),
    });
  } else if (view === "path") {
    payload = graphPath(generation, {
      from: options.from,
      to: options.to,
      maxDepth: Number(options.maxDepth ?? 5),
    });
  } else if (view === "impact") {
    payload = graphImpact(generation, {
      nodeId: String(options.nodeId ?? ""),
      depth: Number(options.depth ?? 3),
    });
  } else {
    payload = {
      nodes: generation.nodes,
      edges: generation.edges,
      truncated: generation.nodes.length > limit,
    };
  }
  return renderMermaid(generation, payload, { view, limit });
}

function renderMermaid(generation, payload, options) {
  const limit = options.limit;
  const nodes = selectMermaidNodes(payload, limit);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (payload.edges ?? generation.edges)
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((left, right) => `${left.source}:${left.target}:${left.kind}`.localeCompare(`${right.source}:${right.target}:${right.kind}`))
    .slice(0, Math.max(0, limit * 2));
  const aliases = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const truncated = Boolean(payload.truncated) || nodes.length < (payload.nodes ?? generation.nodes).length || edges.length < (payload.edges ?? generation.edges).length;
  const lines = [
    "flowchart LR",
    `%% provider: ${generation.provider.id}`,
    `%% view: ${options.view}`,
    `%% truncated: ${truncated}`,
  ];
  for (const node of nodes) lines.push(`  ${aliases.get(node.id)}["${escapeMermaidLabel(nodeLabel(node))}"]`);
  for (const edge of edges) lines.push(`  ${aliases.get(edge.source)} -->|"${escapeMermaidLabel(edge.kind)}"| ${aliases.get(edge.target)}`);
  return `${lines.join("\n")}\n`;
}

function selectMermaidNodes(payload, limit) {
  const byId = new Map((payload.nodes ?? []).map((node) => [node.id, node]));
  const edgeNodes = [];
  for (const edge of payload.edges ?? []) {
    if (byId.has(edge.source)) edgeNodes.push(byId.get(edge.source));
    if (byId.has(edge.target)) edgeNodes.push(byId.get(edge.target));
  }
  const selected = dedupeBy([...edgeNodes, ...(payload.nodes ?? [])], (node) => node.id)
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limit);
  return selected;
}

function nodeLabel(node) {
  const label = node.qualifiedName || node.name || node.path || node.id;
  return `${node.kind}:${String(label).slice(0, 80)}`;
}

function escapeMermaidLabel(value) {
  return String(value).replaceAll("\\", "/").replaceAll("\"", "'").replaceAll("\n", " ");
}

// Doc ↔ code join — emits deterministic edges joining doc/claim nodes (from
// `map.json`) to file/symbol nodes (from this generation). The join is reversible
// (every edge carries doc+file evidence + content hashes) and typed as
// supports / contradicts / supersedes. A claim with NO matching code node does
// not emit a join — it remains a doc-side finding, not a graph contradiction.
export function buildDocCodeJoins(generation, options = {}) {
  const repoRoot = generation?.repoRoot ? resolve(generation.repoRoot) : null;
  const map = readDocMap(repoRoot, options);
  if (!map) return { schemaVersion: 1, provider: generation.provider.id, joins: [], supersedes: [], truncated: false, sourceDocMap: null };
  const nodesById = new Map(generation.nodes.map((node) => [node.id, node]));
  const docById = new Map(map.nodes.filter((node) => node.kind === "doc").map((doc) => [doc.id, doc]));
  const claimById = new Map(map.nodes.filter((node) => node.kind === "claim").map((claim) => [claim.id, claim]));
  const claimsByDoc = new Map();
  for (const edge of map.edges) {
    if (edge.type === "contains" && claimById.has(edge.to)) {
      if (!claimsByDoc.has(edge.from)) claimsByDoc.set(edge.from, []);
      claimsByDoc.get(edge.from).push(edge.to);
    }
  }
  const codeRefByDoc = new Map();
  for (const edge of map.edges) {
    if (edge.type !== "mentions-code") continue;
    if (!codeRefByDoc.has(edge.from)) codeRefByDoc.set(edge.from, []);
    codeRefByDoc.get(edge.from).push(edge.to);
  }
  const codeRefsById = new Map(map.nodes.filter((node) => node.kind === "code_ref").map((node) => [node.id, node]));
  const joins = [];
  for (const [docId, claimIds] of claimsByDoc) {
    const doc = docById.get(docId);
    const codeRefIds = codeRefByDoc.get(docId) ?? [];
    for (const claimId of claimIds) {
      const claim = claimById.get(claimId);
      if (!doc || !claim) continue;
      for (const codeRefId of codeRefIds) {
        const codeRef = codeRefsById.get(codeRefId);
        if (!codeRef?.path) continue;
        const codeNode = nodesById.get(`file:${codeRef.path}`) ?? generation.nodes.find((node) => node.kind === "symbol" && node.path === codeRef.path);
        if (!codeNode) continue;
        const join = classifyJoin(claim, doc, codeRef, codeNode);
        if (join) joins.push(join);
      }
    }
  }
  const supersedes = buildSupersedesChain(map, joins);
  return {
    schemaVersion: 1,
    provider: generation.provider.id,
    joins,
    supersedes,
    truncated: false,
    sourceDocMap: { docs: docById.size, claims: claimById.size, generatedAt: map.generatedAt },
  };
}

function classifyJoin(claim, doc, codeRef, codeNode) {
  const status = claim.status;
  const text = stripInlineCode(claim.text);
  const isStale = status === "stale" || /\b(stale|contradict|drift|missing|not implemented|not built|not shipped|deprecated)\b/i.test(text);
  const isImplemented = status === "implemented" && !isStale;
  const isSupersedes = /\b(supersedes|superseded by|replaced by)\b/i.test(text);
  const baseEvidence = {
    docRef: { path: doc.path, line: claim.line ?? null, sha1: doc.sha1 ?? null },
    codeRef: { path: codeRef.path, exists: codeRef.exists !== false },
    codeNode: { id: codeNode.id, path: codeNode.path, contentHash: codeNode.evidence?.[0]?.contentHash ?? null },
  };
  if (isSupersedes) {
    return {
      kind: "supersedes",
      source: codeNode.id,
      target: `doc:${doc.path}`,
      confidence: 0.9,
      confidenceClass: "INFERRED",
      reason: "claim references supersedes/replaced",
      evidence: baseEvidence,
    };
  }
  if (isStale) {
    return {
      kind: "contradicts",
      source: `doc:${doc.path}`,
      target: codeNode.id,
      confidence: 0.85,
      confidenceClass: "EXTRACTED",
      reason: `claim status=${status || "claim"} mentions stale/drift/missing/contradict; code node exists`,
      evidence: baseEvidence,
    };
  }
  if (isImplemented) {
    return {
      kind: "supports",
      source: `doc:${doc.path}`,
      target: codeNode.id,
      confidence: 0.85,
      confidenceClass: "EXTRACTED",
      reason: `claim status=implemented; code node exists`,
      evidence: baseEvidence,
    };
  }
  return null;
}

function buildSupersedesChain(map, joins) {
  const lifecycleDocs = map.nodes.filter(
    (node) => node.kind === "doc" && node.lifecycle?.status === "superseded",
  );
  const out = lifecycleDocs.map((doc) => ({
    kind: "supersedes",
    source: doc.lifecycle.supersededBy ? { doc: doc.lifecycle.supersededBy } : { external: true },
    target: { doc: doc.path, supersededOn: doc.lifecycle.supersededOn ?? null },
    evidence: { sourceDoc: doc.path, targetMatch: doc.lifecycle.supersededBy ?? null },
  }));
  const supersedeClaims = map.nodes.filter(
    (node) => node.kind === "claim" && /\b(supersedes|replaced by|deprecated by)\b/i.test(stripInlineCode(node.text ?? "")),
  );
  for (const claim of supersedeClaims) {
    const doc = map.nodes.find((node) => node.kind === "doc" && node.id && map.edges.some((e) => e.type === "contains" && e.from === node.id && e.to === claim.id));
    if (!doc) continue;
    const target = extractSupersedeTarget(claim.text);
    if (!target) continue;
    out.push({
      kind: "supersedes",
      source: { doc: doc.path, line: claim.line, text: claim.text.slice(0, 240) },
      target,
      evidence: { sourceDoc: doc.path, targetMatch: target },
    });
  }
  return out;
}

function extractSupersedeTarget(text) {
  const match = text.match(/(?:supersedes|replaced by|deprecated by)\s+([^\s.]+(?:\.[^\s.]+)*)/i);
  return match ? match[1] : null;
}

function readDocMap(repoRoot, options) {
  const explicit = options?.docMap ?? null;
  if (explicit) return explicit;
  if (!repoRoot) return null;
  const candidates = [
    join(repoRoot, options?.outDir ?? ".agent", "map.json"),
    join(repoRoot, ".agent", "map.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8"));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function stripInlineCode(text) {
  return String(text ?? "").replace(/`[^`]*`/g, "");
}

export function graphFlowInventory(generation, options = {}) {
  const complete = Boolean(options.complete);
  const maxFlows = Number(options.maxFlows ?? (complete ? 5000 : 200));
  const outgoing = new Set(generation.edges.map((edge) => edge.source));
  const incoming = new Set(generation.edges.map((edge) => edge.target));
  const entryPoints = generation.nodes.filter((node) => node.kind === "symbol" && outgoing.has(node.id) && !incoming.has(node.id));
  const flows = [];
  let truncated = false;
  for (const entry of entryPoints) {
    const terminalPaths = terminalPathsFrom(generation, entry.id, maxFlows - flows.length);
    if (!terminalPaths.length) {
      flows.push({ entry, status: "broken", path: [entry], missingHop: "no terminal reachable", evidence: entry.evidence });
      continue;
    }
    for (const path of terminalPaths) {
      flows.push({
        id: `flow:${entry.id}->${path.at(-1).id}`,
        entry,
        terminal: path.at(-1),
        status: "complete",
        path,
        evidence: path.flatMap((node) => node.evidence ?? []),
      });
      if (flows.length >= maxFlows) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return {
    schemaVersion: 1,
    provider: generation.provider.id,
    generatedAt: generation.manifest?.generatedAt ?? `gen:${generation.manifest?.generationId?.replace(/^sha256:/, "").slice(0, 16) ?? "0"}`,
    mode: complete ? "complete" : "bounded",
    maxFlows,
    entryPoints: entryPoints.length,
    flows,
    truncated,
    truncationReason: truncated ? `flow inventory hit maxFlows=${maxFlows}` : null,
  };
}

function terminalPathsFrom(generation, entryId, limit = 200) {
  const paths = [];
  const queue = [[entryId]];
  while (queue.length && paths.length < limit) {
    const ids = queue.shift();
    const current = ids.at(-1);
    const outgoing = generation.edges.filter((edge) => edge.source === current);
    if (!outgoing.length && ids.length > 1) {
      paths.push(ids.map((id) => generation.nodes.find((node) => node.id === id)).filter(Boolean));
      continue;
    }
    for (const edge of outgoing) {
      if (ids.includes(edge.target) || ids.length > 12) continue;
      queue.push([...ids, edge.target]);
    }
  }
  return paths;
}

function pathPayload(generation, nodeIds) {
  const edgeSteps = [];
  for (let index = 0; index < nodeIds.length - 1; index += 1) {
    edgeSteps.push(generation.edges.find((edge) => edge.source === nodeIds[index] && edge.target === nodeIds[index + 1]));
  }
  return {
    schemaVersion: 1,
    provider: generation.provider.id,
    found: true,
    path: nodeIds.map((id) => generation.nodes.find((node) => node.id === id)).filter(Boolean),
    edges: edgeSteps.filter(Boolean),
  };
}

function writeGeneration(outDir, generation) {
  const graphDir = join(outDir, "graph");
  const generationDir = join(graphDir, "generations", generation.manifest.generationId.replace("sha256:", ""));
  mkdirSync(generationDir, { recursive: true });
  writeJson(join(generationDir, "nodes.json"), generation.nodes);
  writeJson(join(generationDir, "edges.json"), generation.edges);
  writeJson(join(generationDir, "graph.json"), generation);
  writeFileSync(join(generationDir, "COMPLETE"), "complete\n");
  const tmpManifest = join(graphDir, `manifest.${process.pid}.${Date.now()}.tmp`);
  mkdirSync(dirname(tmpManifest), { recursive: true });
  writeJson(tmpManifest, generation.manifest);
  renameSync(tmpManifest, join(graphDir, "manifest.json"));
}

function buildGenerationFromSources(root, source, options = {}) {
  const nodes = [];
  const edges = [];
  const fileNodes = new Map();
  const addNode = (node) => {
    const normalized = {
      id: node.id,
      kind: node.kind,
      labels: node.labels ?? [],
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      path: normalizePath(node.path),
      confidence: node.confidence ?? 1,
      evidence: node.evidence,
    };
    nodes.push(normalized);
    return normalized;
  };
  for (const file of source.files) {
    const node = addNode({
      id: `file:${file.path}`,
      kind: "file",
      labels: ["File"],
      name: file.path.split("/").at(-1),
      qualifiedName: file.path,
      path: file.path,
      evidence: [fileEvidence(file, 1, Math.max(1, file.lines.length))],
    });
    fileNodes.set(file.path, node);
  }
  for (const file of source.files.filter(isCodeFile)) extractSymbols(file, addNode);
  for (const file of source.files.filter(isCodeFile)) {
    const sourceNode = fileNodes.get(file.path);
    for (const imported of extractImports(file, source.files)) {
      const targetNode = fileNodes.get(imported);
      if (sourceNode && targetNode) edges.push(edge("IMPORTS", sourceNode, targetNode, [fileEvidence(file, 1, 1)]));
    }
  }
  addSchemaReferenceEdges(source.files, nodes, edges);
  addCallEdges(source.files, nodes, edges);
  addConfigEdges(source.files, nodes, edges);
  const cleanNodes = dedupeBy(nodes, (node) => node.id);
  const rawEdges = dedupeBy(edges, (item) => `${item.kind}:${item.source}:${item.target}:${item.evidence?.[0]?.path ?? ""}`);
  const candidateGeneration = { schemaVersion: 1, provider: PROVIDER, manifest: null, nodes: cleanNodes, edges: rawEdges, repoRoot: root };
  const docMap = readDocMap(root, null);
  const docTruth = docMap
    ? buildDocCodeJoins(candidateGeneration, { docMap })
    : { schemaVersion: 1, provider: PROVIDER.id, joins: [], supersedes: [], truncated: false, sourceDocMap: null };
  const cleanEdges = dedupeBy(rawEdges, (item) => `${item.kind}:${item.source}:${item.target}:${item.evidence?.[0]?.path ?? ""}`);
  const manifest = {
    schemaVersion: 1,
    provider: PROVIDER,
    // Stable generation stamp derived from the generation id, so byte-identity
    // on unchanged rebuilds is preserved.
    generatedAt: `gen:${generationId(cleanNodes, cleanEdges, source.files).replace(/^sha256:/, "").slice(0, 16)}`,
    generationId: generationId(cleanNodes, cleanEdges, source.files),
    complete: true,
    // The fileLimit the build was run with (0 = unlimited). graphStatus and
    // downstream consumers use this to scope their re-scan so a huge real
    // workspace (D:\Claude has 1M+ directories) does not OOM the doctor.
    fileLimit: Number(options.fileLimit ?? 0),
    truncated: Boolean(source.fileLimitReached || source.traversalTruncated),
    truncationReasons: source.truncationReasons,
    repo: {
      rootName: root.split(/[\\/]/).at(-1),
      sourceHash: sourceHash(source.files),
      fileCount: source.files.length,
    },
    counts: {
      nodes: cleanNodes.length,
      edges: cleanEdges.length,
      joins: docTruth.joins.length,
      supersedes: docTruth.supersedes.length,
    },
  };
  return { schemaVersion: 1, provider: PROVIDER, manifest, nodes: cleanNodes, edges: cleanEdges, docTruth, repoRoot: root };
}

function scanSources(root, fileLimit = 0, walkOptions = {}) {
  const files = [];
  const traversal = walk(root, walkOptions);
  let fileLimitReached = false;
  for (const absolutePath of traversal.paths) {
    let path;
    try {
      path = normalizePath(relative(root, absolutePath));
    } catch {
      continue;
    }
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
    const isParsed = CODE_EXTENSIONS.has(ext) || FILE_ONLY_EXTENSIONS.has(ext);
    let size;
    try {
      size = statSync(absolutePath).size;
    } catch {
      continue;
    }
    if (size > 2 * 1024 * 1024) continue;
    if (!isParsed) {
      files.push({
        absolutePath,
        path,
        contentHash: `size:${size}`,
        size,
        lines: [],
      });
      if (fileLimit > 0 && files.length >= fileLimit) {
        fileLimitReached = true;
        break;
      }
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(absolutePath);
    } catch {
      continue;
    }
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    let normalizedBytes = bytes;
    let normalizedText = text;
    if (path === "README.md") {
      normalizedText = text.replace(
        /\n?<!-- blueprint:docs:start -->[\s\S]*?<!-- blueprint:docs:end -->\n?/,
        "",
      );
      normalizedBytes = Buffer.from(normalizedText, "utf8");
    }
    files.push({
      absolutePath,
      path,
      text: normalizedText,
      lines: normalizedText.split(/\r?\n/),
      contentHash: sha256(normalizedBytes),
      size: bytes.length,
    });
    if (fileLimit > 0 && files.length >= fileLimit) {
      fileLimitReached = true;
      break;
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const truncationReasons = new Set(traversal.reasons);
  if (fileLimitReached) truncationReasons.add("file_limit");
  return {
    files,
    fileLimitReached,
    traversalTruncated: traversal.state.truncated,
    truncationReasons: [...truncationReasons].sort(),
  };
}

// Iterative directory walker. D:/Claude contains over a million directories,
// which overflows the JS call stack when walked recursively. An explicit stack
// keeps memory bounded and avoids the limit. Memory safety guarantees:
//   1. `maxDirs` cap is checked BEFORE any per-iteration work so a runaway
//      source tree cannot exceed the budget.
//   2. Directory entries are streamed and retained only up to
//      `maxEntriesPerDir + 1`, so an escaped cache cannot allocate an
//      unbounded Dirent array.
const MAX_ENTRIES_PER_DIR = 5000;
function walk(root, options = {}) {
  const maxDirs = Number(options.maxDirs ?? 50000);
  const maxEntriesPerDir = Number(options.maxEntriesPerDir ?? MAX_ENTRIES_PER_DIR);
  const reasons = new Set();
  const state = { truncated: false };

  function* iteratePaths() {
    const visited = new Set();
    const stack = [root];
    let processedDirs = 0;
    while (stack.length > 0) {
      if (processedDirs >= maxDirs) {
        reasons.add("directory_limit");
        state.truncated = true;
        return;
      }
      const directory = stack.pop();
      const real = resolve(directory);
      let canonical = real;
      try {
        canonical = realpathSync(real);
      } catch {
        /* use resolved form */
      }
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      processedDirs += 1;
      const entries = [];
      let dir;
      try {
        dir = opendirSync(directory);
        while (true) {
          const entry = dir.readSync();
          if (!entry) break;
          entries.push(entry);
          if (entries.length > maxEntriesPerDir) break;
        }
      } catch {
        continue;
      } finally {
        try {
          dir?.closeSync();
        } catch {
          /* already closed */
        }
      }
      if (entries.length > maxEntriesPerDir) {
        reasons.add("directory_entry_limit");
        state.truncated = true;
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const parentName = basename(directory);
      const childDirectories = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORED.has(entry.name)) continue;
          childDirectories.push(join(directory, entry.name));
        } else if (entry.isFile()) {
          if (IGNORED_FILE_NAMES.has(entry.name)) continue;
          if ((entry.name === "product.md" || entry.name === "architecture.md") && parentName === "docs") continue;
          try {
            if (statSync(join(directory, entry.name)).size <= 2 * 1024 * 1024) {
              yield join(directory, entry.name);
            }
          } catch {
            /* unreadable file: skip */
          }
        }
      }
      for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
        stack.push(childDirectories[index]);
      }
    }
  }

  return { paths: iteratePaths(), state, reasons };
}

function addCallEdges(files, nodes, edges) {
  const targets = nodes.filter((node) => node.kind === "symbol" && ["Method", "Function"].some((label) => node.labels.includes(label)));
  const sources = nodes.filter((node) => node.kind === "symbol" && ["Method", "Function", "Test"].some((label) => node.labels.includes(label)));
  const targetsByName = new Map();
  for (const target of targets) {
    const callName = target.qualifiedName.split(".").at(-1);
    const matches = targetsByName.get(callName) ?? [];
    matches.push(target);
    targetsByName.set(callName, matches);
  }
  const importsByPath = new Map();
  for (const importEdge of edges.filter((item) => item.kind === "IMPORTS")) {
    const sourcePath = importEdge.source.replace(/^file:/, "");
    const targetPath = importEdge.target.replace(/^file:/, "");
    const imported = importsByPath.get(sourcePath) ?? new Set();
    imported.add(targetPath);
    importsByPath.set(sourcePath, imported);
  }
  for (const source of sources) {
    const file = files.find((item) => item.path === source.path);
    if (!file) continue;
    const ev = source.evidence[0];
    const body = file.lines.slice(ev.startLine - 1, ev.endLine).join("\n");
    for (const [callName, namedTargets] of targetsByName) {
      if (!containsCall(file, body, callName)) continue;
      const sameFile = namedTargets.filter((target) => target.path === source.path && target.id !== source.id);
      const importedPaths = importsByPath.get(source.path) ?? new Set();
      const imported = namedTargets.filter((target) => importedPaths.has(target.path) && target.id !== source.id);
      const resolvedTargets = sameFile.length > 0
        ? sameFile
        : imported.length > 0
          ? imported
          : namedTargets.length === 1 && namedTargets[0].id !== source.id
            ? namedTargets
            : [];
      for (const target of resolvedTargets) {
        edges.push(edge(source.labels.includes("Test") ? "TESTS" : "CALLS", source, target, source.evidence));
      }
    }
  }
}

function addConfigEdges(files, nodes, edges) {
  const filesByPath = new Map(nodes.filter((node) => node.kind === "file").map((node) => [node.path, node]));
  for (const source of nodes.filter((node) => node.labels?.includes("Const"))) {
    const file = files.find((item) => item.path === source.path);
    if (!file) continue;
    const line = file.lines[source.evidence[0].startLine - 1] ?? "";
    for (const match of line.matchAll(/["']([^"']+\.(?:json|yaml|yml|toml|sqlite|db))["']/g)) {
      const target = filesByPath.get(normalizePath(match[1]));
      if (target) edges.push(edge("CONFIGURES", source, target, source.evidence));
    }
  }
}

function edge(kind, source, target, evidence) {
  return {
    id: `edge:${kind}:${source.id}->${target.id}`,
    kind,
    source: source.id,
    target: target.id,
    confidence: 1,
    evidence,
  };
}

function fileEvidence(file, startLine, endLine) {
  return { path: file.path, startLine, endLine, contentHash: file.contentHash };
}

function evidenceFresh(generation, evidence) {
  return evidence.every((item) => {
    const file = generation.nodes.find((node) => node.kind === "file" && node.path === item.path);
    return file?.evidence?.[0]?.contentHash === item.contentHash;
  });
}

function scoreNode(node, terms) {
  if (!terms.length) return 1;
  const haystack = `${node.kind} ${node.name} ${node.qualifiedName} ${node.path}`.toLowerCase();
  return terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
}

function queryTerms(query) {
  const stop = new Set(["a", "an", "and", "for", "in", "of", "the", "to", "where"]);
  return [...new Set(String(query).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length > 1 && !stop.has(term)))];
}

function generationId(nodes, edges, files) {
  return `sha256:${sha256(JSON.stringify({ nodes, edges, sourceHash: sourceHash(files) }))}`;
}

function sourceHash(files) {
  return `sha256:${sha256(files.map((file) => `${file.path}:${file.contentHash}`).join("\n"))}`;
}

function estimateTokens(evidence) {
  return Math.max(1, Number(evidence.endLine) - Number(evidence.startLine) + 1);
}

function isCodeFile(file) {
  return CODE_EXTENSIONS.has(file.path.split(".").at(-1)?.toLowerCase());
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
