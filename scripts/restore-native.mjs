import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const codexDir = path.join(home, ".codex");
const openCodexDir = path.join(home, ".opencodex");
const tomlPath = path.join(codexDir, "config.toml");
const nativeMarker = path.join(openCodexDir, "native_mode");

fs.mkdirSync(openCodexDir, { recursive: true });
fs.writeFileSync(nativeMarker, "native\n", { mode: 0o600 });

const currentToml = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "";
const hasGatewayConfig = /opencodex managed|model_catalog_json\s*=|openai_base_url\s*=\s*["']http:\/\/127\.0\.0\.1:8765\/v1/i.test(currentToml);

if (hasGatewayConfig) {
  const backup = fs.readdirSync(codexDir)
    .filter(name => name.startsWith("config.toml.bak_"))
    .map(name => ({ name, time: Number.parseInt(name.split("_")[1], 10) || 0 }))
    .sort((a, b) => a.time - b.time)[0];

  if (backup) {
    fs.copyFileSync(path.join(codexDir, backup.name), tomlPath);
  } else {
    const restored = currentToml
      .replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "")
      .replace(/^\s*model_catalog_json\s*=.*\r?\n?/gim, "")
      .replace(/^\s*openai_base_url\s*=\s*["']http:\/\/127\.0\.0\.1:8765\/v1["']\s*\r?\n?/gim, "")
      .trim();
    fs.writeFileSync(tomlPath, restored + "\n");
  }
}

const catalogPath = path.join(openCodexDir, "custom_model_catalog.json");
if (fs.existsSync(catalogPath)) fs.writeFileSync(catalogPath, JSON.stringify({ models: [] }, null, 2));

const cachePath = path.join(codexDir, "models_cache.json");
if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { force: true });

console.log("[OpenCodex] Native mode enabled. Config and model catalog restored; gateway will stay disabled.");
