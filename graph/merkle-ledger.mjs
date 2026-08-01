import { contentDigest } from "./generation-identity.mjs";

function normalizeDigest(value) {
  const text = String(value ?? "");
  return text.startsWith("xxh128:") ? text : `xxh128:${text}`;
}

export function leafDigestForFile(contentDigestValue) {
  return normalizeDigest(contentDigestValue);
}

export function dirDigest(childEntries) {
  const entries = [...(childEntries ?? [])]
    .map((entry) => [String(entry.name), String(entry.digest)])
    .sort(([left], [right]) => left.localeCompare(right));
  return contentDigest(Buffer.from(JSON.stringify(entries), "utf8"));
}

function parentDirectories(path) {
  const parts = String(path).replaceAll("\\", "/").split("/").filter(Boolean);
  const parents = [""];
  for (let index = 1; index < parts.length; index += 1) parents.push(parts.slice(0, index).join("/"));
  return parents;
}

function rebuildDirectories(db) {
  const files = db.prepare("SELECT path, digest FROM generation_leaf WHERE kind = 'file' ORDER BY path").all();
  const children = new Map();
  const ensure = (path) => {
    if (!children.has(path)) children.set(path, new Map());
    return children.get(path);
  };
  for (const file of files) {
    const parts = file.path.split("/");
    let directory = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      const childPath = parts.slice(0, index + 1).join("/");
      ensure(directory).set(parts[index], { kind: "dir", path: childPath });
      directory = childPath;
    }
    ensure(directory).set(parts.at(-1), { kind: "file", digest: file.digest, path: file.path });
  }
  db.exec("DELETE FROM generation_leaf WHERE kind = 'dir'");
  const directories = [...children.keys()].sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
  const upsert = db.prepare("INSERT INTO generation_leaf(path, kind, digest) VALUES (?, 'dir', ?) ON CONFLICT(path) DO UPDATE SET kind='dir', digest=excluded.digest");
  for (const directory of directories) {
    const entries = [...children.get(directory).entries()].map(([name, entry]) => ({
      name,
      digest: entry.kind === "file" ? entry.digest : db.prepare("SELECT digest FROM generation_leaf WHERE path = ? AND kind = 'dir'").get(entry.path)?.digest,
    }));
    const digest = dirDigest(entries);
    upsert.run(directory, digest);
    if (directory !== "") {
      const parent = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
      const parentEntry = children.get(parent)?.get(directory.split("/").at(-1));
      if (parentEntry) parentEntry.digest = digest;
    }
  }
  if (!children.has("")) return dirDigest([]);
  const rootEntries = [...children.get("").entries()].map(([name, entry]) => ({ name, digest: entry.kind === "file" ? entry.digest : db.prepare("SELECT digest FROM generation_leaf WHERE path = ? AND kind = 'dir'").get(entry.path)?.digest }));
  const rootDigest = dirDigest(rootEntries);
  upsert.run("", rootDigest);
  return rootDigest;
}

export function updateLeafChain(db, path, contentDigestOrNull) {
  if (contentDigestOrNull === null || contentDigestOrNull === undefined) {
    db.prepare("DELETE FROM generation_leaf WHERE path = ? AND kind = 'file'").run(String(path));
  } else {
    db.prepare("INSERT INTO generation_leaf(path, kind, digest) VALUES (?, 'file', ?) ON CONFLICT(path) DO UPDATE SET kind='file', digest=excluded.digest").run(String(path), leafDigestForFile(contentDigestOrNull));
  }
  return rebuildDirectories(db);
}

export function computeFullLedger(db, files) {
  db.exec("DELETE FROM generation_leaf");
  const insert = db.prepare("INSERT INTO generation_leaf(path, kind, digest) VALUES (?, 'file', ?)");
  for (const file of files ?? []) {
    const digest = file.contentDigest ?? file.content_digest ?? file.contentHash;
    if (digest) insert.run(String(file.path), leafDigestForFile(digest));
  }
  return rebuildDirectories(db);
}

export function diffLedgerAgainstTree(db, root, scanFiles) {
  const recorded = new Map(db.prepare("SELECT path, digest FROM generation_leaf WHERE kind = 'file'").all().map((row) => [row.path, row.digest]));
  const current = new Map((scanFiles ?? []).map((file) => [String(file.path), leafDigestForFile(file.contentDigest ?? file.content_digest ?? file.contentHash)]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, digest] of current) {
    if (!recorded.has(path)) added.push(path);
    else if (recorded.get(path) !== digest) changed.push(path);
  }
  for (const path of recorded.keys()) if (!current.has(path)) removed.push(path);
  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    root: root ?? db.prepare("SELECT digest FROM generation_leaf WHERE path = '' AND kind = 'dir'").get()?.digest ?? null,
  };
}
