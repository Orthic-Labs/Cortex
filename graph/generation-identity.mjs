// Generation identity — body hash (generationId) vs manifest metadata (manifestDigest).
//
// generationId binds the full node/edge set plus source tree hash. It must be
// sealed only after augmentation so lexical and AST layers share one identity.
//
// manifestDigest binds publish metadata downstream consumers pin without loading
// the graph body: provider, composition, counts, schema version, sourceObservation.

import { createHash } from "node:crypto";
import { createXXHash128 } from "hash-wasm";

const xxhasher = await createXXHash128();

function xxh128(value) {
  xxhasher.init();
  xxhasher.update(value);
  return xxhasher.digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function computeGenerationId(nodes, edges, sourceHash) {
  return `xxh128:${xxh128(JSON.stringify({ nodes, edges, sourceHash }))}`;
}

export function computeManifestDigest(manifest, sourceObservation = null) {
  const payload = {
    schemaVersion: manifest?.schemaVersion ?? 1,
    provider: manifest?.provider ?? null,
    providerComposition: manifest?.providerComposition ?? null,
    counts: manifest?.counts ?? null,
    sourceObservation: sourceObservation ?? manifest?.sourceObservation ?? null,
  };
  return `sha256:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
}

/** Re-seal generationId + manifestDigest on the in-memory generation object. */
export function finalizeGenerationIdentity(generation) {
  const manifest = generation?.manifest;
  if (!manifest) return generation;
  const sourceHash = manifest.repo?.sourceHash ?? null;
  const id = computeGenerationId(generation.nodes ?? [], generation.edges ?? [], sourceHash);
  manifest.generationId = id;
  manifest.generatedAt = `gen:${id.replace(/^xxh128:/, "").slice(0, 16)}`;
  manifest.manifestDigest = computeManifestDigest(manifest, generation.sourceObservation);
  if (generation.docTruth && generation.provider) {
    generation.docTruth.provider = typeof generation.provider === "string"
      ? generation.provider
      : generation.provider.id;
  }
  return generation;
}
