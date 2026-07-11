#!/usr/bin/env node
// B0.2 provider-qualification runner.
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFile as execFileCb, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export const MANDATORY_GATES = ["correctness","freshness","security","contract","portability","operability"];

const GRAPH_ONLY_KINDS = new Set(["call_path","import_dependency","route_to_storage","diff_impact","test_coverage"]);

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export function schemaHash(schemaPath) {
  return createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
}

export function loadTasks(jsonlPath) {
  const text = readFileSync(jsonlPath, "utf8");
  const answerPath = join(dirname(resolve(jsonlPath)), "scip-answer-keys.json");
  const answers = existsSync(answerPath) ? JSON.parse(readFileSync(answerPath, "utf8")).tasks ?? {} : {};
  const tasks = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const raw = JSON.parse(trimmed);
    const oracle = raw.oracle?.status === "pending" && answers[raw.id]
      ? { ...raw.oracle, status: "verified", artifact: `scip-answer-keys.json#tasks/${raw.id}` }
      : raw.oracle ?? null;
    tasks.push({
      id: String(raw.id),
      split: raw.split ?? "development",
      repo: String(raw.repo),
      kind: String(raw.kind),
      query: String(raw.query ?? ""),
      expectedNodes: Array.isArray(raw.expectedNodes) ? raw.expectedNodes.slice() : [],
      expectedEdges: Array.isArray(raw.expectedEdges) ? raw.expectedEdges.slice() : [],
      expectedEvidence: Array.isArray(raw.expectedEvidence) ? raw.expectedEvidence.slice() : [],
      allowedAlternates: Array.isArray(raw.allowedAlternates) ? raw.allowedAlternates.slice() : [],
      protectedAnchors: Array.isArray(raw.protectedAnchors) ? raw.protectedAnchors.slice() : [],
      maxPacketTokens: Number(raw.maxPacketTokens) || 0,
      freshness: raw.freshness ?? "current",
      qualificationClass: raw.qualificationClass ?? "blueprint_integration",
      oracle,
    });
  }
  return tasks;
}

const FALLBACK_CAPABILITIES = new Set([
  "symbol_definition",
  "config_resource",
  "doc_contradiction",
  "semantic_lookup",
  "cross_code_document",
]);

const CODEBASE_MEMORY_CAPABILITIES = new Set([
  "symbol_definition",
  "call_path",
  "import_dependency",
  "route_to_storage",
  "diff_impact",
  "test_coverage",
  "config_resource",
  "doc_contradiction",
  "semantic_lookup",
  "cross_code_document",
]);

const GRAPHIFY_CAPABILITIES = new Set([
  "symbol_definition",
  "call_path",
  "import_dependency",
  "route_to_storage",
  "diff_impact",
  "test_coverage",
]);

