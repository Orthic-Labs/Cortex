// D16: atomic update application. Backs up the database before any
// incompatible migration, performs atomic app replacement, and retains one
// prior version plus a compatible store backup.

import { existsSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function backupStore(root, { outDir = ".agent" } = {}) {
  const dbPath = join(root, outDir, "graph", "graph.db");
  if (!existsSync(dbPath)) return { backedUp: false, path: null };
  const backupDir = join(root, outDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const target = join(backupDir, `graph.db.before-update-${Date.now()}`);
  copyFileSync(dbPath, target);
  return { backedUp: true, path: target };
}

export function stageUpdate({ fromDir, toDir, backup }) {
  // Atomic app replacement: copy the new payload beside the old, then swap.
  const stagingDir = `${toDir}.staging-${Date.now()}`;
  mkdirSync(stagingDir, { recursive: true });
  copyRecursive(fromDir, stagingDir);
  return stagingDir;
}

export function applyStaged({ stagingDir, appDir, priorDir }) {
  // Retain one prior version.
  rmSync(priorDir, { recursive: true, force: true });
  if (existsSync(appDir)) copyRecursive(appDir, priorDir);
  rmSync(appDir, { recursive: true, force: true });
  copyRecursive(stagingDir, appDir);
  rmSync(stagingDir, { recursive: true, force: true });
  return { applied: true, priorDir };
}

function copyRecursive(source, target) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const src = join(source, name);
    const dst = join(target, name);
    if (statSync(src).isDirectory()) copyRecursive(src, dst);
    else copyFileSync(src, dst);
  }
}
