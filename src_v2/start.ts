/**
 * CodexBridge V2 Entry Runner
 */

import { CodexBridgeServer } from "./server/gateway.js";
import { configureNetworkDispatcher } from "./services/network.js";

const configuredPort = process.env.OPENCODEX_PORT || process.env.PORT || "8765";
const port = parseInt(configuredPort, 10);
configureNetworkDispatcher();
const server = new CodexBridgeServer(port);

server.start().catch((err) => {
  console.error(`Failed to start CodexBridge V2: ${err.message}`);
  process.exit(1);
});