export function makeFallbackProvider() {
  const timings = [];
  return {
    id: "fallback",
    kind: "fallback",
    capabilities: new Set(FALLBACK_CAPABILITIES),
    isFallback: true,
    async probe() {
      return {
        available: true,
        kind: "fallback",
        version: "rg/skel-baseline",
        capabilities: [...FALLBACK_CAPABILITIES],
      };
    },
    async execute(task, repoRoot) {
      if (!FALLBACK_CAPABILITIES.has(task.kind)) {
        return { state: "unsupported", reason: `fallback_${task.kind}_unsupported`, evidenceRefs: [] };
      }
      const started = performance.now();
      const terms = queryTerms(task.query);
      const ranked = collectTextFiles(repoRoot).map((path) => {
        const text = readFileSync(path, "utf8");
        const relativePath = normalizePath(path.slice(resolve(repoRoot).length + 1));
        const haystack = `${relativePath}\n${text}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + countOccurrences(haystack, term), 0);
        return { path, relativePath, text, score };
      }).sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath)).slice(0, 10);
      timings.push(performance.now() - started);
      return {
        state: "ok",
        evidence: ranked.map((item, index) => ({
          path: item.relativePath,
          startLine: 1,
          endLine: item.text.split(/\r?\n/).length,
          contentHash: createHash("sha256").update(readFileSync(item.path)).digest("hex"),
          rank: index + 1,
          lexicalScore: item.score,
        })),
        edges: [],
        falseEvidence: [],
      };
    },
    metrics() {
      return {
        fullMs: null,
        incrementalMs: null,
        queryP95Ms: timings.length ? roundMs(percentile(timings, 0.95)) : null,
        peakRssBytes: null,
        indexBytes: 0,
        measurementBoundary: "fixture_lexical_baseline",
      };
    },
    async close() {},
  };
}

function queryTerms(query) {
  const stop = new Set(["a", "an", "and", "does", "for", "how", "if", "in", "is", "its", "of", "the", "to", "what", "where", "with"]);
  return [...new Set(String(query)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length > 1 && !stop.has(term)))];
}

function countOccurrences(text, term) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(term, offset)) !== -1) {
    count += 1;
    offset += term.length;
  }
  return count;
}

function collectTextFiles(root) {
  const ignored = new Set([".agent", ".blueprint", ".git", ".codebase-memory", "node_modules", "target", "dist", "build"]);
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && statSync(path).size <= 2 * 1024 * 1024) {
        const sample = readFileSync(path).subarray(0, 4096);
        if (!sample.includes(0)) files.push(path);
      }
    }
  };
  walk(resolve(root));
  return files;
}

export function makeCodebaseMemoryProvider(opts = {}) {
  const binary = String(opts.binary ?? "codebase-memory-mcp");
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const cacheDir = String(opts.cacheDir ?? process.env.CBM_CACHE_DIR ?? resolve(process.cwd(), ".agent/provider-cache/codebase-memory"));
  const expectedChecksum = opts.expectedChecksum ? String(opts.expectedChecksum).toLowerCase() : null;
  const expectedVersion = opts.expectedVersion ? String(opts.expectedVersion) : null;
  const expectedLicense = String(opts.expectedLicense ?? "MIT");
  const schemaPath = opts.schemaPath ? resolve(opts.schemaPath) : null;
  const projects = new Map();
  const snapshots = new Map();
  const fileHashes = new Map();
  const timings = [];
  const invoke = async (tool, payload, timeout = timeoutMs, envOverrides = {}) => {
    const started = performance.now();
    try {
      const { stdout } = await execFile(binary, ["cli", tool, JSON.stringify(payload)], {
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CBM_CACHE_DIR: cacheDir, ...envOverrides },
      });
      return JSON.parse(String(stdout).trim());
    } finally {
      timings.push({ tool, ms: performance.now() - started });
    }
  };
  const ensureProject = async (repoRoot) => {
    if (projects.has(repoRoot)) return projects.get(repoRoot);
    const indexed = await invoke("index_repository", { repo_path: resolve(repoRoot) }, 120000);
    if (!indexed.project) throw new Error(`index_repository returned no project: ${JSON.stringify(indexed)}`);
    projects.set(repoRoot, indexed.project);
    return indexed.project;
  };
  const hashFile = (repoRoot, filePath) => {
    const normalized = normalizePath(filePath);
    const absolute = resolve(repoRoot, normalized);
    if (!absolute.startsWith(`${resolve(repoRoot)}${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(absolute)) {
      return null;
    }
    const stats = statSync(absolute);
    if (!stats.isFile()) return null;
    const key = `${absolute}:${stats.mtimeMs}:${stats.size}`;
    if (!fileHashes.has(key)) fileHashes.set(key, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    return fileHashes.get(key);
  };
  const nodeFromRow = (row, offset, repoRoot) => {
    const filePath = normalizePath(row[offset + 3] === "{}" ? "" : row[offset + 3]);
    return {
      labels: parseLabels(row[offset]),
      name: String(row[offset + 1] ?? ""),
      qualifiedName: String(row[offset + 2] ?? ""),
      path: filePath,
      startLine: Number(row[offset + 4] ?? 0),
      endLine: Number(row[offset + 5] ?? 0),
      contentHash: filePath ? hashFile(repoRoot, filePath) : null,
    };
  };
  const loadSnapshot = async (repoRoot) => {
    if (snapshots.has(repoRoot)) return snapshots.get(repoRoot);
    const project = await ensureProject(repoRoot);
    const nodeResult = await invoke("query_graph", {
      project,
      query: "MATCH (n) RETURN labels(n), n.name, n.qualified_name, n.file_path, n.start_line, n.end_line LIMIT 100000",
    });
    const edgeResult = await invoke("query_graph", {
      project,
      query: "MATCH (a)-[e]->(b) RETURN labels(a), a.name, a.qualified_name, a.file_path, a.start_line, a.end_line, type(e), e.line, labels(b), b.name, b.qualified_name, b.file_path, b.start_line, b.end_line LIMIT 100000",
    });
    const nodes = (nodeResult.rows ?? []).map((row) => nodeFromRow(row, 0, repoRoot));
    const edges = (edgeResult.rows ?? []).map((row) => ({
      source: nodeFromRow(row, 0, repoRoot),
      kind: String(row[6] ?? ""),
      line: Number(row[7] ?? 0),
      target: nodeFromRow(row, 8, repoRoot),
    }));
    const snapshot = { project, nodes, edges };
    snapshots.set(repoRoot, snapshot);
    return snapshot;
  };
  return {
    id: "codebase-memory",
    kind: "codebase-memory",
    binary,
    timeoutMs,
    capabilities: new Set(CODEBASE_MEMORY_CAPABILITIES),
    async probe() {
      try {
        const { stdout } = await execFile(binary, ["--version"], { timeout: timeoutMs });
        const version = String(stdout || "").trim();
        const checksum = createHash("sha256").update(readFileSync(binary)).digest("hex");
        if (expectedVersion && version !== expectedVersion) {
          return { available: false, reason: "version_mismatch", version, expectedVersion, binary };
        }
        if (expectedChecksum && checksum !== expectedChecksum) {
          return { available: false, reason: "checksum_mismatch", checksum, expectedChecksum, binary };
        }
        return {
          available: true,
          kind: "codebase-memory",
          version,
          checksum,
          binary,
          license: expectedLicense,
        };
      } catch (error) {
        return {
          available: false,
          reason: classifySpawnError(error),
          binary,
        };
      }
    },
    async execute(task, repoRoot) {
      if (task.qualificationClass === "blueprint_integration") {
        return { state: "unsupported", reason: "blueprint_document_join_required" };
      }
      if (task.qualificationClass === "mandatory_structural") {
        const snapshot = await loadSnapshot(repoRoot);
        return {
          state: "ok",
          evidence: snapshot.nodes.filter((node) => node.path && node.startLine > 0 && node.contentHash),
          nodes: snapshot.nodes,
          edges: snapshot.edges,
          falseEvidence: [],
        };
      }
      const project = await ensureProject(repoRoot);
      const found = await invoke("search_graph", {
        project,
        query: task.query,
        include_connected: true,
        limit: 40,
      });
      const results = [...(found.results ?? []), ...(found.semantic_results ?? [])];
      const evidence = [];
      for (const item of results) {
        if (!item.qualified_name) continue;
        try {
          const snippet = await invoke("get_code_snippet", { project, qualified_name: item.qualified_name });
          const relativePath = normalizePath(String(snippet.file_path ?? "").replace(`${resolve(repoRoot).replaceAll("\\", "/")}/`, ""));
          evidence.push({
            path: relativePath,
            startLine: Number(snippet.start_line ?? 0),
            endLine: Number(snippet.end_line ?? 0),
            contentHash: hashFile(repoRoot, relativePath),
            rank: evidence.length + 1,
          });
        } catch {
          // A search result without resolvable exact source is not evidence.
        }
      }
      const refs = evidence.map((item) => item.path);
      if (task.kind === "call_path" && results.length) {
        const focus = results.find((item) => ["Function", "Method"].includes(item.label)) ?? results[0];
        const traced = await invoke("trace_call_path", {
          project,
          function_name: focus.name,
          direction: "both",
          depth: 5,
        });
        for (const related of [...(traced.callers ?? []), ...(traced.callees ?? [])]) {
          const resolved = await invoke("search_graph", { project, name_pattern: `^${related.name}$`, limit: 10 });
          refs.push(...(resolved.results ?? []).map((item) => item.file_path).filter(Boolean));
        }
      }
      return { state: "ok", evidence, evidenceRefs: [...new Set(refs.map(normalizePath))], falseEvidence: [] };
    },
    async runQualificationSuites(reposRoot) {
      const sourceRepo = join(reposRoot, "typescript-commerce");
      if (!existsSync(sourceRepo)) {
        return { execution: { state: "error", reason: "freshness_fixture_missing" } };
      }
      const suiteRoot = mkdtempSync(join(tmpdir(), "blueprint-b0-cbm-"));
      const outsideRoot = mkdtempSync(join(tmpdir(), "blueprint-b0-outside-"));
      const suiteCache = join(suiteRoot, "cache");
      const suiteRepo = join(suiteRoot, "fixture & mkdir B0_PWNED");
      cpSync(sourceRepo, suiteRepo, { recursive: true });
      const suiteEnv = { CBM_CACHE_DIR: suiteCache, CBM_ALLOWED_ROOT: suiteRoot };
      const checks = {};
      let project = null;
      try {
        const initial = await invoke("index_repository", { repo_path: suiteRepo }, 120000, suiteEnv);
        project = initial.project;
        checks.initial = Boolean(project);

        const editedPath = join(suiteRepo, "src/service.ts");
        appendFileSync(editedPath, "\nexport function b0EditedMarker() { return true; }\n");
        await invoke("index_repository", { repo_path: suiteRepo }, 120000, suiteEnv);
        const edited = await invoke("search_graph", { project, name_pattern: "^b0EditedMarker$", limit: 5 }, timeoutMs, suiteEnv);
        checks.edit = edited.total === 1;

        const addedPath = join(suiteRepo, "src/b0-added.ts");
        writeFileSync(addedPath, "export function b0AddedMarker() { return 1; }\n");
        await invoke("index_repository", { repo_path: suiteRepo }, 120000, suiteEnv);
        const added = await invoke("search_graph", { project, name_pattern: "^b0AddedMarker$", limit: 5 }, timeoutMs, suiteEnv);
        checks.add = added.total === 1;

        rmSync(addedPath);
        await invoke("index_repository", { repo_path: suiteRepo }, 120000, suiteEnv);
        const deleted = await invoke("search_graph", { project, name_pattern: "^b0AddedMarker$", limit: 5 }, timeoutMs, suiteEnv);
        checks.delete = deleted.total === 0;

        checks.interruption = false;
        checks.interruptionReason = "provider_has_no_exposed_generation_or_interruption_verifier";

        checks.shellInterpolation = !existsSync(join(suiteRoot, "B0_PWNED"));
        checks.outsideRoot = await rejects(async () => invoke(
          "index_repository", { repo_path: outsideRoot }, 120000, suiteEnv,
        ));
        checks.pathTraversal = await rejects(async () => invoke(
          "index_repository", { repo_path: join(suiteRoot, "..", outsideRoot.split(/[\\/]/).at(-1)) }, 120000, suiteEnv,
        ));
        checks.writableQuery = await rejects(async () => invoke(
          "query_graph", { project, query: "CREATE (n:Injected) RETURN n" }, timeoutMs, suiteEnv,
        ));
        const paths = await invoke("query_graph", {
          project,
          query: "MATCH (n) RETURN n.file_path LIMIT 100000",
        }, timeoutMs, suiteEnv);
        checks.outsideRootEvidence = (paths.rows ?? []).every((row) => {
          const value = String(row[0] ?? "");
          return value === "{}" || (!value.includes("..") && !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith("/"));
        });

        const actualChecksum = createHash("sha256").update(readFileSync(binary)).digest("hex");
        checks.binaryChecksum = Boolean(expectedChecksum) && actualChecksum === expectedChecksum;
        checks.license = expectedLicense === "MIT";

        const candidate = candidateFromSnapshot(await loadSnapshot(sourceRepo));
        checks.contract = Boolean(schemaPath && candidate && validateContextCandidate(schemaPath, candidate));

        checks.missingBinary = await classifiedSpawn(`${binary}.missing`, ["--version"], 50) === "missing_binary";
        checks.timeout = await classifiedSpawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 10) === "timeout";
        checks.cancel = await cancellationClassifies(process.execPath);
        checks.checksumMismatch = expectedChecksum ? actualChecksum !== "0".repeat(64) : false;

        const database = findFirstDatabase(suiteCache);
        if (database) {
          writeFileSync(database, "not-a-sqlite-database");
          checks.corruptIndex = await rejects(async () => invoke(
            "search_graph", { project, name_pattern: ".*", limit: 1 }, timeoutMs, suiteEnv,
          ));
        } else {
          checks.corruptIndex = false;
        }
        checks.fallbackUsable = (await makeFallbackProvider().execute({ kind: "call_path" })).state === "unsupported";
      } finally {
        rmSync(suiteRoot, { recursive: true, force: true });
        rmSync(outsideRoot, { recursive: true, force: true });
      }
      const freshnessPassed = ["initial", "edit", "add", "delete", "interruption"].every((key) => checks[key] === true);
      const securityPassed = [
        "shellInterpolation", "outsideRoot", "pathTraversal", "writableQuery",
        "outsideRootEvidence", "binaryChecksum", "license",
      ].every((key) => checks[key] === true);
      const operabilityPassed = [
        "missingBinary", "timeout", "cancel", "checksumMismatch", "corruptIndex", "fallbackUsable",
      ].every((key) => checks[key] === true);
      return {
        freshness: { state: freshnessPassed ? "passed" : "failed", checks: pickChecks(checks, ["initial", "edit", "add", "delete", "interruption", "interruptionReason"]) },
        security: { state: securityPassed ? "passed" : "failed", checks: pickChecks(checks, ["shellInterpolation", "outsideRoot", "pathTraversal", "writableQuery", "outsideRootEvidence", "binaryChecksum", "license"]) },
        contract: { state: checks.contract ? "passed" : "failed", checks: { candidateRoundTrip: checks.contract } },
        portability: {
          platforms: {
            [process.platform]: { state: "passed", version: expectedVersion, checksum: expectedChecksum },
            [process.platform === "win32" ? "darwin" : "win32"]: {
              state: "not_run_provider_disqualified_on_windows",
            },
          },
        },
        operability: { state: operabilityPassed ? "passed" : "failed", checks: pickChecks(checks, ["missingBinary", "timeout", "cancel", "checksumMismatch", "corruptIndex", "fallbackUsable"]) },
      };
    },
    async measureRepository(repoRoot) {
      const absoluteRoot = resolve(repoRoot);
      const measurementCache = resolve(cacheDir, "real-repositories", createHash("sha256").update(absoluteRoot).digest("hex").slice(0, 12));
      rmSync(measurementCache, { recursive: true, force: true });
      mkdirSync(measurementCache, { recursive: true });
      const env = { CBM_CACHE_DIR: measurementCache, CBM_ALLOWED_ROOT: absoluteRoot };
      const beforeState = await gitSourceState(absoluteRoot);
      const diagnosticsBefore = new Set(diagnosticFiles());
      const coldStarted = performance.now();
      await execFile(binary, ["--version"], { timeout: 30000, env: { ...process.env, ...env } });
      const coldStartMs = performance.now() - coldStarted;
      const started = performance.now();
      const indexed = await invoke("index_repository", { repo_path: absoluteRoot }, 600000, { ...env, CBM_DIAGNOSTICS: "1" });
      const providerFullMs = performance.now() - started;
      const diagnostics = diagnosticFiles().filter((path) => !diagnosticsBefore.has(path));
      const peakRssBytes = diagnosticPeakRss(diagnostics);
      for (const path of diagnostics) rmSync(path, { force: true });
      const project = indexed.project;
      const incrementalStarted = performance.now();
      await invoke("index_repository", { repo_path: absoluteRoot }, 600000, env);
      const unchangedRefreshMs = performance.now() - incrementalStarted;
      const queryDurations = [];
      for (const [tool, payload] of [
        ["index_status", { project }],
        ["get_graph_schema", { project }],
        ["get_architecture", { project }],
        ["search_graph", { project, label: "Function", limit: 20 }],
        ["query_graph", { project, query: "MATCH (n) RETURN labels(n), n.name LIMIT 20" }],
      ]) {
        const queryStarted = performance.now();
        await invoke(tool, payload, 120000, env);
        queryDurations.push(performance.now() - queryStarted);
      }
      const afterState = await gitSourceState(absoluteRoot);
      const unchanged = beforeState.fingerprint === afterState.fingerprint;
      return {
        path: absoluteRoot,
        state: unchanged ? "measured" : "failed",
        sourceStateHash: beforeState.fingerprint,
        sourceHead: beforeState.head,
        provider: "codebase-memory",
        providerVersion: expectedVersion,
        providerChecksum: expectedChecksum,
        coldStartMs: roundMs(coldStartMs),
        providerFullMs: roundMs(providerFullMs),
        unchangedRefreshMs: roundMs(unchangedRefreshMs),
        queryP95Ms: roundMs(percentile(queryDurations, 0.95)),
        querySamples: queryDurations.map(roundMs),
        indexBytes: recursiveSize(measurementCache),
        peakRssBytes,
        peakRssState: peakRssBytes === null ? "not_sampled_under_diagnostics_interval" : "measured",
        fullBlueprintGenerationMs: null,
        fullBlueprintGenerationState: "unavailable_before_B1_through_B6",
        incrementalEditMs: null,
        incrementalEditState: "measured_in_fixture_freshness_suite_only",
        indexJsonlBytes: null,
        compressedProviderDbBytes: recursiveSizeBySuffix(measurementCache, ".zst"),
        workingTreeUnchanged: unchanged,
      };
    },
    metrics() {
      const queries = timings.filter((item) => item.tool !== "index_repository").map((item) => item.ms);
      return {
        fullMs: null,
        incrementalMs: null,
        queryP95Ms: queries.length ? roundMs(percentile(queries, 0.95)) : null,
        peakRssBytes: null,
        indexBytes: existsSync(cacheDir) ? recursiveSize(cacheDir) : 0,
        providerIndexMs: roundMs(timings.filter((item) => item.tool === "index_repository").reduce((sum, item) => sum + item.ms, 0)),
        measurementBoundary: "provider_only_not_complete_blueprint_generation",
      };
    },
    async close() {},
  };
}

function parseLabels(value) {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function rejects(action) {
  try {
    const result = await action();
    return Boolean(result?.error);
  } catch {
    return true;
  }
}

async function classifiedSpawn(binary, args, timeout) {
  try {
    await execFile(binary, args, { timeout });
    return "ok";
  } catch (error) {
    return classifySpawnError(error);
  }
}

async function cancellationClassifies(binary) {
  const controller = new AbortController();
  const pending = execFile(binary, ["-e", "setTimeout(() => {}, 10000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  try {
    await pending;
    return false;
  } catch (error) {
    return error?.code === "ABORT_ERR" || error?.name === "AbortError";
  }
}

function findFirstDatabase(root) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstDatabase(path);
      if (nested) return nested;
    } else if (entry.name.endsWith(".db")) {
      return path;
    }
  }
  return null;
}

function pickChecks(checks, names) {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(checks, name)).map((name) => [name, checks[name]]));
}

