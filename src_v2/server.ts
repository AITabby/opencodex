/**
 * OpenCodex V2 Server Entrypoint
 */

import { CodexBridgeServer } from "./server/gateway.js";

const configuredPort = process.env.OPENCODEX_PORT || process.env.PORT;
const port = configuredPort ? parseInt(configuredPort, 10) : 8765;
const server = new CodexBridgeServer(port);

server.start().catch((err) => {
  console.error(`Failed to start OpenCodex V2 Gateway: ${err.message}`);
  process.exit(1);
});
