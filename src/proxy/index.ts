/**
 * OpenCodex Proxy Server
 * Connects standard Codex requests to selected API providers (DeepSeek, SiliconFlow, OpenAI, Custom).
 * Hosts the local glassmorphic dashboard at http://localhost:8765/dashboard.
 * Broadcasts real-time terminal logs to dashboard sessions using SSE.
 */

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn, spawnSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";

import {
  responsesToChat,
  chatCompletionToResponse,
  extractNamespaceMap,
  ResponsesStreamState,
  processVisionBridge
} from "./translator.js";

import { getDashboardHtml } from "./dashboard.js";
import { getVisualizerHtml } from "./visualizer.js";

interface ProviderConfig {
  name: string;
  base_url: string;
  api_key: string;
  vision_model?: string;
}

interface ProxyConfig {
  providers: ProviderConfig[];
}

// In-Memory Live Logs Buffer & SSE broadcaster
const activeSseClients = new Set<(payload: any) => void>();
const logBuffer: any[] = [];
const MAX_LOG_BUFFER = 200;

export function addLog(tag: string, text: string, level: string = "info") {
  const timeStr = new Date().toLocaleTimeString();
  const payload = { time: timeStr, tag, text, level };
  logBuffer.push(payload);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.shift();
  }
  for (const send of activeSseClients) {
    try {
      send(payload);
    } catch {
      // ignore
    }
  }
}

// Intercept all system logs so they stream seamlessly to the Web Dashboard!
const originalLog = console.log;
const originalError = console.error;

console.log = (...args: any[]) => {
  originalLog(...args);
  const txt = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  addLog("INFO", txt, "info");
};

console.error = (...args: any[]) => {
  originalError(...args);
  const txt = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  addLog("PROXY", txt, "warn");
};

export class ProxyServer {
  private server: http.Server | null = null;
  public config!: ProxyConfig;
  private configDir = join(homedir(), ".opencodex");
  private initializedSessions = new Set<string>();

  constructor() {
    this.ensureConfigDir();
    this.ensureCheckPermsHelper();
    this.loadConfig();
    this.autoPatchCodexConfig();
    this.autoPatchPlugins();
    this.ensurePythonScripts();
  }

