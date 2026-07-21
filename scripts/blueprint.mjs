#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDocCodeJoins,
  buildGraphGeneration,
  createContextCandidateSet,
  graphArchitecture,
  graphCapabilities,
  graphFlowInventory,
  graphImpact,
  graphMermaid,
  graphNeighbors,
  graphPath,
  graphStatus,
  queryGraph,
  resolveGraphNode,
} from "../graph/static-provider.mjs";
import { generateDocs } from "../lib/generated-docs.mjs";
import {
  buildIncrementalPhase2Plan,
  isReconciliationDecisionCurrent,
  sealPhase2Artifacts,
} from "../lib/incremental-phase2.mjs";
import { CODE_EXTENSIONS } from "../graph/language-extractors.mjs";
import { workingTreeSummary } from "../sources/dirty-files.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONTEXT_BUDGET_SCRIPT = resolve(SCRIPT_DIR, "../../../lib/context_budget.py");
const CONTEXT_BUDGET_LOG = resolve(SCRIPT_DIR, "../../../.cache/metrics/context-budget.jsonl");
const AUDIT_FACT_COLLECTOR = resolve(SCRIPT_DIR, "../../audit/collect-facts.mjs");
const DEFAULT_HYGIENE_CHECKS = [
  "decomposition",
  "dead_code",
  "duplication",
  "outdated",
  "cargo_outdated",
  "binary_pins",
  "debt_markers",
  "dep_pinning",
  "negative_space",
];
const NETWORK_ONLY_HYGIENE_CHECKS = new Set(["outdated", "cargo_outdated"]);

const DEFAULT_OUT = ".agent";
const SCHEMA_VERSION = 1;
const FULL_UNDERSTANDING_SHAPE = Object.freeze({
  architecture: [
    "stack", "components", "dataFlow", "entryPoints", "stateStores", "externalDeps",
    "deployableUnits", "externalServices", "infrastructure", "crossCutting",
    "capabilityCoverage", "flows", "coverageGaps",
  ],
  interfaces: ["publicApi", "moduleInterfaces", "dataContracts", "configKeys", "extensionPoints", "fragileContracts"],
  health: ["oversized", "slop", "hotspots", "duplication", "coupling", "untested", "deadWeight", "top10"],
  contract: ["invariants", "constraints", "assumptions", "entropy", "decisions"],
  security: ["trustBoundaries", "secrets", "injectionSurface", "authz", "dataProtection", "dangerousPatterns", "posture"],
  solid: ["dimensions", "scorecard", "top5"],
});
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
  archiveGlobs: ["docs/archive/", "docs/history/"],
  budgets: {
    briefMaxLines: 160,
    maxReadFirstFiles: 8,
    maxSourceSpans: 30,
    maxTruths: 10,
    maxGotchas: 8,
    maxCodeEvidence: 14,
  },
  hygiene: {
    // Review trigger only. Size never proves that a component should be decomposed.
    decompositionReviewLoc: 400,
    // A not-needed dismissal of a candidate with this many incoming graph relationships requires a
    // second assessor (audit renderer enforces; same rule as the >=3x-size trigger).
    secondAssessorIncomingRelationships: 25,
  },
  ignoredPrefixes: [
    ".agent/",
    ".audit/",
    ".blueprint/",
    ".git/",
    ".codex-tmp/",
    ".cache/",
    ".gstack/",
    "node_modules/",
    "target/",
    "engine/target",
    "dist/",
    "docs/product.md",
    "docs/architecture.md",
  ],
};

function usage() {
  const command = scriptCommand();
  console.log(`usage:
  ${command}
  ${command} "task to orient around"
  ${command} build [--out .agent] [--limit N] [--check] [--no-readme-link]
  ${command} brief --task "..." [--out .agent] [--refresh] [--limit N]
  ${command} doctor [--out .agent] [--json] [--full] [--limit N]
  ${command} phase2 plan|seal [--out .agent] [--json] [--no-readme-link]
  ${command} hygiene status|refresh [--out .agent] [--only check,...] [--offline] [--json]
  ${command} graph build|status|schema|search|neighbors|path|impact|resolve|architecture|flows|doc-truth|mermaid|planner-status|candidates [--out .agent] [--limit N]
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
    } else if (["check", "refresh", "complete", "json", "full", "offline", "no-readme-link"].includes(key)) {
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

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
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

function archivePathMatches(path, pattern) {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(String(pattern ?? "").trim());
  if (!normalizedPattern) return false;
  if (!normalizedPattern.includes("*")) {
    const prefix = normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`;
    return normalizedPath === normalizedPattern.replace(/\/$/, "") || normalizedPath.startsWith(prefix);
  }
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(normalizedPath);
}