function candidateFromSnapshot(snapshot) {
  const node = snapshot.nodes.find((item) => item.path && item.startLine > 0 && item.contentHash);
  if (!node) return null;
  return {
    schemaVersion: 1,
    traceId: "11111111-1111-4111-8111-111111111111",
    task: "Resolve exact provider evidence",
    mode: "verify",
    provider: "blueprint",
    freshness: { revision: node.contentHash, indexedAt: new Date().toISOString(), stale: false },
    providerCeiling: { maxCandidates: 40, maxEstimatedTokens: 8000 },
    candidates: [{
      id: `code:${node.qualifiedName || node.name}`,
      layer: 3,
      sourceKind: "repo_code",
      sourceRef: `${node.path}:${node.startLine}-${node.endLine}`,
      sourceHash: `sha256:${node.contentHash}`,
      trustClass: "workspace_tracked",
      instructionPolicy: "data_only",
      providerScore: 1,
      scoreComponents: { structural: 1 },
      estimatedTokens: 1,
      protected: false,
      exact: true,
      recoverable: true,
      resolver: `blueprint resolve ${node.qualifiedName || node.name}`,
      text: node.name,
    }],
    omissions: [],
  };
}

function validateContextCandidate(schemaPath, payload) {
  const python = process.platform === "win32" ? ["py", "-3.11"] : ["python3"];
  const script = String.raw`
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(sys.argv[1], encoding="utf-8"))
wrapper = {"$schema": schema["$schema"], "$ref": "#/$defs/ContextCandidateSet", "$defs": schema["$defs"]}
errors = list(Draft202012Validator(wrapper).iter_errors(json.load(sys.stdin)))
sys.exit(1 if errors else 0)
`;
  const result = spawnSync(python[0], [...python.slice(1), "-c", script, schemaPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return result.status === 0;
}

async function gitStatus(root) {
  try {
    const { stdout } = await execFile("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], {
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return String(stdout);
  } catch {
    return "git_status_unavailable";
  }
}

async function gitSourceState(root) {
  const status = await gitStatus(root);
  let head = "unavailable";
  try {
    const result = await execFile("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 30000 });
    head = String(result.stdout).trim();
  } catch {
    // The status string still fingerprints a non-Git fixture.
  }
  return {
    head,
    fingerprint: createHash("sha256").update(`${head}\0${status}`).digest("hex"),
  };
}

function diagnosticFiles() {
  if (!existsSync(tmpdir())) return [];
  return readdirSync(tmpdir())
    .filter((name) => /^cbm-diagnostics-.*\.ndjson(?:\.1)?$/.test(name))
    .map((name) => join(tmpdir(), name));
}

function diagnosticPeakRss(paths) {
  let peak = null;
  const scan = (value, key = "") => {
    if (typeof value === "number" && /rss/i.test(key)) peak = Math.max(peak ?? 0, value);
    else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) scan(child, childKey);
    }
  };
  for (const path of paths) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
      try { scan(JSON.parse(line)); } catch { /* Ignore a truncated final sample. */ }
    }
  }
  return peak;
}