  private ensureConfigDir() {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  private ensureCheckPermsHelper() {
    const helperPath = join(this.configDir, "check_perms");
    if (!existsSync(helperPath)) {
      console.log("[OpenCodex] Building permission checker helper...");
      const swiftCode = `import Foundation
import ApplicationServices
import CoreGraphics

print(AXIsProcessTrusted())
if #available(macOS 10.15, *) {
    print(CGPreflightScreenCaptureAccess())
} else {
    print(true)
}
`;
      const tempSwiftFile = join(this.configDir, "temp_check_perms.swift");
      try {
        writeFileSync(tempSwiftFile, swiftCode, "utf-8");
        const compileRes = spawnSync("swiftc", [tempSwiftFile, "-o", helperPath], { encoding: "utf-8" });
        if (compileRes.status !== 0) {
          console.error(`[OpenCodex] Failed to compile check_perms helper: ${compileRes.stderr}`);
        } else {
          console.log("[OpenCodex] Successfully compiled check_perms helper.");
        }
      } catch (err: any) {
        console.error(`[OpenCodex] Error creating check_perms helper: ${err.message}`);
      } finally {
        if (existsSync(tempSwiftFile)) {
          try { unlinkSync(tempSwiftFile); } catch {}
        }
      }
    }
  }

  private ensurePythonScripts() {
    const minimaxScript = `import sys
import os
import json
import urllib.request
import binascii

def main():
    if len(sys.argv) < 3:
        print("ERROR: Missing text or output path")
        sys.exit(1)
        
    text = sys.argv[1]
    output_path = sys.argv[2]
    voice_id = sys.argv[3] if len(sys.argv) > 3 else "presenter_male"
    
    api_key = os.environ.get("MINIMAX_API_KEY")
    api_host = os.environ.get("MINIMAX_API_HOST", "https://api.minimaxi.com")
    
    if not api_key:
        print("ERROR: Missing MINIMAX_API_KEY environment variable")
        sys.exit(1)
        
    url = f"{api_host}/v1/t2a_v2"
    
    payload = {
        "model": "speech-01-turbo",
        "text": text,
        "stream": False,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": 1.0,
            "vol": 1.0,
            "pitch": 0
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3"
        },
        "output_format": "hex"
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        req = urllib.request.Request(
            url, 
            data=json.dumps(payload).encode("utf-8"), 
            headers=headers, 
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            res_data = response.read().decode("utf-8")
            res_json = json.loads(res_data)
            
            if "base_resp" in res_json and res_json["base_resp"].get("status_code") != 0:
                msg = res_json["base_resp"].get("status_msg", "Unknown error")
                print(f"ERROR: MiniMax API Error: {msg}")
                sys.exit(1)
                
            audio_hex = res_json.get("data")
            if not audio_hex:
                print("ERROR: No audio data returned from MiniMax")
                sys.exit(1)
                
            audio_bytes = binascii.unhexlify(audio_hex)
            
            with open(output_path, "wb") as f:
                f.write(audio_bytes)
                
            print("SUCCESS")
    except Exception as e:
        print(f"ERROR: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()`;

    const transcribeScript = `import sys
import os
import warnings

# Suppress warnings (like the FP16 CPU warning) to keep stdout clean
warnings.filterwarnings("ignore")

try:
    import whisper
    
    if len(sys.argv) < 2:
        print("ERROR: Missing audio file path")
        sys.exit(1)
        
    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"ERROR: File not found: {audio_path}")
        sys.exit(1)
        
    # Load model (cached locally in ~/.cache/whisper)
    model = whisper.load_model("base")
    
    # Transcribe (fp16=False avoids CPU warning)
    result = model.transcribe(audio_path, fp16=False)
    
    # Output the transcribed text
    print(result.get("text", "").strip())
except Exception as e:
    print(f"ERROR: {str(e)}")
    sys.exit(1)`;

    try {
      writeFileSync("/tmp/ocb_minimax_tts.py", minimaxScript, "utf-8");
      writeFileSync("/tmp/ocb_transcribe.py", transcribeScript, "utf-8");
      console.error("[OpenCodex] Written helper python scripts to /tmp successfully.");
    } catch (err: any) {
      console.error("[OpenCodex] Failed to write helper python scripts: " + err.message);
    }
  }


  private loadConfig() {
    const p = join(this.configDir, "providers.json");
    if (existsSync(p)) {
      try {
        this.config = JSON.parse(readFileSync(p, "utf-8"));
        console.error(`[OpenCodex] Loaded providers configuration: ${p}`);

        // Clean up unused blank providers on startup
        const catalog = this.getModelCatalog();
        const activeProviders = new Set<string>();
        activeProviders.add("opencode");
        if (catalog && Array.isArray(catalog.models)) {
          for (const m of catalog.models) {
            if (m.provider) {
              activeProviders.add(m.provider);
            }
          }
        }
        if (this.config.providers && Array.isArray(this.config.providers)) {
          const originalCount = this.config.providers.length;
          this.config.providers = this.config.providers.filter((prov: any) => {
            if (prov.name === "opencode" || prov.name === "") return true;
            const hasCredentials = (prov.base_url && prov.base_url.trim() !== "") || (prov.api_key && prov.api_key.trim() !== "");
            return hasCredentials || activeProviders.has(prov.name);
          });
          if (this.config.providers.length < originalCount) {
            console.error(`[OpenCodex] Startup cleanup: removed ${originalCount - this.config.providers.length} unused blank provider(s).`);
            this.saveConfig();
          }
        }
        return;
      } catch (err: any) {
        console.error(`[OpenCodex] Error reading providers.json: ${err.message}`);
      }
    }

    this.config = {
      providers: [
        { name: "", base_url: "", api_key: "" },
        { name: "opencode", base_url: "https://opencode.ai/zen/go/v1", api_key: "" }
      ]
    };
    console.error(`[OpenCodex] Config file not found. Created default config.`);
    this.saveConfig();
  }

  private saveConfig() {
    const p = join(this.configDir, "providers.json");
    try {
      writeFileSync(p, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to save config: ${err.message}`);
    }
  }

  private getModelCatalog(): any {
    const p = join(this.configDir, "custom_model_catalog.json");
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch (err: any) {
        console.error(`[OpenCodex] Failed to read model catalog: ${err.message}`);
      }
    }
    return { models: [] };
  }

  private saveModelCatalog(catalog: any) {
    const p = join(this.configDir, "custom_model_catalog.json");
    try {
      const jsonStr = JSON.stringify(catalog, null, 2);
      writeFileSync(p, jsonStr, "utf-8");
      console.error(`[OpenCodex] Saved custom model catalog to ${p}`);
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to save custom model catalog: ${err.message}`);
    }
  }

  private buildCatalogFromModelNames(names: string[], existingModels: any[] = []): any {
    const providers = new Map<string, ProviderConfig>();
    for (const p of this.config.providers) providers.set(p.name, p);

    const models: any[] = [];
    for (const entry of names) {
      let provider = "";
      let modelName = entry;
      if (entry.includes(":")) {
        const parts = entry.split(":");
        provider = parts[0].trim();
        modelName = parts.slice(1).join(":").trim();
      }
      if (provider && !providers.has(provider)) {
        this.config.providers.push({ name: provider, base_url: "", api_key: "" });
        providers.set(provider, { name: provider, base_url: "", api_key: "" });
        this.saveConfig();
      }
      const existing = existingModels.find((m: any) => m.slug === modelName || m.model === modelName);
      if (existing) {
        models.push({
          ...existing,
          provider
        });
      } else {
        models.push({
          slug: modelName,
          model: modelName,
          display_name: modelName,
          provider,
          description: `Custom model: ${modelName}${provider ? ` (${provider})` : ""}`,
          context_window: 200000,
          max_context_window: 1000000,
          auto_compact_token_limit: 160000,
          truncation_policy: { mode: "tokens", limit: 48000 },
          default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
          default_reasoning_summary: "none",
          reasoning_summary_format: "none",
          supports_reasoning_summaries: false,
          default_verbosity: "low",
          support_verbosity: false,
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text_and_image",
          supports_search_tool: false,
          supports_parallel_tool_calls: true,
          experimental_supported_tools: ["computer_use", "mcp"],
          input_modalities: ["text", "image"],
          supports_image_detail_original: true,
          shell_type: "shell_command",
          visibility: "list",
          minimal_client_version: "0.0.1",
          supported_in_api: true,
          availability_nux: null,
          upgrade: null,
          priority: 100,
          prefer_websockets: false,
          available_in_plans: ["free", "plus", "pro", "team", "business", "enterprise"],
          base_instructions: "You are a coding agent running in Codex through a local BYOK shim.",
          model_messages: {
            instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
            instructions_variables: { model_name: modelName }
          },
          supports_computer_use: true,
          supports_mcp: true,
          vision_bridge_enabled: false
        });
      }
    }
    return { models };
  }


  private findProvider(model: string, catalogEntry?: any): ProviderConfig | null {
    if (catalogEntry?.provider) {
      return this.config.providers.find(p => p.name === catalogEntry.provider) || null;
    }
    if (model.startsWith("mimo")) {
      return this.config.providers.find(p => p.name === "opencode") || null;
    }
    return this.config.providers[0] || null;
  }

  private resolveKey(raw: string): string {
    if (raw.startsWith("$")) {
      return process.env[raw.slice(1)] || "";
    }
    return raw;
  }

  private autoPatchCodexConfig() {
    const tomlPath = join(homedir(), ".codex", "config.toml");

    const catalogPath = join(this.configDir, "custom_model_catalog.json");
    if (!existsSync(catalogPath)) {
      const emptyCatalog = { models: [] };
      writeFileSync(catalogPath, JSON.stringify(emptyCatalog, null, 2), "utf-8");
      console.log(`[OpenCodex] Created empty model catalog at ${catalogPath}`);
    }

    if (!existsSync(tomlPath)) {
      console.error(`[OpenCodex] Codex config.toml not found at ${tomlPath}. Skipped auto-patching.`);
      return;
    }

    try {
      const tomlContent = readFileSync(tomlPath, "utf-8");

      if (tomlContent.includes("# >>> opencodex managed >>>")) {
        return;
      }

      console.log(`[OpenCodex] Detecting unpatched config.toml. Performing surgical auto-patch...`);

      const tomlBackupPath = tomlPath + ".bak_" + Date.now();
      writeFileSync(tomlBackupPath, tomlContent, "utf-8");
      console.log(`[OpenCodex] Created backup of config.toml at ${tomlBackupPath}`);

      let patchedToml = stripManagedBlocks(tomlContent);

      const managedTop = `# >>> opencodex managed >>>
model = "deepseek-v4-flash"
model_provider = "opencodex"
model_catalog_json = "${catalogPath}"
# <<< opencodex managed <<<
`;

      const managedProvider = `# >>> opencodex managed >>>
[model_providers.opencodex]
name = "OpenCodex"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 600000
# <<< opencodex managed <<<
`;

      patchedToml = managedTop + "\n" + patchedToml + "\n\n" + managedProvider;
      writeFileSync(tomlPath, patchedToml, "utf-8");
      console.log(`[OpenCodex] Successfully patched config.toml to route via OpenCodex!`);

      this.restartCodexDesktop();
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to auto-patch config.toml: ${err.message}`);
    }
  }

  public patchCodexConfig() {
    const tomlPath = join(homedir(), ".codex", "config.toml");
    const catalogPath = join(this.configDir, "custom_model_catalog.json");
    if (!existsSync(tomlPath)) return;
    try {
      const content = readFileSync(tomlPath, "utf-8");
      let patched = stripManagedBlocks(content);
      const managedTop = `# >>> opencodex managed >>>
model = "deepseek-v4-flash"
model_provider = "opencodex"
model_catalog_json = "${catalogPath}"
# <<< opencodex managed <<<
`;
      const managedProvider = `# >>> opencodex managed >>>
[model_providers.opencodex]
name = "OpenCodex"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 600000
# <<< opencodex managed <<<
`;
      patched = managedTop + "\n" + patched + "\n\n" + managedProvider;
      writeFileSync(tomlPath, patched, "utf-8");
      console.log(`[OpenCodex] Patched config.toml with opencodex provider.`);
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to patch config.toml: ${err.message}`);
    }
  }

