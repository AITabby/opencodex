/**
 * OpenCodex V2 Server Entrypoint
 */

import { CodexBridgeServer } from "./server/gateway.js";

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8765;
const server = new CodexBridgeServer(port);

server.start().catch((err) => {
  console.error(`Failed to start OpenCodex V2 Gateway: ${err.message}`);
  process.exit(1);
});
