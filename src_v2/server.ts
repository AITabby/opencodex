/**
 * OpenCodex V2 Server Entrypoint
 */

import { CodexBridgeServer } from "./server/gateway.js";
import { safeErrorMessage } from "./server/privacy.js";

const configuredPort = process.env.OPENCODEX_PORT || process.env.PORT || "8765";
const port = parseInt(configuredPort, 10);
const server = new CodexBridgeServer(port);

server.start().catch((err) => {
  console.error(`Failed to start OpenCodex V2 Gateway: ${safeErrorMessage(err)}`);
  process.exit(1);
});
