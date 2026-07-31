#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(`Unable to start ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.platform === "darwin") {
  run("/bin/zsh", [path.join(scriptDir, "build-all.sh")]);
} else {
  console.log(`Building OpenCodex for ${process.platform}...`);
  run(process.execPath, [path.join(scriptDir, "build.mjs")]);
  console.log("");
  console.log("Skipping OpenCodexBar: the embedded voice companion is macOS-only.");
  console.log(`Build complete: ${path.join(appRoot, "dist")}`);
  console.log("Start the web gateway with: npm start");
}
