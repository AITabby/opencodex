import { spawn } from "child_process";
const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);
let buf = "", ids = new Set();

proc.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (ids.has(msg.id)) {
        console.log(`RESPONSE id=${msg.id}:`, JSON.stringify(msg).substring(0, 300));
        ids.delete(msg.id);
        if (msg.id === 3) { // tools/call response
          const text = msg.result?.content?.[0]?.text || JSON.stringify(msg.result);
          console.log("TOOL RESULT:", text.substring(0, 500));
          proc.kill();
          process.exit(0);
        }
      }
    } catch(e) {}
  }
  buf = lines[lines.length - 1];
});

function send(id, method, params) {
  ids.add(id);
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params: params || {}}) + "\n");
}

// 1. Initialize
send(1, "initialize", {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "t", version: "1"}});

setTimeout(() => {
  // 2. Initialized notification (no id)
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized", params: {}}) + "\n");
  console.log("Sent initialized notification");
}, 500);

setTimeout(() => {
  // 3. Call list_apps
  send(3, "tools/call", {name: "list_apps", arguments: {}});
  console.log("Sent list_apps");
}, 800);

setTimeout(() => {
  console.log("TIMEOUT - no response");
  proc.kill();
  process.exit(1);
}, 10000);
