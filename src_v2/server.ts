/**
 * OpenCodex V2 Server Entrypoint
 */

import { CodexBridgeServer } from "./server/gateway.js";

const configuredPort = process.env.OPENCODEX_PORT || process.env.PORT || "8765";
const port = parseInt(configuredPort, 10);
const server = new CodexBridgeServer(port);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const stop = server.stop().catch(() => undefined);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  void Promise.race([stop, timeout]).finally(() => process.exit(0));
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

function monitorDesktopParent(): void {
  const parentPid = Number(process.env.OPENCODEX_PARENT_PID || 0);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;

  // The macOS shell owns this Node child. If the app is force-quit or crashes,
  // there is no Swift termination callback to stop the gateway, so detect the
  // dead parent and close the server/child resources ourselves.
  const monitor = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(monitor);
      shutdown();
    }
  }, 2000);
  monitor.unref();
}

server.start()
  .then(() => monitorDesktopParent())
  .catch((err) => {
    console.error(`Failed to start OpenCodex V2 Gateway: ${err.message}`);
    process.exit(1);
  });
