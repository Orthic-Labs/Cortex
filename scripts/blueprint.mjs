#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDocCodeJoins,
  buildGraphGeneration,
  createContextCandidateSet,
  graphArchitecture,
  graphFlowInventory,
  graphImpact,
  graphMermaid,
  graphNeighbors,
  graphPath,
  graphStatus,
  queryGraph,
  resolveGraphNode,
} from "../graph/static-provider.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONTEXT_BUDGET_SCRIPT = resolve(SCRIPT_DIR, "../../../lib/context_budget.py");
const CONTEXT_BUDGET_LOG = resolve(SCRIPT_DIR, "../../../.cache/metrics/context-budget.jsonl");

const DEFAULT_OUT = ".agent";
const SCHEMA_VERSION = 1;
const STATUS_RE =
  /\b(done|complete|implemented|partial|pending|planned|stale|drift|contradict|missing|not implemented|not shipped|not built|gap|gotcha|decision|canonical|supersedes)\b/i;
const GOTCHA_RE = /\b(do not|don't|never|missing|not implemented|not shipped|not built|stale|drift|contradict|gotcha|warning)\b/i;
// Language-agnostic: any slash-separated path token ending in a known code/doc extension.
const PATH_RE =
  /(?:^|[`(\s])((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.(?:rs|ts|tsx|js|jsx|mjs|cjs|json|toml|md|mdx|yml|yaml|py|go|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|kts|scala|sh|ps1|sql|html|css|scss|vue|svelte))(?:[`)\s.,;:]|$)/g;
const CODE_EXT = new Set([
  "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "rb", "php",
  "c", "cc", "cpp", "h", "hpp", "cs", "swift", "kt", "kts", "scala", "sh", "ps1",
  "sql", "vue", "svelte",
]);
const TASK_STOP_TERMS = new Set([
  "add",
  "build",
  "check",
  "create",
  "fix",
  "implement",
  "make",
  "test",
  "update",
  "use",
]);

const DEFAULT_CONFIG = {
  canonicalDocs: ["AGENTS.md", "CLAUDE.md", "README.md"],
  archiveGlobs: ["docs/archive/"],
  budgets: {
    briefMaxLines: 160,
    maxReadFirstFiles: 8,
    maxSourceSpans: 30,
    maxTruths: 10,
    maxGotchas: 8,
    maxCodeEvidence: 14,
  },
  ignoredPrefixes: [
    ".agent/",
    ".git/",
    ".codex-tmp/",
    ".cache/",
    ".gstack/",
    "node_modules/",
    "target/",
    "engine/target",
    "dist/",
  ],
};

function usage() {
  const command = scriptCommand();
  console.log(`usage:
  ${command}
  ${command} "task to orient around"
  ${command} build [--out .agent] [--limit N] [--check]
  ${command} brief --task "..." [--out .agent] [--refresh] [--limit N]
  ${command} doctor [--out .agent]
  ${command} graph build|status|schema|search|neighbors|path|impact|resolve|architecture|flows|doc-truth|mermaid|planner-status|candidates [--out .agent]
`);
}

function scriptCommand() {
  return "blueprint";
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) {
      args[key] = inline;
    } else if (["check", "refresh"].includes(key)) {
      args[key] = true;
    } else {
      args[key] = argv[++i];
    }
  }
  return args;
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function slug(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function repoFiles(root, config, limit = 0) {
  let files;
  try {
    const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    files = raw
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    files = walk(root).map((path) => relative(root, path));
  }
  const ignored = config.ignoredPrefixes ?? [];
  const filtered = files
    .map(normalizePath)
    .filter((path) => !ignored.some((prefix) => path.startsWith(prefix)))
    .filter((path) => existsSync(join(root, path)))
    .sort();
  return limit > 0 ? filtered.slice(0, limit) : filtered;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "node_modules", "target"].includes(entry.name)) continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function loadConfig(root, outDir) {
  const path = join(root, outDir, "config.json");
  if (!existsSync(path)) writeJson(path, DEFAULT_CONFIG);
  return readJson(path, DEFAULT_CONFIG);
}

function isDoc(path) {
  return path.endsWith(".md") || ["AGENTS.md", "CLAUDE.md", "README.md"].includes(path);
}

function isImplementationPath(path) {
  if (isDoc(path)) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CODE_EXT.has(ext);
}

function sourceSignature(root, config, limit = 0) {
  const files = repoFiles(root, config, limit);
  const docHashes = files
    .filter(isDoc)
    .map((path) => {
      const text = readFileSync(join(root, path), "utf8");
      return `${path}:${sha1(text)}`;
    });
  const fileListHash = sha1(files.join("\n"));
  return sha1([fileListHash, ...docHashes].join("\n"));
}

