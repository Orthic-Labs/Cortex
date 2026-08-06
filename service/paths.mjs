// D30: daemon IPC path resolution — Unix domain socket on macOS/Linux, named
// pipe on Windows. One endpoint per user.

import { homedir } from "node:os";
import { join } from "node:path";

export function daemonEndpoint() {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\orthic-cortex";
  }
  return join(homedir(), ".cortex", "cortex.sock");
}

export function daemonPidPath() {
  return join(homedir(), ".cortex", "daemon.pid");
}
