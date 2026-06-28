import { spawnSync } from "node:child_process";

if (process.platform !== "win32") process.exit(0);

const result = spawnSync("dotnet", [
  "publish",
  "native/windows-cu-agent/cu-agent.csproj",
  "-c", "Release",
  "--nologo"
], { stdio: "inherit" });

if (result.error?.code === "ENOENT" || result.status === 127 || result.status === 9009) {
  console.error("\nOpenCodex needs the .NET 8 SDK on Windows for native Computer Use.");
  console.error("Install it with: winget install Microsoft.DotNet.SDK.8\n");
}

process.exit(result.status ?? 1);