function extractDoc(root, path, allFiles) {
  const full = join(root, path);
  const text = readFileSync(full, "utf8");
  const lines = text.split(/\r?\n/);
  const headings = [];
  const claims = [];
  const codeRefs = new Set();
  let currentHeading = "";
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      currentHeading = heading[2].trim();
      headings.push({ line: i + 1, level: heading[1].length, text: currentHeading });
      continue;
    }
    if (!inFence) {
      for (const match of line.matchAll(PATH_RE)) {
        codeRefs.add(normalizePath(match[1]));
      }
    }
    if (inFence || !looksLikeClaim(line)) continue;
    claims.push({
      id: `claim.${slug(path)}.${i + 1}`,
      kind: "claim",
      source: path,
      line: i + 1,
      heading: currentHeading,
      text: truncateText(cleanClaimText(line), 360),
      status: classifyStatus(line),
      missingRefs: [],
    });
  }
  const refs = [...codeRefs].map((ref) => ({
    path: ref,
    exists: allFiles.has(ref) || existsSync(join(root, ref)),
  }));
  const stat = statSync(full);
  return {
    id: `doc.${slug(path)}`,
    kind: "doc",
    path,
    title: headings[0]?.text ?? basename(path),
    sha1: sha1(text),
    mtimeMs: Math.floor(stat.mtimeMs),
    searchText: truncateText(text.replace(/\s+/g, " "), 2400),
    headings,
    claims,
    codeRefs: refs,
  };
}

function looksLikeClaim(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith(">")) return false;
  const plain = stripInlineCode(trimmed);
  if (plain.length < 12 || !STATUS_RE.test(plain)) return false;
  if (/^(expected:|run:|assert!?|\/\/|let\s|const\s|fn\s|pub\s|use\s|import\s)/i.test(trimmed)) {
    return false;
  }
  return true;
}

function stripInlineCode(line) {
  return String(line).replace(/`[^`]*`/g, "");
}

function cleanClaimText(line) {
  return String(line).trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ");
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, Math.max(0, maxLength - 3));
  return `${clipped.replace(/\s+\S*$/, "")}...`;
}

function classifyStatus(line) {
  const lower = stripInlineCode(line).toLowerCase();
  if (/not implemented|not shipped|not built|missing|pending|planned|gap/.test(lower)) return "planned";
  if (/partial|drift/.test(lower)) return "partial";
  if (/stale|contradict/.test(lower)) return "stale";
  if (/done|complete|implemented/.test(lower)) return "implemented";
  return "claim";
}

function build(root, outDir, options = {}) {
  const config = loadConfig(root, outDir);
  const limit = Number(options.limit ?? 0);
  const files = repoFiles(root, config, limit);
  const allFiles = new Set(files);
  const docs = files.filter(isDoc).map((path) => extractDoc(root, path, allFiles));
  const claims = docs.flatMap((doc) => doc.claims);
  const codeRefs = new Map();
  const edges = [];
  const stale = { missingReferences: [], staleClaims: [] };

  for (const doc of docs) {
    for (const claim of doc.claims) {
      edges.push({ from: doc.id, to: claim.id, type: "contains" });
      if (claim.status === "stale") stale.staleClaims.push(claim);
    }
    for (const ref of doc.codeRefs) {
      const id = `code.${slug(ref.path)}.${sha1(ref.path).slice(0, 8)}`;
      codeRefs.set(ref.path, { id, kind: "code_ref", path: ref.path, exists: ref.exists });
      edges.push({ from: doc.id, to: id, type: "mentions-code" });
      if (!ref.exists) stale.missingReferences.push({ source: doc.path, path: ref.path });
    }
  }

  const nodes = [
    { id: "repo.root", kind: "repo", path: "." },
    ...docs.map(({ claims: _claims, codeRefs: _codeRefs, ...doc }) => doc),
    ...claims,
    ...codeRefs.values(),
  ];
  const generatedAt = new Date().toISOString();
  const signature = sourceSignature(root, config, limit);
  const map = {
    schemaVersion: SCHEMA_VERSION,
    repo: basename(root),
    generatedAt,
    entrypoint: `${outDir}/START-HERE.md`,
    precedence: ["code", "adr", "current-audit", "architecture", "plan", "archive"],
    stats: { files: files.length, docs: docs.length, claims: claims.length, codeRefs: codeRefs.size },
    nodes,
    edges,
  };
  const index = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    sourceSignature: signature,
    configHash: sha1(JSON.stringify(config)),
    files: files.map((path) => ({ path, isDoc: isDoc(path) })),
  };

  const queue = buildUnderstandingQueue(root, docs, files);
  writeJson(join(root, outDir, "map.json"), map);
  writeJson(join(root, outDir, "claims.json"), claims);
  writeJson(join(root, outDir, "stale.json"), stale);
  writeJson(join(root, outDir, "index.json"), index);
  writeJson(join(root, outDir, "queue.json"), queue);
  const graphGeneration = buildGraphGeneration(root, { outDir });
  const flows = graphFlowInventory(graphGeneration);
  writeJson(join(root, outDir, "flows.json"), flows);
  writeText(join(root, outDir, "START-HERE.md"), startHere(map, stale, graphGeneration, flows));
  return { map, stale, index, queue, graphGeneration, flows };
}

// Deterministic Phase-2 worklist: pair each doc claim with the implementation
// files its own doc references (the things to verify it against), plus the
// largest implementation files as synthesis anchors. Grounds the agent pass so
// it reads real code instead of guessing.
function buildUnderstandingQueue(root, docs, files) {
  const claims = [];
  for (const doc of docs) {
    const candidateFiles = doc.codeRefs
      .filter((ref) => ref.exists && isImplementationPath(ref.path))
      .map((ref) => ref.path);
    for (const claim of doc.claims) {
      claims.push({
        id: claim.id,
        source: claim.source,
        line: claim.line,
        status: claim.status,
        text: claim.text,
        candidateFiles,
      });
    }
  }
  const anchors = files
    .filter(isImplementationPath)
    .map((path) => {
      try {
        return { path, size: statSync(join(root, path)).size };
      } catch {
        return { path, size: 0 };
      }
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 15)
    .map((item) => item.path);
  return { generatedAt: new Date().toISOString(), claims, anchors };
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

function startHere(map, stale, graphGeneration = null, flows = null) {
  const missing = stale.missingReferences.slice(0, 8);
  const command = scriptCommand();
  const topDocs = map.nodes
    .filter((node) => node.kind === "doc")
    .slice(0, 20)
    .map((doc) => `- ${doc.path}${doc.title && doc.title !== basename(doc.path) ? ` — ${doc.title}` : ""}`);
  return `# ${map.repo} — Repo Map

The single human-readable entry point. Everything else under \`${map.entrypoint.split("/")[0]}/\` (\`map.json\`, \`claims.json\`, \`stale.json\`, \`index.json\`) is machine-readable for agents.

Generated: ${map.generatedAt}

## Stats

- Files: ${map.stats.files}
- Docs: ${map.stats.docs}
- Doc claims: ${map.stats.claims}
- Code refs: ${map.stats.codeRefs}
- Missing refs: ${stale.missingReferences.length}

## Graph

\`\`\`mermaid
${mermaid(map)}
\`\`\`

## Code Graph

${graphGeneration ? `- Provider: \`${graphGeneration.provider.id}\`
- Nodes: ${graphGeneration.nodes.length}
- Edges: ${graphGeneration.edges.length}
- Generation: \`${graphGeneration.manifest.generationId}\`
- Product flows: ${flows?.flows?.length ?? 0}` : "- Not generated."}