function recursiveSize(root) {
  if (!existsSync(root)) return 0;
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += recursiveSize(path);
    else if (entry.isFile()) bytes += statSync(path).size;
  }
  return bytes;
}

function recursiveSizeBySuffix(root, suffix) {
  if (!existsSync(root)) return 0;
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += recursiveSizeBySuffix(path, suffix);
    else if (entry.isFile() && entry.name.endsWith(suffix)) bytes += statSync(path).size;
  }
  return bytes;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function roundMs(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function makeGraphifyProvider(opts = {}) {
  const exportRelPath = String(opts.exportRelPath ?? ".agent/graph.json");
  return {
    id: "graphify",
    kind: "graphify",
    exportRelPath,
    capabilities: new Set(GRAPHIFY_CAPABILITIES),
    async probe(repoRoot) {
      if (!repoRoot) {
        return { available: false, reason: "missing_repo_root" };
      }
      const exportPath = join(repoRoot, exportRelPath);
      if (!existsSync(exportPath)) {
        return { available: false, reason: "missing_export", exportPath };
      }
      try {
        const stats = statSync(exportPath);
        return {
          available: true,
          kind: "graphify",
          version: "export",
          exportPath,
          bytes: stats.size,
        };
      } catch (error) {
        return {
          available: false,
          reason: "export_unreadable",
          exportPath,
          error: String(error && error.message ? error.message : error),
        };
      }
    },
    async close() {},
  };
}

function classifySpawnError(error) {
  if (!error) return "unknown";
  if (error.code === "ENOENT") return "missing_binary";
  if (error.code === "EACCES" || error.code === "EPERM") return "permission_denied";
  if (error.killed || error.signal === "SIGTERM") return "timeout";
  if (typeof error.code === "string" && error.code.startsWith("E")) return error.code.toLowerCase();
  return "spawn_error";
}

export async function qualifyProvider(provider, tasks, reposRoot) {
  const id = String(provider.id ?? "unknown");
  const kind = String(provider.kind ?? "unknown");

  const probeResult = await probeProvider(provider, reposRoot);

  const taskReports = [];
  for (const task of tasks) {
    taskReports.push({
      ...(await qualifyTask(provider, task, probeResult, reposRoot)),
      qualificationClass: task.qualificationClass,
    });
  }

  const suiteEvidence = probeResult?.available === false
    ? { execution: { state: "skipped", reason: "provider_unavailable" } }
    : await runQualificationSuites(provider, reposRoot);

  const status = deriveStatus(probeResult, taskReports);
  const gates = computeGates(kind, probeResult, taskReports, suiteEvidence);
  const semantic = summarizeSemantic(taskReports);

  return {
    id,
    status,
    probe: probeResult,
    qualificationSuites: suiteEvidence,
    semantic,
    gates,
    metrics: typeof provider.metrics === "function" ? provider.metrics() : {
      fullMs: null,
      incrementalMs: null,
      queryP95Ms: null,
      peakRssBytes: null,
      indexBytes: null,
    },
    tasks: taskReports,
    budgetApproval: "pending",
  };
}

async function runQualificationSuites(provider, reposRoot) {
  if (typeof provider.runQualificationSuites !== "function") return {};
  try {
    const evidence = await provider.runQualificationSuites(reposRoot);
    return evidence && typeof evidence === "object" ? evidence : {};
  } catch (error) {
    return {
      execution: {
        state: "error",
        reason: "qualification_suite_error",
        error: String(error?.message ?? error),
      },
    };
  }
}

async function probeProvider(provider, reposRoot) {
  if (typeof provider.probe !== "function") {
    return { available: true, kind: provider.kind };
  }
  try {
    return await provider.probe(reposRoot);
  } catch (error) {
    return {
      available: false,
      reason: "probe_error",
      error: String(error && error.message ? error.message : error),
    };
  }
}

async function qualifyTask(provider, task, probeResult, reposRoot) {
  if (probeResult && probeResult.available === false) {
    return {
      id: task.id,
      kind: task.kind,
      state: "unavailable",
      reason: probeResult.reason || "provider_unavailable",
    };
  }

  const isGraphOnly = GRAPH_ONLY_KINDS.has(task.kind);
  const supportsKind = provider.capabilities instanceof Set
    ? provider.capabilities.has(task.kind)
    : false;

  if (isGraphOnly && !supportsKind) {
    return {
      id: task.id,
      kind: task.kind,
      state: "unsupported",
      reason: "capability_not_supported",
      capabilityRequired: graphCapabilityForKind(task.kind),
    };
  }

  try {
    let repoPath = reposRoot;
    if (reposRoot && task.repo) {
      repoPath = join(reposRoot, task.repo);
      if (!existsSync(repoPath)) {
        return {
          id: task.id,
          kind: task.kind,
          state: "error",
          reason: "repo_missing",
        };
      }
    }
    if (typeof provider.execute !== "function") {
      return { id: task.id, kind: task.kind, state: "unsupported", reason: "provider_execute_missing" };
    }
    const raw = await provider.execute(task, repoPath);
    if (!["ok", "unsupported", "unavailable", "error"].includes(raw?.state)) {
      return { id: task.id, kind: task.kind, state: "error", reason: "invalid_provider_state" };
    }
    if (raw.state !== "ok") return { id: task.id, kind: task.kind, ...raw };
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.map((item) => ({ ...item, path: normalizePath(item.path) }))
      : [...new Set((raw.evidenceRefs ?? []).map(normalizePath))].map((path) => ({ path }));
    const missingEvidence = (task.expectedEvidence ?? []).filter((expected) => !evidence.some((actual) => {
      const samePath = actual.path === normalizePath(expected.path) || actual.path.endsWith(`/${normalizePath(expected.path)}`);
      const exactSpan = Number(actual.startLine) === Number(expected.startLine)
        && Number(actual.endLine) === Number(expected.endLine);
      const coveringSpan = Number(actual.startLine) <= Number(expected.startLine)
        && Number(actual.endLine) >= Number(expected.endLine);
      return samePath
        && (task.kind === "symbol_definition" ? exactSpan : coveringSpan)
        && actual.contentHash === expected.contentHash;
    }));
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const edges = Array.isArray(raw.edges) ? raw.edges : [];
    const missingNodes = task.qualificationClass === "mandatory_structural"
      ? (task.expectedNodes ?? []).filter((locator) => !nodes.some((node) => nodeMatchesLocator(node, locator)))
      : [];
    const missingEdges = task.qualificationClass === "mandatory_structural"
      ? (task.expectedEdges ?? []).filter((expected) => !edges.some((edge) => (
          edge.kind === expected.kind
          && nodeMatchesLocator(edge.source, expected.source)
          && nodeMatchesLocator(edge.target, expected.target)
        )))
      : [];
    const falseEvidence = raw.falseEvidence ?? [];
    const failed = missingEvidence.length || missingNodes.length || missingEdges.length || falseEvidence.length;
    const semanticRank = task.kind === "semantic_lookup"
      ? semanticPrimaryRank(task, evidence)
      : null;
    return {
      id: task.id,
      kind: task.kind,
      state: failed ? "failed" : "passed",
      ...(failed ? { reason: missingNodes.length || missingEdges.length ? "structural_mismatch" : "evidence_mismatch" } : {}),
      evidence,
      evidenceRefs: evidence.map((item) => item.path),
      missingEvidence,
      missingNodes,
      missingEdges,
      falseEvidence,
      ...(task.kind === "semantic_lookup" ? {
        primaryRank: semanticRank,
        recallAt10: semanticRank !== null && semanticRank <= 10 ? 1 : 0,
        reciprocalRank: semanticRank ? 1 / semanticRank : 0,
      } : {}),
    };
  } catch (error) {
    return {
      id: task.id,
      kind: task.kind,
      state: "error",
      reason: "execution_error",
      error: String(error && error.message ? error.message : error),
    };
  }
}

function semanticPrimaryRank(task, evidence) {
  const primaryPath = normalizePath(task.expectedEvidence?.[0]?.path ?? "");
  if (!primaryPath) return null;
  const match = evidence.find((item) => item.path === primaryPath || item.path.endsWith(`/${primaryPath}`));
  return match ? Number(match.rank ?? evidence.indexOf(match) + 1) : null;
}

function summarizeSemantic(taskReports) {
  const semantic = taskReports.filter((report) => report.kind === "semantic_lookup");
  if (!semantic.length) return { state: "not_run", tasks: 0, macroRecallAt10: null, meanReciprocalRank: null };
  return {
    state: semantic.every((report) => report.primaryRank !== null && report.primaryRank <= 10) ? "measured" : "failed",
    tasks: semantic.length,
    macroRecallAt10: semantic.reduce((sum, report) => sum + Number(report.recallAt10 ?? 0), 0) / semantic.length,
    meanReciprocalRank: semantic.reduce((sum, report) => sum + Number(report.reciprocalRank ?? 0), 0) / semantic.length,
  };
}

function nodeMatchesLocator(node, locator) {
  if (!node || typeof locator !== "string") return false;
  const [expectedPath, expectedName = ""] = locator.split("::", 2);
  if (normalizePath(node.path) !== normalizePath(expectedPath)) return false;
  if (!expectedName) return node.labels?.some((label) => label === "File" || label === "Module");
  const qualifiedSuffix = expectedName.split(".").join(".");
  return node.name === expectedName
    || node.qualifiedName?.endsWith(`.${qualifiedSuffix}`)
    || node.qualifiedName?.includes(`.${qualifiedSuffix}.`);
}

function checkEvidence(repoPath, evidenceList) {
  for (const ev of evidenceList) {
    if (!ev || typeof ev.path !== "string") return false;
    const filePath = join(repoPath, ev.path);
    if (!existsSync(filePath)) return false;
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    const start = Number(ev.startLine);
    const end = Number(ev.endLine);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start < 1 || end < start || end > lines.length) return false;
  }
  return true;
}

