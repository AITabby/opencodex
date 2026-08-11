/**
 * CodexBridge V2 Entry Runner
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
  // App-managed gateways are owned by the macOS shell. Keep the parent PID
  // watchdog for standalone/CLI launches, but do not run a duplicate watcher
  // inside the embedded child where a transient process check can look like a
  // clean shutdown during startup.
  if (String(process.env.OPENCODEX_APP_MODE || "").trim() === "1") return;
  const parentPid = Number(process.env.OPENCODEX_PARENT_PID || 0);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
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
    console.error(`Failed to start CodexBridge V2: ${err.message}`);
    process.exit(1);
  });