## Key Docs

${topDocs.length ? topDocs.join("\n") : "- None found."}

## Warnings

${missing.length ? missing.map((ref) => `- ${ref.source} mentions missing ${ref.path}`).join("\n") : "- No missing refs found."}

## Task Brief

For a specific task, generate a scoped brief (Read-First files, claims, code evidence, drift):

\`\`\`bash
${command} "your task"
\`\`\`
`;
}

function mermaid(map) {
  const lines = ["flowchart TD", '  repo["repo"]'];
  for (const doc of map.nodes.filter((node) => node.kind === "doc").slice(0, 18)) {
    lines.push(`  ${safeMermaidId(doc.id)}["${escapeMermaid(doc.title)}"]`);
    lines.push(`  repo --> ${safeMermaidId(doc.id)}`);
  }
  return lines.join("\n");
}

function safeMermaidId(id) {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function escapeMermaid(text) {
  return String(text).replaceAll('"', "'");
}

function isFresh(root, outDir, config, limit = 0) {
  const mapPath = join(root, outDir, "map.json");
  const indexPath = join(root, outDir, "index.json");
  const configPath = join(root, outDir, "config.json");
  if (!existsSync(mapPath) || !existsSync(indexPath) || !existsSync(configPath)) return false;
  const index = readJson(indexPath, null);
  if (!index?.sourceSignature) return false;
  if (index.sourceSignature !== sourceSignature(root, config, limit)) return false;
  return graphStatus(root, outDir).state === "fresh";
}

function ensureFresh(root, outDir, options) {
  const config = loadConfig(root, outDir);
  if (!options.refresh && isFresh(root, outDir, config, Number(options.limit ?? 0))) {
    return { rebuilt: false, config };
  }
  build(root, outDir, options);
  return { rebuilt: true, config };
}

function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

function taskKeywords(text) {
  const terms = [...tokenize(text)].filter((term) => !TASK_STOP_TERMS.has(term));
  return new Set(terms.length ? terms : [...tokenize(text)]);
}

function normalizedSearchText(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreText(taskTerms, text) {
  const hay = String(text).toLowerCase();
  let score = 0;
  for (const term of taskTerms) {
    if (hay.includes(term)) score += term.length > 5 ? 3 : 1;
  }
  return score;
}

function plannedContextBudget(task, root) {
  try {
    const command = process.platform === "win32" ? "py" : "python3";
    const args = process.platform === "win32" ? ["-3.11"] : [];
    args.push(
      CONTEXT_BUDGET_SCRIPT,
      "plan",
      "--surface", "blueprint",
      "--session", createHash("sha256").update(root).digest("hex"),
      "--query", task,
      "--record", CONTEXT_BUDGET_LOG,
    );
    if (process.env.MEMRIGHT_TRANSCRIPT_PATH) {
      args.push("--transcript", process.env.MEMRIGHT_TRANSCRIPT_PATH);
    }
    return JSON.parse(execFileSync(command, args, { encoding: "utf8", windowsHide: true }));
  } catch {
    return null;
  }
}

function orderedTermScore(taskTerms, text) {
  const terms = [...taskTerms];
  if (terms.length < 2) return 0;
  const hay = normalizedSearchText(text);
  let score = hay.includes(terms.join(" ")) ? 8 : 0;
  for (let i = 0; i < terms.length - 1; i += 1) {
    if (hay.includes(`${terms[i]} ${terms[i + 1]}`)) score += 3;
  }
  return score;
}

function claimIsRelevant(taskTerms, claim) {
  const directText = `${claim.text} ${claim.heading ?? ""}`;
  const text = `${directText} ${claim.source}`;
  if (
    /\b(separate change|out of scope)\b/i.test(stripInlineCode(claim.text)) &&
    !isTaskTextMatch(taskTerms, directText)
  ) {
    return false;
  }
  if (/\blow priority after\b/i.test(stripInlineCode(claim.text))) return false;
  if (taskTerms.size <= 1) return claim.score >= 3;
  const directHits = countTaskTermHits(taskTerms, directText);
  return orderedTermScore(taskTerms, directText) > 0 || (directHits >= 1 && claim.score >= 5);
}

function brief(root, outDir, options) {
  const task = options.task;
  if (!task) throw new Error("brief requires --task");
  const { rebuilt, config } = ensureFresh(root, outDir, options);
  const contextBudget = plannedContextBudget(task, root);
  const map = readJson(join(root, outDir, "map.json"), null);
  const taskTerms = taskKeywords(task);
  const docById = new Map(map.nodes.filter((node) => node.kind === "doc").map((doc) => [doc.id, doc]));
  const edgesByDoc = new Map();
  for (const edge of map.edges) {
    if (!edgesByDoc.has(edge.from)) edgesByDoc.set(edge.from, []);
    edgesByDoc.get(edge.from).push(edge);
  }
  const claims = map.nodes
    .filter((node) => node.kind === "claim")
    .map((claim) => ({
      ...claim,
      score:
        scoreText(taskTerms, claim.text) +
        scoreText(taskTerms, claim.source) * 5 +
        scoreText(taskTerms, claim.heading ?? "") * 2 +
        (config.canonicalDocs?.includes(claim.source) ? 2 : 0) +
        (claim.status === "planned" ? 1 : 0),
    }))
    .filter((claim) => claimIsRelevant(taskTerms, claim))
    .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
  const claimScoreBySource = new Map();
  for (const claim of claims) {
    claimScoreBySource.set(claim.source, Math.max(claimScoreBySource.get(claim.source) ?? 0, claim.score));
  }

  const diverseClaims = [];
  const sourceCounts = new Map();
  for (const claim of claims) {
    const count = sourceCounts.get(claim.source) ?? 0;
    if (count >= 8) continue;
    diverseClaims.push(claim);
    sourceCounts.set(claim.source, count + 1);
    if (diverseClaims.length >= config.budgets.maxSourceSpans) break;
  }
  const selectedDocs = new Map();
  for (const claim of diverseClaims) {
    const doc = [...docById.values()].find((item) => item.path === claim.source);
    if (!doc) continue;
    selectedDocs.set(doc.path, doc);
  }
  if (selectedDocs.size === 0) {
    for (const doc of map.nodes.filter((node) => node.kind === "doc")) {
      const score = scoreText(taskTerms, `${doc.path} ${doc.title} ${doc.searchText ?? ""}`);
      if (score > 0) selectedDocs.set(doc.path, doc);
    }
  }
  const maxReadFirst = contextBudget
    ? Math.max(2, Math.min(config.budgets.maxReadFirstFiles, Math.floor(contextBudget.blueprint_chars / 200)))
    : config.budgets.maxReadFirstFiles;
  const docReadLimit = Math.max(1, Math.min(2, Math.ceil(maxReadFirst * 0.35)));
  const canonicalDocPaths = (config.canonicalDocs ?? [])
    .map((path) => docById.get(`doc.${slug(path)}`) ?? [...docById.values()].find((doc) => doc.path === path))
    .filter((doc) => doc && documentMatchesTask(doc, taskTerms))
    .map((doc) => doc.path);
  const docCandidates = [...new Set([...selectedDocs.keys(), ...canonicalDocPaths])];
  const docsFirst = docCandidates
    .sort((a, b) => docPriority(b) - docPriority(a) || a.localeCompare(b))
    .slice(0, docReadLimit);
  function docPriority(path) {
    const doc = [...docById.values()].find((item) => item.path === path);
    const canonicalBonus = (config.canonicalDocs ?? []).includes(path) ? 4 : 0;
    return (claimScoreBySource.get(path) ?? 0) * 10 + scoreText(taskTerms, `${path} ${doc?.title ?? ""} ${doc?.searchText ?? ""}`) + canonicalBonus;
  }
  const codeRefs = new Map();
  const addCodeRefsForDoc = (path) => {
    const doc = selectedDocs.get(path);
    if (!doc) return;
    for (const edge of edgesByDoc.get(doc.id) ?? []) {
      if (edge.type !== "mentions-code") continue;
      const node = map.nodes.find((item) => item.id === edge.to && item.exists);
      if (node && isImplementationPath(node.path)) codeRefs.set(node.path, node);
    }
  };
  for (const path of docsFirst) addCodeRefsForDoc(path);
  if (codeRefs.size === 0) {
    for (const path of selectedDocs.keys()) {
      if (codeRefs.size >= maxReadFirst - docsFirst.length) break;
      if (!docsFirst.includes(path)) addCodeRefsForDoc(path);
    }
  }
  const codeFirst = [...codeRefs.keys()].slice(0, Math.max(0, maxReadFirst - docsFirst.length));
  const semanticCodeFirst = semanticReadFirstPaths(root, outDir, config, taskTerms, Number(options.limit ?? 0));
  const readFirstItems = codeFirst.length
    ? [...docsFirst, ...codeFirst, ...semanticCodeFirst]
    : [...selectedDocs.keys()].slice(0, maxReadFirst);
  let readFirst = [...new Set(readFirstItems)].slice(0, maxReadFirst);
  const truths = diverseClaims
    .filter((claim) => ["implemented", "partial", "planned", "stale"].includes(claim.status))
    .slice(0, config.budgets.maxTruths);
  const gotchas = diverseClaims
    .filter(
      (claim) =>
        claim.score >= 7 &&
        (countTaskTermHits(taskTerms, `${claim.text} ${claim.source}`) >=
          Math.min(taskTerms.size, 3) ||
          orderedTermScore(taskTerms, `${claim.text} ${claim.source}`) > 0) &&
        GOTCHA_RE.test(claim.text) &&
        !/^(expected:|assert!?|\/\/)/i.test(claim.text),
    )
    .slice(0, config.budgets.maxGotchas);
  // One dir per task (no timestamp): reruns of the same task overwrite the four fixed output files
  // instead of accumulating. runs/ is gitignored working state, not a history log.
  const runDir = join(outDir, "runs", slug(task) || "task");
  const sources = diverseClaims.map((claim) => ({
    id: claim.id,
    source: claim.source,
    line: claim.line,
    heading: claim.heading,
    status: claim.status,
    text: claim.text,
  }));
  let evidence = codeEvidence(
    root,
    evidenceCandidatePaths(root, outDir, config, taskTerms, readFirst, Number(options.limit ?? 0)),
    taskTerms,
    config.budgets.maxCodeEvidence ?? 12,
  );
  readFirst = [...new Set([...readFirst, ...evidence.map((item) => item.path)])].slice(0, maxReadFirst);
  evidence = codeEvidence(root, readFirst, taskTerms, config.budgets.maxCodeEvidence ?? 12);
  const briefText = taskBrief({ task, rebuilt, readFirst, truths, gotchas, sources, evidence, map });
  writeText(join(root, runDir, "TASK-BRIEF.md"), briefText);
  writeJson(join(root, runDir, "context.json"), {
    task,
    rebuilt,
    contextBudget,
    readFirst,
    claimIds: sources.map((source) => source.id),
    evidenceIds: evidence.map((item) => item.id),
  });
  writeJson(join(root, runDir, "sources.json"), sources);
  writeJson(join(root, runDir, "evidence.json"), evidence);
  const expected = String(options.expect ?? "")
    .split(",")
    .map((item) => normalizePath(item.trim()))
    .filter(Boolean);
  const missingExpected = expected.filter((path) => !readFirst.includes(path));
  if (missingExpected.length) {
    console.error(`missing expected read-first files: ${missingExpected.join(", ")}`);
    process.exitCode = 2;
  }
  return { runDir, readFirst, sources, rebuilt, missingExpected };
}

function taskBrief({ task, rebuilt, readFirst, truths, gotchas, sources, evidence, map }) {
  const list = (items, render) => (items.length ? items.map(render).join("\n") : "- None found.");
  const drift = driftChecks(truths, readFirst, taskKeywords(task));
  return `# Task Brief

Task: ${task}

Graph: ${rebuilt ? "rebuilt before this brief" : "fresh existing graph reused"}
Generated: ${new Date().toISOString()}

## Read First

${list(readFirst, (path) => `- ${path}`)}

## Relevant Claims

${list(truths, (claim) => `- ${claim.text} (${claim.source}:${claim.line})`)}

## Drift Checks

${list(drift, (item) => `- ${item}`)}

## Code Evidence

${list(evidence, (item) => `- ${item.kind}: ${item.text} (${item.path}:${item.line})`)}

## Gotchas

${list(gotchas, (claim) => `- ${claim.text} (${claim.source}:${claim.line})`)}

## Source Spans

${list(sources.slice(0, 20), (source) => `- ${source.id} -> ${source.source}:${source.line}`)}

## Fallback

If this brief misses the task area, read ${map.entrypoint} and run targeted \`rg\` before broad file sweeps.
`;
}

function documentMatchesTask(doc, taskTerms) {
  return scoreText(taskTerms, `${doc.path} ${doc.title} ${doc.searchText ?? ""}`) > 0;
}

function evidenceCandidatePaths(root, outDir, config, taskTerms, readFirst, limit = 0) {
  const candidates = new Set([...readFirst.filter(isImplementationPath), ...semanticReadFirstPaths(root, outDir, config, taskTerms, limit)]);
  for (const path of repoFiles(root, config, limit)) {
    if (!isImplementationPath(path) || candidates.size >= 80) continue;
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (stat.size > 240_000) continue;
    const text = readFileSync(full, "utf8");
    if (scoreText(taskTerms, `${path} ${text}`) > 0) candidates.add(path);
  }
  return [...candidates];
}

// Generic: no repo-specific runtime path list. Evidence selection is driven by
// task-term scoring over the actual tracked files, not a hardcoded layout.
function semanticReadFirstPaths(root, outDir, config, taskTerms, limit = 0) {
  void config;
  void limit;
  try {
    const generation = readFreshGraph(root, outDir);
    const query = [...taskTerms].join(" ");
    return [...new Set(queryGraph(generation, { query, limit: 12 })
      .flatMap((result) => result.evidence ?? [])
      .map((item) => item.path)
      .filter(isImplementationPath))];
  } catch {
    return [];
  }
}

function codeEvidence(root, readFirst, taskTerms, maxItems) {
  const items = [];
  const seen = new Set();
  for (const path of readFirst.filter(isImplementationPath)) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, "utf8").split(/\r?\n/);
    let pendingTestAttr = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*#\[(tokio::test|test)\]/.test(line)) {
        pendingTestAttr = true;
        continue;
      }
      const kind = classifyCodeEvidenceLine(line, path, taskTerms, pendingTestAttr);
      if (!kind) {
        if (line.trim()) pendingTestAttr = false;
        continue;
      }
      pendingTestAttr = false;
      const text = truncateText(line.trim().replace(/\s+/g, " "), 220);
      const key = `${path}:${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: `evidence.${slug(path)}.${i + 1}`,
        path,
        line: i + 1,
        kind,
        text,
        score: codeEvidenceScore(kind, taskTerms, `${line} ${path}`),
      });
    }
  }
  return selectDiverseEvidence(items, maxItems);
}

function classifyCodeEvidenceLine(line, path, taskTerms, pendingTestAttr) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("///") || trimmed.startsWith("#")) return null;
  if (!isTaskTextMatch(taskTerms, `${line} ${path}`)) return null;
  if (pendingTestAttr && /\b(async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*/.test(trimmed)) return "test";
  if (/^\s*(pub\s+)?(async\s+)?fn\s+[A-Za-z_]/.test(line)) return "function";
  if (/^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Za-z_]/.test(line)) return "function";
  if (/^\s*(export\s+)?(public\s+|private\s+|protected\s+|static\s+)*(func|def)\s+[A-Za-z_]/.test(line)) return "function";
  if (/^\s*(export\s+)?(abstract\s+)?class\s+[A-Za-z_]/.test(line)) return "class";
  if (/^\s*(export\s+)?(pub\s+)?(type|interface|struct|enum|trait)\s+[A-Za-z_]/.test(line)) return "type";
  if (/^\s*(export\s+)?const\s+[A-Za-z_]/.test(line)) return "constant";
  if (/^\s*(pub\s+)?(const|static)\s+[A-Z0-9_]+\b/.test(line)) return "constant";
  if (/^\s*mod\s+[A-Za-z_][A-Za-z0-9_]*\s*;/.test(line)) return "module";
  if (/^\s*(import\b|use\s+|from\s+\S+\s+import|require\()/.test(line)) return "reference";
  if (/\b(process\.env|std::env|os\.environ|getenv|ENV\[|System\.getenv)\b/.test(line)) return "config";
  if (/[.:]{1,2}[A-Za-z_][A-Za-z0-9_]*\s*\(|\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) return "call-site";
  return null;
}

function codeEvidenceScore(kind, taskTerms, line) {
  const priority = {
    function: 60,
    "call-site": 55,
    test: 52,
    type: 50,
    class: 50,
    module: 50,
    constant: 48,
    config: 35,
    reference: 25,
  };
  return (priority[kind] ?? 0) + scoreText(taskTerms, line) + orderedTermScore(taskTerms, line);
}

function selectDiverseEvidence(items, maxItems) {
  const sorted = [...items].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  const selected = [];
  const selectedKeys = new Set();
  const take = (item) => {
    if (!item || selectedKeys.has(item.id) || selected.length >= maxItems) return false;
    selected.push(item);
    selectedKeys.add(item.id);
    return true;
  };

  for (const path of [...new Set(sorted.map((item) => item.path))]) {
    take(sorted.find((item) => item.path === path));
  }

  for (const kind of ["module", "type", "class", "constant", "function", "call-site", "config", "test", "reference"]) {
    take(sorted.find((item) => item.kind === kind));
  }

  for (const item of sorted) {
    if (selected.length >= maxItems) break;
    const kindCounts = countBy(selected, "kind");
    const pathCounts = countBy(selected, "path");
    if ((kindCounts.get(item.kind) ?? 0) >= 4) continue;
    if ((pathCounts.get(item.path) ?? 0) >= 5) continue;
    take(item);
  }

  return selected;
}

function countBy(items, field) {
  const counts = new Map();
  for (const item of items) counts.set(item[field], (counts.get(item[field]) ?? 0) + 1);
  return counts;
}

function driftChecks(claims, readFirst, taskTerms) {
  const planned = claims.filter((claim) =>
    !/\b(separate change|out of scope)\b/i.test(stripInlineCode(claim.text)) &&
    isTaskTextMatch(taskTerms, `${claim.text} ${claim.heading ?? ""}`) &&
    /\b(pending|deferred|absent|not implemented|not built|not shipped|missing|planned|gap)\b/i.test(
      stripInlineCode(claim.text),
    ),
  );
  const hasImplementationFiles = readFirst.some(isImplementationPath);
  const checks = [];
  if (planned.length && hasImplementationFiles) {
    checks.push(
      `Docs include pending/deferred claims, but implementation files are in Read First; verify code before adding from scratch. First pending claim: ${planned[0].source}:${planned[0].line}`,
    );
  }
  return checks;
}

function isTaskTextMatch(taskTerms, text) {
  if (taskTerms.size <= 1) return countTaskTermHits(taskTerms, text) >= 1;
  return (
    orderedTermScore(taskTerms, text) > 0 ||
    countTaskTermHits(taskTerms, text) >= Math.min(taskTerms.size, 3)
  );
}

function countTaskTermHits(taskTerms, text) {
  const hay = String(text).toLowerCase();
  let hits = 0;
  for (const term of taskTerms) {
    if (hay.includes(term)) hits += 1;
  }
  return hits;
}

function doctor(root, outDir) {
  const map = readJson(join(root, outDir, "map.json"), null);
  const stale = readJson(join(root, outDir, "stale.json"), { missingReferences: [] });
  if (!map) throw new Error(`${outDir}/map.json missing; run build first`);
  const errors = [];
  const ids = new Set();
  for (const node of map.nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of map.edges) {
    if (!ids.has(edge.from)) errors.push(`edge missing from node: ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`edge missing to node: ${edge.to}`);
  }
  console.log(`doctor: docs=${map.stats.docs} claims=${map.stats.claims} missingRefs=${stale.missingReferences.length}`);
  for (const warning of stale.missingReferences.slice(0, 10)) {
    console.log(`warning: ${warning.source} mentions missing ${warning.path}`);
  }
  if (errors.length) {
    for (const error of errors) console.error(`error: ${error}`);
    return 1;
  }
  return 0;
}