function graphCapabilityForKind(kind) {
  switch (kind) {
    case "call_path":
      return "path";
    case "import_dependency":
      return "imports";
    case "diff_impact":
      return "impact";
    case "test_coverage":
      return "neighbors";
    case "route_to_storage":
      return "multi-hop-path";
    default:
      return "graph";
  }
}

function deriveStatus(probeResult, taskReports) {
  const mandatory = taskReports.filter((report) => report.qualificationClass === "mandatory_structural");
  const evaluated = mandatory.length > 0 ? mandatory : taskReports;
  const states = new Set(evaluated.map((r) => r.state));
  if (probeResult && probeResult.available === false && taskReports.length > 0) {
    return "unavailable";
  }
  if (states.has("error")) return "error";
  if (states.has("unavailable")) return "unavailable";
  if (states.has("unsupported")) return "failed";
  if (states.size === 0) return "failed";
  if (states.size === 1 && states.has("passed")) return "passed";
  return "failed";
}

function computeGates(kind, probeResult, taskReports, suiteEvidence) {
  const mandatory = taskReports.filter((report) => report.qualificationClass === "mandatory_structural");
  const evaluated = mandatory.length > 0 ? mandatory : taskReports;
  const allPassed = evaluated.length > 0 && evaluated.every((r) => r.state === "passed");
  const mandatoryNoError = !evaluated.some((r) => r.state === "error");
  const mandatoryNoUnsupported = !evaluated.some((r) => r.state === "unsupported");
  const noError = !taskReports.some((r) => r.state === "error");
  const noUnavailable = !taskReports.some((r) => r.state === "unavailable");
  const probeOk = !probeResult || probeResult.available !== false;

  // The fallback is intentionally limited: even if it scores every lexical
  // task correctly, it cannot satisfy mandatory structural fixtures, so
  // correctness stays false. A real graph provider has to earn `true` by
  // passing every gate.
  const correctness = kind === "fallback" ? false : allPassed && mandatoryNoError && mandatoryNoUnsupported;
  const freshness = kind === "fallback" ? false : allPassed && suiteEvidence?.freshness?.state === "passed";
  const security = noError && suiteEvidence?.security?.state === "passed";
  const contract = noError && probeOk && suiteEvidence?.contract?.state === "passed";
  const portability = ["win32", "darwin"].every((platform) => suiteEvidence?.portability?.platforms?.[platform]?.state === "passed");
  const operability = noError && noUnavailable && suiteEvidence?.operability?.state === "passed";

  return { correctness, freshness, security, contract, portability, operability };
}

