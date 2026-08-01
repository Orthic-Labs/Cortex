import { readFileSync, statSync } from "node:fs";
import { contentDigest } from "./generation-identity.mjs";

function fileIdentity(stat) {
  return Number.isFinite(Number(stat?.dev)) && Number.isFinite(Number(stat?.ino))
    ? `${stat.dev}:${stat.ino}`
    : null;
}

function changed(before, after) {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

export function stableRead(absPath) {
  const statBefore = statSync(absPath);
  let bytes = readFileSync(absPath);
  let statAfter = statSync(absPath);
  let unstable = false;
  if (changed(statBefore, statAfter)) {
    bytes = readFileSync(absPath);
    statAfter = statSync(absPath);
    unstable = changed(statBefore, statAfter) || changed(statAfter, statBefore);
  }
  return {
    bytes,
    contentDigest: contentDigest(bytes),
    fileIdentity: fileIdentity(statAfter),
    statBefore,
    statAfter,
    unstable,
  };
}
