import { spawn } from "child_process";
const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);
let buf = "";

proc.stdout.on("data", (d) => {
  buf += d.toString();
  console.log("STDOUT:", d.toString());
});

proc.stderr.on("data", (d) => {
  console.log("STDERR:", d.toString());
});

// Wait for process to be ready, then send initialize
setTimeout(() => {
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "t", version: "1"}}}) + "\n");
}, 200);

setTimeout(() => {
  // Send list_apps directly, no initialized notification
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "list_apps", arguments: {}}}) + "\n");
  console.log("Sent list_apps at 2s");
}, 2000);

setTimeout(() => {
  console.log("--- 5s timeout ---");
  proc.kill();
  process.exit(1);
}, 5000);
