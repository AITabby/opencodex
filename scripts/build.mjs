#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const distRoot = path.join(appRoot, "dist");
const typescriptCompiler = path.join(
  appRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc"
);
const compiledEntry = path.join(distRoot, "server.js");
const gatewayEntry = path.join(distRoot, "gateway-entry.js");

if (!existsSync(typescriptCompiler)) {
  console.error("TypeScript is not installed. Run npm install first.");
  process.exit(1);
}

console.log("Cleaning dist...");
rmSync(distRoot, { recursive: true, force: true });

console.log("Compiling OpenCodex gateway...");
const compileResult = spawnSync(process.execPath, [typescriptCompiler], {
  cwd: appRoot,
  env: process.env,
  stdio: "inherit"
});

if (compileResult.error) {
  console.error(`Unable to start TypeScript: ${compileResult.error.message}`);
  process.exit(1);
}

if (compileResult.status !== 0) {
  process.exit(compileResult.status ?? 1);
}

if (!existsSync(compiledEntry)) {
  console.error(`TypeScript completed without the gateway entry: ${compiledEntry}`);
  process.exit(1);
}

renameSync(compiledEntry, gatewayEntry);
writeFileSync(compiledEntry, 'import "./gateway-entry.js";\n', "utf8");

console.log(`Gateway build complete: ${distRoot}`);
