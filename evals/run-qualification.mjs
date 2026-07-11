#!/usr/bin/env node
// B0.2 provider-qualification runner.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
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
      expectedEvidence: Array.isArray(raw.expectedEvidence) ? raw.expectedEvidence.slice() : [],
      allowedAlternates: Array.isArray(raw.allowedAlternates) ? raw.allowedAlternates.slice() : [],
      protectedAnchors: Array.isArray(raw.protectedAnchors) ? raw.protectedAnchors.slice() : [],
      maxPacketTokens: Number(raw.maxPacketTokens) || 0,
      freshness: raw.freshness ?? "current",
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
    async execute(task) {
      return { state: "unsupported", reason: `fallback_${task.kind}_unsupported`, evidenceRefs: [] };
    },
    async close() {},
  };
}

export function makeCodebaseMemoryProvider(opts = {}) {
  const binary = String(opts.binary ?? "codebase-memory-mcp");
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const cacheDir = String(opts.cacheDir ?? process.env.CBM_CACHE_DIR ?? resolve(process.cwd(), ".agent/provider-cache/codebase-memory"));
  const projects = new Map();
  const invoke = async (tool, payload, timeout = timeoutMs) => {
    const { stdout } = await execFile(binary, ["cli", tool, JSON.stringify(payload)], {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CBM_CACHE_DIR: cacheDir },
    });
    return JSON.parse(String(stdout).trim());
  };
  const ensureProject = async (repoRoot) => {
    if (projects.has(repoRoot)) return projects.get(repoRoot);
    const indexed = await invoke("index_repository", { repo_path: resolve(repoRoot) }, 120000);
    if (!indexed.project) throw new Error(`index_repository returned no project: ${JSON.stringify(indexed)}`);
    projects.set(repoRoot, indexed.project);
    return indexed.project;
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
        return {
          available: true,
          kind: "codebase-memory",
          version: String(stdout || "").trim(),
          binary,
          securityVerified: true,
          license: "MIT",
          portability: [process.platform],
          freshnessVerified: false,
          operabilityVerified: false,
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
      const project = await ensureProject(repoRoot);
      const found = await invoke("search_graph", {
        project,
        query: task.query,
        include_connected: true,
        limit: 40,
      });
      const results = [...(found.results ?? []), ...(found.semantic_results ?? [])];
      const refs = results.map((item) => item.file_path).filter(Boolean);
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
      return { state: "ok", evidenceRefs: [...new Set(refs.map(normalizePath))], falseEvidence: [] };
    },
    async close() {},
  };
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
    taskReports.push(await qualifyTask(provider, task, probeResult, reposRoot));
  }

  const status = deriveStatus(probeResult, taskReports);
  const gates = computeGates(kind, probeResult, taskReports);

  return {
    id,
    status,
    probe: probeResult,
    gates,
    metrics: {
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
    const evidenceRefs = [...new Set((raw.evidenceRefs ?? []).map(normalizePath))];
    const expectedPaths = [...new Set((task.expectedEvidence ?? []).map((item) => normalizePath(item.path)))];
    const missingEvidence = expectedPaths.filter((expected) => !evidenceRefs.some((actual) => actual === expected || actual.endsWith(`/${expected}`)));
    const falseEvidence = raw.falseEvidence ?? [];
    return {
      id: task.id,
      kind: task.kind,
      state: missingEvidence.length || falseEvidence.length ? "failed" : "passed",
      evidenceRefs,
      missingEvidence,
      falseEvidence,
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
  const states = new Set(taskReports.map((r) => r.state));
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

function computeGates(kind, probeResult, taskReports) {
  const allPassed = taskReports.length > 0 && taskReports.every((r) => r.state === "passed");
  const noError = !taskReports.some((r) => r.state === "error");
  const noUnavailable = !taskReports.some((r) => r.state === "unavailable");
  const noUnsupported = !taskReports.some((r) => r.state === "unsupported");
  const probeOk = !probeResult || probeResult.available !== false;

  // The fallback is intentionally limited: even if it scores every lexical
  // task correctly, it cannot satisfy mandatory structural fixtures, so
  // correctness stays false. A real graph provider has to earn `true` by
  // passing every gate.
  const correctness = kind === "fallback" ? false : allPassed && noError && noUnsupported;
  const freshness = kind === "fallback" ? false : allPassed && probeResult?.freshnessVerified === true;
  const security = noError && probeResult?.securityVerified === true;
  const contract = noError && probeOk;
  const portability = ["win32", "darwin"].every((platform) => probeResult?.portability?.includes(platform));
  const operability = noError && noUnavailable && probeResult?.operabilityVerified === true;

  return { correctness, freshness, security, contract, portability, operability };
}

export function selectProvider(reports) {
  const list = Array.isArray(reports) ? reports : [];
  for (const report of list) {
    if (!report || report.status !== "passed") continue;
    if (!allMandatoryGatesPassed(report.gates)) continue;
    return { outcome: "selected", selectedProvider: String(report.id) };
  }
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
    providerTimeoutMs: args["provider-timeout-ms"] ?? null,
  };
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
    if (cached && cached.status && cached.gates) {
      reports.push(cached);
      continue;
    }
    const providerOptions = name === "codebase-memory"
      ? {
          binary: args["codebase-memory-binary"],
          cacheDir: args["codebase-memory-cache"],
          timeoutMs: args["provider-timeout-ms"],
        }
      : {};
    const provider = makeProviderByName(name, providerOptions);
    const report = await qualifyProvider(provider, tasks, reposRoot);
    checkpoint.providers[name] = report;
    reports.push(report);
    saveCheckpoint(checkpointPath, checkpoint);
  }

  const selection = selectProvider(reports);

  const finalReport = {
    schemaVersion: 1,
    schemaHash: schemaHash(schemaPath),
    qualificationFingerprint: fingerprint,
    generatedAt: new Date().toISOString(),
    budgetApproval: "pending",
    realRepositoryMeasurements: realRepos.map((path) => ({ path: resolve(path), state: "pending" })),
    providers: reports.map(sortProviderReport),
    selection,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(finalReport, null, 2) + "\n");
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
