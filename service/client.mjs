// D30: daemon IPC client — connects to the daemon endpoint and issues
// request/response/cancel with deadlines.

import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, encodeRequest, encodeResponse, encodeCancel, decodeLine } from "./protocol.mjs";
import { daemonEndpoint } from "./paths.mjs";

export class DaemonClient {
  constructor({ endpoint = null } = {}) {
    this.endpoint = endpoint ?? daemonEndpoint();
    this.socket = null;
    this.buffer = "";
    this.waiters = new Map();
  }

  async connect() {
    if (this.socket) return this;
    const socket = connect(this.endpoint);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const message = decodeLine(line);
        if (!message) continue;
        const waiter = this.waiters.get(message.requestId);
        if (waiter) {
          this.waiters.delete(message.requestId);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("connect timeout"), { code: "connect_timeout" }));
      }, 3000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on("error", () => {});
    this.socket = socket;
    return this;
  }

  async request({ method, input = {}, repoId = null, generation = null, deadlineMs = 2000 }) {
    if (!this.socket) await this.connect();
    const requestId = randomUUID();
    const envelopeRepoId = repoId ?? input.repoId ?? null;
    const envelopeGeneration = generation ?? input.generation ?? null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(Object.assign(new Error("request deadline exceeded"), { code: "deadline_exceeded" }));
      }, deadlineMs + 500);
      this.waiters.set(requestId, { resolve, timer });
      this.socket.write(encodeRequest({ requestId, repoId: envelopeRepoId, generation: envelopeGeneration, method, deadlineMs, input }));
    });
  }

  cancel(targetRequestId) {
    if (!this.socket) return;
    this.socket.write(encodeCancel(targetRequestId));
  }

  close() {
    return new Promise((resolve) => {
      if (!this.socket) return resolve();
      this.socket.end(resolve);
    });
  }
}

export { PROTOCOL_VERSION };