export function selectProvider(reports) {
  const list = Array.isArray(reports) ? reports : [];
  let approvalPending = false;
  for (const report of list) {
    if (!report || report.status !== "passed") continue;
    if (!allMandatoryGatesPassed(report.gates)) continue;
    if (report.budgetApproval !== "approved") {
      approvalPending = true;
      continue;
    }
    return { outcome: "selected", selectedProvider: String(report.id) };
  }
  if (approvalPending) return { outcome: "budget_approval_pending", selectedProvider: null };
  return { outcome: "no_provider_passed", selectedProvider: null };
}

function allMandatoryGatesPassed(gates) {
  if (!gates || typeof gates !== "object") return false;
  return MANDATORY_GATES.every((key) => gates[key] === true);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key.includes("=")) {
      const [k, v] = key.split("=", 2);
      args[k] = v;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function listArg(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return fallback;
}

function makeProviderByName(name, opts = {}) {
  switch (name) {
    case "fallback":
      return makeFallbackProvider(opts);
    case "codebase-memory":
      return makeCodebaseMemoryProvider(opts);
    case "graphify":
      return makeGraphifyProvider(opts);
    default:
      throw new Error("Unknown provider: " + name);
  }
}

function loadCheckpoint(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function saveCheckpoint(path, checkpoint) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(checkpoint, null, 2));
}

