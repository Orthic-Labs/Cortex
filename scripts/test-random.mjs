#!/usr/bin/env node
// Phase 7.5 — randomized test-order runner.
//
// Defect 18 records two production lock deaths that `test:all
// --test-concurrency=1` did not catch because the SERIAL suite runs tests
// in deterministic filesystem order and any race that depends on a
// particular ordering is invisible. Randomizing the file order — and
// running with the SAME concurrency=1 floor — exposes order-dependent
// failures (shared-tempdir collisions, leaked handles, port reuse) without
// throwing away the determinism that makes the serial suite trustworthy.
//
// Usage:  node scripts/test-random.mjs [--seed=N] [--runs=N]
//         pnpm test:random           # one randomized run, default seed
//
// This script does NOT replace `test:all`. It runs ALONGSIDE it; pass the
// random variant in CI as a separate job and gate on it.

import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TESTS = join(ROOT, "tests");

function parseArgs(argv) {
  const args = { seed: null, runs: 1 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--seed=")) args.seed = Number(arg.slice("--seed=".length));
    else if (arg.startsWith("--runs=")) args.runs = Number(arg.slice("--runs=".length));
  }
  return args;
}

function collectTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(full);
    }
  }
  return files;
}

// xorshift32 — small deterministic PRNG so a recorded seed reproduces a
// specific run. `Math.random()` is not reproducible across Node versions.
function makeRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function fisherYates(arr, rng) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function run() {
  const args = parseArgs(process.argv);
  const allFiles = collectTests(TESTS);
  let totalFail = 0;
  for (let runIndex = 0; runIndex < args.runs; runIndex += 1) {
    const seed = args.seed ?? (Math.floor(Math.random() * 0xffffffff) || 1);
    const rng = makeRng(seed);
    const order = fisherYates([...allFiles], rng);
    const relativePaths = order.map((full) => relative(ROOT, full));
    process.stdout.write(`[test-random] run ${runIndex + 1}/${args.runs} seed=${seed} files=${relativePaths.length}\n`);
    process.stdout.write(`[test-random] order: ${relativePaths.join(" ")}\n`);
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...relativePaths], {
      cwd: ROOT,
      stdio: "inherit",
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(`[test-random] run ${runIndex + 1} failed with status=${result.status}\n`);
      totalFail += 1;
    }
  }
  if (totalFail > 0) {
    process.stderr.write(`[test-random] ${totalFail}/${args.runs} runs failed\n`);
    process.exit(1);
  }
  process.stdout.write(`[test-random] all ${args.runs} runs passed\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { run(); } catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exit(1); }
}