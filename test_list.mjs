import { spawn } from "child_process";

const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);

let buffer = "";
let id = 0;

function send(method, params) {
  id++;
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params: params || {}}) + "\n");
  return id;
}

proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.id === 2) {
        console.log("LIST_APPS:", JSON.stringify(msg.result).substring(0, 300));
        proc.kill();
        process.exit(0);
      }
    } catch(e) {}
  }
  buffer = lines[lines.length - 1];
});

// Initialize
send("initialize", {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "t", version: "1"}});
setTimeout(() => send("tools/list", {}), 300);
setTimeout(() => { proc.kill(); process.exit(1); }, 5000);