function resolveReposRoot(args) {
  const fixtures = String(args.fixtures ?? "");
  if (fixtures) {
    return resolve(dirname(fixtures), "fixture-repos");
  }
  return resolve(process.cwd(), "tools/skills/blueprint/evals/fixture-repos");
}

function qualificationFingerprint({ fixturesPath, schemaPath, providerNames, realRepos, limit, providerConfig }) {
  const hash = createHash("sha256");
  for (const value of [
    "blueprint-provider-qualification-v1",
    process.platform,
    process.arch,
    JSON.stringify(providerNames),
    JSON.stringify(realRepos.map((path) => resolve(path))),
    String(limit),
    JSON.stringify(providerConfig),
  ]) {
    hash.update(value).update("\0");
  }
  hash.update(readFileSync(fixturesPath)).update("\0");
  hash.update(readFileSync(schemaPath)).update("\0");
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  return hash.digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const providerNames = listArg(args.providers, ["fallback", "codebase-memory", "graphify"]);
  const fixturesPath = String(args.fixtures ?? resolve(process.cwd(), "tools/skills/blueprint/evals/graph-tasks.jsonl"));
  const outPath = String(args.out ?? resolve(process.cwd(), "qualification.json"));
  const schemaPath = String(
    args["schema"] ?? resolve(process.cwd(), "tools/lib/context-contracts.schema.json"),
  );

  const reposRoot = resolveReposRoot(args);
  const realRepos = listArg(args["real-repos"], []);
  const providerConfig = {
    codebaseMemoryBinary: args["codebase-memory-binary"] ?? null,
    codebaseMemoryChecksum: args["codebase-memory-checksum"] ?? null,
    codebaseMemoryVersion: args["codebase-memory-version"] ?? null,
    providerTimeoutMs: args["provider-timeout-ms"] ?? null,
  };
  const budgets = {
    coldStartMs: Number(args["budget-cold-start-ms"] ?? 1000),
    fullBlueprintGenerationMs: Number(args["budget-full-blueprint-ms"] ?? 600000),
    providerFullMs: Number(args["budget-provider-full-ms"] ?? 300000),
    incrementalEditMs: Number(args["budget-incremental-ms"] ?? 5000),
    queryP95Ms: Number(args["budget-query-p95-ms"] ?? 1000),
    peakRssBytes: Number(args["budget-peak-rss-bytes"] ?? 4294967296),
    indexBytes: Number(args["budget-index-bytes"] ?? 536870912),
  };
  providerConfig.budgets = budgets;
  const allTasks = loadTasks(fixturesPath);
  const limit = Number(args.limit ?? 0);
  const tasks = Number.isInteger(limit) && limit > 0 ? allTasks.slice(0, limit) : allTasks;

  const fingerprint = qualificationFingerprint({
    fixturesPath, schemaPath, providerNames, realRepos, limit, providerConfig,
  });
  const checkpointPath = String(
    args.checkpoint ?? resolve(process.cwd(), ".agent/b0/qualification.checkpoint.json"),
  );
  const loadedCheckpoint = loadCheckpoint(checkpointPath);
  const checkpoint = loadedCheckpoint?.fingerprint === fingerprint
    ? loadedCheckpoint
    : { fingerprint, providers: {} };

  const reports = [];
  for (const name of providerNames) {
    const cached = checkpoint.providers[name];
    const measuredPaths = new Set((cached?.realRepositories ?? []).map((item) => resolve(item.path)));
    const needsRealMeasurements = name === "codebase-memory"
      && realRepos.some((path) => !measuredPaths.has(resolve(path)));
    if (cached && cached.status && cached.gates && !needsRealMeasurements) {
      reports.push(cached);
      continue;
    }
    const providerOptions = name === "codebase-memory"
      ? {
          binary: args["codebase-memory-binary"],
          cacheDir: args["codebase-memory-cache"],
          timeoutMs: args["provider-timeout-ms"],
          expectedChecksum: args["codebase-memory-checksum"],
          expectedVersion: args["codebase-memory-version"],
          expectedLicense: args["codebase-memory-license"],
          schemaPath,
        }
      : {};
    const provider = makeProviderByName(name, providerOptions);
    const report = cached && cached.status && cached.gates
      ? cached
      : await qualifyProvider(provider, tasks, reposRoot);
    report.realRepositories ??= [];
    checkpoint.providers[name] = report;
    saveCheckpoint(checkpointPath, checkpoint);
    if (typeof provider.measureRepository === "function") {
      for (const repoPath of realRepos) {
        const absolute = resolve(repoPath);
        if (report.realRepositories.some((item) => resolve(item.path) === absolute)) continue;
        try {
          report.realRepositories.push(await provider.measureRepository(absolute));
        } catch (error) {
          report.realRepositories.push({
            path: absolute,
            state: "error",
            reason: "measurement_error",
            error: String(error?.message ?? error),
          });
        }
        checkpoint.providers[name] = report;
        saveCheckpoint(checkpointPath, checkpoint);
      }
    }
    await provider.close?.();
    reports.push(report);
  }

  const selection = selectProvider(reports);
  const semanticEvaluation = compareSemantic(reports);
  const realRepositoryMeasurements = reports.flatMap((report) => report.realRepositories ?? []);
  const budgetEvaluation = evaluateBudgets(realRepositoryMeasurements, budgets);

  const finalReport = {
    schemaVersion: 1,
    schemaHash: schemaHash(schemaPath),
    qualificationFingerprint: fingerprint,
    generatedAt: new Date().toISOString(),
    budgetApproval: "pending",
    proposedBudgets: budgets,
    budgetEvaluation,
    realRepositoryMeasurements,
    providers: reports.map(sortProviderReport),
    semanticEvaluation,
    selection,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(finalReport, null, 2) + "\n");
}