function runGraphCommand(root, outDir, subcommand, args) {
  if (subcommand === "build") {
    const generation = buildGraphGeneration(root, { outDir });
    console.log(`graph built ${outDir}/graph/manifest.json provider=${generation.provider.id} nodes=${generation.nodes.length} edges=${generation.edges.length}`);
    return 0;
  }
  if (subcommand === "status") {
    const status = graphStatus(root, outDir);
    if (status.state === "missing") {
      console.log(`graph missing ${outDir}/graph/manifest.json`);
      return 2;
    }
    const provider = status.manifest?.provider?.id ?? "unknown";
    console.log(`graph ${status.state} provider=${provider} generation=${status.manifest?.generationId ?? "none"}`);
    return status.state === "fresh" ? 0 : 2;
  }
  if (subcommand === "search") {
    const generation = readFreshGraph(root, outDir);
    const query = String(args.query ?? args._.join(" ")).trim();
    const results = queryGraph(generation, { query, limit: Number(args.limit ?? 20) });
    console.log(JSON.stringify({ schemaVersion: 1, provider: generation.provider.id, query, results }, null, 2));
    return 0;
  }
  if (subcommand === "candidates") {
    const generation = readFreshGraph(root, outDir);
    const query = String(args.query ?? args.task ?? args._.join(" ")).trim();
    console.log(JSON.stringify(createContextCandidateSet(generation, {
      task: String(args.task ?? query),
      query,
      maxCandidates: Number(args.limit ?? 40),
    }), null, 2));
    return 0;
  }
  if (subcommand === "planner-status") {
    const generation = readFreshGraph(root, outDir);
    const query = String(args.query ?? args.task ?? args._.join(" ")).trim();
    const candidateSet = createContextCandidateSet(generation, {
      task: String(args.task ?? query),
      query,
      maxCandidates: Number(args.limit ?? 40),
    });
    console.log(JSON.stringify({
      schemaVersion: 1,
      provider: generation.provider.id,
      planner: memrightPlannerStatus(),
      candidateSet,
    }, null, 2));
    return 0;
  }
  if (subcommand === "schema") {
    console.log(JSON.stringify({ schemaVersion: 1, provider: "blueprint-static", artifacts: ["manifest", "nodes", "edges", "graph", "docTruth", "mermaid", "plannerStatus", "ContextCandidateSet"] }, null, 2));
    return 0;
  }
  if (subcommand === "resolve") {
    const generation = readFreshGraph(root, outDir);
    const result = resolveGraphNode(generation, String(args.node ?? args._[0] ?? ""));
    if (!result) throw new Error(`graph node not found: ${args.node ?? args._[0] ?? ""}`);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (subcommand === "neighbors") {
    const generation = readFreshGraph(root, outDir);
    console.log(JSON.stringify(graphNeighbors(generation, {
      nodeId: String(args.node ?? args._[0] ?? ""),
      direction: args.direction ?? "both",
      depth: Number(args.depth ?? 1),
    }), null, 2));
    return 0;
  }
  if (subcommand === "path") {
    const generation = readFreshGraph(root, outDir);
    console.log(JSON.stringify(graphPath(generation, {
      from: args.from,
      to: args.to,
      maxDepth: Number(args["max-depth"] ?? 5),
    }), null, 2));
    return 0;
  }
  if (subcommand === "architecture") {
    const generation = readFreshGraph(root, outDir);
    console.log(JSON.stringify(graphArchitecture(generation), null, 2));
    return 0;
  }
  if (subcommand === "impact") {
    const generation = readFreshGraph(root, outDir);
    console.log(JSON.stringify(graphImpact(generation, {
      nodeId: String(args.node ?? args._[0] ?? ""),
      depth: Number(args.depth ?? 3),
    }), null, 2));
    return 0;
  }
  if (subcommand === "flows") {
    const generation = readFreshGraph(root, outDir);
    const inventory = graphFlowInventory(generation);
    writeJson(join(root, outDir, "flows.json"), inventory);
    console.log(JSON.stringify(inventory, null, 2));
    return 0;
  }
  if (subcommand === "doc-truth") {
    const generation = readFreshGraph(root, outDir);
    const docTruth = generation.docTruth ?? buildDocCodeJoins({ ...generation, repoRoot: root }, { outDir });
    console.log(JSON.stringify(docTruth, null, 2));
    return 0;
  }
  if (subcommand === "mermaid") {
    const generation = readFreshGraph(root, outDir);
    console.log(graphMermaid(generation, {
      view: args.view ?? args._[0] ?? "architecture",
      nodeId: String(args.node ?? ""),
      direction: args.direction ?? "both",
      depth: Number(args.depth ?? 1),
      from: args.from,
      to: args.to,
      maxDepth: Number(args["max-depth"] ?? 5),
      limit: Number(args.limit ?? 60),
    }));
    return 0;
  }
  usage();
  return 1;
}

function memrightPlannerStatus() {
  try {
    const help = execFileSync("memright", ["help"], { encoding: "utf8", timeout: 5000 });
    const hasPlanContext = /\bplan-context\b/.test(help);
    return {
      service: "memright",
      command: "memright plan-context",
      state: hasPlanContext ? "ready" : "missing_command",
      evidence: hasPlanContext
        ? "memright help lists plan-context"
        : "memright help does not list plan-context; Blueprint can emit ContextCandidateSet but MemRight admission is not live",
    };
  } catch (error) {
    return {
      service: "memright",
      command: "memright plan-context",
      state: "unavailable",
      evidence: String(error?.message ?? error),
    };
  }
}

function readFreshGraph(root, outDir) {
  let status = graphStatus(root, outDir);
  if (status.state !== "fresh") {
    buildGraphGeneration(root, { outDir });
    status = graphStatus(root, outDir);
  }
  const generationPath = join(root, outDir, "graph", "generations", status.manifest.generationId.replace("sha256:", ""), "graph.json");
  return readJson(generationPath, null);
}

function runBriefAndPrint(root, outDir, args) {
  const result = brief(root, outDir, args);
  console.log(`brief ${result.runDir}/TASK-BRIEF.md readFirst=${result.readFirst.length} sources=${result.sources.length} rebuilt=${result.rebuilt}`);
  return result.missingExpected.length ? 2 : 0;
}

function runMapAndPrint(root, outDir, args = {}) {
  const { rebuilt } = ensureFresh(root, outDir, args);
  const map = readJson(join(root, outDir, "map.json"), null);
  console.log(`${rebuilt ? "built" : "fresh"} ${outDir}/map.json docs=${map.stats.docs} claims=${map.stats.claims} start=${outDir}/START-HERE.md`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  if (!command) {
    const root = process.cwd();
    const outDir = DEFAULT_OUT;
    return runMapAndPrint(root, outDir);
  }
  if (command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  const knownCommands = new Set(["build", "brief", "doctor", "graph"]);
  if (!knownCommands.has(command)) {
    const args = parseArgs(argv);
    const task = String(args.task ?? args._.join(" ")).trim();
    if (!task) {
      usage();
      return 1;
    }
    args.task = task;
    const root = process.cwd();
    const outDir = normalizePath(args.out ?? DEFAULT_OUT);
    return runBriefAndPrint(root, outDir, args);
  }
  const args = parseArgs(rest);
  const root = process.cwd();
  const outDir = normalizePath(args.out ?? DEFAULT_OUT);
  if (command === "graph") {
    const [subcommand, ...graphRest] = rest;
    const graphArgs = parseArgs(graphRest);
    return runGraphCommand(root, outDir, subcommand, graphArgs);
  }
  if (command === "build") {
    const result = build(root, outDir, args);
    if (args.check) {
      const config = loadConfig(root, outDir);
      const fresh = isFresh(root, outDir, config, Number(args.limit ?? 0));
      if (!fresh) throw new Error("generated graph is stale immediately after build");
    }
    console.log(`built ${outDir}/map.json docs=${result.map.stats.docs} claims=${result.map.stats.claims}`);
    return 0;
  }
  if (command === "brief") {
    return runBriefAndPrint(root, outDir, args);
  }
  if (command === "doctor") return doctor(root, outDir);
  usage();
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`maprepo: ${error.message}`);
  process.exitCode = 1;
}