  private autoPatchPlugins() {
    const tomlPath = join(homedir(), ".codex", "config.toml");
    if (!existsSync(tomlPath)) return;
    try {
      let content = readFileSync(tomlPath, "utf-8");
      if (!content.includes('computer-use@openai-bundled')) {
        console.log("[OpenCodex] Enabling computer-use@openai-bundled plugin...");
        let lines = content.split(/\r?\n/);
        let idx = lines.findIndex(l => l.includes("[plugins.") || l.includes("[features]"));
        if (idx !== -1) {
          lines.splice(idx, 0, '[plugins."computer-use@openai-bundled"]', "enabled = true", "");
          writeFileSync(tomlPath, lines.join("\n"), "utf-8");
          console.log("[OpenCodex] Successfully enabled computer-use@openai-bundled in config.toml.");
        } else {
          writeFileSync(tomlPath, content + '\n\n[plugins."computer-use@openai-bundled"]\nenabled = true\n', "utf-8");
          console.log("[OpenCodex] Successfully appended computer-use@openai-bundled in config.toml.");
        }
      }

      const cacheDir = join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "computer-use");
      if (!existsSync(cacheDir)) {
        console.log("[OpenCodex] computer-use plugin assets not found. Installing via codex plugin add...");
        const codexPath = join(homedir(), ".local", "bin", "codex");
        const execPath = existsSync(codexPath) ? codexPath : "codex";

        exec(`"${execPath}" plugin add computer-use@openai-bundled`, {
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/Library/Python/3.9/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`
          }
        }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[OpenCodex] Failed to install computer-use plugin: ${err.message}`);
          } else {
            console.log(`[OpenCodex] Successfully installed computer-use plugin: ${stdout.trim()}`);
          }
        });
      }
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to patch plugins: ${err.message}`);
    }
  }

  public restartCodexDesktop() {
    console.log("[OpenCodex] Executing background cold-restart of Codex Desktop...");
    const cmd = 'killall Codex "Codex Helper" "Codex Helper (Renderer)" "Codex Helper (GPU)" SkyComputerUseClient SkyComputerUseService bare-modifier-monitor 2>/dev/null; kill -9 $(ps aux | grep -i "codex app-server" | grep -v "grep" | awk \'{print $2}\') 2>/dev/null; sleep 1.5; open -a Codex';
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`[OpenCodex] Codex restart completed with errors or status: ${err.message}`);
      } else {
        console.log("[OpenCodex] Codex Desktop successfully restarted in the background.");
      }
    });
  }

  public restartVoiceBar(method: "swift-run" | "app" = "swift-run") {
    console.log(`[OpenCodex] Restarting Voice Bar using method: ${method}`);
    
    // Resolve opencodex-bar directory path dynamically and portably
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(moduleDir, "..", "..", "..", "opencodex-bar"), // relative to compiled dist/proxy/index.js
      join(moduleDir, "..", "..", "opencodex-bar"),      // relative to src/proxy/index.ts
      join(process.cwd(), "..", "opencodex-bar"),
      join(process.cwd(), "opencodex-bar"),
      join(homedir(), "projects", "opencodex-bar"),
      join(homedir(), "opencodex-bar")
    ];

    let barDir = "";
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        barDir = candidate;
        break;
      }
    }
    if (!barDir) {
      barDir = join(process.cwd(), "..", "opencodex-bar"); // default fallback
    }
    console.log(`[OpenCodex] Resolved Voice Bar directory: ${barDir}`);

    // Thaw native apps in case OpenCodexBar was killed/resigned in a frozen state
    const nativeApps = [
      "抖音.app", "TikTok.app", 
      "NeteaseMusic.app", "QQMusic.app", 
      "TencentVideo.app", "腾讯视频.app", 
      "Youku.app", "优酷.app", 
      "iQIYI.app", "爱奇艺.app"
    ];
    const thawCmd = nativeApps.map(app => `pkill -CONT -f "${app}"`).join(" ; ");
    const killCmd = `${thawCmd} ; killall OpenCodexBar 2>/dev/null || true`;
    exec(killCmd, (err) => {
      setTimeout(() => {
        let startCmd = `open ${join(barDir, "OpenCodexBar.app")}`;
        if (method === "swift-run") {
          let binPath = join(barDir, ".build/arm64-apple-macosx/release/OpenCodexBar");
          if (!existsSync(binPath)) {
            const debugPath = join(barDir, ".build/arm64-apple-macosx/debug/OpenCodexBar");
            if (existsSync(debugPath)) {
              binPath = debugPath;
            } else {
              binPath = "swift run";
            }
          }
          const escapedBinPath = binPath.replace(/"/g, '\\"');
          startCmd = `osascript -e 'tell application "Terminal" to do script "\\"${escapedBinPath}\\" & disown && exit"'`;
        }
        exec(startCmd, (startErr) => {
          if (startErr) {
            console.error(`[OpenCodex] Failed to start Voice Bar via ${method}: ${startErr.message}`);
          } else {
            console.log(`[OpenCodex] Voice Bar start command initiated successfully via ${method}.`);
          }
        });
      }, 500);
    });
  }

  start(port: number) {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const buffer = Buffer.concat(chunks);
        this.handle(req, res, buffer);
      });
    });

    const wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws) => {
      this.handleWebSocketConnection(ws);
    });

    this.server.listen(port, "0.0.0.0");
    console.error(`[OpenCodex] Unified HTTP server listening on port ${port}`);
    console.error(`[OpenCodex] Web Dashboard UI → http://localhost:${port}/dashboard`);
  }

  stop() {
    this.server?.close();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, session_id");
    
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const body = rawBody.toString("utf-8");

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // ─── Web Dashboard Routes ───
    if (path === "/dashboard" || path === "/dashboard/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getDashboardHtml());
      return;
    }

    if (path === "/visualizer" || path === "/visualizer/") {
      const parsedUrl = new URL(req.url || "", "http://localhost");
      const isHud = parsedUrl.searchParams.get("mode") === "hud";
      
      const p = join(this.configDir, "voice_settings.json");
      let hudTheme = "vortex";
      if (existsSync(p)) {
        try {
          const settings = JSON.parse(readFileSync(p, "utf-8"));
          hudTheme = settings.hud_theme || "vortex";
          if (hudTheme !== "vortex" && hudTheme !== "siri") {
            hudTheme = "vortex";
          }
        } catch {}
      }

      res.writeHead(200, { 
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });
      res.end(getVisualizerHtml(isHud, hudTheme));
      return;
    }

    if (path === "/api/logs/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.flushHeaders();
      
      // Send initial backlog
      for (const line of logBuffer) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }

      const sender = (payload: any) => {
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
      };

      activeSseClients.add(sender);

      const keepalive = setInterval(() => {
        try { res.write(`:keepalive\n\n`); } catch { clearInterval(keepalive); }
      }, 15000);

      req.on("close", () => {
        activeSseClients.delete(sender);
        clearInterval(keepalive);
      });
      return;
    }

    if (path === "/api/config" && req.method === "POST") {
      try {
        const data = JSON.parse(body);

        if (data.providers && Array.isArray(data.providers)) {
          const updatedProviders = data.providers.map((newP: any) => {
            if (newP.api_key && (newP.api_key.includes("...") || newP.api_key.endsWith("..."))) {
              const oldP = this.config.providers.find((p: any) => p.name === newP.name);
              if (oldP && oldP.api_key) {
                return { ...newP, api_key: oldP.api_key };
              }
            }
            return newP;
          });
          this.config.providers = updatedProviders;
        } else {
          this.config.providers = [
            { name: data.primary.name, base_url: data.primary.base_url, api_key: data.primary.api_key },
            { name: "opencode", base_url: data.opencode.base_url || "https://opencode.ai/zen/go/v1", api_key: data.opencode.api_key || "", vision_model: data.opencode.model || "mimo-v2.5" }
          ];
        }

        if (data.models && Array.isArray(data.models)) {
          const existing = this.getModelCatalog();
          const catalog = this.buildCatalogFromModelNames(data.models, existing.models || []);
          this.saveModelCatalog(catalog);
          console.log(`[OpenCodex] Saved models from input: ${data.models.length} total.`);
        }

        // Clean up unused blank providers
        const catalog = this.getModelCatalog();
        const activeProviders = new Set<string>();
        activeProviders.add("opencode");
        if (catalog && Array.isArray(catalog.models)) {
          for (const m of catalog.models) {
            if (m.provider) {
              activeProviders.add(m.provider);
            }
          }
        }
        if (this.config.providers && Array.isArray(this.config.providers)) {
          this.config.providers = this.config.providers.filter((prov: any) => {
            if (prov.name === "opencode" || prov.name === "") return true;
            const hasCredentials = (prov.base_url && prov.base_url.trim() !== "") || (prov.api_key && prov.api_key.trim() !== "");
            return hasCredentials || activeProviders.has(prov.name);
          });
        }
        this.saveConfig();

        this.patchCodexConfig();
        this.autoPatchPlugins();
        if (data.restart) {
          this.restartCodexDesktop();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", restarted: !!data.restart }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/models" && req.method === "GET") {
      // Returns complete model catalog & enabled models
      const catalog = this.getModelCatalog();
      const active = catalog.models?.filter((m: any) => m.visibility === "list").map((m: any) => m.slug) || [];
      
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(JSON.stringify({
        catalog: catalog.models?.map((m: any) => ({
          id: m.slug,
          model: m.model,
          provider: m.provider || "",
          display_name: m.display_name,
          no_image_support: m.input_modalities ? !m.input_modalities.includes("image") : true,
          vision_bridge_enabled: !!m.vision_bridge_enabled
        })) || [],
        active
      }));
      return;
    }

    if (path === "/api/models" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        console.log("[OpenCodex] Received POST /api/models data:", data);
        const activeIds = data.active || [];
        const visionBridgeIds = data.vision_bridge || [];
        const catalog = this.getModelCatalog();
        
        if (catalog.models) {
          catalog.models.forEach((m: any) => {
            m.visibility = activeIds.includes(m.slug) ? "list" : "hide";
            m.vision_bridge_enabled = visionBridgeIds.includes(m.slug);
          });
          this.saveModelCatalog(catalog);
        }
        
        if (data.restart) {
          this.restartCodexDesktop();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", restarted: !!data.restart }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/models/delete" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const slug = data.id;
        const catalog = this.getModelCatalog();
        if (catalog.models) {
          catalog.models = catalog.models.filter((m: any) => m.slug !== slug && m.model !== slug);
          this.saveModelCatalog(catalog);
          console.log(`[OpenCodex] Deleted model: ${slug}`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/logs/poll" && req.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0");
      const entries = logBuffer.slice(since > 0 ? Math.max(0, logBuffer.length - (logBuffer.length - since)) : 0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries, total: logBuffer.length }));
      return;
    }

    if (path === "/api/sessions" && req.method === "GET") {
      try {
        const sessionsMap = new Map<string, { id: string, text: string, ts: number }>();
        
        // 1. Scan history.jsonl
        const historyPath = join(homedir(), ".codex", "history.jsonl");
        if (existsSync(historyPath)) {
          const lines = readFileSync(historyPath, "utf-8").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.session_id) {
                sessionsMap.set(item.session_id, {
                  id: item.session_id,
                  text: item.text,
                  ts: item.ts * 1000
                });
              }
            } catch {}
          }
        }

        // Load voice settings to get the system prompt
        const p = join(this.configDir, "voice_settings.json");
        let voiceSystemPrompt = "";
        if (existsSync(p)) {
          try {
            const settings = JSON.parse(readFileSync(p, "utf-8"));
            voiceSystemPrompt = settings.voice_system_prompt || "";
          } catch {}
        }
        const prefixUtf = voiceSystemPrompt + "\n\n用户说：";
        const prefixUtfClean = voiceSystemPrompt + "\n\n\u7528\u623f\u8bf4\uff1a"; // clean alternative

        // 2. Scan rollout files for complete context and timestamps
        const sessionsDir = join(homedir(), ".codex", "sessions");
        if (existsSync(sessionsDir)) {
          const files = findRolloutFiles(sessionsDir);
          for (const file of files) {
            try {
              const content = readFileSync(file, "utf-8");
              const lines = content.split("\n");
              let session_id = "";
              let ts = 0;
              let firstUserMsg = "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const item = JSON.parse(trimmed);
                if (item.type === "session_meta") {
                  if (item.payload?.id) {
                    session_id = item.payload.id;
                  }
                  if (item.payload?.timestamp) {
                    const rawTs = item.payload.timestamp;
                    if (typeof rawTs === "number") {
                      ts = rawTs < 9999999999 ? rawTs * 1000 : rawTs;
                    } else if (typeof rawTs === "string") {
                      ts = Date.parse(rawTs) || 0;
                    }
                  }
                } else if (item.type === "event_msg" && item.payload?.type === "user_message") {
                  if (!firstUserMsg && item.payload.message) {
                    let uMsg = item.payload.message;
                    if (voiceSystemPrompt) {
                      if (uMsg.startsWith(prefixUtf)) {
                        uMsg = uMsg.slice(prefixUtf.length);
                      } else if (uMsg.startsWith(prefixUtfClean)) {
                        uMsg = uMsg.slice(prefixUtfClean.length);
                      }
                    }
                    firstUserMsg = uMsg;
                  }
                }
              }
              if (session_id) {
                const existing = sessionsMap.get(session_id);
                sessionsMap.set(session_id, {
                  id: session_id,
                  text: firstUserMsg || (existing ? existing.text : `会话 ${session_id}`),
                  ts: ts || (existing ? existing.ts : Date.now())
                });
              }
            } catch {}
          }
        }

        const archivedPath = join(this.configDir, "archived_sessions.json");
        let archivedIds = new Set<string>();
        if (existsSync(archivedPath)) {
          try {
            archivedIds = new Set(JSON.parse(readFileSync(archivedPath, "utf-8")));
          } catch {}
        }

        const sessions = Array.from(sessionsMap.values()).map(s => ({
          ...s,
          archived: archivedIds.has(s.id)
        })).sort((a, b) => b.ts - a.ts);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sessions));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/detail" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        
        // Load voice settings to get the system prompt
        const p = join(this.configDir, "voice_settings.json");
        let voiceSystemPrompt = "";
        if (existsSync(p)) {
          try {
            const settings = JSON.parse(readFileSync(p, "utf-8"));
            voiceSystemPrompt = settings.voice_system_prompt || "";
          } catch {}
        }
        const prefixUtf = voiceSystemPrompt + "\n\n用户说：";
        const prefixUtfClean = voiceSystemPrompt + "\n\n\u7528\u623f\u8bf4\uff1a"; // clean alternative

        const sessionsDir = join(homedir(), ".codex", "sessions");
        const rolloutFile = findRolloutFileById(sessionsDir, sid);
        
        const messages: any[] = [];
        if (rolloutFile && existsSync(rolloutFile)) {
          const lines = readFileSync(rolloutFile, "utf-8").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.type === "event_msg") {
                const pType = item.payload?.type;
                if (pType === "user_message") {
                  let uMsg = item.payload.message || "";
                  if (voiceSystemPrompt) {
                    if (uMsg.startsWith(prefixUtf)) {
                      uMsg = uMsg.slice(prefixUtf.length);
                    } else if (uMsg.startsWith(prefixUtfClean)) {
                      uMsg = uMsg.slice(prefixUtfClean.length);
                    }
                  }
                  messages.push({
                    role: "user",
                    text: uMsg
                  });
                } else if (pType === "agent_message") {
                  messages.push({
                    role: "assistant",
                    text: item.payload.message
                  });
                }
              }
            } catch {}
          }
        } else {
          // Fallback to history.jsonl
          const historyPath = join(homedir(), ".codex", "history.jsonl");
          if (existsSync(historyPath)) {
            const lines = readFileSync(historyPath, "utf-8").split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const item = JSON.parse(trimmed);
                if (item.session_id === sid) {
                  messages.push({
                    role: "user",
                    text: item.text
                  });
                }
              } catch {}
            }
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/enter" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {};
        if (existsSync(p)) {
          try { settings = JSON.parse(readFileSync(p, "utf-8")); } catch {}
        }
        settings.active_session_id = sid;
        writeFileSync(p, JSON.stringify(settings, null, 2), "utf-8");

        this.broadcastSession(sid);

        console.error(`[Sessions] Switched active session to: ${sid}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", session_id: sid }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/clear-all" && req.method === "POST") {
      try {
        const historyPath = join(homedir(), ".codex", "history.jsonl");
        if (existsSync(historyPath)) {
          writeFileSync(historyPath, "", "utf-8");
        }
        const sessionsDir = join(homedir(), ".codex", "sessions");
        deleteSessionFiles(sessionsDir);

        console.error(`[Sessions] Cleared all sessions.`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/delete" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        
        // 1. Delete from history.jsonl
        const historyPath = join(homedir(), ".codex", "history.jsonl");
        if (existsSync(historyPath)) {
          const lines = readFileSync(historyPath, "utf-8").split("\n");
          const remainingLines: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.session_id !== sid) {
                remainingLines.push(line);
              }
            } catch {
              remainingLines.push(line);
            }
          }
          writeFileSync(historyPath, remainingLines.join("\n") + "\n", "utf-8");
        }

        // 2. Delete rollout file
        const sessionsDir = join(homedir(), ".codex", "sessions");
        const rolloutFile = findRolloutFileById(sessionsDir, sid);
        if (rolloutFile && existsSync(rolloutFile)) {
          try {
            unlinkSync(rolloutFile);
          } catch {}
        }

        console.error(`[Sessions] Deleted session: ${sid}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/archive" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        const archived = !!data.archived;
        const archivedPath = join(this.configDir, "archived_sessions.json");
        let archivedIds: string[] = [];
        if (existsSync(archivedPath)) {
          try {
            archivedIds = JSON.parse(readFileSync(archivedPath, "utf-8"));
          } catch {}
        }
        if (archived) {
          if (!archivedIds.includes(sid)) {
            archivedIds.push(sid);
          }
        } else {
          archivedIds = archivedIds.filter(id => id !== sid);
        }
        writeFileSync(archivedPath, JSON.stringify(archivedIds, null, 2), "utf-8");
        console.error(`[Sessions] Session ${sid} archive status set to ${archived}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/test-log" && req.method === "POST") {
      console.log("[OpenCodex] Test log from dashboard at " + new Date().toLocaleTimeString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (path === "/api/permissions" && req.method === "GET") {
      try {
        const helperPath = join(this.configDir, "check_perms");
        if (!existsSync(helperPath)) {
          this.ensureCheckPermsHelper();
        }
        const result = spawnSync(helperPath, [], { encoding: "utf-8" });
        if (result.status === 0) {
          const lines = result.stdout.trim().split("\n");
          const permissions = {
            accessibility: lines[0] === "true",
            screenRecording: lines[1] === "true"
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", permissions }));
        } else {
          throw new Error(result.stderr || "Helper execution failed");
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/permissions/fix" && req.method === "POST") {
      try {
        const appPath1 = join(homedir(), ".codex", "computer-use", "Codex Computer Use.app");
        const appPath2 = join(appPath1, "Contents", "SharedSupport", "SkyComputerUseClient.app");
        
        if (existsSync(appPath1)) {
          // Launch/open the real signed app bundle so that macOS triggers the stable permission prompt
          exec(`open "${appPath1}"`);
        }

        exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
        exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"');

        if (existsSync(appPath1)) {
          exec(`open -R "${appPath1}"`);
        }
        if (existsSync(appPath2)) {
          setTimeout(() => {
            exec(`open -R "${appPath2}"`);
          }, 800);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", message: "Prompts triggered and folders opened." }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/restart-codex" && req.method === "POST") {
      try {
        this.restartCodexDesktop();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/reset" && req.method === "POST") {
      try {
        const tomlPath = join(homedir(), ".codex", "config.toml");
        if (existsSync(tomlPath)) {
          let content = readFileSync(tomlPath, "utf-8");
          content = content.replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "").trim();
          writeFileSync(tomlPath, content + "\n", "utf-8");
        }
        const catalogPath = join(this.configDir, "custom_model_catalog.json");
        if (existsSync(catalogPath)) {
          writeFileSync(catalogPath, JSON.stringify({ models: [] }), "utf-8");
        }
        console.log("[OpenCodex] Reset to native state. Restarting Codex...");
        this.restartCodexDesktop();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/voice-settings" && req.method === "GET") {
      const p = join(this.configDir, "voice_settings.json");
      let settings = {
        stt_engine: "local-whisper",
        stt_api_key: "",
        stt_base_url: "https://api.openai.com/v1",
        stt_model: "whisper-1",
        tts_engine: "edge-tts",
        tts_api_key: "",
        tts_base_url: "https://api.openai.com/v1",
        tts_model: "tts-1",
        tts_voice: "zh-CN-XiaoxiaoNeural",
        tts_appid: "",
        tts_resource: "",
        tts_resource_id: "",
        voice_system_prompt: "",
        vad_threshold: -35.0,
        vad_duration: 2.0,
        voice_llm_model: "",
        hud_theme: "vortex"
      };
      if (existsSync(p)) {
        try {
          settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(settings));
      return;
    }

    if (path === "/api/voice-settings" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const p = join(this.configDir, "voice_settings.json");
        const settings = {
          stt_engine: data.stt_engine || "local-whisper",
          stt_api_key: data.stt_api_key || "",
          stt_base_url: data.stt_base_url || "https://api.openai.com/v1",
          stt_model: data.stt_model || "whisper-1",
          tts_engine: data.tts_engine || "edge-tts",
          tts_api_key: data.tts_api_key || "",
          tts_base_url: data.tts_base_url || "https://api.openai.com/v1",
          tts_model: data.tts_model || "tts-1",
          tts_voice: data.tts_voice || "zh-CN-XiaoxiaoNeural",
          tts_appid: data.tts_appid || "",
          tts_resource: data.tts_resource || "",
          tts_resource_id: data.tts_resource || "", // Alias for compatibility
          voice_system_prompt: data.voice_system_prompt || "",
          vad_threshold: typeof data.vad_threshold === "number" ? data.vad_threshold : -35.0,
          vad_duration: typeof data.vad_duration === "number" ? data.vad_duration : 2.0,
          voice_llm_model: data.voice_llm_model || "",
          enable_wake_word: typeof data.enable_wake_word === "boolean" ? data.enable_wake_word : false,
          hud_theme: ["vortex", "siri"].includes(data.hud_theme) ? data.hud_theme : "vortex"
        };
        writeFileSync(p, JSON.stringify(settings, null, 2), "utf-8");
        console.error("[OpenCodex] Saved voice settings to " + p);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", settings }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/voice/stt" && req.method === "POST") {
      try {
        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {
          stt_engine: "local-whisper",
          stt_api_key: "",
          stt_base_url: "https://api.openai.com/v1",
          stt_model: "whisper-1"
        };
        if (existsSync(p)) {
          try {
            settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
          } catch {}
        }

        const audioPath = "/tmp/stt_web_input.wav";
        writeFileSync(audioPath, rawBody);
        console.error(`[OpenCodex Voice API] Received audio data for STT, size = ${rawBody.length} bytes`);

        const engine = settings.stt_engine || "local-whisper";
        if (engine === "openai-compatible") {
          console.error(`[OpenCodex Voice API] Transcribing via API endpoint: ${settings.stt_base_url}`);
          this.transcribeAudioAPI(audioPath, settings)
            .then((text) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ text }));
            })
            .catch((err) => {
              console.error(`[OpenCodex Voice API STT API Err] ${err.message}`);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message, text: "" }));
            });
        } else {
          // Default to local-whisper
          console.error(`[OpenCodex Voice API] Transcribing locally via local-whisper...`);
          this.transcribeAudioLocal(audioPath, (text) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ text: text || "" }));
          });
        }
      } catch (err: any) {
        console.error(`[OpenCodex Voice API STT Err] ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, text: "" }));
      }
      return;
    }

    if (path === "/api/voice/tts" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const text = data.text;
        if (!text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Text is empty" }));
          return;
        }

        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {
          tts_engine: "edge-tts",
          tts_api_key: "",
          tts_base_url: "https://api.openai.com/v1",
          tts_model: "tts-1",
          tts_voice: "zh-CN-XiaoxiaoNeural"
        };
        if (existsSync(p)) {
          try {
            settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
          } catch {}
        }

        let engine = settings.tts_engine || "";
        if (engine === "" && settings.tts_base_url && settings.tts_base_url.includes("bytedance")) {
          engine = "doubao";
        }
        if (engine === "") {
          engine = "edge-tts";
        }

        console.error(`[OpenCodex Voice API] Synthesizing speech via ${engine} for text: '${text.substring(0, 30)}...'`);

        if (engine === "openai-compatible") {
          this.synthesizeSpeechAPI(text, settings)
            .then((audioBuffer) => {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            })
            .catch((err) => {
              console.error(`[OpenCodex Voice API TTS API Err] ${err.message}`);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            });
        } else if (engine === "doubao") {
          this.synthesizeSpeechDoubao(text, settings)
            .then((audioBuffer) => {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            })
            .catch((err) => {
              console.error(`[OpenCodex Voice API Doubao TTS Err] ${err.message}`);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            });
        } else if (engine === "minimax") {
          this.synthesizeSpeechMiniMax(text, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "MiniMax synthesis failed" }));
            }
          });
        } else if (engine === "kokoro") {
          this.synthesizeSpeechKokoro(text, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/wav" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Kokoro synthesis failed" }));
            }
          });
        } else {
          // Default to edge-tts
          this.synthesizeSpeechEdge(text, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "EdgeTTS synthesis failed" }));
            }
          });
        }
      } catch (err: any) {
        console.error(`[OpenCodex Voice API TTS Err] ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/execute-command" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const command = data.command;
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Command is empty" }));
          return;
        }

        console.error(`[OpenCodex Command Console] Executing: ${command}`);
        const cmdPath = "/Applications/Codex.app/Contents/Resources/codex";
        const child = spawn(cmdPath, ["--dangerously-bypass-approvals-and-sandbox", "exec", "--skip-git-repo-check", "-"]);
        
        let output = "";
        let errorOutput = "";

        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
          errorOutput += chunk.toString();
        });

        child.on("close", (code) => {
          const cleanOutput = output.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "").trim();
          const cleanError = errorOutput.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "").trim();
          
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            code,
            output: cleanOutput,
            error: cleanError
          }));
        });

        child.stdin.write(command + "\n");
        child.stdin.end();

      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/voice-bar/status" && req.method === "GET") {
      exec('pgrep -x OpenCodexBar', (err, stdout) => {
        const running = !err && stdout.trim().length > 0;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ running, pid: running ? stdout.trim() : null }));
      });
      return;
    }

    if (path === "/api/voice-bar/launch" && req.method === "POST") {
      try {
        const data = JSON.parse(body || "{}");
        const method = data.method === "app" ? "app" : "swift-run";
        this.restartVoiceBar(method);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", method }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── Standard Gateway Routes ───

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "1.0.0", opencodex: true }));
      return;
    }

    if (path === "/v1/config") {
      const safe = {
        providers: this.config.providers.map(p => ({
          ...p,
          api_key: p.api_key ? p.api_key.slice(0, 8) + "..." : ""
        }))
      };
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(JSON.stringify(safe, null, 2));
      return;
    }

    if (path === "/v1/models" || path === "/v1/models/") {
      const catalog = this.getModelCatalog();
      const list = catalog.models || [];
      
      // Filter list based on visibility === "list"
      const data = list
        .filter((m: any) => m.visibility === "list")
        .map((m: any) => ({
          id: m.slug,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "opencodex"
        }));

      // Always inject native Computer Use pass-through model id
      data.push({ id: "opencodex/cu", object: "model", owned_by: "local" });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }

    if (path === "/v1/responses" && req.method === "POST") {
      const sidHeader = req.headers["x-session-id"] || req.headers["session-id"] || "";
      const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
      this.handleResponses(body, res, sessionId);
      return;
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      this.handleChat(body, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  }

  // ══════════════════════════════════════════════
  //  Responses API Gateway (Used by Codex UI)
  // ══════════════════════════════════════════════

  private async handleResponses(body: string, res: http.ServerResponse, sessionId?: string) {
    let reqBody: any;
    try {
      reqBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    if (body.includes("image_url") || body.includes("input_image") || body.includes("file_data")) {
      console.error("[OpenCodex-DEBUG] Incoming request contains image/file data. Structure:", JSON.stringify(reqBody, (k, v) => {
        if (typeof v === "string" && v.length > 200) return v.slice(0, 100) + "... (truncated)";
        return v;
      }, 2));
    }

    // Detect get_app_state output to inject delay and allow CUA session initialization (check only the most recent tool outputs at the end of history)
    let hasGetAppStateOutput = false;
    if (reqBody.input && Array.isArray(reqBody.input)) {
      for (let i = reqBody.input.length - 1; i >= 0; i--) {
        const item = reqBody.input[i];
        if (item && item.type === "function_call_output") {
          const outStr = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
          if (outStr.includes("<app_specific_instructions>") || outStr.includes("CUA App Version:")) {
            hasGetAppStateOutput = true;
            break;
          }
        } else {
          // Once we encounter a non-tool-output item, we stop checking as we've processed the latest turn's outputs
          break;
        }
      }
    }
    if (hasGetAppStateOutput && sessionId) {
      if (!this.initializedSessions.has(sessionId)) {
        this.initializedSessions.add(sessionId);
        console.log(`[OpenCodex Proxy] Detected cold-start get_app_state output for session ${sessionId}. Injecting 1500ms delay to allow CUA session to stabilize...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    const requestedModel = reqBody.model || "";
    
    // Resolve which actual model and provider we route to
    const catalog = this.getModelCatalog();
    const catalogEntry = catalog.models?.find((m: any) => m.slug === requestedModel);
    const mappedModelName = (catalogEntry && catalogEntry.model) ? catalogEntry.model : requestedModel;

    const provider = this.findProvider(mappedModelName, catalogEntry);
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown model: ${requestedModel}` }));
      return;
    }

    const apiKey = this.resolveKey(provider.api_key);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `API Key is missing. Configure keys via http://localhost:8765/dashboard` }));
      return;
    }

    // Always compress images; describe with MiMo if vision bridge enabled
    const callVisionBridge = catalogEntry ? !!catalogEntry.vision_bridge_enabled : false;
    const processedReqBody = await processVisionBridge(reqBody, callVisionBridge ? this.config : undefined);

    const upstreamModel = mappedModelName;
    const isStream = processedReqBody.stream ?? false;

    console.log(`[Responses] Routing ${requestedModel} → ${provider.name}/${upstreamModel} (stream=${isStream}, visionBridge=${callVisionBridge})`);

    const chatBody = responsesToChat(processedReqBody, upstreamModel, sessionId);
    const namespaceMap = extractNamespaceMap(processedReqBody.tools);

    try {
      if (isStream) {
        await this.streamResponses(chatBody, provider, requestedModel, apiKey, namespaceMap, res);
      } else {
        await this.nonStreamResponses(chatBody, provider, requestedModel, apiKey, namespaceMap, res);
      }
    } catch (err: any) {
      console.error(`[Responses] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  private async streamResponses(
    body: any,
    provider: ProviderConfig,
    requestedModel: string,
    apiKey: string,
    namespaceMap: Record<string, string>,
    res: http.ServerResponse
  ) {
    const response = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorText }));
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.writeHead(200);

    const streamState = new ResponsesStreamState(requestedModel, namespaceMap);
    await streamState.start(async (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            await streamState.writeChatDelta(async (payload) => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            }, chunk);
          } catch {
            // ignore JSON parsing chunks error
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    await streamState.finish(async (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    res.end();
  }

  private async nonStreamResponses(
    body: any,
    provider: ProviderConfig,
    requestedModel: string,
    apiKey: string,
    namespaceMap: Record<string, string>,
    res: http.ServerResponse
  ) {
    const r = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    const rawText = await r.text();
    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: rawText.slice(0, 250) };
    }

    if (!r.ok) {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    const responseBody = chatCompletionToResponse(data, requestedModel, namespaceMap);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseBody));
  }

  // ══════════════════════════════════════════════
  //  Standard OpenAI Chat completions routing
  // ══════════════════════════════════════════════

  private async handleChat(body: string, res: http.ServerResponse) {
    let reqBody: any;
    try {
      reqBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    const model = reqBody.model || "";
    const catalog = this.getModelCatalog();
    const catalogEntry = catalog.models?.find((m: any) => m.slug === model);
    const provider = this.findProvider(model, catalogEntry);
    
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown model: ${model}` }));
      return;
    }

    const apiKey = this.resolveKey(provider.api_key);
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `API Key missing.` }));
      return;
    }

    const upstreamModel = (catalogEntry && catalogEntry.model) ? catalogEntry.model : model;
    const isStream = reqBody.stream ?? false;
    
    console.log(`[Chat] Routing ${model} → ${provider.name}/${upstreamModel} (stream=${isStream})`);

    const upstreamBody = {
      model: upstreamModel,
      messages: this.translateMessages(reqBody.messages || [], model),
      temperature: reqBody.temperature ?? 0.7,
      max_tokens: reqBody.max_output_tokens ?? 8192,
      stream: isStream
    };

    try {
      if (isStream) {
        await this.streamChat(upstreamBody, provider, model, apiKey, res);
      } else {
        await this.nonStreamChat(upstreamBody, provider, model, apiKey, res);
      }
    } catch (err: any) {
      console.error(`[Chat] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  private translateMessages(messages: any[], model: string): any[] {
    const hasNativeVision = ["mimo-v2.5", "mimo-v2-omni"].includes(model);

    return messages.map((msg: any) => {
      if (msg.role === "tool") {
        return {
          role: "tool",
          tool_call_id: msg.tool_call_id || "",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
        };
      }

      if (msg.role === "assistant" && msg.tool_calls) {
        return {
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function?.name || tc.name || "",
              arguments: tc.function?.arguments
                ? typeof tc.function.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments)
                : "{}"
            }
          }))
        };
      }

      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map((part: any) => {
          if (part.type === "image_url" || part.type === "image") {
            if (hasNativeVision) {
              return { type: "image_url", image_url: { url: part.image_url?.url || part.source?.url || "" } };
            }
            return { type: "text", text: "[Visual Screenshot description omitted by OpenCodex]" };
          }
          return part;
        })
      };
    });
  }

  private async nonStreamChat(body: any, provider: ProviderConfig, model: string, apiKey: string, res: http.ServerResponse) {
    const r = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
    
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private async streamChat(body: any, provider: ProviderConfig, model: string, apiKey: string, res: http.ServerResponse) {
    const r = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errorText = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorText }));
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.writeHead(200);

    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;
          try {
            res.write(`data: ${trimmed.slice(6)}\n\n`);
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.write("data: [DONE]\n\n");
    res.end();
  }

  private transcribeAudioLocal(filePath: string, cb: (text: string | null) => void) {
    const pythonCmd = "python3";
    const args = ["/tmp/ocb_transcribe.py", filePath];
    const uvxPath = join(homedir(), ".local", "bin", "uvx");
    
    const env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/Library/Python/3.9/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`
    };

    const child = existsSync(uvxPath)
      ? spawn(uvxPath, ["--with", "openai-whisper", "python3", "/tmp/ocb_transcribe.py", filePath], { env })
      : spawn(pythonCmd, args, { env });

    let output = "";
    let errorOutput = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const text = output.trim();
        console.error(`[OpenCodex Local Whisper] Transcribed text: '${text}'`);
        cb(text);
      } else {
        console.error(`[OpenCodex Local Whisper Err] Exit code ${code}. Error: ${errorOutput}`);
        cb(null);
      }
    });
  }

  private async transcribeAudioAPI(filePath: string, settings: any): Promise<string> {
    const apiKey = settings.stt_api_key || "";
    const baseUrl = settings.stt_base_url || "https://api.openai.com/v1";
    const model = settings.stt_model || "whisper-1";

    const url = baseUrl.endsWith("/audio/transcriptions")
      ? baseUrl
      : `${baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

    const audioData = readFileSync(filePath);
    const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
    let payload = Buffer.alloc(0);

    const appendField = (name: string, value: string) => {
      let str = `--${boundary}\r\n`;
      str += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
      str += `${value}\r\n`;
      payload = Buffer.concat([payload, Buffer.from(str)]);
    };

    const appendFile = (name: string, filename: string, data: Buffer) => {
      let str = `--${boundary}\r\n`;
      str += `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`;
      str += `Content-Type: audio/wav\r\n\r\n`;
      payload = Buffer.concat([payload, Buffer.from(str), data, Buffer.from("\r\n")]);
    };

    appendField("model", model);
    appendFile("file", "speech.wav", audioData);
    payload = Buffer.concat([payload, Buffer.from(`--${boundary}--\r\n`)]);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body: payload
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`STT API returned status ${response.status}: ${errText}`);
    }

    const resJson: any = await response.json();
    return resJson.text || "";
  }

  private async synthesizeSpeechAPI(text: string, settings: any): Promise<Buffer> {
    const apiKey = settings.tts_api_key || "";
    const baseUrl = settings.tts_base_url || "https://api.openai.com/v1";
    const model = settings.tts_model || "tts-1";
    let voice = settings.tts_voice || "alloy";

    const validVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    if (!validVoices.includes(voice.toLowerCase())) {
      voice = "alloy";
    }

    const url = baseUrl.endsWith("/audio/speech")
      ? baseUrl
      : `${baseUrl.replace(/\/$/, "")}/audio/speech`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, input: text, voice })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`TTS API returned status ${response.status}: ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private synthesizeSpeechMiniMax(text: string, settings: any, cb: (data: Buffer | null) => void) {
    const apiKey = settings.tts_api_key || "";
    const apiHost = settings.tts_base_url || "https://api.minimaxi.com";
    const voiceId = settings.tts_voice || "presenter_male";
    
    const tempOutput = "/tmp/tts_minimax_web.mp3";
    const env = {
      ...process.env,
      MINIMAX_API_KEY: apiKey,
      MINIMAX_API_HOST: apiHost,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/Library/Python/3.9/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`
    };
    const child = spawn("python3", ["/tmp/ocb_minimax_tts.py", text, tempOutput, voiceId], { env });
    
    let errOutput = "";
    child.stderr.on("data", (chunk) => {
      errOutput += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0 && existsSync(tempOutput)) {
        try {
          const data = readFileSync(tempOutput);
          cb(data);
        } catch (err: any) {
          console.error(`[OpenCodex Voice API MiniMax Err] Failed to read output file: ${err.message}`);
          cb(null);
        }
      } else {
        console.error(`[OpenCodex Voice API MiniMax Err] Exit code ${code}. Error: ${errOutput}`);
        cb(null);
      }
    });
  }

  private synthesizeSpeechEdge(text: string, settings: any, cb: (data: Buffer | null) => void) {
    let voice = settings.tts_voice || "zh-CN-XiaoxiaoNeural";
    if (!voice.includes("-") || voice.length < 5) {
      const hasChinese = /[\u4e00-\u9fa5]/.test(text);
      voice = hasChinese ? "zh-CN-XiaoxiaoNeural" : "en-US-AvaNeural";
    }
    const tempOutput = "/tmp/tts_edge_web_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".mp3";
    const uvxPath = join(homedir(), ".local", "bin", "uvx");
    const homebrewPath = "/opt/homebrew/bin/edge-tts";
    const localBinPath = "/usr/local/bin/edge-tts";
    
    const env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/Library/Python/3.9/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`
    };

    let edgeTtsCmd = "edge-tts";
    let args = ["--voice", voice, "--text", text, "--write-media", tempOutput];
    
    if (existsSync(homebrewPath)) {
      edgeTtsCmd = homebrewPath;
    } else if (existsSync(localBinPath)) {
      edgeTtsCmd = localBinPath;
    } else if (existsSync(uvxPath)) {
      edgeTtsCmd = uvxPath;
      args = ["edge-tts", ...args];
    }
    
    const child = spawn(edgeTtsCmd, args, { env });

    let errOutput = "";
    child.stderr.on("data", (chunk) => {
      errOutput += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0 && existsSync(tempOutput)) {
        try {
          const data = readFileSync(tempOutput);
          cb(data);
        } catch (err: any) {
          console.error(`[OpenCodex Voice API EdgeTTS Err] Failed to read output file: ${err.message}`);
          cb(null);
        } finally {
          try {
            unlinkSync(tempOutput);
          } catch {}
        }
      } else {
        console.error(`[OpenCodex Voice API EdgeTTS Err] Exit code ${code}. Error: ${errOutput}`);
        cb(null);
        try {
          unlinkSync(tempOutput);
        } catch {}
      }
    });
  }

  private async synthesizeSpeechDoubao(text: string, settings: any): Promise<Buffer> {
    const apiKey = settings.tts_api_key || "";
    const baseUrl = settings.tts_base_url || "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
    const voice = settings.tts_voice || "zh_female_xiaohe_uranus_bigtts";
    const appid = settings.tts_appid || "";
    const resourceId = settings.tts_resource || settings.tts_resource_id || "seed-tts-2.0";

    const crypto = await import("node:crypto");
    const reqid = crypto.randomUUID();

    let headers: Record<string, string> = {};
    let bodyPayload: any = {};

    // If AppID is provided, we use the legacy V1/V2 AppID + Access Key authentication format.
    // Otherwise, we use the new V3 API Key authentication format.
    if (appid) {
      headers = {
        "Content-Type": "application/json",
        "X-Api-App-Key": appid,
        "X-Api-Access-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": reqid
      };

      bodyPayload = {
        app: {
          appid: appid,
          token: apiKey,
          cluster: resourceId.includes("icl") ? "volcano_icl" : "volcano_tts"
        },
        user: {
          uid: "opencodex_user"
        },
        audio: {
          voice_type: voice,
          encoding: "mp3"
        },
        request: {
          reqid: reqid,
          text: text,
          text_type: "plain",
          operation: "submit"
        }
      };
    } else {
      headers = {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": reqid
      };

      let modelVal = settings.tts_model || "seed-tts-2.0-expressive";
      if (modelVal === "tts-1") {
        modelVal = "seed-tts-2.0-expressive";
      }

      bodyPayload = {
        req_params: {
          text: text,
          model: modelVal,
          speaker: voice,
          encoding: "mp3"
        }
      };
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Doubao TTS API returned status ${response.status}: ${errText}`);
    }

    const resText = await response.text();
    const lines = resText.split("\n");
    let audioBuffer = Buffer.alloc(0);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        if (json.data) {
          const chunk = Buffer.from(json.data, "base64");
          audioBuffer = Buffer.concat([audioBuffer, chunk]);
        }
      } catch (e) {
        // ignore
      }
    }

    if (audioBuffer.length === 0) {
      throw new Error(`Doubao TTS synthesis returned no audio. Response was: ${resText.slice(0, 300)}`);
    }

    return audioBuffer;
  }

  private activeWsClients = new Set<WebSocket>();

  public broadcastSession(sessionId: string) {
    const payload = JSON.stringify({
      type: "activate_session",
      session_id: sessionId
    });
    for (const ws of this.activeWsClients) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  public handleWebSocketConnection(ws: WebSocket) {
    this.activeWsClients.add(ws);
    let audioBuffer = Buffer.alloc(0);
    let isListening = false;

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        if (isListening) {
          audioBuffer = Buffer.concat([audioBuffer, data as Buffer]);
        }
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start_stt") {
          audioBuffer = Buffer.alloc(0);
          isListening = true;
          console.error("[WebSocket STT] Listening started...");
        } else if (msg.type === "stop_stt") {
          isListening = false;
          console.error(`[WebSocket STT] Listening stopped. Audio size: ${audioBuffer.length} bytes`);
          await this.processWebSocketSTT(ws, audioBuffer);
        } else if (msg.type === "active_session_changed") {
          const sid = msg.session_id;
          if (sid) {
            const p = join(this.configDir, "voice_settings.json");
            let settings: any = {};
            if (existsSync(p)) {
              try { settings = JSON.parse(readFileSync(p, "utf-8")); } catch {}
            }
            settings.active_session_id = sid;
            writeFileSync(p, JSON.stringify(settings, null, 2), "utf-8");
            console.error(`[WebSocket] Client updated active_session_id to: ${sid}`);
          }
        }
      } catch (err: any) {
        console.error(`[WebSocket message err] ${err.message}`);
      }
    });

    ws.on("close", () => {
      this.activeWsClients.delete(ws);
      isListening = false;
      audioBuffer = Buffer.alloc(0);
    });
  }

  private async processWebSocketSTT(ws: WebSocket, pcmBuffer: Buffer) {
    try {
      const p = join(this.configDir, "voice_settings.json");
      let settings: any = {
        stt_engine: "local-whisper",
        stt_api_key: "",
        stt_base_url: "https://api.openai.com/v1",
        stt_model: "whisper-1"
      };
      if (existsSync(p)) {
        try {
          settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
        } catch {}
      }

      const wavBuffer = pcmToWav(pcmBuffer, 16000, 1, 16);
      const tmpWavPath = `/tmp/ws_stt_${Date.now()}.wav`;
      writeFileSync(tmpWavPath, wavBuffer);

      let text = "";
      const isAPI = settings.stt_engine === "openai-compatible" || (settings.stt_api_key && settings.stt_api_key.startsWith("gsk_")) || settings.stt_base_url.includes("groq");

      if (isAPI) {
        text = await this.transcribeAudioAPI(tmpWavPath, settings);
      } else {
        text = await new Promise<string>((resolve) => {
          this.transcribeAudioLocal(tmpWavPath, (resText) => {
            resolve(resText || "");
          });
        });
      }

      try {
        unlinkSync(tmpWavPath);
      } catch {}

      console.error(`[WebSocket STT] Final text: "${text}"`);
      ws.send(JSON.stringify({
        type: "transcription_final",
        text: text
      }));
    } catch (err: any) {
      console.error(`[WebSocket STT err] ${err.message}`);
      ws.send(JSON.stringify({
        type: "transcription_final",
        text: ""
      }));
    }
  }

  private async synthesizeSpeechKokoro(text: string, settings: any, cb: (data: Buffer | null) => void) {
    try {
      const response = await fetch("http://127.0.0.1:8766/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: text,
          voice: settings.tts_voice || "zf_xiaoxiao",
          speed: 1.0
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[OpenCodex Voice API Kokoro Err] Server returned status ${response.status}: ${errText}`);
        cb(null);
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      cb(Buffer.from(arrayBuffer));
    } catch (err: any) {
      console.error(`[OpenCodex Voice API Kokoro Err] Failed to fetch Kokoro server: ${err.message}`);
      cb(null);
    }
  }
}

function findRolloutFiles(dir: string, filesList: string[] = []): string[] {
  if (!existsSync(dir)) return filesList;
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        findRolloutFiles(fullPath, filesList);
      } else if (file.startsWith("rollout-") && file.endsWith(".jsonl")) {
        filesList.push(fullPath);
      }
    } catch {}
  }
  return filesList;
}

function findRolloutFileById(dir: string, sessionId: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const res = findRolloutFileById(fullPath, sessionId);
        if (res) return res;
      } else if (file.endsWith(`-${sessionId}.jsonl`)) {
        return fullPath;
      }
    } catch {}
  }
  return null;
}

function deleteSessionFiles(dir: string) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        deleteSessionFiles(fullPath);
        rmSync(fullPath, { recursive: true, force: true });
      } else if (file.endsWith(".jsonl")) {
        unlinkSync(fullPath);
      }
    } catch {}
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function stripManagedBlocks(content: string): string {
  return content.replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "").trim();
}

function getDefaultCatalog() {
  return { models: [] };
}