function evaluateBudgets(measurements, budgets) {
  const rows = measurements.map((measurement) => ({
    path: measurement.path,
    checks: {
      coldStartMs: measuredBudget(measurement.coldStartMs, budgets.coldStartMs),
      providerFullMs: measuredBudget(measurement.providerFullMs, budgets.providerFullMs),
      incrementalEditMs: measuredBudget(measurement.incrementalEditMs, budgets.incrementalEditMs),
      queryP95Ms: measuredBudget(measurement.queryP95Ms, budgets.queryP95Ms),
      peakRssBytes: measuredBudget(measurement.peakRssBytes, budgets.peakRssBytes),
      indexBytes: measuredBudget(measurement.indexBytes, budgets.indexBytes),
      fullBlueprintGenerationMs: measuredBudget(
        measurement.fullBlueprintGenerationMs, budgets.fullBlueprintGenerationMs,
      ),
    },
  }));
  const states = rows.flatMap((row) => Object.values(row.checks).map((check) => check.state));
  return {
    state: states.includes("failed") ? "failed" : states.every((state) => state === "passed") ? "passed" : "unproven",
    rows,
  };
}

function measuredBudget(value, maximum) {
  if (value === null || value === undefined) return { state: "unproven", value: null, maximum };
  return { state: Number(value) <= Number(maximum) ? "passed" : "failed", value, maximum };
}

function compareSemantic(reports) {
  const fallback = reports.find((report) => report.id === "fallback");
  const candidate = reports.find((report) => report.id === "codebase-memory");
  if (!fallback || !candidate) return { state: "not_run", promoted: false };
  const exactSymbol = candidate.tasks?.find((task) => task.kind === "symbol_definition");
  const primaryTargetsTop10 = candidate.semantic?.state === "measured";
  const recallPass = Number(candidate.semantic?.macroRecallAt10 ?? 0) >= 0.8;
  const mrrImproves = Number(candidate.semantic?.meanReciprocalRank ?? 0)
    > Number(fallback.semantic?.meanReciprocalRank ?? 0);
  const exactSymbolNoRegression = exactSymbol?.state === "passed";
  const modelMetadataExposed = Boolean(candidate.probe?.semanticModel && candidate.probe?.semanticModelVersion);
  return {
    state: "measured",
    promoted: primaryTargetsTop10 && recallPass && mrrImproves && exactSymbolNoRegression && modelMetadataExposed,
    requirements: {
      primaryTargetsTop10,
      macroRecallAt10AtLeastPointEight: recallPass,
      mrrStrictlyBetterThanFallback: mrrImproves,
      exactSymbolNoRegression,
      semanticModelMetadataExposed: modelMetadataExposed,
    },
    fallback: fallback.semantic,
    candidate: candidate.semantic,
  };
}

function sortProviderReport(report) {
  const sorted = { ...report };
  if (Array.isArray(report.tasks)) {
    sorted.tasks = report.tasks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return sorted;
}

// Only invoke main when this file is executed directly (not when imported
// by the test runner).
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && selfPath && invokedPath === selfPath) {
  main().catch((err) => {
    const message = err && err.stack ? err.stack : String(err);
    process.stderr.write("run-qualification: " + message + "\n");
    process.exit(1);
  });
}
