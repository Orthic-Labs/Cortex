// D30: daemon IPC server — the daemon owns writable handles and serializes
// writes per repository. Read requests use generation-pinned read-only
// handles and bounded queues. Newline-delimited JSON over Unix socket
// (macOS/Linux) or named pipe (Windows).

import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createCortexApplicationService } from "../lib/application/service.mjs";
import { RootRegistry } from "../lib/application/root-registry.mjs";
import { PROTOCOL_VERSION, decodeLine, encodeResponse, METHODS } from "./protocol.mjs";
import { daemonEndpoint } from "./paths.mjs";

export function createDaemonServer({ service = null, endpoint = null, registryEntries = [] } = {}) {
  const registry = new RootRegistry(registryEntries);
  const appService = service ?? createCortexApplicationService({ rootRegistry: registry, allowEmbeddedRoot: false });
  const socketPath = endpoint ?? daemonEndpoint();
  const pending = new Map(); // requestId -> { resolve, timer }
  const activeSockets = new Set();

  const server = createServer((socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = decodeLine(line);
        if (!message) continue;
        handleMessage(socket, message).catch(() => {});
      }
    });
    socket.on("error", () => {});
  });

  async function handleMessage(socket, message) {
    if (message.method === "cancel") {
      const target = pending.get(String(message.input?.targetRequestId ?? ""));
      if (target) {
        clearTimeout(target.timer);
        pending.delete(target.id);
        socket.write(encodeResponse({ requestId: message.requestId, ok: true, generation: null, result: { cancelled: true }, error: null }));
      }
      return;
    }
    if (!METHODS.includes(message.method)) {
      socket.write(encodeResponse({ requestId: message.requestId, ok: false, generation: null, result: null, error: { code: "method_unknown", message: `unknown method ${message.method}` } }));
      return;
    }
    const requestId = String(message.requestId ?? "");
    const timer = setTimeout(() => {
      pending.delete(requestId);
      socket.write(encodeResponse({ requestId, ok: false, generation: null, result: null, error: { code: "deadline_exceeded", message: "request deadline exceeded" } }));
    }, Number(message.deadlineMs ?? 2000));
    pending.set(requestId, { id: requestId, timer });
    try {
      const method = appService[message.method];
      const mergedInput = { ...(message.input ?? {}) };
      if (message.repoId) mergedInput.repoId = message.repoId;
      if (message.generation) mergedInput.generation = message.generation;
      const result = await method(mergedInput);
      clearTimeout(timer);
      pending.delete(requestId);
      socket.write(encodeResponse({ requestId, ok: true, generation: result?.generationId ?? null, result, error: null }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      socket.write(encodeResponse({ requestId, ok: false, generation: null, result: null, error: { code: error.code ?? "internal_error", message: String(error.message ?? error) } }));
    }
  }

  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    async listen() {
      if (process.platform !== "win32") {
        rmSync(socketPath, { force: true });
        mkdirSync(dirname(socketPath), { recursive: true });
      }
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      return { endpoint: socketPath };
    },
    close() {
      for (const socket of activeSockets) socket.destroy();
      activeSockets.clear();
      return new Promise((resolve) => server.close(() => { rmSync(socketPath, { force: true }); resolve(); }));
    },
  });
}
