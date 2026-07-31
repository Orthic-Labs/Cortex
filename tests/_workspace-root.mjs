import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findWorkspaceRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "tools/lib/context-contracts.schema.json"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`workspace contract root not found from ${start}`);
    current = parent;
  }
}
