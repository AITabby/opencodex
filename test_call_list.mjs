import { spawn } from "child_process";
const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);
let buf = "";

proc.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      console.log("RESP id=" + msg.id + ":", JSON.stringify(msg).substring(0, 400));
      if (msg.id === 1) {
        proc.kill();
        process.exit(0);
      }
    } catch(e) {}
  }
  buf = lines[lines.length - 1];
});

// Directly call list_apps tool without initialize
setTimeout(() => {
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "list_apps", arguments: {}}}) + "\n");
  console.log("Called list_apps");
}, 500);

setTimeout(() => { console.log("TIMEOUT"); proc.kill(); process.exit(1); }, 8000);
