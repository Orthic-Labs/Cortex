import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { syncToCurrentSourceAtPath } from "../../graph/barrier.mjs";
import {
  closeStore,
  listClaimSlice,
  openStoreReadOnly,
} from "../../graph/store-sqlite.mjs";
import {
  boundedArchitecture,
  boundedImpact,
  boundedNeighbors,
  indexedQueryGeneration,
  indexedResolve,
  readIndexedMeta,
} from "../../graph/traverse-store.mjs";
import {
  createContextCandidateSet,
  graphStatus,
  queryGraph,
  repositoryIdentity,
} from "../../graph/static-provider.mjs";
import { fail } from "./errors.mjs";

function databasePath(root, outDir) {
  return join(root, outDir, "graph", "graph.db");
}

export function createCortexApplicationService({
  outDir = ".agent",
  rootRegistry = null,
  allowEmbeddedRoot = true,
} = {}) {
  const resolveRoot = (input = {}) => {
    if (rootRegistry) return rootRegistry.resolve(input);
    if (!allowEmbeddedRoot) fail("root_not_enrolled", "No enrolled Cortex repository matches this request.");
    return resolve(input.repoRoot ?? process.cwd());
  };

  async function withCurrentDb(input, callback) {
    const root = resolveRoot(input);
    const dbPath = databasePath(root, outDir);
    if (!existsSync(dbPath)) fail("graph_missing", `Graph store is missing for ${root}.`);
    const receipt = await syncToCurrentSourceAtPath(root, {
      outDir,
      timeoutMs: Number(input.timeoutMs ?? 2000),
    });
    if (receipt.barrierResult !== "caught_up" && !input.allowStale) {
      fail("stale_blocked", "Cortex freshness barrier did not catch up.", { receipt });
    }
    const db = openStoreReadOnly(dbPath);
    try {
      const meta = readIndexedMeta(db);
      if (!meta?.manifest?.generationId) fail("graph_missing", "No sealed generation is available.");
      if (input.generation && input.generation !== meta.manifest.generationId) {
        fail("generation_mismatch", "Requested generation is not current.", {
          expected: input.generation,
          observed: meta.manifest.generationId,
        });
      }
      return await callback({ root, db, meta, receipt });
    } finally {
      closeStore(db);
    }
  }

  async function resolveAnchor(input) {
    if (String(input.anchor ?? "").startsWith("file:") || String(input.anchor ?? "").startsWith("symbol:")) {
      return String(input.anchor);
    }
    return withCurrentDb(input, ({ db }) => {
      const generation = indexedQueryGeneration(db, String(input.anchor ?? ""), { limit: 8 });
      const matches = queryGraph(generation, { query: String(input.anchor ?? ""), limit: 8 });
      const exact = matches.filter((match) => match.id === input.anchor || match.name === input.anchor || match.qualifiedName === input.anchor || match.path === input.anchor);
      if (exact.length === 1) return exact[0].id;
      if (exact.length === 0 && matches.length === 1) return matches[0].id;
      if (exact.length === 0) fail("anchor_not_found", `No graph anchor matches ${input.anchor}.`);
      fail("anchor_ambiguous", `More than one graph anchor matches ${input.anchor}.`, { candidates: exact.map((x) => x.id) });
    });
  }

  return Object.freeze({
    async status(input = {}) {
      const root = resolveRoot(input);
      const status = graphStatus(root, outDir);
      return {
        schemaVersion: 1,
        repository: repositoryIdentity(root),
        ...status,
      };
    },

    async search(input = {}) {
      return withCurrentDb(input, ({ db, meta, receipt }) => {
        const query = String(input.query ?? "").trim();
        const generation = indexedQueryGeneration(db, query, { limit: Number(input.limit ?? 20), anchors: input.anchors ?? [] });
        return {
          schemaVersion: 1,
          kind: "search",
          generationId: meta.manifest.generationId,
          provider: meta.provider,
          query,
          results: queryGraph(generation, { query, limit: Number(input.limit ?? 20) }),
          omissions: [],
          truncated: false,
          continuationCursor: null,
          freshnessReceipt: receipt,
        };
      });
    },

    async resolve(input = {}) {
      return withCurrentDb(input, ({ db, meta, receipt }) => {
        const result = indexedResolve(db, String(input.nodeId ?? ""), {
          sourceState: receipt.barrierResult === "caught_up" ? "clean" : "stale",
        });
        if (!result) fail("node_not_found", `Graph node not found: ${input.nodeId}`);
        return { ...result, generationId: meta.manifest.generationId, freshnessReceipt: receipt };
      });
    },

    async orient(input = {}) {
      return withCurrentDb(input, ({ root, db, meta, receipt }) => {
        const query = String(input.query ?? input.task ?? "").trim();
        const generation = indexedQueryGeneration(db, query, { limit: Number(input.limit ?? 40), anchors: input.anchors ?? [] });
        const candidates = createContextCandidateSet(generation, {
          task: String(input.task ?? query),
          query,
          maxCandidates: Number(input.limit ?? 40),
          anchors: input.anchors ?? [],
          ...repositoryIdentity(root),
          repoRoot: root,
          receiptId: receipt.receiptId,
        });
        return {
          schemaVersion: 1,
          action: "allow",
          reasonCode: "oriented",
          generationId: meta.manifest.generationId,
          candidateSet: candidates,
          freshnessReceipt: receipt,
          omissions: candidates.omissions ?? [],
        };
      });
    },

    async expand(input = {}) {
      const nodeId = await resolveAnchor(input);
      return withCurrentDb(input, ({ db, receipt }) => boundedNeighbors(db, {
        nodeId,
        direction: input.direction ?? "both",
        depth: Number(input.depth ?? 1),
        budget: Number(input.budget ?? 2000),
        cursor: input.cursor,
        freshness: {
          generationId: receipt.generationId,
          sourceState: receipt.barrierResult === "caught_up" ? "clean" : "stale",
          dirtyFileCount: 0,
        },
      }));
    },

    async impact(input = {}) {
      const nodeId = await resolveAnchor(input);
      return withCurrentDb(input, ({ db, receipt }) => boundedImpact(db, {
        nodeId,
        depth: Number(input.depth ?? 3),
        budget: Number(input.budget ?? 2000),
        cursor: input.cursor,
        freshness: {
          generationId: receipt.generationId,
          sourceState: receipt.barrierResult === "caught_up" ? "clean" : "stale",
          dirtyFileCount: 0,
        },
      }));
    },

    async architecture(input = {}) {
      return withCurrentDb(input, ({ db, receipt }) => boundedArchitecture(db, {
        budget: Number(input.budget ?? 2000),
        cursor: input.cursor,
        freshness: {
          generationId: receipt.generationId,
          sourceState: receipt.barrierResult === "caught_up" ? "clean" : "stale",
          dirtyFileCount: 0,
        },
      }));
    },

    async documentTruth(input = {}) {
      return withCurrentDb(input, ({ db, meta, receipt }) => ({
        schemaVersion: 1,
        generationId: meta.manifest.generationId,
        claims: listClaimSlice(db, meta.manifest.generationId, {
          limit: Number(input.limit ?? 200),
          claimId: input.claimId,
          kind: input.kind,
        }),
        freshnessReceipt: receipt,
        omissions: [],
        truncated: false,
      }));
    },
  });
}
