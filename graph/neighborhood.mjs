const DAMPING = 0.85;
const ITERATIONS = 20;
const MAX_HOPS = 2;

function nodePath(node) { return String(node?.path ?? ""); }
function nodeSpan(node) {
  const evidence = Array.isArray(node?.evidence) ? node.evidence[0] : null;
  return [Number(evidence?.startLine ?? 1), Number(evidence?.endLine ?? evidence?.startLine ?? 1)];
}
function nodeCost(node) { return Math.max(1, Math.ceil(JSON.stringify({ id: node.id, name: node.name, path: node.path, span: nodeSpan(node) }).length / 4)); }

function resolveAnchors(generation, anchors) {
  const nodes = generation.nodes ?? [];
  return (anchors ?? []).map((raw) => {
    const value = String(raw);
    const exact = nodes.find((node) => node.id === value)
      ?? nodes.find((node) => node.path === value && node.kind === "file")
      ?? nodes.find((node) => node.path === value);
    return { path: exact?.path ?? value, symbol: exact?.kind === "file" ? null : exact?.name ?? null, protected: true, node: exact ?? null };
  });
}

function pageRank(nodes, edges, anchorIds) {
  const ids = nodes.map((node) => node.id);
  const index = new Map(ids.map((id, position) => [id, position]));
  const outgoing = nodes.map(() => []);
  for (const edge of edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined || edge.resolved === false) continue;
    outgoing[source].push(target);
  }
  const personalization = new Set(anchorIds.map((id) => index.get(id)).filter((id) => id !== undefined));
  const uniform = personalization.size ? 1 / personalization.size : 1 / Math.max(1, nodes.length);
  let scores = nodes.map(() => 1 / Math.max(1, nodes.length));
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const next = nodes.map(() => (1 - DAMPING) * (personalization.size ? 0 : uniform));
    if (personalization.size) for (const position of personalization) next[position] += (1 - DAMPING) * uniform;
    for (let source = 0; source < outgoing.length; source += 1) {
      const targets = outgoing[source];
      const share = scores[source] / Math.max(1, targets.length);
      if (!targets.length) {
        for (let position = 0; position < next.length; position += 1) next[position] += DAMPING * share / Math.max(1, next.length);
      } else for (const target of targets) next[target] += DAMPING * share;
    }
    scores = next;
  }
  return new Map(nodes.map((node, position) => [node.id, scores[position]]));
}

function hopsFrom(nodes, edges, anchorIds) {
  const adjacent = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!adjacent.has(edge.source) || !adjacent.has(edge.target)) continue;
    adjacent.get(edge.source).push(edge.target);
    adjacent.get(edge.target).push(edge.source);
  }
  const distances = new Map(anchorIds.map((id) => [id, 0]));
  let frontier = [...anchorIds];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const distance = distances.get(id);
      for (const target of adjacent.get(id) ?? []) {
        if (distances.has(target)) continue;
        distances.set(target, distance + 1);
        next.push(target);
      }
    }
    frontier = next;
  }
  return distances;
}

export function buildNeighborhood(generation, anchors, { budgetTokens = 8000, receiptId = null, repoId = null, repoRoot = null, maxHops = MAX_HOPS } = {}) {
  const nodes = generation.nodes ?? [];
  const edges = generation.edges ?? [];
  const resolvedAnchors = resolveAnchors(generation, anchors);
  const anchorIds = resolvedAnchors.map((anchor) => anchor.node?.id).filter(Boolean);
  const scores = pageRank(nodes, edges, anchorIds);
  const distances = hopsFrom(nodes, edges, anchorIds);
  const selected = new Set(anchorIds);
  let usedTokens = anchorIds.reduce((sum, id) => sum + nodeCost(nodes.find((node) => node.id === id)), 0);
  const ranked = nodes
    .filter((node) => !selected.has(node.id) && (distances.get(node.id) ?? Infinity) <= maxHops)
    .sort((left, right) => (scores.get(right.id) - scores.get(left.id)) || left.id.localeCompare(right.id));
  let budgetOmissions = 0;
  for (const node of ranked) {
    const cost = nodeCost(node);
    if (usedTokens + cost > Number(budgetTokens)) { budgetOmissions += 1; continue; }
    selected.add(node.id);
    usedTokens += cost;
  }
  const hopOmissions = nodes.filter((node) => !selected.has(node.id) && !anchorIds.includes(node.id) && (distances.get(node.id) ?? Infinity) > maxHops).length;
  const unresolved = edges.filter((edge) => edge.resolved === false || !edge.target).length;
  const neurons = [...selected].map((id) => nodes.find((node) => node.id === id)).filter(Boolean)
    .sort((left, right) => (anchorIds.includes(left.id) ? -1 : anchorIds.includes(right.id) ? 1 : (scores.get(right.id) - scores.get(left.id)) || left.id.localeCompare(right.id)))
    .map((node) => ({ id: node.id, kind: node.kind, path: node.path, span: nodeSpan(node), score: scores.get(node.id) ?? 0 }));
  const synapses = edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)).map((edge) => ({
    id: edge.id,
    kind: edge.kind,
    source: edge.source,
    target: edge.target,
    confidenceTier: edge.confidenceTier ?? null,
    resolved: edge.resolved !== false,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const omissions = [];
  if (budgetOmissions) omissions.push({ reason: "budget", count: budgetOmissions, recovery: "raise --budget-tokens | cortex neighborhood <path>" });
  if (hopOmissions) omissions.push({ reason: "hops", count: hopOmissions, recovery: "cortex neighborhood <path>" });
  if (unresolved) omissions.push({ reason: "unresolved", count: unresolved, recovery: "cortex neighborhood <path>" });
  const selectedIds = neurons.map((neuron) => neuron.id);
  return {
    schemaVersion: 1,
    kind: "RepositoryNeighborhoodV1",
    repoId: repoId ?? generation.repoId ?? null,
    repoRoot: repoRoot ?? generation.repoRoot ?? null,
    generationId: generation.manifest?.generationId ?? null,
    receiptId,
    anchors: resolvedAnchors.map(({ path, symbol, protected: isProtected }) => ({ path, symbol, protected: isProtected })),
    neurons,
    synapses,
    circuits: selectedIds.length ? [{ name: "repository-neighborhood", neuronIds: selectedIds }] : [],
    bounds: { budgetTokens: Number(budgetTokens), usedTokens, maxHops },
    omissions,
  };
}

export { DAMPING, ITERATIONS, MAX_HOPS };
