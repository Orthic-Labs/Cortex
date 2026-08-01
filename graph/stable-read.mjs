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

export function stableRead(absPath, fs = { readFileSync, statSync }) {
  let statBefore = fs.statSync(absPath);
  let bytes = fs.readFileSync(absPath);
  let statAfter = fs.statSync(absPath);
  let unstable = changed(statBefore, statAfter);
  if (unstable) {
    statBefore = fs.statSync(absPath);
    bytes = fs.readFileSync(absPath);
    statAfter = fs.statSync(absPath);
    unstable = changed(statBefore, statAfter);
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
