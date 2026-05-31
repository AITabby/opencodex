import { spawn } from "child_process";
const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);
let buf = "";

proc.stdout.on("data", (d) => {
  buf += d.toString();
  console.log("DATA:", d.toString().trim());
});

// Send only tools/list - no initialize
setTimeout(() => {
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {}}) + "\n");
  console.log("Sent tools/list");
}, 500);

setTimeout(() => {
  console.log("DONE");
  proc.kill();
  process.exit(0);
}, 3000);
