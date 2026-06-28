import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let agent: ChildProcessWithoutNullStreams | null = null;
let requestQueue = Promise.resolve();

function resolveAgentPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = join(moduleDir, "..", "..");
  const candidates = [
    join(rootDir, "native", "windows-cu-agent", "cu-agent.exe"),
    join(rootDir, "native", "windows-cu-agent", "bin", "Release", "net8.0-windows", "win-x64", "publish", "cu-agent.exe"),
    join(rootDir, "native", "windows-cu-agent", "bin", "Release", "net8.0-windows", "cu-agent.exe")
  ];
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error("Windows Computer Use agent is missing. Run npm install again with the .NET 8 SDK installed.");
  }
  return executable;
}

function getAgent(): ChildProcessWithoutNullStreams {
  if (agent && !agent.killed) return agent;
  agent = spawn(resolveAgentPath(), [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  agent.once("exit", () => { agent = null; });
  return agent;
}

async function sendNow(action: string, params: Record<string, unknown>): Promise<any> {
  const child = getAgent();
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error(`Windows Computer Use action timed out: ${action}`)), 15000);

    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(value);
    };
    const onExit = () => finish(new Error("Windows Computer Use agent exited unexpectedly."));
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const result = JSON.parse(buffer.slice(0, newline).trim());
        if (result.status !== "ok") finish(new Error(result.error || `Windows action failed: ${action}`));
        else finish(undefined, result);
      } catch (error: any) {
        finish(new Error(`Invalid response from Windows Computer Use agent: ${error.message}`));
      }
    };

    child.once("exit", onExit);
    child.stdout.on("data", onData);
    child.stdin.write(JSON.stringify({ action, ...params }) + "\n");
  });
}

export function sendWindowsAction(action: string, params: Record<string, unknown> = {}): Promise<any> {
  const pending = requestQueue.then(() => sendNow(action, params));
  requestQueue = pending.then(() => undefined, () => undefined);
  return pending;
}
