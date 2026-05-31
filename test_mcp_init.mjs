import { spawn } from "child_process";

const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);

let buffer = "";
let id = 0;

function send(method, params) {
  id++;
  const req = JSON.stringify({jsonrpc: "2.0", id, method, params: params || {}});
  console.log("SEND:", req);
  proc.stdin.write(req + "\n");
  return id;
}

proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      console.log("RECV:", JSON.stringify(msg).substring(0, 200));
    } catch(e) {}
  }
  buffer = lines[lines.length - 1];
});

proc.stderr.on("data", (d) => console.log("ERR:", d.toString()));

// Step 1: Initialize
send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0" }
});

setTimeout(() => {
  // Step 2: Initialized notification
  send("notifications/initialized", {});
}, 500);

setTimeout(() => {
  // Step 3: List tools
  send("tools/list", {});
}, 1000);

setTimeout(() => {
  // Step 4: Get Chrome state
  send("tools/call", {name: "get_app_state", arguments: {app: "Google Chrome"}});
}, 2000);

setTimeout(() => {
  proc.kill();
  process.exit(0);
}, 10000);
