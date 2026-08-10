import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "package.json"),
    path.join(moduleDir, "..", "package.json"),
    path.join(process.cwd(), "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (typeof packageJson?.version === "string" && packageJson.version.trim()) return packageJson.version.trim();
    } catch {}
  }
  return "unknown";
}

export const APP_VERSION = String(process.env.OPENCODEX_VERSION || "").trim() || readPackageVersion();
