import { spawn } from "child_process";
const cuPath = "/Users/aitabby/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const proc = spawn(cuPath, ["mcp"]);
let buf = "", id = 0, initDone = false;

function send(method, params) {
  id++;
  proc.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params: params || {}}) + "\n");
}

proc.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.id === 100) {
        const text = msg.result?.content?.[0]?.text || JSON.stringify(msg.result);
        console.log("RESULT:", text.substring(0, 500));
        proc.kill();
        process.exit(0);
      }
      if (msg.id === 1 && msg.result) {
        initDone = true;
        console.log("INIT OK");
        send("tools/call", {name: "list_apps", arguments: {}});
      }
    } catch(e) {}
  }
  buf = lines[lines.length - 1];
});

send("initialize", {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "t", version: "1"}});
setTimeout(() => { proc.kill(); process.exit(1); }, 10000);
