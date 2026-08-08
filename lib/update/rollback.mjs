// D16: rollback — current↔previous with fixture stores. Restores the prior
// app version and the compatible store backup.

import { existsSync, rmSync, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function rollback({ appDir, priorDir, storeBackup, outDir = ".agent", root }) {
  const problems = [];
  if (!existsSync(priorDir)) problems.push("no prior version retained");
  if (storeBackup && !existsSync(storeBackup)) problems.push("no store backup");
  if (problems.length) return { ok: false, problems };

  rmSync(appDir, { recursive: true, force: true });
  copyRecursive(priorDir, appDir);

  if (storeBackup) {
    const dbPath = join(root ?? "", outDir, "graph", "graph.db");
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    copyFileSync(storeBackup, dbPath);
  }
  return { ok: true };
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