function parseDocLifecycle(root, path, lines, allFiles, config) {
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const first = firstIndex >= 0 ? lines[firstIndex].replace(/^\uFEFF/, "").trim() : "";
  const second = firstIndex >= 0 ? (lines[firstIndex + 1] ?? "").trim() : "";
  const hasRepoHistoricalNote = /^>\s*Retained as historical context; do not treat as current\.\s*$/i.test(second);
  const hasExternalHistoricalNote = second.startsWith(">")
    && /historical/i.test(second)
    && /outside this repository/i.test(second);
  const targeted = /^>\s*Superseded by\s+`([^`]+)`\s+on\s+(\d{4}-\d{2}-\d{2})\.\s*$/i.exec(first);
  const external = /^>\s*Superseded on\s+(\d{4}-\d{2}-\d{2})\.\s*$/i.exec(first);

  if (targeted && !hasRepoHistoricalNote) {
    return {
      status: "current",
      invalidMarker: { target: targeted[1].trim(), reason: "historical-note-invalid" },
    };
  }
  if (external && !hasExternalHistoricalNote) {
    return { status: "current", invalidMarker: { reason: "historical-note-invalid" } };
  }
  if (targeted && hasRepoHistoricalNote) {
    const rawTarget = targeted[1].trim();
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(rawTarget)) {
      return { status: "current", invalidMarker: { target: rawTarget, reason: "target-absolute" } };
    }
    const resolvedTarget = resolve(root, rawTarget);
    const relativeTarget = normalizePath(relative(root, resolvedTarget));
    if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith("../")) {
      return { status: "current", invalidMarker: { target: rawTarget, reason: "target-outside-repo" } };
    }
    if (!allFiles.has(relativeTarget)) {
      return { status: "current", invalidMarker: { target: rawTarget, reason: "target-not-indexed" } };
    }
    let physicalTarget;
    try {
      physicalTarget = realpathSync(resolvedTarget);
      if (!statSync(physicalTarget).isFile()) {
        return { status: "current", invalidMarker: { target: rawTarget, reason: "target-not-file" } };
      }
    } catch {
      return { status: "current", invalidMarker: { target: rawTarget, reason: "target-not-indexed" } };
    }
    const physicalRelative = normalizePath(relative(realpathSync(root), physicalTarget));
    if (!physicalRelative || physicalRelative === ".." || physicalRelative.startsWith("../")) {
      return { status: "current", invalidMarker: { target: rawTarget, reason: "target-outside-repo" } };
    }
    return { status: "superseded", supersededBy: relativeTarget, supersededOn: targeted[2] };
  }
  if (external && hasExternalHistoricalNote) {
    return { status: "superseded", supersededBy: null, supersededOn: external[1] };
  }
  if ((config?.archiveGlobs ?? []).some((pattern) => archivePathMatches(path, pattern))) {
    return { status: "archived", supersededBy: null, supersededOn: null };
  }
  return { status: "current" };
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
  if (!existsSync(path)) {
    writeJson(path, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  // Forward-merge new defaults into a stored config created before they were added.
  // Array-valued keys (ignoredPrefixes, canonicalDocs, archiveGlobs) are unioned;
  // object-valued keys are shallow-merged with stored winning; everything else passes through.
  const stored = readJson(path, {});
  const merged = { ...DEFAULT_CONFIG, ...stored };
  if (Array.isArray(DEFAULT_CONFIG.ignoredPrefixes) && Array.isArray(stored.ignoredPrefixes)) {
    merged.ignoredPrefixes = [...new Set([...DEFAULT_CONFIG.ignoredPrefixes, ...stored.ignoredPrefixes])];
  }
  if (Array.isArray(DEFAULT_CONFIG.canonicalDocs) && Array.isArray(stored.canonicalDocs)) {
    merged.canonicalDocs = [...new Set([...DEFAULT_CONFIG.canonicalDocs, ...stored.canonicalDocs])];
  }
  if (Array.isArray(DEFAULT_CONFIG.archiveGlobs) && Array.isArray(stored.archiveGlobs)) {
    merged.archiveGlobs = [...new Set([...DEFAULT_CONFIG.archiveGlobs, ...stored.archiveGlobs])];
  }
  if (DEFAULT_CONFIG.budgets && stored.budgets) {
    merged.budgets = { ...DEFAULT_CONFIG.budgets, ...stored.budgets };
  }
  if (DEFAULT_CONFIG.hygiene && stored.hygiene) {
    merged.hygiene = { ...DEFAULT_CONFIG.hygiene, ...stored.hygiene };
  }
  return merged;
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
      let text = readFileSync(join(root, path), "utf8");
      // Strip the blueprint-generated README pointer block before hashing so
      // adding/removing the block on later builds does not perturb the
      // signature. The block is purely generated, not source truth. Consume
      // the separator newlines too so the stripped form matches the original.
      if (path === "README.md") {
        text = text.replace(
          /\n?<!-- blueprint:docs:start -->[\s\S]*?<!-- blueprint:docs:end -->\n?/,
          "",
        );
      }
      return `${path}:${sha1(text)}`;
    });
  const fileListHash = sha1(files.join("\n"));
  return sha1([fileListHash, ...docHashes].join("\n"));
}

function extractDoc(root, path, allFiles, config) {
  const full = join(root, path);
  // Strip the blueprint-generated pointer block from README.md BEFORE line
  // parsing so headings/claims/codeRefs are unaffected by generated content.
  // This keeps map.json byte-identical across unchanged rebuilds.
  let text = readFileSync(full, "utf8");
  if (path === "README.md") {
    text = text.replace(
      /\n?<!-- blueprint:docs:start -->[\s\S]*?<!-- blueprint:docs:end -->\n?/,
      "",
    );
  }
  const lines = text.split(/\r?\n/);
  const lifecycle = parseDocLifecycle(root, path, lines, allFiles, config);
  const headings = [];
  const claims = [];
  const codeRefs = new Set();
  const ignored = config?.ignoredPrefixes ?? [];
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
    if (lifecycle.status !== "current") continue;
    if (!inFence) {
      for (const match of line.matchAll(PATH_RE)) {
        const normalized = normalizePath(match[1]);
        if (ignored.some((prefix) => normalized.startsWith(prefix))) continue;
        codeRefs.add(normalized);
      }
    }
    if (inFence || !looksLikeClaim(line)) continue;
    claims.push({
      // Claim IDs must be unique across same-slug paths. Suffix the path-hash
      // short form so two docs whose slugs collide still get distinct claims.
      id: `claim.${slug(path)}.${sha1(path).slice(0, 4)}.${i + 1}`,
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
  // Strip the blueprint-generated pointer block from README.md before hashing
  // so map.json is byte-identical across unchanged rebuilds.
  let stableText = text;
  if (path === "README.md") {
    stableText = text.replace(
      /\n?<!-- blueprint:docs:start -->[\s\S]*?<!-- blueprint:docs:end -->\n?/,
      "",
    );
  }
  return {
    // Doc IDs must be collision-safe across same-slug paths
    // (e.g. `src/foo.md` and `src_foo.md` both slug to `src-foo-md`).
    // Suffix the path-hash short form so distinct paths never collide.
    id: `doc.${slug(path)}.${sha1(path).slice(0, 8)}`,
    kind: "doc",
    path,
    title: headings[0]?.text ?? basename(path),
    sha1: sha1(stableText),
    searchText: truncateText(stableText.replace(/\s+/g, " "), 2400),
    lifecycle,
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
  const sourceObservation = gitSourceObservation(root);
  if (sourceObservation?.dirty) {
    throw graphReadError(
      "graph_build_deferred_dirty",
      "Tracked source changes are present; commit or restore them before rebuilding the committed graph",
    );
  }
  const files = repoFiles(root, config, limit);
  const allFiles = new Set(files);
  const docs = files.filter(isDoc).map((path) => extractDoc(root, path, allFiles, config));
  const claims = docs.flatMap((doc) => doc.claims);
  const codeRefs = new Map();
  const edges = [];
  const stale = { missingReferences: [], staleClaims: [], invalidSupersessionMarkers: [] };

  for (const doc of docs) {
    if (doc.lifecycle?.invalidMarker) {
      stale.invalidSupersessionMarkers.push({ source: doc.path, ...doc.lifecycle.invalidMarker });
    }
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

  const docsByPath = new Map(docs.map((doc) => [doc.path, doc]));
  for (const doc of docs) {
    const targetPath = doc.lifecycle?.status === "superseded" ? doc.lifecycle.supersededBy : null;
    if (!targetPath) continue;
    const targetDoc = docsByPath.get(targetPath);
    if (targetDoc) {
      edges.push({ from: targetDoc.id, to: doc.id, type: "supersedes" });
      continue;
    }
    const id = `code.${slug(targetPath)}.${sha1(targetPath).slice(0, 8)}`;
    codeRefs.set(targetPath, { id, kind: "code_ref", path: targetPath, exists: true });
    edges.push({ from: id, to: doc.id, type: "supersedes" });
  }

  const nodes = [
    { id: "repo.root", kind: "repo", path: "." },
    ...docs.map(({ claims: _claims, codeRefs: _codeRefs, ...doc }) => doc),
    ...claims,
    ...codeRefs.values(),
  ];
  const signature = sourceSignature(root, config, limit);
  // Stable identifier for this generation: derived from the source signature
  // so unchanged rebuilds produce byte-identical artifacts.
  const generatedAt = `gen:${signature.slice(0, 16)}`;
  const map = {
    schemaVersion: SCHEMA_VERSION,
    repo: basename(root),
    generatedAt,
    entrypoint: ".blueprint/manifest.json",
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

  const queue = buildUnderstandingQueue(root, docs, files, signature);
  writeJson(join(root, outDir, "map.json"), map);
  writeJson(join(root, outDir, "claims.json"), claims);
  writeJson(join(root, outDir, "stale.json"), stale);
  writeJson(join(root, outDir, "index.json"), index);
  writeJson(join(root, outDir, "queue.json"), queue);
  const graphGeneration = buildGraphGeneration(root, { outDir, fileLimit: limit || 0 });
  const flows = graphFlowInventory(graphGeneration);
  writeJson(join(root, outDir, "flows.json"), flows);
  const phase2Plan = buildIncrementalPhase2Plan({
    graph: graphGeneration,
    queue,
    verdictEnvelope: optionalJson(join(root, outDir, "verdicts.json")).value,
    understanding: optionalJson(join(root, outDir, "understanding.json")).value,
  });
  writeJsonAtomic(join(root, outDir, "phase2-plan.json"), phase2Plan);
  const docsResult = generateDocs(root, { noReadmeLink: Boolean(options.noReadmeLink) });
  const blueprintManifest = writeBlueprintManifest(root, outDir, {
    map,
    index,
    graphGeneration,
    flows,
    phase2Plan,
    docsResult,
    stats: { files: files.length, docs: docs.length, claims: claims.length, codeRefs: codeRefs.size },
    sourceObservation,
  });
  return { map, stale, index, queue, graphGeneration, flows, phase2Plan, docsResult, blueprintManifest };
}

// Write the portable Blueprint manifest at `.blueprint/manifest.json` —
// the canonical machine entry point for downstream consumers. Repo-relative
// paths only; no absolute Windows/Mac paths; safe to diff and digest.
function gitBaseCommit(root) {
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40,64}$/i.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

function gitSourceObservation(root) {
  const head = gitBaseCommit(root);
  if (!head) return null;
  try {
    const status = execFileSync("git", [
      "status", "--porcelain=v1", "-z", "--untracked-files=no", "--", ".",
      ":(exclude).agent", ":(exclude).agent/**",
      ":(exclude).blueprint", ":(exclude).blueprint/**",
      ":(exclude)docs/product.md", ":(exclude)docs/architecture.md",
    ], {
      cwd: root,
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      head,
      dirty: status.length > 0,
      statusDigest: createHash("sha256").update(status).digest("hex"),
    };
  } catch {
    return null;
  }
}

function finalizedSourceEpoch(root, before) {
  const after = gitSourceObservation(root);
  if (!before || !after) return { baseCommit: null, sourceState: "unversioned" };
  if (before.head !== after.head || before.statusDigest !== after.statusDigest) {
    return { baseCommit: null, sourceState: "concurrent_update" };
  }
  if (before.dirty) return { baseCommit: null, sourceState: "dirty_overlay" };
  return { baseCommit: before.head, sourceState: "clean" };
}

function writeBlueprintManifest(root, outDir, {
  map, index, graphGeneration, flows, phase2Plan, docsResult, stats, sourceObservation,
}) {
  const manifestDir = join(root, ".blueprint");
  mkdirSync(manifestDir, { recursive: true });
  const graphManifest = graphGeneration?.manifest ?? {};
  const sourceEpoch = finalizedSourceEpoch(root, sourceObservation);
  const stableStamp = index?.sourceSignature
    ? `gen:${index.sourceSignature.slice(0, 16)}`
    : `gen:${Date.now().toString(16).padStart(16, "0")}`;
  const manifest = {
    schemaVersion: 1,
    repo: basename(root),
    generatedAt: stableStamp,
    entrypoint: ".agent/",
    humanDocs: ["docs/product.md", "docs/architecture.md"],
    artifacts: {
      map: `${outDir}/map.json`,
      claims: `${outDir}/claims.json`,
      stale: `${outDir}/stale.json`,
      index: `${outDir}/index.json`,
      queue: `${outDir}/queue.json`,
      flows: `${outDir}/flows.json`,
      phase2Plan: `${outDir}/phase2-plan.json`,
      graph: `${outDir}/graph/manifest.json`,
    },
    generation: {
      schemaVersion: 1,
      id: graphManifest.generationId ?? null,
      revision: graphManifest.generationId ?? null,
      baseCommit: sourceEpoch.baseCommit,
      sourceState: sourceEpoch.sourceState,
      indexedAt: graphManifest.generatedAt ?? null,
      stale: false,
      sourceKind: "blueprint",
      toolVersions: {
        blueprint: graphManifest.provider?.id ?? "blueprint-static",
        ...Object.fromEntries(
          Object.entries(graphManifest.toolVersions ?? {}).map(([k, v]) => [k, String(v)]),
        ),
      },
      providerCapabilities: graphCapabilities().outputs ?? [],
      supportedEdgeTypes: Array.isArray(graphManifest.supportedEdgeTypes) ? graphManifest.supportedEdgeTypes : [],
      supportedLanguages: Array.isArray(graphManifest.supportedLanguages) ? graphManifest.supportedLanguages : [],
      fileCount: stats.files,
      contentHash: graphManifest.repo?.sourceHash ?? null,
      frozen: true,
    },
    capabilities: graphCapabilities(),
    stats: {
      files: stats.files,
      docs: stats.docs,
      claims: stats.claims,
      codeRefs: stats.codeRefs,
      flows: flows?.flows?.length ?? 0,
      graphNodes: graphGeneration?.nodes?.length ?? 0,
      graphEdges: graphGeneration?.edges?.length ?? 0,
    },
    docs: docsResult?.mode ?? "wrote",
    docsConflict: docsResult?.conflicts ?? [],
    phase2: {
      complete: Boolean(phase2Plan?.complete),
      verify: phase2Plan?.verdicts?.verify?.length ?? 0,
      synthesize: phase2Plan?.dimensions?.synthesize?.length ?? 0,
    },
    sourceSignature: index?.sourceSignature ?? null,
  };
  const manifestPath = join(manifestDir, "manifest.json");
  writeJson(manifestPath, manifest);
  return { path: manifestPath, manifest };
}

// Deterministic Phase-2 worklist: pair each doc claim with the implementation
// files its own doc references (the things to verify it against), plus the
// largest implementation files as synthesis anchors. Grounds the agent pass so
// it reads real code instead of guessing.
function buildUnderstandingQueue(root, docs, files, signature) {
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
  return { generatedAt: `gen:${signature.slice(0, 16)}`, claims, anchors };
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
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

// The graph is tracked-only (a function of the COMMIT, so `.agent/` can travel
// through git). Anything in the working tree but not committed is therefore absent
// from the graph. Surface it loudly so the omission is a choice, not a surprise —
// the exact "told-done-when-not" / silent-omission failure mode this rebuild exists
// to kill. Query-time overlay adapters (dirty-files, live-overlay) still inject
// this dirty work into context packets; only the persisted graph omits it.
function warnUncommitted(root, outDir) {
  let summary;
  try {
    summary = workingTreeSummary(root);
  } catch {
    return;
  }
  if (!summary.available) return;
  // Blueprint's OWN generated artifacts are not "user work missing from the graph"
  // — warning about them is noise, and once .agent/ is tracked they would dominate
  // the list. Exclude the output dir, the portable manifest, and the generated docs
  // regardless of their git-ignore status.
  const outPrefix = `${normalizePath(outDir)}/`;
  const ownPaths = new Set([".blueprint", "docs/product.md", "docs/architecture.md"]);
  const isBlueprintOwned = (path) =>
    path.startsWith(outPrefix) || path.startsWith(".blueprint/") || ownPaths.has(path);
  const dirtyTracked = summary.dirtyTracked.filter((path) => !isBlueprintOwned(path));
  const untracked = summary.untracked.filter((path) => !isBlueprintOwned(path));
  const total = dirtyTracked.length + untracked.length;
  if (total === 0) return;
  const sample = [...dirtyTracked, ...untracked].slice(0, 8);
  console.warn(
    `uncommitted: ${total} working-tree file(s) are NOT in the graph ` +
      `(${dirtyTracked.length} modified tracked, ${untracked.length} untracked). ` +
      `Commit them to include them; they remain visible to task briefs via the overlay. ` +
      `e.g. ${sample.join(", ")}${total > sample.length ? " …" : ""}`,
  );
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
  const currentDocs = map.nodes.filter(
    (node) => node.kind === "doc" && (node.lifecycle?.status ?? "current") === "current",
  );
  const docById = new Map(currentDocs.map((doc) => [doc.id, doc]));
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
    for (const doc of currentDocs) {
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

function optionalJson(path) {
  if (!existsSync(path)) return { state: "missing", value: null };
  try {
    return { state: "present", value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { state: "corrupt", value: null, error: String(error?.message ?? error) };
  }
}

function fullCompletionStatus(root, outDir, graph) {
  const reasons = [];
  const graphGenerationId = graph.manifest?.generationId ?? null;
  const portableResult = optionalJson(join(root, ".blueprint/manifest.json"));
  const portable = portableResult.value;
  const portableCurrent = portableResult.state === "present"
    && portable?.generation?.id === graphGenerationId
    && portable?.generation?.sourceState !== "concurrent_update"
    && portable?.generation?.stale !== true;
  if (portableResult.state === "missing") {
    reasons.push({ code: "missing_portable_manifest", severity: "blocker", message: ".blueprint/manifest.json is missing." });
  } else if (portableResult.state === "corrupt") {
    reasons.push({ code: "corrupt_portable_manifest", severity: "blocker", message: portableResult.error });
  } else if (portable?.generation?.id !== graphGenerationId) {
    reasons.push({
      code: "manifest_generation_mismatch",
      severity: "blocker",
      message: "portable and graph manifests name different generations; run the complete build to reseal them together.",
    });
  } else if (portable?.generation?.sourceState === "concurrent_update") {
    reasons.push({
      code: "concurrent_update",
      severity: "blocker",
      message: "source changed while Blueprint was publishing; preserve the previous complete generation and rerun.",
    });
  } else if (portable?.generation?.stale === true) {
    reasons.push({
      code: "stale_portable_manifest",
      severity: "blocker",
      message: "portable Blueprint manifest is marked stale; rebuild and reseal before completion.",
    });
  }

  const understandingResult = optionalJson(join(root, outDir, "understanding.json"));
  const understanding = understandingResult.value;
  let phase2Complete = understandingResult.state === "present";
  if (understandingResult.state === "missing") {
    reasons.push({ code: "missing_understanding", severity: "blocker", message: "Phase 2 understanding.json is missing; continue automatically with verification and synthesis." });
  } else if (understandingResult.state === "corrupt") {
    reasons.push({ code: "corrupt_understanding", severity: "blocker", message: understandingResult.error });
  } else if (understanding?.sourceGenerationId !== graphGenerationId) {
    phase2Complete = false;
    reasons.push({ code: "stale_understanding", severity: "blocker", message: "understanding.json was synthesized from a different graph generation; rerun Phase 2." });
  }

  const missingUnderstandingFields = [];
  if (phase2Complete) {
    for (const [dimension, fields] of Object.entries(FULL_UNDERSTANDING_SHAPE)) {
      const section = understanding?.[dimension];
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        missingUnderstandingFields.push(dimension);
        continue;
      }
      for (const field of fields) {
        if (!Array.isArray(section[field])) missingUnderstandingFields.push(`${dimension}.${field}`);
      }
    }
    if (!(understanding.architecture.components?.length > 0)) missingUnderstandingFields.push("architecture.components(non-empty)");
    if (!(understanding.architecture.dataFlow?.length > 0)) missingUnderstandingFields.push("architecture.dataFlow(non-empty)");
    if (JSON.stringify(understanding).includes('"pending":true')) missingUnderstandingFields.push("pending stubs");
    if (missingUnderstandingFields.length) {
      phase2Complete = false;
      reasons.push({
        code: "incomplete_understanding",
        severity: "blocker",
        fields: missingUnderstandingFields,
        message: "Phase 2 synthesis is incomplete; all six dimensions and a real component flow are mandatory.",
      });
    }
  }

  const verdictsResult = optionalJson(join(root, outDir, "verdicts.json"));
  const verdictsEnvelope = verdictsResult.value
    && typeof verdictsResult.value === "object"
    && !Array.isArray(verdictsResult.value)
    ? verdictsResult.value
    : null;
  const verdicts = Array.isArray(verdictsResult.value)
    ? verdictsResult.value
    : Array.isArray(verdictsEnvelope?.verdicts)
      ? verdictsEnvelope.verdicts
      : null;
  if (!verdicts) {
    phase2Complete = false;
    reasons.push({
      code: verdictsResult.state === "corrupt" ? "corrupt_verdicts" : "missing_verdicts",
      severity: "blocker",
      message: "Phase 2 verdicts.json is missing or invalid; claim verification has not completed.",
    });
  } else if (verdictsEnvelope?.sourceGenerationId !== graphGenerationId) {
    phase2Complete = false;
    reasons.push({
      code: "stale_verdicts",
      severity: "blocker",
      message: "verdicts.json is not bound to the current graph generation; rerun claim verification.",
    });
  }

  const graphBodyResult = optionalJson(join(root, outDir, "graph/graph.json"));
  const queueResult = optionalJson(join(root, outDir, "queue.json"));
  if (graphBodyResult.state === "present" && queueResult.state === "present") {
    const incrementalPlan = buildIncrementalPhase2Plan({
      graph: graphBodyResult.value,
      queue: queueResult.value,
      verdictEnvelope: verdictsEnvelope,
      understanding,
    });
    if (!incrementalPlan.complete) {
      phase2Complete = false;
      reasons.push({
        code: "incremental_phase2_pending",
        severity: "blocker",
        verify: incrementalPlan.verdicts.verify.length,
        synthesize: incrementalPlan.dimensions.synthesize.length,
        message: "Phase 2 has evidence-dependent verification or synthesis misses; process phase2-plan.json and seal the result.",
      });
    }
  } else {
    phase2Complete = false;
    reasons.push({
      code: "incremental_phase2_unavailable",
      severity: "blocker",
      message: "Phase 2 dependency inputs are missing or corrupt; rebuild Phase 1 before semantic work.",
    });
  }

  const generatedDoc = (...paths) => {
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("<!-- generated by blueprint")) return text;
    }
    return "";
  };
  const product = generatedDoc(join(root, "docs/product.md"), join(root, outDir, "docs/product.md"));
  const architecture = generatedDoc(join(root, "docs/architecture.md"), join(root, outDir, "docs/architecture.md"));
  const docsPresent = Boolean(product && architecture);
  const expectedDocGeneration = graphGenerationId
    ? `gen:${graphGenerationId.replace(/^sha256:/, "")}`
    : null;
  const docsCurrent = docsPresent
    && expectedDocGeneration
    && product.includes(expectedDocGeneration)
    && architecture.includes(expectedDocGeneration);
  const workflowPresent = architecture.includes("## System workflow") && architecture.includes("```mermaid");
  const phase3Complete = Boolean(docsPresent && docsCurrent && workflowPresent);
  if (!docsPresent) {
    reasons.push({ code: "missing_human_docs", severity: "blocker", message: "current generated docs/product.md and docs/architecture.md are required." });
  } else if (!docsCurrent) {
    reasons.push({ code: "stale_human_docs", severity: "blocker", message: "generated human docs do not match the current graph generation; regenerate them after Phase 2." });
  } else if (!workflowPresent) {
    reasons.push({ code: "missing_workflow_diagram", severity: "blocker", message: "docs/architecture.md lacks the synthesized component Mermaid; regenerate after Phase 2." });
  }

  const divergences = (verdicts ?? []).filter((item) => ["contradicted", "stale"].includes(item?.verdict));
  let phase4 = "not_required";
  if (divergences.length) {
    const reconcileResult = optionalJson(join(root, outDir, "reconcile.json"));
    const reconcile = Array.isArray(reconcileResult.value)
      ? reconcileResult.value
      : Array.isArray(reconcileResult.value?.entries)
        ? reconcileResult.value.entries
        : [];
    const decisions = new Map(reconcile.map((item) => [item.claimId, item]));
    phase4 = divergences.every((item) => isReconciliationDecisionCurrent(item, decisions.get(item.claimId)))
      ? "complete"
      : "pending";
    if (phase4 === "pending") {
      reasons.push({ code: "pending_reconciliation", severity: "blocker", count: divergences.length, message: "Phase 4 has unresolved code↔doc decisions requiring the user's call." });
    }
  }

  const phase1Complete = graph.state === "fresh" && portableCurrent;
  const phases = {
    phase1: phase1Complete ? "complete" : "incomplete",
    phase2: phase2Complete ? "complete" : "incomplete",
    phase3: phase3Complete ? "complete" : "incomplete",
    phase4,
  };
  const complete = phase1Complete && phase2Complete && phase3Complete && phase4 !== "pending";
  return { state: complete ? "complete" : "incomplete", phases, reasons };
}

