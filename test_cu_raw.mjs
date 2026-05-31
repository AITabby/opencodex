import { spawn } from "child_process";

const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);

let buffer = "";
proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.id === 1) {
        console.log("TOOLS:", JSON.stringify(msg.result?.tools?.map(t => t.name)));
        // Close after getting tools
        const closeReq = JSON.stringify({jsonrpc: "2.0", id: 2, method: "notifications/closed", params: {}});
        proc.stdin.write(closeReq + "\n");
      }
      if (msg.id === 2) {
        proc.kill();
        process.exit(0);
      }
    } catch(e) {}
  }
});

// Request tool list
const req = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {}});
proc.stdin.write(req + "\n");

setTimeout(() => { console.log("TIMEOUT"); proc.kill(); process.exit(1); }, 5000);
