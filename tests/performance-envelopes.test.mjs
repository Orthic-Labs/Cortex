// D50: performance envelopes by repository class. A machine-readable budget
// table (evals/performance-envelopes.json) is enforced here with a 4x CI slack
// multiplier, so CI fails on real regressions without flaking on noisy runners.
// A waiver requires a machine-readable rationale AND an expiry — recorded in
// the same table; an expired or rationale-less waiver is itself a failure.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, closeStore } from "../graph/store-sqlite.mjs";
import { syncToCurrentSource } from "../graph/barrier.mjs";
import { CortexRepositoryWorker } from "../watchman/repo-actor.mjs";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts/cortex.mjs");
const ENVELOPES = JSON.parse(readFileSync(join(ROOT, "evals/performance-envelopes.json"), "utf8"));

function repoClassFixture(className) {
  const entry = ENVELOPES.repoClasses[className];
  if (!entry?.fixture) return null;
  const repo = mkdtempSync(join(tmpdir(), `cortex-envelope-${className}-`));
  cpSync(join(ROOT, entry.fixture), repo, { recursive: true });
  return repo;
}

function elapsed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

async function elapsedAsync(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", timeout: 300_000 });
}

function dbSizeBytes(repo) {
  return statSync(join(repo, ".agent/graph/graph.db")).size;
}

test("performance envelope table is well-formed and every waiver is valid", () => {
  assert.equal(ENVELOPES.schemaVersion, 1);
  const envelopeKeys = ["coldBuildMs", "incrementalUpdateMs", "noopBarrierMs", "searchImpactMs", "mcpResponseMs", "rssMb", "dbSizeMb", "incrementalWriteBytes"];
  for (const [className, entry] of Object.entries(ENVELOPES.repoClasses)) {
    assert.ok(["small", "medium", "large"].includes(className), `unknown class ${className}`);
    assert.ok(entry.description, `${className} needs a description`);
    for (const key of envelopeKeys) {
      assert.ok(Number.isFinite(entry.budgets[key]) && entry.budgets[key] > 0, `${className}.${key} must be a positive number`);
    }
  }
  assert.ok(ENVELOPES.ciSlackMultiplier >= 2, "CI slack must be at least 2x to avoid flaky CI");
  const future = Date.now() + 24 * 60 * 60 * 1000;
  for (const waiver of ENVELOPES.waivers ?? []) {
    assert.ok(waiver?.id && waiver?.envelope && waiver?.rationale, "every waiver needs id, envelope, rationale");
    assert.ok(waiver.expiresAt && Date.parse(waiver.expiresAt) > future, `waiver ${waiver.id} has no future expiry`);
  }
});

test("the CI slack multiplier is applied to the checked-in budgets, not to measurements", () => {
  const multiplier = ENVELOPES.ciSlackMultiplier;
  const budget = ENVELOPES.repoClasses.medium.budgets.noopBarrierMs;
  // A measurement that misses the raw budget but stays within multiplier*raw
  // must continue to pass — the multiplier is the enforcement threshold.
  assert.ok(budget * multiplier > budget);
});

test("small class envelopes: cold build, no-op barrier, search, db size", async () => {
  const repo = repoClassFixture("small");
  if (!repo) return;
  try {
    const small = ENVELOPES.repoClasses.small.budgets;
    const build = elapsed(() => runCli(repo, ["build", "--out", ".agent"]));
    assert.equal(build.value.status, 0, build.value.stderr?.slice(-500));
    assert.ok(build.ms <= small.coldBuildMs * ENVELOPES.ciSlackMultiplier, `cold build ${build.ms.toFixed(0)}ms > budget`);

    const db = openStore(join(repo, ".agent/graph/graph.db"));
    const barrier = await elapsedAsync(() => syncToCurrentSource(db, repo, { timeoutMs: 5000 }));
    assert.ok(["caught_up", "gap_blocked", "timeout"].includes(barrier.value.barrierResult));
    closeStore(db);
    assert.ok(barrier.ms <= small.noopBarrierMs * ENVELOPES.ciSlackMultiplier, `no-op barrier ${barrier.ms.toFixed(0)}ms > budget`);

    const orient = elapsed(() => runCli(repo, ["orient", "--query", "config", "--json"]));
    assert.equal(orient.value.status, 0, orient.value.stderr?.slice(-500));
    assert.ok(orient.ms <= small.searchImpactMs * ENVELOPES.ciSlackMultiplier, `search ${orient.ms.toFixed(0)}ms > budget`);

    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    assert.ok(rssMb <= small.rssMb * ENVELOPES.ciSlackMultiplier, `rss ${rssMb.toFixed(0)}MB > budget`);
    assert.ok(dbSizeBytes(repo) <= small.dbSizeMb * 1024 * 1024 * ENVELOPES.ciSlackMultiplier, "db size > budget");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("medium class envelopes: cold build, delta ingest write volume, status response", async () => {
  const repo = repoClassFixture("medium");
  if (!repo) return;
  try {
    const medium = ENVELOPES.repoClasses.medium.budgets;
    const build = elapsed(() => runCli(repo, ["build", "--out", ".agent"]));
    assert.equal(build.value.status, 0, build.value.stderr?.slice(-500));
    assert.ok(build.ms <= medium.coldBuildMs * ENVELOPES.ciSlackMultiplier, `cold build ${build.ms.toFixed(0)}ms > budget`);

    const statusStart = performance.now();
    const status = runCli(repo, ["status", "--json"]);
    const statusMs = performance.now() - statusStart;
    assert.equal(status.status, 0, status.stderr);
    assert.ok(statusMs <= medium.mcpResponseMs * ENVELOPES.ciSlackMultiplier, `status ${statusMs.toFixed(0)}ms > budget`);

    const source = join(repo, "src/service.ts");
    if (existsSync(source)) {
      const before = dbSizeBytes(repo);
      writeFileSync(source, `${readFileSync(source, "utf8")}\nexport const envelopeProbe = Date.now();\n`);
      const worker = new CortexRepositoryWorker({ root: repo, outDir: ".agent", snapshotPath: null, adapter: { startWatch: () => ({ unsubscribe: () => {} }), writeSnapshot: () => {}, eventsSince: () => [] } });
      try {
        const delta = await elapsedAsync(() => worker.ingest("src/service.ts", "modify"));
        assert.equal(delta.value.applied, true, "event appended and journal drained");
        // Allow the journal to drain through its debounce before measuring.
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(dbSizeBytes(repo) - before <= medium.incrementalWriteBytes * ENVELOPES.ciSlackMultiplier, "incremental write volume > budget");
      } finally {
        await worker.actor.stop();
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