function doctor(root, outDir, options = {}) {
  const startedAt = new Date().toISOString();
  const jsonMode = Boolean(options.json);
  const fullMode = Boolean(options.full);
  const out = jsonMode
    ? (line) => process.stdout.write(`${line}\n`)
    : (line) => process.stdout.write(`${line}\n`);
  const mapPath = join(root, outDir, "map.json");
  const stalePath = join(root, outDir, "stale.json");
  if (!existsSync(mapPath)) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      state: "missing",
      generatedAt: startedAt,
      artifacts: { map: `${outDir}/map.json`, graph: `${outDir}/graph/manifest.json` },
      errors: [`${outDir}/map.json missing; run build first`],
      warnings: [],
      reasons: [
        {
          code: "missing_map",
          severity: "blocker",
          message: "Blueprint map.json is not present; planner cannot retrieve candidates.",
        },
      ],
      capabilities: graphCapabilities(),
    }, null, 2));
    return 2;
  }
  let map;
  let stale;
  try {
    map = readJson(mapPath, null);
    stale = readJson(stalePath, { missingReferences: [] });
  } catch (error) {
    // The map is PRESENT but unparseable — distinct from "missing" (never built).
    // A consumer treats corrupt as "rebuild, something wrote bad bytes", not "run
    // build for the first time".
    console.log(JSON.stringify({
      schemaVersion: 1,
      state: "corrupt",
      generatedAt: startedAt,
      artifacts: { map: `${outDir}/map.json`, graph: `${outDir}/graph/manifest.json` },
      errors: [String(error?.message ?? error)],
      warnings: [],
      reasons: [
        {
          code: "corrupt_map",
          severity: "blocker",
          message: "Blueprint map.json could not be parsed.",
        },
      ],
      capabilities: graphCapabilities(),
    }, null, 2));
    return 1;
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
    reasons.push({
      code: "duplicate_node_ids",
      severity: "blocker",
      message: `graph contains ${map.nodes.length - ids.size} duplicate node id(s); discovery must enforce collision-safe IDs.`,
    });
  }
  for (const edge of map.edges) {
    if (!ids.has(edge.from)) errors.push(`edge missing from node: ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`edge missing to node: ${edge.to}`);
  }
  for (const warning of stale.missingReferences.slice(0, 10)) {
    warnings.push(`${warning.source} mentions missing ${warning.path}`);
  }
  if (stale.missingReferences.length > 0) {
    reasons.push({
      code: "missing_references",
      severity: "warning",
      count: stale.missingReferences.length,
      message: "documents reference paths that no longer exist on disk",
    });
  }
  const graph = graphStatus(root, outDir);
  const completion = fullMode ? fullCompletionStatus(root, outDir, graph) : null;
  if (completion) reasons.push(...completion.reasons);
  if (graph.state === "stale") {
    warnings.push(graph.providerMismatch
      ? "graph manifest was built by an older Blueprint provider and must be rebuilt"
      : "graph manifest source hash is stale relative to current files");
    reasons.push({
      code: "stale_graph",
      severity: "blocker",
      providerMismatch: Boolean(graph.providerMismatch),
      message: graph.providerMismatch
        ? "graph provider version does not match the installed Blueprint extractor; rebuild required."
        : "graph manifest sourceHash does not match current source tree; rebuild required.",
    });
  }
  if (graph.state === "indeterminate") {
    warnings.push("graph freshness scan was truncated before it could verify the source tree");
    reasons.push({
      code: "scan_truncated",
      severity: "warning",
      truncationReasons: graph.truncationReasons ?? [],
      message: "graph freshness is indeterminate because traversal hit a safety cap; rebuild or adjust the scan policy.",
    });
  }
  if ((graph.capabilities?.unsupportedFileCount ?? 0) > 0) {
    reasons.push({
      code: "unsupported_languages",
      severity: "info",
      count: graph.capabilities.unsupportedFileCount,
      unsupportedExtensions: graph.capabilities.unsupportedExtensions,
      message: "graph is fresh but some source files use extensions outside the parsed set; symbol-level retrieval is partial.",
    });
  }
  if ((graph.capabilities?.dirtyOverlayFileCount ?? 0) > 0) {
    reasons.push({
      code: "dirty_overlay",
      severity: "info",
      count: graph.capabilities.dirtyOverlayFileCount,
      message: "working tree contains modified files newer than the committed graph; overlay candidates are surfaced with explicit freshness.",
    });
  }
  // Map graph states to dispatch G1 states: fresh + complete coverage -> ready,
  // fresh + unsupported-extension files -> degraded, stale -> stale,
  // missing -> missing.
  const fresh = graph.state === "fresh";
  const hasIncompleteCoverage = graph.state === "indeterminate" || (graph.capabilities?.unsupportedFileCount ?? 0) > 0;
  // Six typed states, most-severe first:
  //   missing  — map.json absent (never built)
  //   corrupt  — map present but structurally invalid (dangling edges, dup ids)
  //   broken   — graph provider version incompatible with the persisted graph
  //   stale    — source tree changed since the graph was built
  //   degraded — fresh but coverage is incomplete (unsupported languages / truncated scan)
  //   ready    — fresh and complete
  // corrupt/broken were previously folded into missing/stale; the granular reason
  // codes always carried the detail, but the top-level state now names them too.
  const state =
    graph.state === "missing"
      ? "missing"
      : errors.length
        ? "corrupt"
        : graph.providerMismatch
          ? "broken"
          : graph.state === "stale"
            ? "stale"
            : graph.state === "indeterminate" || (fresh && hasIncompleteCoverage)
              ? "degraded"
              : "ready";
  console.log(JSON.stringify({
    schemaVersion: 1,
    state,
    generatedAt: startedAt,
    artifacts: {
      map: `${outDir}/map.json`,
      graph: `${outDir}/graph/manifest.json`,
      graphState: graph.state,
      provider: graph.manifest?.provider ?? null,
      generationId: graph.manifest?.generationId ?? null,
    },
    stats: {
      docs: map.stats.docs,
      claims: map.stats.claims,
      codeRefs: map.stats.codeRefs,
      missingRefs: stale.missingReferences.length,
      unsupportedFileCount: graph.capabilities?.unsupportedFileCount ?? 0,
      dirtyOverlayFileCount: graph.capabilities?.dirtyOverlayFileCount ?? 0,
    },
    errors,
    warnings,
    reasons,
    capabilities: graphCapabilities(),
    graphCapabilities: {
      parsedExtensions: graph.capabilities?.parsedExtensions ?? graphCapabilities().languageCoverage.parsedExtensions,
      unsupportedExtensions: graph.capabilities?.unsupportedExtensions ?? [],
      unsupportedFileCount: graph.capabilities?.unsupportedFileCount ?? 0,
      dirtyOverlayFileCount: graph.capabilities?.dirtyOverlayFileCount ?? 0,
    },
    ...(completion ? { completion: { state: completion.state, phases: completion.phases } } : {}),
  }, null, 2));
  if (fullMode && completion?.state !== "complete") return 2;
  return state === "ready" || state === "stale" || state === "degraded" ? 0 : 1;
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
    const generation = readFreshGraph(root, outDir, {
      expectedGeneration: args["expected-generation"],
    });
    const query = String(args.query ?? args.task ?? args._.join(" ")).trim();
    const repoCodeScanStarted = process.hrtime.bigint();
    const candidateSet = createContextCandidateSet(generation, {
      task: String(args.task ?? query),
      query,
      maxCandidates: Number(args.limit ?? 40),
      anchors: args.anchors ? String(args.anchors).split(",").map((path) => path.trim()).filter(Boolean) : [],
    });
    const repoCodeScanMs = Number(process.hrtime.bigint() - repoCodeScanStarted) / 1_000_000;
    candidateSet._rightcontext = {
      stageElapsedMs: { repo_code_scan: Math.max(0, repoCodeScanMs) },
    };
    console.log(JSON.stringify(candidateSet, null, 2));
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
    const inventory = graphFlowInventory(generation, { complete: Boolean(args.complete), maxFlows: args.limit ? Number(args.limit) : undefined });
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

// Candidate memright executables, in order. execFileSync does not resolve a
// PATH shim on Windows (extensionless), so we also try the canonical binary and
// the ~/bin shim location. MEMRIGHT_BIN overrides everything.
function memrightBinCandidates() {
  return [
    process.env.MEMRIGHT_BIN,
    join(homedir(), "bin", "memright.exe"),
    join(homedir(), "bin", "memright"),
    "D:/Claude/tools/bin/memright.exe",
    join(homedir(), "claude", "tools", "bin", "memright"),
    "memright",
  ].filter(Boolean);
}

// A minimal, schema-valid ContextCandidateSet v1 — enough to make plan-context do
// real admission work and return a packet. Graph-independent so the probe reflects
// the JOIN, not the local graph's freshness.
function plannerProbeCandidateSet() {
  return {
    schemaVersion: 1,
    traceId: "blueprint-planner-probe",
    task: "blueprint planner probe",
    mode: "survey",
    provider: "blueprint-static",
    freshness: { revision: "sha256:probe", indexedAt: "gen:probe", stale: false },
    providerCeiling: { maxCandidates: 1, maxEstimatedTokens: 2000 },
    candidates: [{
      id: "probe:1",
      layer: 3,
      sourceKind: "repo_code",
      sourceRef: "probe.ts:1-1",
      sourceHash: `sha256:${"0".repeat(64)}`,
      trustClass: "workspace_tracked",
      instructionPolicy: "data_only",
      providerScore: 1,
      scoreComponents: { structural: 1 },
      estimatedTokens: 10,
      protected: false,
      exact: true,
      recoverable: true,
      resolver: "blueprint graph resolve --node probe:1",
      text: "probe",
    }],
    omissions: [],
  };
}

// Prove the Blueprint -> MemRight join is actually LIVE by round-tripping a real
// candidate set through `memright plan-context` and validating the returned
// ContextPacket. The old probe only grepped `memright help` for the string
// "plan-context" — a check that could not fail while the join was, in fact, never
// wired. It reported "ready" for a hand-off nothing exercised. This one runs it.
function memrightPlannerStatus() {
  const result = { service: "memright", command: "memright plan-context" };
  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), "bp-planner-"));
    const csPath = join(tmp, "candidate-set.json");
    writeFileSync(csPath, JSON.stringify(plannerProbeCandidateSet()));
    let lastError = "no memright executable found on any known path";
    for (const bin of memrightBinCandidates()) {
      try {
        const out = execFileSync(bin, ["plan-context", "--candidate-set", csPath, "--max-tokens", "2000"], {
          encoding: "utf8",
          timeout: 8000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let parsed;
        try {
          parsed = JSON.parse(out);
        } catch {
          return { ...result, state: "broken", evidence: `plan-context returned non-JSON via ${bin}` };
        }
        if (parsed?.packet && Array.isArray(parsed?.receipts)) {
          return { ...result, state: "ready", evidence: `plan-context round-tripped a ContextPacket (${parsed.receipts.length} receipt(s)) via ${bin}` };
        }
        return { ...result, state: "broken", evidence: `plan-context returned no packet/receipts via ${bin}: ${JSON.stringify(parsed).slice(0, 160)}` };
      } catch (error) {
        const stderr = String(error?.stderr ?? "");
        // An "unknown/unrecognized subcommand" means the binary exists but this
        // version predates the join — a distinct, honest state.
        if (/unrecognized subcommand|unexpected argument|no such subcommand|invalid subcommand/i.test(stderr)) {
          return { ...result, state: "missing_command", evidence: `${bin} has no plan-context subcommand` };
        }
        lastError = stderr ? stderr.slice(0, 200) : String(error?.message ?? error).slice(0, 200);
        // ENOENT (this candidate path doesn't exist) → try the next candidate.
      }
    }
    return { ...result, state: "unavailable", evidence: lastError };
  } catch (error) {
    return { ...result, state: "unavailable", evidence: String(error?.message ?? error).slice(0, 200) };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

function readFreshGraph(root, outDir, options = {}) {
  // Read the manifest to discover the file limit the previous build used.
  // We must rebuild with the same budget so the source hash stays stable
  // and a future doctor pass can detect real staleness. options.fileLimit
  // is for explicit overrides (e.g. CLI doctor); the default is whatever
  // the manifest recorded.
  let manifestFileLimit = 0;
  let persisted = null;
  const manifestPath = join(root, outDir, "graph", "manifest.json");
  try {
    if (!existsSync(manifestPath)) throw graphReadError("graph_missing", "Graph manifest is missing; run blueprint build");
    persisted = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!("fileLimit" in persisted)) {
      throw graphReadError("graph_rebuild_required", "Legacy graph manifest has no fileLimit; run blueprint build");
    }
    manifestFileLimit = Number(persisted.fileLimit ?? 0);
  } catch (error) {
    if (error?.code?.startsWith("graph_")) throw error;
    throw graphReadError("graph_corrupt", `Graph manifest is unreadable: ${error.message}`);
  }
  const fileLimit = options.fileLimit != null && options.fileLimit > 0
    ? options.fileLimit
    : manifestFileLimit || 0;
  const expectedGeneration = String(options.expectedGeneration ?? "").trim();
  if (expectedGeneration) {
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedGeneration)) {
      throw graphReadError("graph_generation_invalid", "Expected graph generation is invalid");
    }
    if (!persisted.complete || persisted.generationId !== expectedGeneration) {
      throw graphReadError(
        "graph_generation_changed",
        "Graph generation changed after the central freshness verdict",
        { expectedGeneration, observedGeneration: persisted.generationId ?? null },
      );
    }
    const generation = readJson(join(root, outDir, "graph", "graph.json"), null);
    const bodyGeneration = generation?.manifest?.generationId ?? null;
    if (!generation || bodyGeneration !== expectedGeneration) {
      throw graphReadError(
        "graph_generation_changed",
        "Graph body does not match the central freshness verdict",
        { expectedGeneration, observedGeneration: bodyGeneration },
      );
    }
    return generation;
  }
  let status = graphStatus(root, outDir, { fileLimit });
  if (status.state !== "fresh") {
    throw graphReadError("graph_rebuild_required", `Graph is ${status.state}; run blueprint build`, { state: status.state });
  }
  const generationPath = join(root, outDir, "graph", "graph.json");
  const generation = readJson(generationPath, null);
  if (!generation) throw graphReadError("graph_corrupt", "Graph generation is missing or unreadable");
  return generation;
}

function graphReadError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function runBriefAndPrint(root, outDir, args) {
  const result = brief(root, outDir, args);
  console.log(`brief ${result.runDir}/TASK-BRIEF.md readFirst=${result.readFirst.length} sources=${result.sources.length} rebuilt=${result.rebuilt}`);
  return result.missingExpected.length ? 2 : 0;
}

function phase1CompletionMarker(args = {}) {
  return args.check
    ? "phase1_maintenance=complete full_blueprint=not_requested"
    : "phase1_ready full_blueprint=incomplete next=phase2";
}

function runMapAndPrint(root, outDir, args = {}) {
  const { rebuilt } = ensureFresh(root, outDir, args);
  const map = readJson(join(root, outDir, "map.json"), null);
  console.log(`${rebuilt ? "built" : "fresh"} ${outDir}/map.json docs=${map.stats.docs} claims=${map.stats.claims} manifest=.blueprint/manifest.json product=docs/product.md architecture=docs/architecture.md ${phase1CompletionMarker(args)}`);
  return 0;
}

function hygieneStatus(root, outDir) {
  const hygieneDir = join(root, outDir, "hygiene");
  const manifestPath = join(hygieneDir, "manifest.json");
  const factsPath = join(hygieneDir, "facts.json");
  if (!existsSync(manifestPath) || !existsSync(factsPath)) {
    return { schemaVersion: 1, kind: "blueprint-hygiene", state: "missing", manifestPath: normalizePath(relative(root, manifestPath)) };
  }
  const manifest = readJson(manifestPath, null);
  const graph = graphStatus(root, outDir);
  const generationMatches = graph.manifest?.generationId === manifest?.sourceGenerationId;
  const state = graph.state === "fresh" && generationMatches ? "fresh" : "stale";
  return {
    ...manifest,
    state,
    graphState: graph.state,
    generationMatches,
  };
}

function refreshHygiene(root, outDir, args) {
  const graph = graphStatus(root, outDir);
  if (graph.state !== "fresh") {
    return {
      schemaVersion: 1,
      kind: "blueprint-hygiene",
      state: graph.state === "missing" ? "missing" : "stale",
      graphState: graph.state,
      error: "fresh Blueprint graph required before hygiene refresh",
    };
  }
  const selectedChecks = String(args.only ?? DEFAULT_HYGIENE_CHECKS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!selectedChecks.length || selectedChecks.some((value) => !/^[a-z0-9_]+$/.test(value))) {
    throw new Error("hygiene --only must be a comma-separated list of check identifiers");
  }
  const hygieneDir = join(root, outDir, "hygiene");
  mkdirSync(hygieneDir, { recursive: true });
  const collectorChecks = args.offline
    ? selectedChecks.filter((check) => !NETWORK_ONLY_HYGIENE_CHECKS.has(check))
    : selectedChecks;
  if (collectorChecks.length > 0) {
    const config = loadConfig(root, outDir);
    execFileSync(process.execPath, [
      AUDIT_FACT_COLLECTOR,
      root,
      "--out",
      hygieneDir,
      "--only",
      collectorChecks.join(","),
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(args.offline ? { AUDIT_OFFLINE: "1" } : {}),
        BLUEPRINT_DECOMPOSITION_REVIEW_LOC: String(config.hygiene?.decompositionReviewLoc ?? 400),
      },
    });
  }
  const factsPath = join(hygieneDir, "facts.json");
  const facts = collectorChecks.length > 0
    ? readJson(factsPath, null)
    : { kind: "audit-facts", generated_at: new Date().toISOString(), workspace: root, checks: [] };
  if (!facts?.checks) throw new Error("hygiene collector did not emit facts.json");
  enrichDecompositionCandidates(facts, readFreshGraph(root, outDir));
  for (const check of selectedChecks.filter((value) => args.offline && NETWORK_ONLY_HYGIENE_CHECKS.has(value))) {
    facts.checks.push({
      check,
      tool: check === "outdated" ? "package-manager outdated" : "cargo-outdated",
      required: false,
      command: null,
      exit_code: null,
      status: "skipped",
      skip_reason: "offline mode",
      findings_count: null,
      duration_ms: 0,
      meta: null,
      log: "",
      tool_absent: false,
    });
  }
  facts.checks.sort((left, right) => selectedChecks.indexOf(left.check) - selectedChecks.indexOf(right.check));
  writeJson(factsPath, facts);
  const selected = facts.checks.filter((check) => selectedChecks.includes(check.check));
  const manifest = {
    schemaVersion: 1,
    kind: "blueprint-hygiene",
    state: "fresh",
    sourceGenerationId: graph.manifest.generationId,
    sourceHash: graph.manifest.repo?.sourceHash ?? null,
    provider: graph.manifest.provider,
    refreshedAt: facts.generated_at,
    selectedChecks,
    factsPath: normalizePath(relative(root, factsPath)),
    checks: selected,
  };
  writeJson(join(hygieneDir, "manifest.json"), manifest);
  return manifest;
}

function enrichDecompositionCandidates(facts, generation) {
  const check = facts.checks.find((item) => item.check === "decomposition");
  if (!check?.meta) return;
  const nodes = generation?.nodes ?? [];
  const edges = generation?.edges ?? [];
  const indexedPaths = new Set(nodes.map((node) => node.path).filter(Boolean));
  const parsed = (path) => CODE_EXTENSIONS.has(String(path).split(".").at(-1)?.toLowerCase());
  // A candidate outside the provider's parsed languages (or outside the indexed generation) gets
  // graphMetrics "unavailable", never fabricated zeros — symbolCount 0 must mean "no symbols found
  // in a parsed file", not "the provider cannot see this language".
  const unavailability = (paths) => {
    const unparsed = paths.filter((path) => !parsed(path));
    if (unparsed.length) return `language not parsed by provider: ${unparsed.join(", ")}`;
    const unindexed = paths.filter((path) => !indexedPaths.has(path));
    if (unindexed.length) return `not in graph generation: ${unindexed.join(", ")}`;
    return null;
  };
  const enrich = (candidate, paths) => {
    const reason = unavailability(paths);
    if (reason) {
      Object.assign(candidate, { graphMetrics: "unavailable", graphMetricsReason: reason });
      return;
    }
    const pathSet = new Set(paths);
    const symbols = nodes.filter((node) => pathSet.has(node.path) && (node.kind === "symbol" || node.kind === "class"));
    const symbolIds = new Set(symbols.map((node) => node.id));
    const spans = symbols.map((node) => {
      const evidence = node.evidence?.[0] ?? {};
      return {
        name: node.qualifiedName ?? node.name,
        kind: node.kind,
        path: node.path,
        labels: node.labels ?? [],
        startLine: evidence.startLine ?? null,
        endLine: evidence.endLine ?? null,
        lines: evidence.startLine && evidence.endLine ? evidence.endLine - evidence.startLine + 1 : 0,
      };
    }).sort((left, right) => right.lines - left.lines || left.name.localeCompare(right.name));
    const incoming = edges.filter((edge) => symbolIds.has(edge.target) && !symbolIds.has(edge.source)).length;
    const outgoing = edges.filter((edge) => symbolIds.has(edge.source) && !symbolIds.has(edge.target)).length;
    Object.assign(candidate, {
      graphMetrics: "available",
      symbolCount: symbols.length,
      largestSymbolLines: spans[0]?.lines ?? 0,
      incomingRelationships: incoming,
      outgoingRelationships: outgoing,
      topSymbols: spans.slice(0, 12),
    });
  };
  for (const candidate of check.meta.oversized ?? []) enrich(candidate, [candidate.file]);
  for (const candidate of check.meta.mechanical_splits ?? []) enrich(candidate, candidate.part_files ?? candidate.files ?? []);
  check.meta.graphMetricsVersion = 2;
  check.meta.review_candidates = [...(check.meta.oversized ?? []), ...(check.meta.mechanical_splits ?? [])];
  facts.decomposition = check.meta;
}

function runHygieneCommand(root, outDir, subcommand, args) {
  const result = subcommand === "refresh"
    ? refreshHygiene(root, outDir, args)
    : subcommand === "status"
      ? hygieneStatus(root, outDir)
      : null;
  if (!result) {
    usage();
    return 1;
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`hygiene ${result.state} checks=${result.checks?.length ?? 0} generation=${result.sourceGenerationId ?? "none"}`);
  return result.state === "fresh" ? 0 : 2;
}

function loadPhase2Inputs(root, outDir) {
  const graph = readJson(join(root, outDir, "graph/graph.json"), null);
  const queue = readJson(join(root, outDir, "queue.json"), null);
  if (!graph?.manifest?.generationId) {
    throw new Error(`phase2_invalid: ${outDir}/graph/graph.json is missing a generation; run blueprint build first`);
  }
  if (!Array.isArray(queue?.claims)) {
    throw new Error(`phase2_invalid: ${outDir}/queue.json is missing or invalid; run blueprint build first`);
  }
  return {
    graph,
    queue,
    verdictEnvelope: optionalJson(join(root, outDir, "verdicts.json")).value,
    understanding: optionalJson(join(root, outDir, "understanding.json")).value,
  };
}

function writePhase2Plan(root, outDir, inputs = loadPhase2Inputs(root, outDir)) {
  const plan = buildIncrementalPhase2Plan(inputs);
  writeJsonAtomic(join(root, outDir, "phase2-plan.json"), plan);
  return plan;
}

function runPhase2Command(root, outDir, subcommand, args) {
  if (subcommand === "plan") {
    const plan = writePhase2Plan(root, outDir);
    if (args.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(`phase2 ${plan.complete ? "reusable" : "pending"} verify=${plan.verdicts.verify.length} synthesize=${plan.dimensions.synthesize.length}`);
    return 0;
  }
  if (subcommand === "seal") {
    const inputs = loadPhase2Inputs(root, outDir);
    const sealed = sealPhase2Artifacts(inputs);
    writeJsonAtomic(join(root, outDir, "verdicts.json"), sealed.verdicts);
    writeJsonAtomic(join(root, outDir, "understanding.json"), sealed.understanding);
    const docs = generateDocs(root, { noReadmeLink: Boolean(args.noReadmeLink) });
    const plan = writePhase2Plan(root, outDir, {
      graph: inputs.graph,
      queue: inputs.queue,
      verdictEnvelope: sealed.verdicts,
      understanding: sealed.understanding,
    });
    const result = {
      schemaVersion: 1,
      state: plan.complete ? "sealed" : "incomplete",
      sourceGenerationId: inputs.graph.manifest.generationId,
      verdicts: sealed.verdicts.verdicts.length,
      dimensions: Object.keys(sealed.understanding.incremental.dimensions).length,
      complete: plan.complete,
      docs: docs.mode,
    };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`phase2 ${result.state} generation=${result.sourceGenerationId} verdicts=${result.verdicts} dimensions=${result.dimensions}`);
    return plan.complete ? 0 : 2;
  }
  usage();
  return 1;
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
  const knownCommands = new Set(["build", "brief", "doctor", "graph", "hygiene", "phase2"]);
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
  if (command === "hygiene") {
    const [subcommand, ...hygieneRest] = rest;
    const hygieneArgs = parseArgs(hygieneRest);
    return runHygieneCommand(root, outDir, subcommand, hygieneArgs);
  }
  if (command === "phase2") {
    const [subcommand, ...phase2Rest] = rest;
    const phase2Args = parseArgs(phase2Rest);
    return runPhase2Command(root, outDir, subcommand, phase2Args);
  }
  if (command === "build") {
    const result = build(root, outDir, args);
    const config = loadConfig(root, outDir);
    const fresh = isFresh(root, outDir, config, Number(args.limit ?? 0));
    if (!fresh) throw new Error("generated graph is stale immediately after build");
    console.log(`built ${outDir}/map.json docs=${result.map.stats.docs} claims=${result.map.stats.claims} manifest=.blueprint/manifest.json product=docs/product.md architecture=docs/architecture.md ${phase1CompletionMarker(args)}`);
    if (result.docsResult?.mode === "docs_conflict") {
      console.warn(`docs_conflict: ${result.docsResult.conflicts.join(", ")} — wrote fallback to .agent/docs/`);
    }
    warnUncommitted(root, outDir);
    return 0;
  }
  if (command === "brief") {
    return runBriefAndPrint(root, outDir, args);
  }
  if (command === "doctor") return doctor(root, outDir, { json: Boolean(args.json), full: Boolean(args.full) });
  usage();
  return 1;
}

try {
  process.on("uncaughtException", e => { console.error("STACK:", e.stack); process.exit(1); });
  process.exitCode = main();
} catch (error) {
  if (error?.code?.startsWith("graph_")) {
    console.error(JSON.stringify({ schemaVersion: 1, error: { code: error.code, message: error.message, ...error.details } }));
  } else {
    console.error(`maprepo: ${error.message}`);
  }
  process.exitCode = 1;
}
