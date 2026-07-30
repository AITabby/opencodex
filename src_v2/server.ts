/**
 * OpenCodex V2 Server Entrypoint
 */

import { CodexBridgeServer } from "./server/gateway.js";
import { configureNetworkDispatcher } from "./services/network.js";

const configuredPort = process.env.OPENCODEX_PORT || process.env.PORT || "8765";
const port = parseInt(configuredPort, 10);
configureNetworkDispatcher();
const server = new CodexBridgeServer(port);

server.start().catch((err) => {
  console.error(`Failed to start OpenCodex V2 Gateway: ${err.message}`);
  process.exit(1);
});
