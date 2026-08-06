// D14: portable runtime bundle contract — self-contained layout, launchers
// resolve bundle-relative paths, and the staged app runs without system Node
// on PATH (simulated by pointing PATH at /usr/bin:/bin).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { stageRuntime } from "../scripts/release/stage-runtime.mjs";

const ROOT = join(import.meta.dirname, "..");
const LAUNCHERS = join(ROOT, "release", "launchers");

function stagedBundle() {
  const out = mkdtempSync(join(tmpdir(), "cortex-runtime-test-"));
  const result = stageRuntime({ out });
  return { out, result };
}

test("stageRuntime produces the S-12 layout", () => {
  const { out, result } = stagedBundle();
  try {
    for (const path of ["bin/cortex", "bin/cortex.cmd", "bin/cortex-mcp", "lib/node", "app/package/scripts/cortex.mjs", "app/schemas", "LICENSE", "README.txt"]) {
      assert.ok(existsSync(join(out, path)), `missing ${path}`);
    }
    assert.equal(result.version, "0.2.0");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("launchers are present and executable", () => {
  const { out } = stagedBundle();
  try {
    for (const name of ["cortex", "cortex.cmd", "cortex.ps1", "cortex-mcp"]) {
      assert.ok(existsSync(join(LAUNCHERS, name)), `missing launcher ${name}`);
    }
    for (const name of ["cortex", "cortex-mcp"]) {
      const mode = statSync(join(LAUNCHERS, name)).mode;
      assert.ok(mode & 0o111, `${name} not executable`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("bundled launcher runs help without system Node on PATH", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX launcher test");
    return;
  }
  const { out } = stagedBundle();
  try {
    const result = spawnSync(join(out, "bin", "cortex"), ["--help"], { env: { ...process.env, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Cortex — repository truth and evidence map/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("bundled app has grammars staged from the production install", () => {
  const { out } = stagedBundle();
  try {
    const grammarDir = join(out, "app", "grammars");
    assert.ok(existsSync(grammarDir), "grammars dir missing");
    const count = readdirSync(grammarDir).filter((name) => name.endsWith(".wasm")).length;
    assert.ok(count > 0, "no WASM grammars staged");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
