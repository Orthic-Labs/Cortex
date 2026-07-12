import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const PROVIDER = {
  id: "blueprint-static",
  version: "repo-local-deterministic-v0",
  license: "workspace-owned",
};

const IGNORED = new Set([".agent", ".agent-test-graph", ".blueprint", ".git", "node_modules", "target", "dist", "build"]);
const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

export function buildGraphGeneration(repoRoot, options = {}) {
  const root = resolve(repoRoot);
  const outDir = options.outDir ? resolve(root, options.outDir) : null;
  const source = scanSources(root);
  const generation = buildGenerationFromSources(root, source);
  if (outDir) writeGeneration(outDir, generation);
  return generation;
}

export function graphStatus(repoRoot, outDir) {
  const root = resolve(repoRoot);
  const manifestPath = join(resolve(root, outDir), "graph", "manifest.json");
  if (!existsSync(manifestPath)) return { state: "missing", manifestPath };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.complete) return { state: "incomplete", manifestPath, manifest };
  const currentHash = sourceHash(scanSources(root).files);
  return {
    state: manifest.repo?.sourceHash === currentHash ? "fresh" : "stale",
    manifestPath,
    manifest,
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
  const supersedeClaims = map.nodes.filter(
    (node) => node.kind === "claim" && /\b(supersedes|replaced by|deprecated by)\b/i.test(stripInlineCode(node.text ?? "")),
  );
  const out = [];
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
  const maxFlows = Number(options.maxFlows ?? 200);
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
    generatedAt: new Date().toISOString(),
    flows,
    truncated,
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

function buildGenerationFromSources(root, source) {
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
    generatedAt: new Date().toISOString(),
    generationId: generationId(cleanNodes, cleanEdges, source.files),
    complete: true,
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

function scanSources(root) {
  const files = [];
  for (const absolutePath of walk(root)) {
    const path = normalizePath(relative(root, absolutePath));
    const bytes = readFileSync(absolutePath);
    if (bytes.includes(0) || bytes.length > 2 * 1024 * 1024) continue;
    const text = bytes.toString("utf8");
    files.push({
      absolutePath,
      path,
      text,
      lines: text.split(/\r?\n/),
      contentHash: sha256(bytes),
      size: bytes.length,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files };
}

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && statSync(full).size <= 2 * 1024 * 1024) out.push(full);
  }
  return out;
}

function extractSymbols(file, addNode) {
  const classStack = [];
  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index];
    const lineNo = index + 1;
    const classMatch = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      const name = classMatch[1];
      const endLine = findBlockEnd(file.lines, index);
      classStack.push({ name, endLine });
      addNode(symbolNode("class", file, name, name, lineNo, endLine));
      continue;
    }
    while (classStack.length && lineNo > classStack.at(-1).endLine) classStack.pop();
    const functionMatch = line.match(/^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (functionMatch) {
      addNode(symbolNode("symbol", file, functionMatch[1], functionMatch[1], lineNo, findBlockEnd(file.lines, index), ["Function"]));
    }
    const constMatch = line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b/);
    if (constMatch) {
      addNode(symbolNode("symbol", file, constMatch[1], constMatch[1], lineNo, lineNo, ["Const"]));
    }
    const currentClass = classStack.at(-1);
    const methodMatch = currentClass && line.match(/^\s{2,}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    if (methodMatch && methodMatch[1] !== "constructor") {
      const qualified = `${currentClass.name}.${methodMatch[1]}`;
      addNode(symbolNode("symbol", file, qualified, qualified, lineNo, findBlockEnd(file.lines, index), ["Method"]));
    }
    const testMatch = line.match(/^\s*test\s*\(\s*["']([^"']+)["']/);
    if (testMatch) {
      addNode(symbolNode("symbol", file, testMatch[1], testMatch[1], lineNo, findBlockEnd(file.lines, index), ["Test"]));
    }
  }
}

function symbolNode(kind, file, name, qualifiedName, startLine, endLine, labels = ["Symbol"]) {
  return {
    id: `symbol:${file.path}::${qualifiedName}`,
    kind,
    labels,
    name,
    qualifiedName,
    path: file.path,
    evidence: [fileEvidence(file, startLine, endLine)],
  };
}

function addCallEdges(files, nodes, edges) {
  const targets = nodes.filter((node) => node.kind === "symbol" && ["Method", "Function"].some((label) => node.labels.includes(label)));
  const sources = nodes.filter((node) => node.kind === "symbol" && ["Method", "Function", "Test"].some((label) => node.labels.includes(label)));
  for (const source of sources) {
    const file = files.find((item) => item.path === source.path);
    if (!file) continue;
    const ev = source.evidence[0];
    const body = file.lines.slice(ev.startLine - 1, ev.endLine).join("\n");
    for (const target of targets) {
      if (source.id === target.id) continue;
      const callName = target.qualifiedName.split(".").at(-1);
      if (!new RegExp(`(?:\\.|\\b)${escapeRegExp(callName)}\\s*\\(`).test(body)) continue;
      edges.push(edge(source.labels.includes("Test") ? "TESTS" : "CALLS", source, target, source.evidence));
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

function extractImports(file, files) {
  const imports = [];
  const baseDir = file.path.split("/").slice(0, -1);
  for (const match of file.text.matchAll(/import(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const raw = [...baseDir, ...specifier.split("/")].filter((part) => part && part !== ".");
    const parts = [];
    for (const part of raw) {
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    const base = parts.join("/").replace(/\.(js|jsx|mjs|cjs)$/, "");
    const found = files.find((candidate) => [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`].includes(candidate.path));
    if (found) imports.push(found.path);
  }
  return imports;
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

function findBlockEnd(lines, startIndex) {
  let depth = 0;
  let seenOpen = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === "{") {
        depth += 1;
        seenOpen = true;
      } else if (char === "}") {
        depth -= 1;
        if (seenOpen && depth <= 0) return index + 1;
      }
    }
  }
  return startIndex + 1;
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
