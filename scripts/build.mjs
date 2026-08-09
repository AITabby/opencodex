import { chmod, copyFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(projectRoot, "dist");
const serverEntry = resolve(distDirectory, "server.js");
const gatewayEntry = resolve(distDirectory, "gateway-entry.js");
const helperScripts = ["codex-provider-bridge", "opencodex-codex"];

function runTypeScriptCompiler() {
  const isWindows = process.platform === "win32";
  const command = isWindows ? (process.env.ComSpec || "cmd.exe") : "tsc";
  const args = isWindows ? ["/d", "/s", "/c", "tsc"] : [];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`TypeScript compiler exited with code ${code ?? "unknown"}`));
    });
  });
}

async function build() {
  await rm(distDirectory, { force: true, recursive: true });
  await runTypeScriptCompiler();
  await rename(serverEntry, gatewayEntry);
  await writeFile(serverEntry, 'import "./gateway-entry.js";\n', "utf8");

  for (const helperScript of helperScripts) {
    const destination = resolve(distDirectory, helperScript);
    await copyFile(resolve(projectRoot, "scripts", helperScript), destination);
    if (process.platform !== "win32") {
      await chmod(destination, 0o755);
    }
  }
}

build().catch((error) => {
  console.error(`[CodexSplit build] ${error?.message || error}`);
  process.exitCode = 1;
});
