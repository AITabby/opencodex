import { spawn } from "child_process";

const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);

let buffer = "";
let id = 0;

function send(method, params, isNotification = false) {
  id++;
  const req = isNotification 
    ? JSON.stringify({jsonrpc: "2.0", method, params: params || {}})
    : JSON.stringify({jsonrpc: "2.0", id, method, params: params || {}});
  proc.stdin.write(req + "\n");
  return id;
}

proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.id === 100) {
        // Tool call response
        const text = msg.result?.content?.[0]?.text || "no text";
        console.log("TOOL RESULT:", text.substring(0, 500));
        proc.kill();
        process.exit(0);
      }
    } catch(e) {}
  }
  buffer = lines[lines.length - 1];
});

// Initialize
send("initialize", {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "test", version: "1.0"}});

setTimeout(() => {
  // Send initialized as notification (no id)
  send("notifications/initialized", {}, true);
}, 300);

setTimeout(() => {
  // Call get_app_state for Chrome
  send("tools/call", {name: "get_app_state", arguments: {app: "Google Chrome"}});
  console.log("Waiting for Chrome state...");
}, 800);

setTimeout(() => {
  console.log("TIMEOUT");
  proc.kill();
  process.exit(1);
}, 30000);
