import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

const transport = new StdioClientTransport({ 
  command: cuPath, 
  args: ["mcp"] 
});

const client = new Client(
  { name: "voice-test", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport);

// Test 1: List apps
const apps = await client.request(
  { method: "tools/call", params: { name: "list_apps", arguments: {} } },
  {}
);
console.log("Apps:", JSON.stringify(apps.content).substring(0, 200));

// Test 2: Get Chrome state
const chrome = await client.request(
  { method: "tools/call", params: { name: "get_app_state", arguments: { app: "Google Chrome" } } },
  {}
);
const textContent = chrome.content.find(c => c.type === "text");
console.log("Chrome state:", textContent?.text?.substring(0, 300));

await client.close();
process.exit(0);
