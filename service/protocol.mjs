// D30: daemon IPC protocol (S-21). Newline-delimited JSON envelopes with
// requestId, repoId, generation pin, method, deadlineMs, and input; responses
// carry ok/generation/result/error; cancellation targets a requestId.

export const PROTOCOL_VERSION = 1;

export function encodeRequest({ requestId, repoId, generation, method, deadlineMs = 2000, input = {} }) {
  return `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, repoId, generation, method, deadlineMs, input })}\n`;
}

export function encodeResponse({ requestId, ok, generation, result, error }) {
  return `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, ok, generation, result, error })}\n`;
}

export function encodeCancel(targetRequestId) {
  return `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: `cancel-${Date.now()}`, method: "cancel", input: { targetRequestId } })}\n`;
}

export function decodeLine(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export const METHODS = Object.freeze([
  "status", "search", "resolve", "orient", "expand", "impact", "architecture", "documentTruth",
]);
