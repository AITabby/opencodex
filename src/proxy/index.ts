/**
 * OpenCodex Proxy Server
 * Connects standard Codex requests to selected API providers (DeepSeek, SiliconFlow, OpenAI, Custom).
 * Hosts the local glassmorphic dashboard at http://localhost:8765/dashboard.
 * Broadcasts real-time terminal logs to dashboard sessions using SSE.
 */

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync, rmSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn, spawnSync, execSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
// @ts-ignore
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch } from "undici";
import zlib from "node:zlib";

// Auto-detect and configure outbound proxy support
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;
const wsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
const fetchDispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : undefined;

if (proxyUrl) {
  console.log(`[OpenCodex Proxy] Configured outbound proxy agent with: ${proxyUrl}`);
}

import {
  responsesToChat,
  chatCompletionToResponse,
  extractNamespaceMap,
  ResponsesStreamState,
  processVisionBridge,
  customResponseIds
} from "./translator.js";

import { getDashboardHtml } from "./dashboard.js";
import { getVisualizerHtml } from "./visualizer.js";

import {
  toResponsesItems,
  toOpenAiMessages,
  toAnthropicPayload,
  normalizeImportedMemory,
  OPENCODEX_MEMORY_TURN_ID,
  type OpenCodexMemoryPackage
} from "./memory_bridge.js";
import { parseMemoryFile, parseMemoryFilePath } from "./memory_file_import.js";
import { scanLocalMemorySources, type ScannedMemorySource } from "./memory_source_scanner.js";
import { withCodexAppServer } from "./codex_app_server.js";

export function isNativeModeEnabled(): boolean {
  const tomlPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(tomlPath)) return true;
  try {
    const content = readFileSync(tomlPath, "utf-8");
    return !content.includes("opencodex managed");
  } catch {
    return true;
  }
}

const IMPORT_PROJECTION_VERSION = 4;

function isNativeMessageId(value: unknown): boolean {
  return typeof value === "string" && /^msg_[A-Za-z0-9_-]+$/.test(value);
}

function isNativeFunctionCallId(value: unknown): boolean {
  return typeof value === "string" && /^fc_[A-Za-z0-9_-]+$/.test(value);
}

function nativeMessageId(value: unknown): string {
  return isNativeMessageId(value)
    ? String(value)
    : `msg_import_${randomUUID().replace(/-/g, "")}`;
}

function nativeFunctionCallId(value: unknown): string {
  return isNativeFunctionCallId(value)
    ? String(value)
    : `fc_import_${randomUUID().replace(/-/g, "")}`;
}

// ResponsesStreamState creates these IDs locally for third-party responses.
// They are not persisted by the official Responses service and must not be
// replayed when the same Codex thread is opened in native mode.
function isGatewayLocalReasoningId(value: unknown): boolean {
  return typeof value === "string" && /^rs_\d{13}_\d+$/.test(value);
}

function sanitizeResponsesForOfficial(reqBody: any): void {
  if (!reqBody || typeof reqBody !== "object") return;

  if (reqBody.previous_response_id && customResponseIds.has(reqBody.previous_response_id)) {
    delete reqBody.previous_response_id;
  }

  if (!Array.isArray(reqBody.input)) return;
  reqBody.input = reqBody.input.filter((item: any) => {
    if (isGatewayLocalReasoningId(item?.id)) return false;
    if (item?.type === "message" && item.id && !isNativeMessageId(item.id)) {
      item.id = nativeMessageId(item.id);
    }
    if (item?.type === "function_call" && item.id && !isNativeFunctionCallId(item.id)) {
      item.id = nativeFunctionCallId(item.id);
    }
    return true;
  });
}

interface ProviderConfig {
  name: string;
  base_url: string;
  api_key: string;
  api_keys?: string[];
  vision_model?: string;
}

interface ProxyConfig {
  providers: ProviderConfig[];
}

// In-Memory Live Logs Buffer & SSE broadcaster
const activeSseClients = new Set<(payload: any) => void>();
const logBuffer: any[] = [];
const MAX_LOG_BUFFER = 200;

const THIRD_PARTY_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic task delegation" }
];

const THIRD_PARTY_SERVICE_TIERS = [
  { id: "priority", name: "Fast", description: "1.5x speed, increased usage" }
];

function normalizeThirdPartyModelCapabilities(model: any): any {
  if (!model?.backend_provider) return model;
  return {
    ...model,
    default_reasoning_level: model.default_reasoning_level || "medium",
    supported_reasoning_levels: THIRD_PARTY_REASONING_LEVELS,
    default_reasoning_summary: model.default_reasoning_summary ?? "none",
    reasoning_summary_format: model.reasoning_summary_format ?? null,
    default_verbosity: model.default_verbosity || "low",
    support_verbosity: model.support_verbosity !== false,
    additional_speed_tiers: model.additional_speed_tiers?.length ? model.additional_speed_tiers : ["fast"],
    service_tiers: model.service_tiers?.length ? model.service_tiers : THIRD_PARTY_SERVICE_TIERS
  };
}

function orderCatalogModels(models: any[]): any[] {
  return models
    .map((model, index) => ({ model: normalizeThirdPartyModelCapabilities(model), index }))
    .sort((a, b) => {
      // Native models from models_cache.json did not always carry a provider
      // field. Treat an un-managed GPT slug as official as well, while any
      // explicit backend_provider always means a custom/subscription model.
      const aNative = !a.model.backend_provider
        && (a.model.provider === "openai" || /^gpt(?:-|$)/i.test(String(a.model.slug || a.model.model || "")));
      const bNative = !b.model.backend_provider
        && (b.model.provider === "openai" || /^gpt(?:-|$)/i.test(String(b.model.slug || b.model.model || "")));
      if (aNative !== bNative) return aNative ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ model }) => model);
}

function isOfficialCatalogModel(model: any): boolean {
  return !model?.backend_provider
    && (model?.provider === "openai" || /^gpt(?:-|$)/i.test(String(model?.slug || model?.model || "")));
}

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

function isSameMessage(m1: any, m2: any): boolean {
  if (m1.role !== m2.role) return false;
  if (m1.role === "tool") {
    return m1.tool_call_id === m2.tool_call_id && m1.content === m2.content;
  }
  if (m1.role === "assistant") {
    const contentMatch = (m1.content || "") === (m2.content || "");
    if (!contentMatch) return false;
    const tc1 = m1.tool_calls || [];
    const tc2 = m2.tool_calls || [];
    if (tc1.length !== tc2.length) return false;
    for (let i = 0; i < tc1.length; i++) {
      if (tc1[i].function?.name !== tc2[i].function?.name) return false;
      if (tc1[i].function?.arguments !== tc2[i].function?.arguments) return false;
    }
    return true;
  }
  return m1.content === m2.content;
}

function mergeHistory(history: any[], incoming: any[]): any[] {
  let overlapLength = 0;
  for (let i = 1; i <= Math.min(history.length, incoming.length); i++) {
    let match = true;
    for (let j = 0; j < i; j++) {
      const historyIndex = history.length - i + j;
      const incomingIndex = j;
      if (!isSameMessage(history[historyIndex], incoming[incomingIndex])) {
        match = false;
        break;
      }
    }
    if (match) {
      overlapLength = i;
    }
  }
  return history.concat(incoming.slice(overlapLength));
}

export class ProxyServer {
  private server: http.Server | null = null;
  public config!: ProxyConfig;
  private configDir = join(homedir(), ".opencodex");
  private initializedSessions = new Set<string>();
  private customConversationHistory = new Map<string, any[]>();
  private customModelSessions = new Set<string>();
  private sessionSequenceNumberMap = new Map<string, number>();
  private customSessionQueues = new Map<any, Promise<void>>();
  private titleSessionHashes = new Set<string>();
  private antigravityTokenCache = "";
  private antigravityTokenCacheTime = 0;
  private antigravityTokenExpiry = 0;
  private currentSystemUtterance: string = "";
  private voiceSessionThreadIds = new Map<string, string>();
  private memorySourceFiles = new Map<string, ScannedMemorySource>();
  public codexMcpClient: any = null;
  private mcpProcess: any = null;
  private mcpRequestId = 0;
  private mcpRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void; onDelta?: (text: string) => void; accumulatedReply: string }>();
  private mcpStdoutBuffer = "";
  private vadProcess: any = null;
  private vadStdoutBuffer = "";
  private vadCallbackQueue: ((res: any) => void)[] = [];

  constructor() {
    this.ensureConfigDir();
    this.ensureCheckPermsHelper();
    this.loadConfig();
    // Starting the local service must leave a native Codex installation
    // untouched. Gateway routing is enabled only by an explicit model import.
    this.mergeNativeModelsIntoCatalog();
    this.repairExistingImportedSessions();
    this.ensurePythonScripts();
    this.startVADDaemon();
  }

  private startVADDaemon() {
    if (this.vadProcess) return;

    const scriptPath = "/Users/aitabby/projects/opencodex/src/proxy/silero_vad_daemon.py";
    console.error(`[OpenCodex VAD] Starting persistent VAD daemon from: ${scriptPath}`);

    this.vadProcess = spawn("python3", [scriptPath]);
    this.vadStdoutBuffer = "";
    this.vadCallbackQueue = [];

    this.vadProcess.stdout.on("data", (data: Buffer) => {
      this.vadStdoutBuffer += data.toString();
      let lines = this.vadStdoutBuffer.split("\n");
      this.vadStdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const res = JSON.parse(trimmed);
          if (res.status === "ready") {
            console.error("[OpenCodex VAD] Daemon is warmed up and ready.");
            continue;
          }
          if (res.status === "reset") {
            const cb = this.vadCallbackQueue.shift();
            if (cb) cb(res);
            continue;
          }
          const cb = this.vadCallbackQueue.shift();
          if (cb) cb(res);
        } catch (e: any) {
          console.error(`[OpenCodex VAD Daemon Parse Error] ${e.message} for line: ${trimmed}`);
        }
      }
    });

    this.vadProcess.stderr.on("data", (data: Buffer) => {
      console.error(`[OpenCodex VAD Daemon Stderr] ${data.toString().trim()}`);
    });

    this.vadProcess.on("close", (code: number) => {
      console.error(`[OpenCodex VAD Daemon Closed] Exit code: ${code}`);
      this.vadProcess = null;
      this.vadCallbackQueue = [];
    });
  }

  private repairExistingImportedSessions() {
    const roots = [
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".codex", "archived_sessions")
    ];
    let repaired = 0;
    const nativeMode = isNativeModeEnabled();
    for (const root of roots) {
      for (const rolloutPath of findRolloutFiles(root)) {
        try {
          if (repairSessionProjectionForMode(rolloutPath, nativeMode)) repaired++;
        } catch (error: any) {
          console.error(`[OpenCodex Memory Bridge] Could not repair ${rolloutPath}: ${error.message}`);
        }
      }
    }
    if (repaired > 0) {
      console.log(`[OpenCodex Memory Bridge] Repaired ${repaired} imported session projection(s).`);
    }
  }

  private sendVADRequest(req: any): Promise<any> {
    this.startVADDaemon();
    return new Promise((resolve) => {
      if (!this.vadProcess) {
        resolve({ error: "VAD process not running" });
        return;
      }
      this.vadCallbackQueue.push(resolve);
      this.vadProcess.stdin.write(JSON.stringify(req) + "\n");
    });
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
    speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5
    
    api_key = os.environ.get("MINIMAX_API_KEY")
    api_host = os.environ.get("MINIMAX_API_HOST", "https://api.minimaxi.com")
    
    if not api_key:
        print("ERROR: Missing MINIMAX_API_KEY environment variable")
        sys.exit(1)
        
    url = f"{api_host}/v1/t2a_v2"
    
    payload = {
        "model": "speech-2.8-turbo",
        "text": text,
        "stream": False,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": speed,
            "vol": 1.0,
            "pitch": 2,
            "emotion": "happy"
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
                
            audio_data = res_json.get("data")
            if not audio_data:
                print("ERROR: No audio data returned from MiniMax")
                sys.exit(1)
            audio_hex = audio_data.get("audio") if isinstance(audio_data, dict) else audio_data
            if not audio_hex:
                print("ERROR: No audio hex string found")
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
    let catalog: any = { models: [] };
    if (existsSync(p)) {
      try {
        catalog = JSON.parse(readFileSync(p, "utf-8"));
      } catch (err: any) {
        console.error(`[OpenCodex] Failed to read model catalog: ${err.message}`);
      }
    }
    if (!catalog.models) catalog.models = [];

    // Always filter out 5.4 and below, and codex-auto-review
    catalog.models = catalog.models.filter((m: any) => {
      const slug = m.slug || "";
      if (slug === "codex-auto-review") return false;
      if (slug === "gpt-5.4" || slug === "gpt-5.4-mini") return false;
      const match = slug.match(/^gpt-(\d+\.\d+)/);
      if (match) {
        const version = parseFloat(match[1]);
        if (version <= 5.4) return false;
      }
      return true;
    });

    // Fix legacy/incorrect backend_model mappings for antigravity Gemini Flash models
    catalog.models.forEach((m: any) => {
      if (m.backend_provider === "antigravity" && m.slug?.startsWith("gemini-3.5-flash")) {
        m.backend_model = "gpt-5.6-luna";
      }
    });

    // The desktop picker follows catalog order. Keep official models first
    // regardless of which subscription/custom provider was added most
    // recently, then retain a stable order among third-party models.
    catalog.models = orderCatalogModels(catalog.models);

    return catalog;
  }

  private saveModelCatalog(catalog: any) {
    const p = join(this.configDir, "custom_model_catalog.json");
    try {
      if (!catalog.models) catalog.models = [];

      // Always filter out 5.4 and below, and codex-auto-review
      catalog.models = catalog.models.filter((m: any) => {
        const slug = m.slug || "";
        if (slug === "codex-auto-review") return false;
        if (slug === "gpt-5.4" || slug === "gpt-5.4-mini") return false;
        const match = slug.match(/^gpt-(\d+\.\d+)/);
        if (match) {
          const version = parseFloat(match[1]);
          if (version <= 5.4) return false;
        }
        return true;
      });

      // Official entries stay in the shared catalog for Codex Desktop, but
      // their visibility is never controlled by OpenCodex' custom-model UI.
      catalog.models.forEach((model: any) => {
        if (isOfficialCatalogModel(model)) model.visibility = "list";
      });
      catalog.models = orderCatalogModels(catalog.models);

      const jsonStr = JSON.stringify(catalog, null, 2);
      writeFileSync(p, jsonStr, "utf-8");
      console.error(`[OpenCodex] Saved custom model catalog to ${p}`);
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to save custom model catalog: ${err.message}`);
    }
  }

  private mergeNativeModelsIntoCatalog() {
    const cachePath = join(homedir(), ".codex", "models_cache.json");
    if (!existsSync(cachePath)) {
      console.log(`[OpenCodex] Native models cache not found at ${cachePath}. Skipping merge.`);
      return;
    }

    try {
      const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
      const nativeModels = cacheData.models || [];
      if (!Array.isArray(nativeModels) || nativeModels.length === 0) {
        return;
      }

      const catalog = this.getModelCatalog();
      if (!catalog.models) {
        catalog.models = [];
      }

      let updated = false;

      for (const native of nativeModels) {
        if (!native.slug) continue;
        
        const idx = catalog.models.findIndex((m: any) => m.slug === native.slug);
        
        if (idx === -1) {
          catalog.models.push({
            ...native,
            provider: "openai",
            visibility: "list"
          });
          updated = true;
        } else {
          // If this is a custom model, keep its provider as opencodex
          const isCustomModel = !!catalog.models[idx].backend_provider || catalog.models[idx].slug.startsWith("mimo");
          const expectedProvider = isCustomModel ? "opencodex" : "openai";
          if (catalog.models[idx].provider !== expectedProvider) {
            catalog.models[idx].provider = expectedProvider;
            updated = true;
          }
        }
      }

      if (updated) {
        this.saveModelCatalog(catalog);
        console.log(`[OpenCodex] Successfully merged native OpenAI models into custom model catalog.`);
      }
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to merge native models: ${err.message}`);
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

      let backendModel = modelName;
      let slug = modelName;
      let separator = "";
      if (modelName.includes("->")) separator = "->";
      else if (modelName.includes("=")) separator = "=";

      if (separator) {
        const parts = modelName.split(separator);
        slug = parts[0].trim();
        backendModel = parts[1].trim();
      }

      // Prevent duplicate slugs in the newly built array
      const existingInNew = models.find((m: any) => m.slug === slug);
      if (existingInNew) {
        if (backendModel !== slug) {
          existingInNew.backend_model = backendModel;
        }
        continue;
      }

      const existing = existingModels.find((m: any) => m.slug === slug || m.model === slug);
      if (existing) {
        const isNative = existing.slug === "gpt-5.5" || existing.slug === "gpt-5.6-luna" || existing.slug === "gpt-5.4-mini" || (existing.provider === "openai" && !existing.backend_provider);
        if (isNative) {
          models.push({
            ...existing,
            provider: "openai",
            backend_provider: undefined
          });
        } else {
          models.push({
            ...existing,
            slug: slug,
            model: slug,
            // Keep a previously customized backend_model unless the entry
            // explicitly remaps it via "slug->backend" / "slug=backend".
            backend_model: separator ? backendModel : (existing.backend_model || backendModel),
            provider: "opencodex",
            backend_provider: provider || existing.backend_provider || existing.provider
          });
        }
      } else {
        models.push({
          slug: slug,
          model: slug,
          display_name: slug,
          backend_model: backendModel,
          provider: "opencodex",
          backend_provider: provider,
          description: `Custom model: ${slug}${provider ? ` (${provider})` : ""}`,
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
    const providerName = catalogEntry?.backend_provider || catalogEntry?.provider;
    if (providerName && providerName !== "opencodex") {
      const found = this.config.providers.find(p => p.name === providerName);
      if (found) return found;
    }
    if (model.startsWith("mimo") || (catalogEntry && catalogEntry.backend_model && catalogEntry.backend_model.startsWith("mimo"))) {
      return this.config.providers.find(p => p.name === "opencode" || p.name === catalogEntry?.backend_provider) || this.config.providers.find(p => p.name === "opencode") || null;
    }
    return this.config.providers[0] || null;
  }

  private resolveKey(raw: string): string {
    if (raw === "grok-cli-auto") {
      try {
        const cachePath = join(this.configDir, "grok_auth_cache.json");
        let session: any = null;
        if (existsSync(cachePath)) {
          try {
            session = JSON.parse(readFileSync(cachePath, "utf-8"));
          } catch (e) {
            console.error("[OpenCodex] Failed to parse grok_auth_cache.json:", e);
          }
        }
        if (!session) {
          const authPath = join(homedir(), ".grok", "auth.json");
          if (existsSync(authPath)) {
            const authData = JSON.parse(readFileSync(authPath, "utf-8"));
            const sessionKey = Object.keys(authData).find(k => k.startsWith("https://auth.x.ai::"));
            if (sessionKey) {
              session = authData[sessionKey];
              console.log("[OpenCodex] Bootstrapped Grok CLI session into independent cache.");
            }
          }
        }
        if (session) {
          const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : 0;
          const now = Date.now();
          if (session.key && expiresAt && (expiresAt - now > 300000)) {
            return session.key;
          }
          console.log("[OpenCodex] Grok independent session is expired or expiring soon. Refreshing...");
          const issuer = session.oidc_issuer || "https://auth.x.ai";
          const clientId = session.oidc_client_id;
          const refreshToken = session.refresh_token;
          if (refreshToken && clientId) {
            try {
              const curlCmd = `curl -s -X POST ${issuer}/oauth2/token -d "grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${clientId}"`;
              const resStr = execSync(curlCmd, { encoding: "utf-8" });
              const tokenData = JSON.parse(resStr);
              if (tokenData && tokenData.access_token) {
                session.key = tokenData.access_token;
                if (tokenData.refresh_token) {
                  session.refresh_token = tokenData.refresh_token;
                }
                if (tokenData.expires_in) {
                  session.expires_at = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
                }
                writeFileSync(cachePath, JSON.stringify(session, null, 2), "utf-8");
                console.log("[OpenCodex] Grok independent session successfully refreshed and saved.");
                return tokenData.access_token;
              } else {
                console.error("[OpenCodex] Grok token refresh response invalid, clearing cache:", resStr);
                try { unlinkSync(cachePath); } catch {}
              }
            } catch (refreshErr: any) {
              console.error("[OpenCodex] Failed to refresh Grok token synchronously, clearing cache:", refreshErr.message);
              try { unlinkSync(cachePath); } catch {}
            }
          }
          if (session.key) return session.key;
        }
      } catch (e: any) {
        console.error("[OpenCodex] Failed to auto-resolve Grok CLI token:", e);
      }
    }
    if (raw === "claude-cli-auto") {
      try {
        const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
        if (existsSync(claudeSettingsPath)) {
          const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
          return settings?.env?.ANTHROPIC_API_KEY || "";
        }
      } catch (e: any) {
        console.error("[OpenCodex] Failed to auto-resolve Claude CLI token:", e);
      }
    }
    if (raw === "antigravity-cli-auto") {
      const now = Date.now();
      const cacheValidUntil = this.antigravityTokenExpiry > 0
        ? this.antigravityTokenExpiry - 30000
        : this.antigravityTokenCacheTime + 300000;
      if (this.antigravityTokenCache && now < cacheValidUntil) {
        return this.antigravityTokenCache;
      }
      try {
        if (process.platform === "darwin") {
          const stdout = execSync('security find-generic-password -a "antigravity" -s "gemini" -w', { encoding: "utf-8" }).trim();
          if (stdout.startsWith("go-keyring-base64:")) {
            const base64Data = stdout.substring("go-keyring-base64:".length);
            const jsonStr = Buffer.from(base64Data, "base64").toString("utf-8");
            const data = JSON.parse(jsonStr);
            if (data?.token?.access_token) {
              this.antigravityTokenCache = data.token.access_token;
              this.antigravityTokenCacheTime = now;
              const expiry = data.token.expiry || data.token.expires_at;
              const expiryMs = expiry ? Date.parse(String(expiry)) : NaN;
              this.antigravityTokenExpiry = Number.isFinite(expiryMs) ? expiryMs : 0;
              return data.token.access_token;
            }
          }
        }
      } catch (e: any) {
        console.error("[OpenCodex] Failed to auto-resolve Antigravity token:", e);
      }
      const op = this.config.providers.find((p: any) => p.name === "opencode");
      return op ? op.api_key : "dummy";
    }
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
model_catalog_json = "${catalogPath}"
openai_base_url = "http://127.0.0.1:8765/v1"
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
      // Materialize capability normalization and ordering before Codex Desktop
      // reads model_catalog_json directly from disk.
      this.saveModelCatalog(this.getModelCatalog());
      const content = readFileSync(tomlPath, "utf-8");
      let patched = stripManagedBlocks(content);
      const managedTop = `# >>> opencodex managed >>>
model_catalog_json = "${catalogPath}"
openai_base_url = "http://127.0.0.1:8765/v1"
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
    const cmd = 'killall ChatGPT Codex "Codex Helper" "Codex Helper (Renderer)" "Codex Helper (GPU)" SkyComputerUseClient SkyComputerUseService bare-modifier-monitor 2>/dev/null; kill -9 $(ps aux | grep -i "codex app-server" | grep -v "grep" | awk \'{print $2}\') 2>/dev/null; sleep 1.5; open -a ChatGPT --args --remote-debugging-port=8315';
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
          // Create a temporary launcher script that runs the binary and exits to close the Terminal window natively.
          // set -m enables job control in non-interactive scripts so & disown works correctly without killing the child process.
          const scriptPath = join(barDir, "launch_opencodex_bar.sh");
          const scriptContent = `#!/bin/bash\nset -m\ncd "${barDir}"\n"${binPath}" &\ndisown\nexit\n`;
          writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
          startCmd = `open -a Terminal "${scriptPath}"`;
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
    this.initCodexMcp();
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
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const isResponsesWs = url.pathname.startsWith("/v1/responses") || url.pathname.includes("responses");

      if (isResponsesWs) {
        console.log(`[OpenCodex WS Proxy] Intercepting responses WebSocket upgrade: ${url.pathname}${url.search}`);
        wss.handleUpgrade(request, socket, head, (clientWs) => {
          this.desktopWsClients.add(clientWs);
          console.log("[OpenCodex WS Proxy] Upgrade request headers:", JSON.stringify(request.headers, null, 2));
          const sidHeader = request.headers["x-session-id"] || request.headers["session-id"] || request.headers["x-thread-id"] || request.headers["thread-id"] || "";
          const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : (sidHeader || "default");
          
          const sessionIdStr = sessionId ? String(sessionId) : "default";
          (clientWs as any).sessionId = sessionIdStr;
          const connInfo = { 
            clientWs, 
            targetWs: null as WebSocket | null, 
            headers: request.headers, 
            lastMsg: null as any,
            isCustomMode: false,
            activeSessionId: sessionIdStr,
            isGeneratingTitle: false
          };
          if (sessionId && sessionId !== "default") {
            this.activeConnectionsBySession.set(sessionId, connInfo);
          }
          this.lastActiveConnection = connInfo;

          let clientClosed = false;
          let targetClosed = false;
          let isLocal = false;
          const pendingBuffer: { data: any; isBinary: boolean }[] = [];

          // Establish connection to official server immediately on upgrade to ensure fresh handshake headers
          const isChatGptAccount = Object.keys(request.headers).some(k => k.toLowerCase() === "chatgpt-account-id");
          let targetUrl = "";
          if (isChatGptAccount) {
            let subPath = url.pathname;
            if (url.pathname.startsWith("/v1/")) {
              subPath = url.pathname.substring(4);
            }
            if (!subPath.startsWith("codex/")) {
              subPath = "codex/" + subPath;
            }
            targetUrl = `wss://chatgpt.com/backend-api/${subPath}${url.search}`;
          } else {
            targetUrl = url.pathname.startsWith("/v1/") 
              ? `wss://api.openai.com${url.pathname}${url.search}` 
              : `wss://chatgpt.com${url.pathname}${url.search}`;
          }

          let realToken = "";
          const authPath = join(homedir(), ".codex", "auth.json");
          if (existsSync(authPath)) {
            try {
              const authData = JSON.parse(readFileSync(authPath, "utf-8"));
              if (authData.tokens && authData.tokens.access_token) {
                realToken = authData.tokens.access_token;
              }
            } catch (e: any) {
              console.error(`[OpenCodex WS Proxy] Failed to read auth.json for WS auth: ${e.message}`);
            }
          }

          const headers: Record<string, string> = {};
          let hasIncomingAuth = false;
          for (const [key, val] of Object.entries(request.headers)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "upgrade" || lowerKey.startsWith("sec-websocket-")) {
              continue;
            }
            if (lowerKey === "authorization") {
              const valStr = Array.isArray(val) ? val[0] : (val || "");
              if (valStr && !valStr.includes("dummy") && !valStr.includes("opencodex")) {
                hasIncomingAuth = true;
              }
            }
            headers[key] = Array.isArray(val) ? val[0] : (val || "");
          }

          if (!hasIncomingAuth && realToken) {
            headers["authorization"] = `Bearer ${realToken}`;
          }

          console.log(`[OpenCodex WS Proxy] Connecting to official server immediately: ${targetUrl}`);
          const targetWs = new WebSocket(targetUrl, { 
            headers,
            agent: wsAgent
          });
          connInfo.targetWs = targetWs;

          targetWs.on("open", () => {
            console.log(`[OpenCodex WS Proxy] Official target connection opened for ${url.pathname}`);
            if (targetWs.readyState === WebSocket.OPEN) {
              for (const p of pendingBuffer) {
                targetWs.send(p.data, { binary: p.isBinary });
              }
              pendingBuffer.length = 0;
            }
          });

          let inJsonStream = false;

          targetWs.on("message", (tData, tIsBinary) => {
            const activeSid = connInfo.activeSessionId || sessionIdStr;
            if (isLocal || connInfo.isCustomMode || this.customModelSessions.has(activeSid)) {
              return;
            }

            let processedTData = tData;
            if (!tIsBinary) {
              try {
                const payload = JSON.parse(tData.toString());
                if (payload.type === "codex.rate_limits") {
                  if (payload.rate_limits) {
                    payload.rate_limits.allowed = true;
                    payload.rate_limits.limit_reached = false;
                    if (payload.rate_limits.primary) {
                      payload.rate_limits.primary.used_percent = 0;
                      payload.rate_limits.primary.limit_reached = false;
                    }
                  }
                  processedTData = Buffer.from(JSON.stringify(payload), "utf-8");
                }
                if (payload.type === "error" && payload.error?.type === "usage_limit_reached") {
                  return; // Ignore official rate limit block
                }
              } catch {}
            }

            const msgStr = processedTData.toString();
            console.log(`[OpenCodex WS Proxy] Message from official server: ${tIsBinary ? "Binary" : msgStr.slice(0, 300)}`);
            
            let isTitleOrBackground = connInfo.isGeneratingTitle || inJsonStream || (msgStr.includes("gpt-5.4-mini") || msgStr.includes("gpt-5.6-luna") || msgStr.includes("{\"title\"") || msgStr.includes("\"title\""));

            if (!tIsBinary) {
              try {
                const payload = JSON.parse(msgStr);
                
                const getSessionHash = (id: string): string | null => {
                  if (!id) return null;
                  const match = id.match(/^(resp|rs|msg|ctc)_([a-f0-9]{24})/);
                  return match ? match[2] : null;
                };

                // Detect title responses and register their session hashes
                if (payload.type === "response.created" && payload.response) {
                  const model = payload.response.model || "";
                  if (model.includes("mini") || model.includes("title")) {
                    const hash = getSessionHash(payload.response.id);
                    if (hash) {
                      this.titleSessionHashes.add(hash);
                    }
                  }
                }
                
                // Precise check if this payload belongs to a title session hash
                const checkId = payload.item_id || payload.response_id || payload.response?.id || payload.item?.id;
                if (checkId) {
                  const hash = getSessionHash(checkId);
                  if (hash && this.titleSessionHashes.has(hash)) {
                    isTitleOrBackground = true;
                  }
                }
                
                // Broadcast streaming text delta to active voice clients
                if (payload.type === "response.output_text.delta" && payload.delta) {
                  const text = payload.delta;
                  if (text.trim().startsWith("{")) {
                    inJsonStream = true;
                  }
                  if (!inJsonStream && connInfo.lastMsg) {
                    const msg = JSON.stringify({ type: "model_chunk", text });
                    for (const voiceClient of this.activeWsClients) {
                      try { voiceClient.send(msg); } catch {}
                    }
                  }
                  if (inJsonStream && text.includes("}")) {
                    inJsonStream = false;
                  }
                } 
                
                // Broadcast completion
                else if (payload.type === "response.completed" || payload.type === "response.output_item.done") {
                  inJsonStream = false;
                  if (payload.type === "response.completed") {
                    connInfo.isGeneratingTitle = false;
                    const msg = JSON.stringify({ type: "model_done", text: "" });
                    for (const voiceClient of this.activeWsClients) {
                      try { voiceClient.send(msg); } catch {}
                    }
                  }
                }
              } catch {}
            }

            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(processedTData, { binary: tIsBinary });
            }
            if (!isTitleOrBackground) {
              for (const otherWs of this.desktopWsClients) {
                if (otherWs !== clientWs && otherWs.readyState === WebSocket.OPEN) {
                  otherWs.send(processedTData, { binary: tIsBinary });
                }
              }
            }
          });

          targetWs.on("close", (code, reason) => {
            console.log(`[OpenCodex WS Proxy] Official target connection closed: ${code} - ${reason.toString()}`);
            targetClosed = true;
            if (!clientClosed) {
              clientWs.close();
            }
          });

          targetWs.on("error", (err) => {
            console.error("[OpenCodex WS Proxy Target Error]", err);
            clientWs.close();
          });

          clientWs.on("message", async (data, isBinary) => {
            let processedData = data;
            if (!isBinary) {
              try {
                const msg = JSON.parse(data.toString());
                let activeSid = msg.client_metadata?.session_id || connInfo.activeSessionId || sessionIdStr;
                this.logWSPacket("IN", msg, String(activeSid));
                if (msg && msg.client_metadata?.session_id) {
                   connInfo.activeSessionId = String(msg.client_metadata.session_id);
                   (clientWs as any).sessionId = String(msg.client_metadata.session_id);
                }
                if (msg && msg.type === "response.create") {
                  connInfo.lastMsg = msg;
                  const model = msg.model || "";
                  if (model) {
                    console.log(`[DEBUG-MODEL-SELECTION] Client response.create requested model: ${model}`);
                    const catalog = this.getModelCatalog();
                    const catalogEntry = catalog.models?.find((m: any) => m.slug === model);
                    connInfo.isCustomMode = !!catalogEntry?.backend_provider;
                    connInfo.isGeneratingTitle = model.includes("mini") || model.includes("title");
                  }
                }
                const model = msg.model || "";
                activeSid = connInfo.activeSessionId || sessionIdStr;

                let isTitlePrompt = false;
                const instructions = msg.instructions || msg.response?.instructions || "";
                if (instructions.includes("provide a short title") || instructions.includes("task title based solely on the prompt")) {
                  isTitlePrompt = true;
                }
                if (Array.isArray(msg.input)) {
                  for (const item of msg.input) {
                    if (item.content && Array.isArray(item.content)) {
                      for (const part of item.content) {
                        if (part.text && (part.text.includes("provide a short title") || part.text.includes("task title based solely on the prompt"))) {
                          isTitlePrompt = true;
                        }
                      }
                    }
                    if (typeof item.content === "string" && (item.content.includes("provide a short title") || item.content.includes("task title based solely on the prompt"))) {
                      isTitlePrompt = true;
                    }
                  }
                }

                if (model) {
                  const catalog = this.getModelCatalog();
                  const catalogEntry = catalog.models?.find((m: any) => m.slug === model);
                  const isCustomModel = !!catalogEntry?.backend_provider;
                  console.log(`[DEBUG-MODEL-SELECTION] Final routing check for model=${model}: isCustomModel=${isCustomModel}, isTitlePrompt=${isTitlePrompt}`);

                  if (isCustomModel || isTitlePrompt) {
                    isLocal = true;
                    if (isCustomModel) {
                      connInfo.isCustomMode = true;
                      this.customModelSessions.add(activeSid);
                    }
                    console.log(`[DEBUG-CUSTOM-MODEL-FLOW] Intercepted Custom Model/Title [${model}] locally for activeSid=${activeSid}.`);
                    await this.handleLocalResponsesWebSocketInline(clientWs, msg, { headers: request.headers, activeSessionId: activeSid });
                    return;
                  } else {
                    const hasUserChatMessage = msg.input && Array.isArray(msg.input) && msg.input.some((item: any) => {
                      if (item.role === "user" && item.content && Array.isArray(item.content)) {
                        return item.content.some((part: any) => part.text && !part.text.includes("provide a short title") && !part.text.includes("task title based solely on the prompt"));
                      }
                      return false;
                    });
                    const isBackgroundRequest = isTitlePrompt || !hasUserChatMessage;

                    if (isBackgroundRequest && this.customModelSessions.has(activeSid)) {
                      isLocal = false;
                      console.log(`[DEBUG-CUSTOM-MODEL-FLOW] Native Model [${model}] requested for background task. Preserving isCustomMode=true.`);
                    } else {
                      isLocal = false;
                      connInfo.isCustomMode = false;
                      this.customModelSessions.delete(activeSid);
                      console.log(`[DEBUG-CUSTOM-MODEL-FLOW] Native Model [${model}] requested. Forwarding to official server.`);
                    }
                  }
                } else {
                  // If the message does not specify a model, preserve the session's local state
                  if (this.customModelSessions.has(activeSid)) {
                    isLocal = true;
                    connInfo.isCustomMode = true;
                    console.log(`[DEBUG-CUSTOM-MODEL-FLOW] No model field in frame, but activeSid=${activeSid} is marked custom. Preserving isLocal=true.`);
                    if (msg.type === "response.create") {
                      console.log(`[DEBUG-CUSTOM-MODEL-FLOW] Intercepted local response.create without model field on custom session.`);
                      await this.handleLocalResponsesWebSocketInline(clientWs, msg, { headers: request.headers, activeSessionId: activeSid });
                      return;
                    }
                  } else {
                    isLocal = false;
                    connInfo.isCustomMode = false;
                  }
                }

                // If forwarding to official server, sanitize custom model references and encrypted_content from client inputs
                if (msg) {
                  let mutated = false;
                  if (msg.type === "response.create") {
                    if (msg.previous_response_id && customResponseIds.has(msg.previous_response_id)) {
                      console.log(`[OpenCodex WS Proxy] Removing custom model previous_response_id reference: ${msg.previous_response_id}`);
                      delete msg.previous_response_id;
                      mutated = true;
                    }
                    if (Array.isArray(msg.input)) {
                      const originalLength = msg.input.length;
                      msg.input = msg.input.filter((item: any) => {
                        if (item && isGatewayLocalReasoningId(item.id)) {
                          console.log(`[OpenCodex WS Proxy] Removing local reasoning item reference ${item.id} from input forwarded to official server.`);
                          return false;
                        }
                        if (item?.type === "message" && item.id && !isNativeMessageId(item.id)) {
                          console.log(`[OpenCodex WS Proxy] Normalizing invalid imported message id ${item.id} before forwarding to official server.`);
                          item.id = nativeMessageId(item.id);
                          mutated = true;
                        }
                        if (item?.type === "function_call" && item.id && !isNativeFunctionCallId(item.id)) {
                          console.log(`[OpenCodex WS Proxy] Normalizing invalid function call id ${item.id} before forwarding to official server.`);
                          item.id = nativeFunctionCallId(item.id);
                          mutated = true;
                        }
                        return true;
                      });
                      if (msg.input.length !== originalLength) {
                        mutated = true;
                      }
                    }
                  }

                  if (Array.isArray(msg.input)) {
                    for (const item of msg.input) {
                      if (item && item.type === "reasoning" && typeof item.encrypted_content === "string") {
                        if (item.encrypted_content.startsWith("anthropic-thinking-v1:")) {
                          const prefix = "anthropic-thinking-v1:";
                          try {
                            const blob = item.encrypted_content.slice(prefix.length);
                            const raw = Buffer.from(blob, "base64url").toString("utf-8");
                            const decoded = JSON.parse(raw);
                            if (decoded && decoded.thinking) {
                              item.summary = [{ type: "summary_text", text: decoded.thinking }];
                            }
                          } catch {}
                          delete item.encrypted_content;
                          mutated = true;
                        }
                      }
                    }
                  }
                  if (mutated) {
                    processedData = Buffer.from(JSON.stringify(msg), "utf-8");
                  }
                }
              } catch (err) {
                // Not JSON or parsing failed, fallback
              }
            }

            if (isLocal) {
              return;
            }

            if (targetWs) {
              console.log(`[OpenCodex WS Proxy] Forwarding message to official server: ${isBinary ? "Binary" : processedData.toString().slice(0, 300)}`);
              if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(processedData, { binary: isBinary });
              } else {
                pendingBuffer.push({ data: processedData, isBinary });
              }
            }
          });

          clientWs.on("close", () => {
            clientClosed = true;
            this.desktopWsClients.delete(clientWs);
            if (sessionId && sessionId !== "default") {
              this.activeConnectionsBySession.delete(sessionId);
            }
            if (this.lastActiveConnection === connInfo) {
              this.lastActiveConnection = null;
            }
            if (targetWs && !targetClosed) {
              targetWs.close();
            }
          });

          clientWs.on("error", (err) => {
            console.error("[OpenCodex WS Proxy Client Error]", err);
            this.desktopWsClients.delete(clientWs);
            if (sessionId && sessionId !== "default") {
              this.activeConnectionsBySession.delete(sessionId);
            }
            if (this.lastActiveConnection === connInfo) {
              this.lastActiveConnection = null;
            }
            if (targetWs) {
              targetWs.close();
            }
          });
        });
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws) => {
      this.handleWebSocketConnection(ws);
    });

    this.server.on("error", (err: any) => {
      console.error(`[OpenCodex] Proxy server port conflict: ${err.message}`);
    });

    this.server.listen(port, "0.0.0.0");
    console.error(`[OpenCodex] Unified HTTP server listening on port ${port}`);
    console.error(`[OpenCodex] Web Dashboard UI → http://localhost:${port}/dashboard`);
  }

  stop() {
    this.server?.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, session_id");
    
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let decompressedBody = rawBody;
    const contentEncoding = req.headers["content-encoding"];
    const requestPath = String(req.url || "").split("?", 1)[0];
    const isQuietDashboardPoll = req.method === "GET" && new Set([
      "/api/logs/poll",
      "/api/logs/stream",
      "/api/gateway/status",
      "/api/voice-settings",
      "/api/voice-bar/status",
      "/api/permissions",
      "/api/cli-bridge/status"
    ]).has(requestPath);
    if (!isQuietDashboardPoll) {
      console.log("[OpenCodex] Request path:", req.url, "Content-Encoding:", contentEncoding, "rawBody signature:", rawBody.slice(0, 4));
    }
    if (contentEncoding === "gzip") {
      try {
        decompressedBody = zlib.gunzipSync(rawBody);
      } catch (err: any) {
        console.error("[OpenCodex] Failed to gunzip body:", err.message);
      }
    } else if (contentEncoding === "deflate") {
      try {
        decompressedBody = zlib.inflateSync(rawBody);
      } catch (err: any) {
        console.error("[OpenCodex] Failed to inflate body:", err.message);
      }
    } else if (contentEncoding === "br") {
      try {
        decompressedBody = zlib.brotliDecompressSync(rawBody);
      } catch (err: any) {
        console.error("[OpenCodex] Failed to brotli decompress body:", err.message);
      }
    } else if (contentEncoding === "zstd") {
      try {
        decompressedBody = execSync("zstd -d", { input: rawBody });
      } catch (err: any) {
        console.error("[OpenCodex] Failed to zstd decompress body:", err.message);
      }
    }

    const body = decompressedBody.toString("utf-8");

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

    if (path === "/api/gateway/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active: !isNativeModeEnabled() }));
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
          this.mergeNativeModelsIntoCatalog();
          console.log(`[OpenCodex] Saved models from input: ${data.models.length} total.`);
        }

        // Warn when a custom model reuses an official model name: the official
        // catalog entry shadows the custom routing, so the custom provider
        // would never receive these requests.
        const collisionWarnings: string[] = [];
        if (Array.isArray(data.models)) {
          const seen = new Set<string>();
          for (const id of data.models) {
            const raw = String(id || "");
            const sep = raw.indexOf(":");
            if (sep < 0) continue; // official entries are bare slugs
            const slug = raw.slice(sep + 1).trim();
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            if (isOfficialCatalogModel({ slug })) {
              collisionWarnings.push(slug);
            }
          }
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

        const enablesGateway = Array.isArray(data.models) && data.models.length > 0;
        if (enablesGateway) {
          this.patchCodexConfig();
          this.autoPatchPlugins();
        }
        if (data.restart && enablesGateway) {
          this.restartCodexDesktop();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", restarted: !!data.restart && enablesGateway, gateway_active: enablesGateway || !isNativeModeEnabled(), name_collisions: collisionWarnings }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/models" && req.method === "GET") {
      if (isNativeModeEnabled()) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        });
        res.end(JSON.stringify({ catalog: [], active: [], mode: "native" }));
        return;
      }
      // Returns complete model catalog & enabled models
      const catalog = this.getModelCatalog();
      // The dashboard manages only third-party/subscription models. Official
      // models remain in the underlying catalog for the Desktop picker.
      const models = (catalog.models || []).filter((model: any) => !isOfficialCatalogModel(model));

      const active = models.filter((m: any) => m.visibility === "list").map((m: any) => m.slug);
      
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(JSON.stringify({
        catalog: models.map((m: any) => ({
          id: m.slug,
          model: m.model,
          provider: m.provider || "",
          backend_provider: m.backend_provider || "",
          display_name: m.display_name,
          backend_model: m.backend_model || "",
          no_image_support: m.input_modalities ? !m.input_modalities.includes("image") : true,
          vision_bridge_enabled: !!m.vision_bridge_enabled
        })),
        providers: (this.config.providers || []).map((p: any) => ({
          name: p.name,
          base_url: p.base_url || "",
          api_key: p.api_key || ""
        })),
        active
      }));
      return;
    }

    if (path === "/api/models" && req.method === "POST") {
      try {
        if (isNativeModeEnabled()) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Gateway is inactive in native mode" }));
          return;
        }
        const data = JSON.parse(body);
        console.log("[OpenCodex] Received POST /api/models data:", data);
        const activeIds = data.active || [];
        const visionBridgeIds = data.vision_bridge || [];
        const catalog = this.getModelCatalog();
        
        if (catalog.models) {
          catalog.models.forEach((m: any) => {
            if (isOfficialCatalogModel(m)) return;
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

    if (path === "/api/models/update" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const slug = String(data.id || "");
        const catalog = this.getModelCatalog();
        const entry = (catalog.models || []).find((m: any) => m.slug === slug || m.model === slug);
        if (!entry) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Model not found: ${slug}` }));
          return;
        }
        if (isOfficialCatalogModel(entry)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Official models cannot be edited" }));
          return;
        }
        if (typeof data.display_name === "string" && data.display_name.trim()) {
          entry.display_name = data.display_name.trim();
        }
        if (typeof data.backend_model === "string" && data.backend_model.trim()) {
          entry.backend_model = data.backend_model.trim();
        }
        this.saveModelCatalog(catalog);

        // Optionally update the backing provider's endpoint/credentials.
        const providerName = entry.backend_provider || entry.provider;
        const provider = (this.config.providers || []).find((p: any) => p.name === providerName);
        let providerUpdated = false;
        if (provider) {
          if (typeof data.base_url === "string" && data.base_url.trim()) {
            provider.base_url = data.base_url.trim();
            providerUpdated = true;
          }
          if (typeof data.api_key === "string" && data.api_key.trim()) {
            provider.api_key = data.api_key.trim();
            delete provider.api_keys;
            providerUpdated = true;
          }
          if (providerUpdated) {
            this.saveConfig();
            this.loadConfig();
          }
        }
        console.log(`[OpenCodex] Updated model: ${slug} (display_name=${entry.display_name}, backend_model=${entry.backend_model}, provider=${providerName}${providerUpdated ? " updated" : ""})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", provider_updated: providerUpdated }));
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

    if (path === "/api/sessions/new" && req.method === "POST") {
      try {
        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {};
        if (existsSync(p)) {
          try { settings = JSON.parse(readFileSync(p, "utf-8")); } catch {}
        }
        settings.active_session_id = "";
        writeFileSync(p, JSON.stringify(settings, null, 2), "utf-8");

        this.broadcastSession("");

        console.error("[Sessions] Reset active session to start a new conversation.");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", session_id: "" }));
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
        // Restarting the desktop application is an operational command, not
        // routing. It is also needed after native-mode session imports so the
        // desktop reloads the newly written local rollout files.
        this.restartCodexDesktop();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/memory-sources/scan" && req.method === "GET") {
      try {
        const groups = await scanLocalMemorySources();
        this.memorySourceFiles.clear();
        for (const group of groups) {
          for (const source of group.sources) {
            this.memorySourceFiles.set(source.source_id, source);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          agents: groups.map((group) => ({
            name: group.name,
            session_count: group.session_count,
            sources: group.sources.map((source) => ({
              source_id: source.source_id,
              display_path: source.display_path,
              format: source.format,
              modified_at: source.modified_at,
              sessions: source.sessions
            }))
          }))
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/memory-sources/import" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const source = this.memorySourceFiles.get(String(data.source_id || ""));
        if (!source) {
          res.writeHead(410, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Scan result expired. Scan local agents again." }));
          return;
        }
        const selectedSessionId = data.session_id === "__default__"
          ? undefined
          : String(data.session_id || "");
        const parsed = await parseMemoryFilePath(source.path, selectedSessionId);
        if (!parsed.memory) throw new Error("The selected session could not be read");
        const imported = await importMemoryIntoCodex(parsed.memory);
        const shouldRestart = data.restart !== false;
        console.log(`[OpenCodex Memory Bridge] Imported scanned source ${source.display_path} into ${imported.id}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "success",
          ...imported,
          detected_format: parsed.detected_format,
          model_visible: true,
          restarted: shouldRestart
        }));
        if (shouldRestart) {
          setTimeout(() => this.restartCodexDesktop(), 350);
        }
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/import" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const fallbackTitle = String(data.name || `Imported conversation ${new Date().toLocaleDateString()}`);
        let memory;
        let detectedFormat = "json";
        if (typeof data.file_name === "string" && typeof data.file_base64 === "string") {
          const fileBytes = Buffer.from(data.file_base64, "base64");
          if (fileBytes.length === 0) throw new Error("The selected file is empty");
          if (fileBytes.length > 48 * 1024 * 1024) {
            throw new Error("Import file is too large. Maximum size is 48 MB");
          }
          const parsedFile = await parseMemoryFile(
            data.file_name,
            new Uint8Array(fileBytes),
            typeof data.session_id === "string" ? data.session_id : undefined
          );
          detectedFormat = parsedFile.detected_format;
          if (parsedFile.sessions?.length && !parsedFile.memory) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              requires_session_selection: true,
              detected_format: parsedFile.detected_format,
              sessions: parsedFile.sessions
            }));
            return;
          }
          if (!parsedFile.memory) throw new Error("No conversation was selected");
          memory = parsedFile.memory;
        } else {
          const rawImport = data.payload ?? (Array.isArray(data.messages) ? data.messages : data);
          memory = normalizeImportedMemory(rawImport, fallbackTitle);
        }
        const imported = await importMemoryIntoCodex(memory);
        const shouldRestart = data.restart !== false;
        console.log(`[OpenCodex Memory Bridge] Imported ${memory.messages.length} messages into Codex thread ${imported.id}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "success",
          ...imported,
          detected_format: detectedFormat,
          model_visible: true,
          restarted: shouldRestart
        }));
        if (shouldRestart) {
          setTimeout(() => this.restartCodexDesktop(), 350);
        }
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/reset" && req.method === "POST") {
      try {
        if (isNativeModeEnabled()) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Already in native mode" }));
          return;
        }
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
        // Native Codex must not inherit temporary IDs emitted by the gateway.
        // Normalize existing rollouts before restarting the desktop client so
        // the first native continuation cannot replay rs_* or import_* items.
        this.repairExistingImportedSessions();
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

    if (path === "/api/cli-bridge/status" && req.method === "GET") {
      let grokDetected = false;
      let grokEmail = "";
      let grokExpiresAt = "";
      let grokActive = false;

      try {
        const grokAuthPath = join(homedir(), ".grok", "auth.json");
        if (existsSync(grokAuthPath)) {
          const authData = JSON.parse(readFileSync(grokAuthPath, "utf-8"));
          const sessionKey = Object.keys(authData).find(k => k.startsWith("https://auth.x.ai::"));
          if (sessionKey && authData[sessionKey]?.key) {
            grokDetected = true;
            grokEmail = authData[sessionKey].email || "";
            grokExpiresAt = authData[sessionKey].expires_at || "";
          }
        }
      } catch {}

      let claudeDetected = false;
      let claudeBaseUrl = "";
      let claudeActive = false;

      try {
        const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
        if (existsSync(claudeSettingsPath)) {
          const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
          if (settings?.env?.ANTHROPIC_API_KEY) {
            claudeDetected = true;
            claudeBaseUrl = settings?.env?.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
          }
        }
      } catch {}

      const catalog = this.getModelCatalog();
      const hasGrokModel = catalog?.models?.some((m: any) => m.backend_provider === "grok");
      const hasClaudeModel = catalog?.models?.some((m: any) => m.backend_provider === "claude");
      const hasAntigravityModel = catalog?.models?.some((m: any) => m.backend_provider === "antigravity");

      let antigravityActive = false;

      if (this.config && Array.isArray(this.config.providers)) {
        const gp = this.config.providers.find((p: any) => p.name === "grok");
        if (gp && gp.api_key === "grok-cli-auto" && hasGrokModel) {
          grokActive = true;
        }
        const cp = this.config.providers.find((p: any) => p.name === "claude");
        if (cp && cp.api_key === "claude-cli-auto" && hasClaudeModel) {
          claudeActive = true;
        }
        const ap = this.config.providers.find((p: any) => p.name === "antigravity");
        if (ap && ap.api_key === "antigravity-cli-auto" && hasAntigravityModel) {
          antigravityActive = true;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        grok: { detected: grokDetected, email: grokEmail, expiresAt: grokExpiresAt, active: grokActive },
        claude: { detected: claudeDetected, baseUrl: claudeBaseUrl, active: claudeActive },
        antigravity: { detected: true, active: antigravityActive }
      }));
      return;
    }

    if (path === "/api/cli-bridge/activate" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const cliName = data.cli;

        if (cliName === "grok") {
          let providers = this.config.providers || [];
          providers = providers.filter((p: any) => p.name !== "grok");
          providers.push({
            name: "grok",
            base_url: "https://api.x.ai/v1",
            api_key: "grok-cli-auto"
          });
          this.config.providers = providers;
          this.saveConfig();

          const catalog = this.getModelCatalog();
          const baseModel = catalog?.models?.find((m: any) => m.slug === "deepseek-v4-pro") || catalog?.models?.[0] || {};
          
          if (catalog && Array.isArray(catalog.models)) {
            catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "grok");
            
            const modelsToAdd = [
              { slug: "grok-4.5", model: "grok-4.5", display_name: "grok-4.5", backend_model: "grok-4.5", context_window: 500000, max_context_window: 500000 },
              { slug: "grok-4.3", model: "grok-4.3", display_name: "grok-4.3", backend_model: "grok-4.3", context_window: 1000000, max_context_window: 1000000 },
              { slug: "grok-4.20-reasoning", model: "grok-4.20-0309-reasoning", display_name: "grok-4.20-reasoning", backend_model: "grok-4.20-0309-reasoning", context_window: 1000000, max_context_window: 1000000 }
            ];

            for (const item of modelsToAdd) {
              catalog.models.push({
                ...baseModel,
                ...item,
                context_window: 200000,
                max_context_window: 200000,
                vision_bridge_enabled: false,
                provider: "opencodex",
                backend_provider: "grok",
                description: `Custom model: ${item.display_name} (grok)`,
                visibility: "list",
                model_messages: {
                  instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
                  instructions_variables: {
                    model_name: item.slug
                  }
                }
              });
            }
            this.saveModelCatalog(catalog);
          }
        } else if (cliName === "claude") {
          let providers = this.config.providers || [];
          providers = providers.filter((p: any) => p.name !== "claude");
          providers.push({
            name: "claude",
            base_url: "claude-cli-auto-url",
            api_key: "claude-cli-auto"
          });
          this.config.providers = providers;
          this.saveConfig();

          const catalog = this.getModelCatalog();
          const baseModel = catalog?.models?.find((m: any) => m.slug === "deepseek-v4-pro") || catalog?.models?.[0] || {};
          
          if (catalog && Array.isArray(catalog.models)) {
            catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "claude");
            
            const modelsToAdd = [
              { slug: "claude-3-5-sonnet", model: "claude-3-5-sonnet", display_name: "claude-3-5-sonnet", backend_model: "claude-3-5-sonnet-20241022", context_window: 200000, max_context_window: 200000 },
              { slug: "claude-3-5-haiku", model: "claude-3-5-haiku", display_name: "claude-3-5-haiku", backend_model: "claude-3-5-haiku-20241022", context_window: 200000, max_context_window: 200000 }
            ];

            for (const item of modelsToAdd) {
              catalog.models.push({
                ...baseModel,
                ...item,
                context_window: 200000,
                max_context_window: 200000,
                vision_bridge_enabled: false,
                provider: "opencodex",
                backend_provider: "claude",
                description: `Custom model: ${item.display_name} (claude)`,
                visibility: "list",
                model_messages: {
                  instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
                  instructions_variables: {
                    model_name: item.slug
                  }
                }
              });
            }
            this.saveModelCatalog(catalog);
          }
        } else if (cliName === "antigravity") {
          let providers = this.config.providers || [];
          providers = providers.filter((p: any) => p.name !== "antigravity");
          providers.push({
            name: "antigravity",
            base_url: "https://opencode.ai/zen/go/v1",
            api_key: "antigravity-cli-auto"
          });
          this.config.providers = providers;
          this.saveConfig();

          const catalog = this.getModelCatalog();
          const baseModel = catalog?.models?.find((m: any) => m.slug === "deepseek-v4-pro") || catalog?.models?.[0] || {};
          
          if (catalog && Array.isArray(catalog.models)) {
            catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "antigravity");
            
            const modelsToAdd = [
              { slug: "gemini-3.5-flash-medium", model: "gemini-3.5-flash-medium", display_name: "Gemini 3.5 Flash (Medium)", backend_model: "gpt-5.6-luna" },
              { slug: "gemini-3.5-flash-high", model: "gemini-3.5-flash-high", display_name: "Gemini 3.5 Flash (High)", backend_model: "gpt-5.6-luna" },
              { slug: "gemini-3.5-flash-low", model: "gemini-3.5-flash-low", display_name: "Gemini 3.5 Flash (Low)", backend_model: "gpt-5.6-luna" },
              { slug: "gemini-3.1-pro-low", model: "gemini-3.1-pro-low", display_name: "Gemini 3.1 Pro (Low)", backend_model: "gpt-5.5" },
              { slug: "gemini-3.1-pro-high", model: "gemini-3.1-pro-high", display_name: "Gemini 3.1 Pro (High)", backend_model: "gpt-5.5" },
              { slug: "claude-sonnet-4.6-thinking", model: "claude-sonnet-4.6-thinking", display_name: "Claude Sonnet 4.6 (Thinking)", backend_model: "gpt-5.5" },
              { slug: "claude-opus-4.6-thinking", model: "claude-opus-4.6-thinking", display_name: "Claude Opus 4.6 (Thinking)", backend_model: "gpt-5.6-terra" },
              { slug: "gpt-oss-120b-medium", model: "gpt-oss-120b-medium", display_name: "GPT-OSS 120B (Medium)", backend_model: "deepseek-v4-pro" }
            ];

            for (const item of modelsToAdd) {
              catalog.models.push({
                ...baseModel,
                ...item,
                context_window: 200000,
                max_context_window: 200000,
                vision_bridge_enabled: false,
                provider: "opencodex",
                backend_provider: "antigravity",
                description: `Antigravity model: ${item.display_name}`,
                visibility: "list",
                model_messages: {
                  instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
                  instructions_variables: {
                    model_name: item.slug
                  }
                }
              });
            }
            this.saveModelCatalog(catalog);
          }
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid CLI name" }));
          return;
        }

        this.loadConfig();
        this.patchCodexConfig();
        this.autoPatchPlugins();
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/cli-bridge/deactivate" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const cliName = data.cli;

        let providers = this.config.providers || [];
        providers = providers.filter((p: any) => p.name !== cliName);
        this.config.providers = providers;
        this.saveConfig();

        const catalog = this.getModelCatalog();
        if (catalog && Array.isArray(catalog.models)) {
          catalog.models = catalog.models.filter((m: any) => m.backend_provider !== cliName);
          this.saveModelCatalog(catalog);
        }

        this.loadConfig();
        this.patchCodexConfig();
        this.autoPatchPlugins();

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
        tts_speed: 1.2,
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

      const catalog = this.getModelCatalog();
      const available_models = (catalog.models || []).map((m: any) => m.slug);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...settings, available_models }));
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
          tts_speed: typeof data.tts_speed === "number" ? data.tts_speed : 1.2,
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
        if (engine === "openai-compatible" || engine === "groq") {
          console.error(`[OpenCodex Voice API] Transcribing via API endpoint (${engine}): ${settings.stt_base_url}`);
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
        if (text) {
          this.currentSystemUtterance = text;
          // Clear it after roughly the duration it takes to speak it (assuming ~250ms per character + 2s buffer)
          const estimatedDuration = Math.max(2000, text.length * 250) + 2000;
          setTimeout(() => {
            if (this.currentSystemUtterance === text) {
              this.currentSystemUtterance = "";
            }
          }, estimatedDuration);
        }
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

        // Clean all emotional expressions in parentheses & brackets before sending to TTS (e.g. （挥手）, (笑), [微笑])
        let cleanText = text
          .replace(/[\(\uFF08][^\)\uFF09]*[\)\uFF09]/g, "")
          .replace(/[\[\u3010][^\]\u3011]*[\]\u3011]/g, "")
          .trim();

        console.error(`[OpenCodex Voice API] Synthesizing speech via ${engine} for text: '${cleanText.substring(0, 30)}...'`);

        if (engine === "openai-compatible") {
          this.synthesizeSpeechAPI(cleanText, settings)
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
          this.synthesizeSpeechDoubao(cleanText, settings)
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
          this.synthesizeSpeechMiniMax(cleanText, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "MiniMax synthesis failed" }));
            }
          });
        } else if (engine === "mimo") {
          this.synthesizeSpeechMiMo(cleanText, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Xiaomi MiMo synthesis failed" }));
            }
          });
        } else if (engine === "kokoro") {
          this.synthesizeSpeechKokoro(cleanText, settings, (audioBuffer) => {
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

    if (path === "/api/voice/ask" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const prompt = data.prompt;
        const sessionId = data.session_id || "default";
        const startTime = Date.now() - 1000;

        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Prompt is empty" }));
          return;
        }

        // 1. Query Electron page URL via CDP to get the exact active thread ID
        let activeThreadId = "";
        const getThreadIdFromCDP = (): Promise<string> => {
          return new Promise((resolve) => {
            try {
              fetch("http://127.0.0.1:8315/json")
                .then(res => res.json())
                .then((targets: any) => {
                  const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
                  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
                    resolve("");
                    return;
                  }
                  
                  const tempWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
                  tempWs.on("open", () => {
                    tempWs.send(JSON.stringify({
                      id: 100,
                      method: "Runtime.evaluate",
                      params: {
                        expression: "window.location.href",
                        returnByValue: true
                      }
                    }));
                  });
                  tempWs.on("message", (data) => {
                    try {
                      const resObj = JSON.parse(data.toString());
                      if (resObj.id === 100) {
                        if (resObj.result?.result?.value) {
                          const href = resObj.result.result.value;
                          const match = href.match(/[?&]thread_id=([^&]+)/);
                          if (match && match[1]) {
                            console.error(`[OpenCodex Voice API] Resolved Thread ID via CDP URL: ${match[1]}`);
                            resolve(match[1]);
                            tempWs.close();
                            return;
                          }
                        }
                        resolve("");
                        tempWs.close();
                      }
                    } catch {
                      // Only close/resolve on parse error if we want to fail-safe, but let's be safe
                    }
                  });
                  tempWs.on("error", () => {
                    resolve("");
                  });
                })
                .catch(() => resolve(""));
            } catch {
              resolve("");
            }
          });
        };

        getThreadIdFromCDP().then(async (resolvedId) => {
          activeThreadId = resolvedId;
          
          // Fallback to SQLite if CDP fails to read URL
          if (!activeThreadId) {
            try {
              const dbPath = join(homedir(), ".codex", "state_5.sqlite");
              if (existsSync(dbPath)) {
                const cmd = `sqlite3 "${dbPath}" "SELECT id FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1;"`;
                const dbThreadId = execSync(cmd, { encoding: "utf-8" }).trim();
                if (dbThreadId) {
                  activeThreadId = dbThreadId;
                }
              }
            } catch {}
          }

          let result = await this.injectPromptViaCDP(prompt);
          if (result === "connection_failed") {
            console.warn("[OpenCodex Voice API] CDP connection failed. Attempting to relaunch Codex with debugging enabled...");
            this.restartCodexDesktop();
            // Wait 5 seconds for Codex to restart and open
            await new Promise((resolve) => setTimeout(resolve, 5000));
            // Retry injection
            result = await this.injectPromptViaCDP(prompt);
          }

          if (result === "success") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "injected", reply: "" }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Failed to inject prompt via CDP: ${result}` }));
          }
        });
      } catch (err: any) {
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
        const cmdPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
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
        
        const checkAndLaunch = async () => {
          let isCDPOpen = false;
          try {
            const cdpRes = await fetch("http://127.0.0.1:8315/json");
            if (cdpRes.ok) {
              isCDPOpen = true;
            }
          } catch (e) {}

          if (!isCDPOpen) {
            console.log("[OpenCodex] Proactively relaunching Codex with debugging enabled since port 8315 is closed...");
            this.restartCodexDesktop();
            // Wait 3.5 seconds for Codex to restart cleanly
            await new Promise((resolve) => setTimeout(resolve, 3500));
          }

          this.restartVoiceBar(method);
        };

        checkAndLaunch().then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", method }));
        }).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
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
      this.handleResponses(body, res, sessionId, req, rawBody);
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

  private async handleResponses(body: string, res: http.ServerResponse, sessionId?: string, req?: http.IncomingMessage, rawBody?: Buffer) {
    let reqBody: any;
    try {
      reqBody = JSON.parse(body);
      writeFileSync("/tmp/responses_request_debug.json", JSON.stringify(reqBody, null, 2), "utf-8");
    } catch (e: any) {
      console.error("[OpenCodex] Failed to parse responses JSON body:", e.message, "Length:", body.length, "First 200 chars:", body.slice(0, 200));
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
    const finalSessionId = sessionId || reqBody.client_metadata?.session_id;

    if (hasGetAppStateOutput && finalSessionId) {
      if (!this.initializedSessions.has(finalSessionId)) {
        this.initializedSessions.add(finalSessionId);
        console.log(`[OpenCodex Proxy] Detected cold-start get_app_state output for session ${finalSessionId}. Injecting 1500ms delay to allow CUA session to stabilize...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    const requestedModel = reqBody.model || "";
    
    // Resolve which actual model and provider we route to
    const catalog = this.getModelCatalog();
    let catalogEntry = catalog.models?.find((m: any) => m.slug === requestedModel);
    
    if (!catalogEntry && catalog.models && catalog.models.length > 0) {
      catalogEntry = catalog.models[0];
      console.log(`[OpenCodex Proxy] Unknown model requested in handleResponses: ${requestedModel}. Falling back to default catalog model: ${catalogEntry.slug}`);
      reqBody.model = catalogEntry.slug;
    }

    const isCustomModel = !!catalogEntry?.backend_provider;
    if (!isCustomModel && req && rawBody) {
      const isChatGptAccount = Object.keys(req.headers).some(k => k.toLowerCase() === "chatgpt-account-id");
      let targetUrl = "";
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathStr = urlObj.pathname;
      if (isChatGptAccount) {
        let subPath = pathStr;
        if (pathStr.startsWith("/v1/")) {
          subPath = pathStr.substring(4);
        }
        if (!subPath.startsWith("codex/")) {
          subPath = "codex/" + subPath;
        }
        targetUrl = `https://chatgpt.com/backend-api/${subPath}${urlObj.search}`;
      } else {
        targetUrl = pathStr.startsWith("/v1/")
          ? `https://api.openai.com${pathStr}${urlObj.search}`
          : `https://chatgpt.com${pathStr}${urlObj.search}`;
      }

      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length" || key.toLowerCase() === "accept-encoding") {
          continue;
        }
        headers[key] = Array.isArray(val) ? val[0] : (val || "");
      }
      
      let realToken = "";
      const authPath = join(homedir(), ".codex", "auth.json");
      if (existsSync(authPath)) {
        try {
          const authData = JSON.parse(readFileSync(authPath, "utf-8"));
          if (authData.tokens && authData.tokens.access_token) {
            realToken = authData.tokens.access_token;
          }
        } catch {}
      }
      if (realToken && !headers["authorization"]) {
        headers["authorization"] = `Bearer ${realToken}`;
      }

      try {
        // An official-model request can follow a third-party turn in the
        // same desktop thread. Remove only gateway-local items before the
        // request reaches the official Responses service.
        sanitizeResponsesForOfficial(reqBody);
        console.log(`[OpenCodex Proxy] Forwarding HTTP ${req.method} for official model to: ${targetUrl}`);
        const officialRes = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: JSON.stringify(reqBody),
          dispatcher: fetchDispatcher
        });

        console.log(`[OpenCodex Proxy] Official server HTTP response status: ${officialRes.status}`);
        res.writeHead(officialRes.status, {
          "Content-Type": officialRes.headers.get("content-type") || "application/json"
        });
        const bodyReader = officialRes.body;
        if (bodyReader) {
          // @ts-ignore
          for await (const chunk of bodyReader) {
            res.write(chunk);
          }
        }
        res.end();
        return;
      } catch (err: any) {
        console.error(`[OpenCodex Proxy] Failed to forward HTTP request to official server: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to forward request to official server: ${err.message}` }));
        return;
      }
    }

    const mappedModelName = (catalogEntry && catalogEntry.backend_model) ? catalogEntry.backend_model : ((catalogEntry && catalogEntry.model) ? catalogEntry.model : requestedModel);

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

    const chatBody = responsesToChat(processedReqBody, upstreamModel, finalSessionId);
    
    // Maintain conversation history locally in the proxy as the client does not send full history in input.
    const sessionIdStr = finalSessionId ? String(finalSessionId) : "default";
    
    if (isCustomModel) {
      this.customModelSessions.add(sessionIdStr);
    } else {
      this.customModelSessions.delete(sessionIdStr);
    }

        const isFirstTurn = !processedReqBody.previous_response_id;
    
    if (isFirstTurn) {
      this.customConversationHistory.set(sessionIdStr, chatBody.messages);
    } else {
      const existingHistory = this.customConversationHistory.get(sessionIdStr) || [];
      if (existingHistory.length === 0) {
        this.customConversationHistory.set(sessionIdStr, chatBody.messages);
      } else {
        const incomingMessages = chatBody.messages.filter((m: any) => m.role !== "system");
        const updatedHistory = mergeHistory(existingHistory, incomingMessages);
        this.customConversationHistory.set(sessionIdStr, updatedHistory);
      }
    }
    chatBody.messages = (this.customConversationHistory.get(sessionIdStr) || []).map((m: any) => {
      if (m.role === "assistant" && !m.content && (!m.tool_calls || m.tool_calls.length === 0)) {
        return { ...m, content: " " };
      }
      return m;
    });

    const namespaceMap = extractNamespaceMap(processedReqBody.tools);

    try {
      if (isStream) {
        await this.streamResponses(chatBody, provider, requestedModel, apiKey, namespaceMap, res, finalSessionId);
      } else {
        await this.nonStreamResponses(chatBody, provider, requestedModel, apiKey, namespaceMap, res, finalSessionId);
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
    res: http.ServerResponse,
    sessionId?: string
  ) {
    const response = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher
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

    const streamState = new ResponsesStreamState(
      requestedModel,
      namespaceMap,
      sessionId,
      (textChunk) => {
        // Broadcast streaming text chunk to all client apps
        const msg = JSON.stringify({ type: "model_chunk", text: textChunk });
        for (const wsClient of this.activeWsClients) {
          try { wsClient.send(msg); } catch {}
        }
      },
      (fullText) => {
        // Broadcast completion message to all client apps
        const msg = JSON.stringify({ type: "model_done", text: fullText });
        for (const wsClient of this.activeWsClients) {
          try { wsClient.send(msg); } catch {}
        }
      }
    );
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

    const assistantMsg = streamState.getAssistantMessage();
    if (assistantMsg) {
      const sessionIdStr = sessionId ? String(sessionId) : "default";
      const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
      this.customConversationHistory.set(sessionIdStr, currentHistory.concat(assistantMsg));
    }
  }

  private async nonStreamResponses(
    body: any,
    provider: ProviderConfig,
    requestedModel: string,
    apiKey: string,
    namespaceMap: Record<string, string>,
    res: http.ServerResponse,
    sessionId?: string
  ) {
    const r = await fetch(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher
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

    const choice = (data.choices || [{}])[0];
    const message = choice.message;
    if (message) {
      const sessionIdStr = sessionId ? String(sessionId) : "default";
      const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
      this.customConversationHistory.set(sessionIdStr, currentHistory.concat(message));
    }
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
    let catalogEntry = catalog.models?.find((m: any) => m.slug === model);
    
    if (!catalogEntry && catalog.models && catalog.models.length > 0) {
      catalogEntry = catalog.models[0];
      console.log(`[OpenCodex Proxy] Unknown model requested in handleChat: ${model}. Falling back to default catalog model: ${catalogEntry.slug}`);
      reqBody.model = catalogEntry.slug;
    }

    const provider = this.findProvider(reqBody.model, catalogEntry);
    
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
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher
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
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher
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

    let accumulatedText = "";
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
            const rawChunk = trimmed.slice(6);
            res.write(`data: ${rawChunk}\n\n`);
            
            const parsed = JSON.parse(rawChunk);
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              accumulatedText += content;
              const msg = JSON.stringify({ type: "model_chunk", text: content });
              for (const wsClient of this.activeWsClients) {
                try { wsClient.send(msg); } catch {}
              }
            }
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Broadcast done signal to APP
    const doneMsg = JSON.stringify({ type: "model_done", text: accumulatedText });
    for (const wsClient of this.activeWsClients) {
      try { wsClient.send(doneMsg); } catch {}
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
    appendField("language", "zh");
    appendField("prompt", "简体中文");
    appendFile("file", "speech.wav", audioData);
    payload = Buffer.concat([payload, Buffer.from(`--${boundary}--\r\n`)]);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body: payload,
      dispatcher: fetchDispatcher
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
      body: JSON.stringify({ model, input: text, voice }),
      dispatcher: fetchDispatcher
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
    const voiceId = settings.tts_voice || "presenter_female";
    
    let modelName = settings.tts_model || "speech-2.8-hd";
    if (modelName === "tts-1" || modelName === "tts-1-hd" || !modelName.startsWith("speech-")) {
      modelName = "speech-2.8-hd";
    }

    const speed = (settings.tts_speed !== undefined) ? parseFloat(settings.tts_speed.toString()) : 
                  (settings.speed !== undefined) ? parseFloat(settings.speed.toString()) : 1.2;

    const wsUrl = "wss://api.minimaxi.com/ws/v1/t2a_v2";
    const wsClient = new WebSocket(wsUrl, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });

    let audioBuffer = Buffer.alloc(0);

    wsClient.on("open", () => {
      const startPayload = {
        event: "task_start",
        model: modelName,
        voice_setting: {
          voice_id: voiceId,
          speed: speed,
        },
        audio_setting: {
          sample_rate: 24000,
          format: "mp3", // OpenCodexBar expects mp3 format
          channel: 1,
        },
      };
      wsClient.send(JSON.stringify(startPayload));
    });

    wsClient.on("message", (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        if (msg.event === "task_started") {
          const continuePayload = {
            event: "task_continue",
            text: text
          };
          wsClient.send(JSON.stringify(continuePayload));
          return;
        }

        const audioHex = msg.data?.audio || "";
        if (audioHex) {
          const chunk = Buffer.from(audioHex, "hex");
          audioBuffer = Buffer.concat([audioBuffer, chunk]);
        }

        if (msg.is_final) {
          wsClient.send(JSON.stringify({ event: "task_finish" }));
          wsClient.close();
          cb(audioBuffer);
        }
      } catch (err: any) {
        console.error(`[OpenCodex MiniMax WS Msg Err] ${err.message}`);
        wsClient.close();
        cb(null);
      }
    });

    wsClient.on("error", (err) => {
      console.error(`[OpenCodex MiniMax WS Client Err] ${err.message}`);
      cb(null);
    });
  }

  private async synthesizeSpeechMiMo(text: string, settings: any, cb: (data: Buffer | null) => void) {
    const apiKey = settings.tts_api_key || "";
    const apiHost = settings.tts_base_url || "https://api.xiaomimimo.com";
    const voiceId = settings.tts_voice || "Chloe";
    
    // We can allow users to inject tone style via assistant personality prompt or default to a standard one
    const stylePrompt = settings.voice_system_prompt || "Natural, clear and friendly tone, standard pace.";

    try {
      const response = await fetch(`${apiHost}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "mimo-v2.5-tts",
          messages: [
            {
              role: "user",
              content: stylePrompt
            },
            {
              role: "assistant",
              content: text
            }
          ],
          audio: {
            format: "mp3", // OpenCodex-bar handles mp3 natively
            voice: voiceId
          },
          stream: false
        }),
        dispatcher: fetchDispatcher
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[MiMo TTS Err] Http Status ${response.status}: ${errText}`);
        return cb(null);
      }

      const resJson: any = await response.json();
      const audioBase64 = resJson.choices?.[0]?.message?.audio?.data;
      if (!audioBase64) {
        console.error(`[MiMo TTS Err] No audio data found in response: ${JSON.stringify(resJson)}`);
        return cb(null);
      }

      const audioBuffer = Buffer.from(audioBase64, "base64");
      cb(audioBuffer);
    } catch (err: any) {
      console.error(`[MiMo TTS Err] Exception: ${err.message}`);
      cb(null);
    }
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

    const speed = (settings.tts_speed !== undefined) ? parseFloat(settings.tts_speed.toString()) : 1.2;
    let edgeTtsCmd = "edge-tts";
    let args = ["--voice", voice, "--text", text, "--write-media", tempOutput];
    if (speed !== 1.0) {
      const pct = Math.round((speed - 1.0) * 100);
      const rateStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
      args.push("--rate", rateStr);
    }
    
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
    let baseUrl = settings.tts_base_url || "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
    if (baseUrl.includes("api.openai.com")) {
      baseUrl = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
    }
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
      if (modelVal === "tts-1" || modelVal === "seed-tts-2.0") {
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
      body: JSON.stringify(bodyPayload),
      dispatcher: fetchDispatcher
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
  private desktopWsClients = new Set<WebSocket>();

  private logWSPacket(direction: "IN" | "OUT", payload: any, sessionId?: string) {
    const line = `[${new Date().toISOString()}] [${direction}] [Session: ${sessionId || "unknown"}] ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n`;
    try {
      appendFileSync("/Users/aitabby/projects/opencodex/ws_packets.log", line, "utf-8");
    } catch (e) {}
  }
  private activeConnectionsBySession = new Map<string, {
    clientWs: WebSocket;
    targetWs: WebSocket | null;
    headers: http.IncomingHttpHeaders;
    lastMsg: any;
  }>();
  private lastActiveConnection: {
    clientWs: WebSocket;
    targetWs: WebSocket | null;
    headers: http.IncomingHttpHeaders;
    lastMsg: any;
  } | null = null;

  public simulateMessagePushToDesktop(sessionId: string, prompt: string, reply: string) {
    console.error(`[OpenCodex Sync] Simulating Responses protocol push to Desktop Webview for session: ${sessionId}`);
    
    // Format conforming to standard responses protocol events
    const respId = `resp_${Date.now()}`;
    const userMsgId = `msg_user_${Date.now()}`;
    const assistantMsgId = `msg_ast_${Date.now()}`;

    const payloads = [
      // 1. Response created
      {
        type: "response.created",
        response: {
          id: respId,
          status: "in_progress",
          model: "opencodex-voice-bridge",
          output: []
        }
      },
      // 2. User prompt message item added
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: userMsgId,
          type: "message",
          status: "completed",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      },
      // 3. User message done
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: userMsgId,
          type: "message",
          status: "completed",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      },
      // 4. Assistant reply message item added
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: assistantMsgId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: []
        }
      },
      // 5. Assistant part added
      {
        type: "response.content_part.added",
        item_id: assistantMsgId,
        output_index: 1,
        content_index: 0,
        part: { type: "output_text", text: reply, annotations: [] }
      },
      // 6. Assistant text done
      {
        type: "response.output_text.done",
        item_id: assistantMsgId,
        output_index: 1,
        content_index: 0,
        text: reply
      },
      // 7. Assistant output item done
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: assistantMsgId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: reply, annotations: [] }]
        }
      },
      // 8. Response completed
      {
        type: "response.completed",
        response: {
          id: respId,
          status: "completed",
          model: "opencodex-voice-bridge",
          output: [
            {
              id: assistantMsgId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: reply, annotations: [] }]
            }
          ]
        }
      }
    ];

    try {
      const allWs = new Set([...this.activeWsClients, ...this.desktopWsClients]);
      for (const ws of allWs) {
        if (ws.readyState === 1 /* OPEN */) {
          for (const payload of payloads) {
            ws.send(JSON.stringify(payload));
          }
        }
      }
    } catch (err: any) {
      console.error(`[OpenCodex Sync Err] Failed to send simulated responses: ${err.message}`);
    }
  }

  public broadcastSession(sessionId: string) {
    const payload = JSON.stringify({
      type: "activate_session",
      session_id: sessionId
    });
    const allWs = new Set([...this.activeWsClients, ...this.desktopWsClients]);
    for (const ws of allWs) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  public handleWebSocketConnection(ws: WebSocket) {
    this.activeWsClients.add(ws);
    let audioBuffer = Buffer.alloc(0);
    let isListening = false;
    let lastProcessedLength = 0;
    let lastVADCheckedLength = 0;
    let chunkInterval: NodeJS.Timeout | null = null;
    let isProcessingChunk = false;
    let lastSpeechActivityTime = Date.now();
    let hasSentFinal = false;
    let lastTranscribedText = "";
    let consecutiveSilenceCount = 0;
    let speechDetected = false;
    let silenceStartTime = 0;

    // Helper to clear timer
    const clearChunkInterval = () => {
      if (chunkInterval) {
        clearInterval(chunkInterval);
        chunkInterval = null;
      }
    };

    // Semantic VAD: Decides if we can cut off early based on transcribed text and time since last sound
    const checkSemanticVAD = async (text: string) => {
      if (hasSentFinal) return;
      const trimmed = text.trim();
      if (trimmed.length < 2) return;

      // Semantic AEC: Check if this is an echo of the system's TTS
      if (this.currentSystemUtterance && this.currentSystemUtterance.length > 0) {
        if (trimmed.length <= 2 && trimmed.match(/^[啊嗯哦哈呀啦呢罢了的得地吗？。！]+$/)) {
          return;
        }
        const cleanTrimmed = trimmed.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
        const cleanUtterance = this.currentSystemUtterance.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
        let isEcho = false;
        if (cleanUtterance.includes(cleanTrimmed)) {
          isEcho = true;
        } else if (cleanTrimmed.includes(cleanUtterance) && cleanTrimmed.length <= cleanUtterance.length + 3) {
          isEcho = true;
        }
        
        if (isEcho) {
          console.error(`[Semantic AEC] Ignored echo text: "${trimmed}"`);
          audioBuffer = Buffer.alloc(0); // clear buffer to drop the echo
          lastVADCheckedLength = 0;
          return;
        }
        
        console.error(`[Semantic AEC] Interruption detected! User said: "${trimmed}" while system was saying: "${this.currentSystemUtterance}"`);
        this.currentSystemUtterance = ""; // Clear it so we don't block subsequent speech
        triggerSpeechEnd(trimmed);
        return;
      }

      // Common final Chinese particles and signs
      const endParticles = ["吗", "呢", "了", "吧", "哈", "呀", "啊", "啦", "吗？", "呢？", "吧？", "呀？", "谢谢", "就可以了", "怎么做", "怎么办", "什么意思", "。", "？", "！"];
      const matchesEnd = endParticles.some(p => trimmed.endsWith(p));

      // Calculate if the transcription has stopped growing (indicating the user paused/stopped speaking)
      if (trimmed === lastTranscribedText) {
        consecutiveSilenceCount++;
      } else {
        consecutiveSilenceCount = 0;
        lastTranscribedText = trimmed;
      }

      // We only cut off if we detected a sentence-end particle AND a brief silence pause (at least 2 chunk durations, ~800ms)
      if (matchesEnd && consecutiveSilenceCount >= 2) {
        console.error(`[Semantic VAD] Finished sentence pattern detected with active pause: "${trimmed}"`);
        triggerSpeechEnd(trimmed);
      }
    };

    const triggerSpeechEnd = async (finalText: string) => {
      if (hasSentFinal) return;
      hasSentFinal = true;
      isListening = false;
      clearChunkInterval();

      console.error(`[Semantic VAD] Triggering early speech end. Final Text: "${finalText}"`);

      // 1. Tell client to stop immediately and transition to loading state
      ws.send(JSON.stringify({
        type: "stop_recording",
        text: finalText
      }));

      // 2. Deliver transcription directly as final
      ws.send(JSON.stringify({
        type: "transcription_final",
        text: finalText
      }));
    };

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        if (isListening) {
          const buf = data as Buffer;
          audioBuffer = Buffer.concat([audioBuffer, buf]);

          // Run Silero VAD check if we have enough accumulated audio buffer (check every 320ms / 5120 samples)
          const checkSize = 10240; // 5120 samples
          if (audioBuffer.length >= checkSize && (audioBuffer.length - lastVADCheckedLength) >= 5120) {
            lastVADCheckedLength = audioBuffer.length;
            const startIdx = audioBuffer.length - 10240;
            const newChunk = audioBuffer.slice(startIdx, audioBuffer.length);
            const b64Data = newChunk.toString("base64");
            
            this.sendVADRequest({ action: "chunk", data: b64Data }).then(async (vadResult) => {
              if (vadResult.error) {
                console.error(`[Silero VAD Daemon Error] ${vadResult.error}`);
                return;
              }
              if (vadResult.has_speech) {
                speechDetected = true;
                
                // Read dynamic vad_duration from settings
                let silenceThreshold = 0.8;
                const p = join(this.configDir, "voice_settings.json");
                if (existsSync(p)) {
                  try {
                    const settings = JSON.parse(readFileSync(p, "utf-8"));
                    if (settings.vad_duration !== undefined) {
                      silenceThreshold = parseFloat(settings.vad_duration);
                    }
                  } catch {}
                }
                
                // If silence at end exceeds threshold, trigger finalization
                if (vadResult.silence_at_end >= silenceThreshold) {
                  console.error(`[Silero VAD] Speech ended with silence duration: ${vadResult.silence_at_end.toFixed(2)}s (threshold: ${silenceThreshold}s)`);
                  
                  isListening = false;
                  clearChunkInterval();
                  if (!hasSentFinal) {
                    console.error(`[Silero VAD] Triggering early stop stt`);
                    hasSentFinal = true;
                    // Instantly notify client to stop recording and show thinking animation
                    ws.send(JSON.stringify({
                      type: "stop_recording",
                      text: lastTranscribedText
                    }));
                    await this.processWebSocketSTT(ws, audioBuffer, lastTranscribedText);
                  }
                }
              }
            }).catch(err => {
              console.error(`[Silero VAD Daemon Promise Err] ${err.message}`);
            });
          }
        }
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start_stt") {
          this.sendVADRequest({ action: "reset" });
          audioBuffer = Buffer.alloc(0);
          lastVADCheckedLength = 0;
          this.currentSystemUtterance = "";
          lastProcessedLength = 0;
          lastTranscribedText = "";
          consecutiveSilenceCount = 0;
          isListening = true;
          isProcessingChunk = false;
          hasSentFinal = false;
          speechDetected = false;
          silenceStartTime = 0;
          lastSpeechActivityTime = Date.now();
          console.error("[WebSocket STT] Listening started...");

          // Periodically check/transcribe current buffer
          clearChunkInterval();
          chunkInterval = setInterval(async () => {
            if (!isListening || isProcessingChunk || hasSentFinal || !speechDetected) return;
            // Wait for at least 0.5 second of audio to start slicing
            if (audioBuffer.length < 16000) return; 

            // Only transcribe if we have new data
            if (audioBuffer.length > lastProcessedLength + 8000) {
              isProcessingChunk = true;
              try {
                const currentBuffer = audioBuffer; // Capture snapshot
                lastProcessedLength = currentBuffer.length;
                
                const p = join(this.configDir, "voice_settings.json");
                let settings: any = {
                  stt_engine: "local-whisper",
                  stt_api_key: "",
                  stt_base_url: "https://api.openai.com/v1",
                  stt_model: "whisper-1"
                };
                if (existsSync(p)) {
                  try { settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) }; } catch {}
                }

                const wavBuffer = pcmToWav(currentBuffer, 16000, 1, 16);
                const tmpWavPath = `/tmp/ws_chunk_${Date.now()}.wav`;
                writeFileSync(tmpWavPath, wavBuffer);

                let text = "";
                const isAPI = settings.stt_engine === "openai-compatible" || settings.stt_engine === "groq" || (settings.stt_api_key && settings.stt_api_key.startsWith("gsk_")) || settings.stt_base_url.includes("groq");
                if (isAPI) {
                  text = await this.transcribeAudioAPI(tmpWavPath, settings);
                } else {
                  text = await new Promise<string>((resolve) => {
                    this.transcribeAudioLocal(tmpWavPath, (resText) => {
                      resolve(resText || "");
                    });
                  });
                }

                try { unlinkSync(tmpWavPath); } catch {}

                if (text && text.trim().length > 0) {
                  console.error(`[WebSocket STT Chunk] Current transcript: "${text}"`);
                  // Notify visualizer or dashboard about progress
                  ws.send(JSON.stringify({
                    type: "transcription_partial",
                    text: text
                  }));

                  // Check if this text meets the finality criteria
                  await checkSemanticVAD(text);
                }
              } catch (err: any) {
                console.error(`[WebSocket STT Chunk Error] ${err.message}`);
              } finally {
                isProcessingChunk = false;
              }
            }
          }, 400); // Check every 400ms

        } else if (msg.type === "stop_stt") {
          isListening = false;
          clearChunkInterval();
          if (!hasSentFinal) {
            console.error(`[WebSocket STT] Listening stopped. Final processing. Audio size: ${audioBuffer.length} bytes`);
            await this.processWebSocketSTT(ws, audioBuffer, lastTranscribedText);
            hasSentFinal = true;
          }
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
      clearChunkInterval();
      audioBuffer = Buffer.alloc(0);
    });
  }

  private async processWebSocketSTT(ws: WebSocket, pcmBuffer: Buffer, fallbackText: string = "") {
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
      const isAPI = settings.stt_engine === "openai-compatible" || settings.stt_engine === "groq" || (settings.stt_api_key && settings.stt_api_key.startsWith("gsk_")) || settings.stt_base_url.includes("groq");

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

      // Prevent Whisper hallucinations (e.g. "......", dropping words) on abrupt cutoffs
      const cleanText = text.replace(/^[。！？\.\s]+|[。！？\.\s]+$/g, '');
      if (cleanText.length === 0 || text.includes('......') || text.includes('。。。') || (text.length < fallbackText.length - 3 && fallbackText.length > 0)) {
        console.error(`[WebSocket STT] Hallucination/Drop detected ("${text}"), using fallback: "${fallbackText}"`);
        text = fallbackText;
      }

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

  private async handleLocalResponsesWebSocketInline(ws: WebSocket, reqBody: any, connInfo: { headers: any; activeSessionId?: string }) {
    const clientHeaders = connInfo.headers;
    const sidHeader = clientHeaders["x-session-id"] || clientHeaders["session-id"] || "";
    const sessionId = reqBody.client_metadata?.session_id || connInfo.activeSessionId || (Array.isArray(sidHeader) ? sidHeader[0] : sidHeader);
    const sessionIdStr = sessionId ? String(sessionId) : "default";

    const previous = this.customSessionQueues.get(ws) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.handleLocalResponsesWebSocketInlineQueued(ws, reqBody, connInfo, sessionId, sessionIdStr));
    this.customSessionQueues.set(ws, current);
    try {
      await current;
    } finally {
      if (this.customSessionQueues.get(ws) === current) {
        this.customSessionQueues.delete(ws);
      }
    }
  }

  private async handleLocalResponsesWebSocketInlineQueued(ws: WebSocket, reqBody: any, connInfo: { headers: any; activeSessionId?: string }, sessionId: any, sessionIdStr: string) {
    (ws as any).sessionId = sessionIdStr;
    const clientHeaders = connInfo.headers;
    const requestedModel = reqBody.model || "";
    const isStream = reqBody.stream ?? true;

    const broadcastToClients = (payload: any) => {
      const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      this.logWSPacket("OUT", payload, sessionIdStr);
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payloadStr); } catch {}
      }
      for (const otherWs of this.desktopWsClients) {
        if (otherWs !== ws && (otherWs as any).sessionId === sessionIdStr && otherWs.readyState === WebSocket.OPEN) {
          try { otherWs.send(payloadStr); } catch {}
        }
      }
    };

    const sendDirect = (payload: any) => {
      const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      this.logWSPacket("OUT", payload, sessionIdStr);
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payloadStr); } catch {}
      }
    };

    // Intercept title prompt locally and simulate a quick structured JSON response
    let isTitlePrompt = false;
    const instructionsStr = reqBody.instructions || "";
    if (instructionsStr.includes("provide a short title") || instructionsStr.includes("task title based solely on the prompt")) {
      isTitlePrompt = true;
    }
    if (Array.isArray(reqBody.input)) {
      for (const item of reqBody.input) {
        if (item.content && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.text && (part.text.includes("provide a short title") || part.text.includes("task title based solely on the prompt"))) {
              isTitlePrompt = true;
            }
          }
        }
        if (typeof item.content === "string" && (item.content.includes("provide a short title") || item.content.includes("task title based solely on the prompt"))) {
          isTitlePrompt = true;
        }
      }
    }

    if (isTitlePrompt) {
      console.log(`[DEBUG-TITLE-GENERATION] Simulating title response locally.`);
      let userPrompt = "Coding Task";
      if (Array.isArray(reqBody.input)) {
        for (const item of reqBody.input) {
          if (item.role === "user" && item.content && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.text) {
                if (part.text.includes("User prompt:\n")) {
                  const idx = part.text.indexOf("User prompt:\n");
                  userPrompt = part.text.slice(idx + 12).trim().substring(0, 20);
                } else if (!part.text.includes("provide a short title") && !part.text.includes("task title based solely on the prompt")) {
                  userPrompt = part.text.trim().substring(0, 20);
                }
              }
            }
          }
        }
      }
      const titleJson = JSON.stringify({
        title: userPrompt || "Coding Task",
        description: "Conversation with Codex"
      });

      const responseMetadata = {
        session_id: reqBody.client_metadata?.session_id || sessionIdStr,
        thread_id: reqBody.client_metadata?.thread_id,
        turn_id: reqBody.client_metadata?.turn_id,
        "x-codex-turn-metadata": reqBody.client_metadata?.["x-codex-turn-metadata"],
      };

      const namespaceMap = extractNamespaceMap(reqBody.tools);
      const streamState = new ResponsesStreamState(
        requestedModel,
        namespaceMap,
        sessionId,
        (textChunk) => {
          const msg = JSON.stringify({ type: "model_chunk", text: textChunk });
          for (const wsClient of this.activeWsClients) {
            try { wsClient.send(msg); } catch {}
          }
        },
        (fullText) => {
          const msg = JSON.stringify({ type: "model_done", text: fullText });
          for (const wsClient of this.activeWsClients) {
            try { wsClient.send(msg); } catch {}
          }
        },
        responseMetadata,
        false,
        {
          get: () => this.sessionSequenceNumberMap.get(sessionIdStr) || 1,
          set: (seq: number) => this.sessionSequenceNumberMap.set(sessionIdStr, seq)
        }
      );
      await streamState.start(async (payload: any) => {
        sendDirect(payload);
      });
      await streamState.writeChatDelta(async (payload: any) => {
        sendDirect(payload);
      }, {
        choices: [{
          delta: {
            content: titleJson
          }
        }]
      });
      await streamState.finish(async (payload: any) => {
        sendDirect(payload);
      });
      return;
    }

    const turnMetadataStr = reqBody.client_metadata?.["x-codex-turn-metadata"];
    let isPrewarm = false;
    if (turnMetadataStr) {
      try {
        const parsed = JSON.parse(turnMetadataStr);
        if (parsed.request_kind === "prewarm") {
          isPrewarm = true;
        }
      } catch {}
    }
    if (!isPrewarm && (!reqBody.input || reqBody.input.length === 0)) {
      isPrewarm = true;
    }



    try {
      writeFileSync("/Users/aitabby/projects/opencodex/debug_req.json", JSON.stringify(reqBody, null, 2), "utf-8");
    } catch (e) {}
    const catalog = this.getModelCatalog();
    let catalogEntry = catalog.models?.find((m: any) => m.slug === requestedModel);
    
    if (!catalogEntry && catalog.models && catalog.models.length > 0) {
      catalogEntry = catalog.models[0];
      reqBody.model = catalogEntry.slug;
    }

    if (!catalogEntry?.backend_provider) {
      ws.send(JSON.stringify({ error: { message: `Native model requested locally: ${requestedModel}` } }));
      return;
    }

    const mappedModelName = (catalogEntry && catalogEntry.backend_model) ? catalogEntry.backend_model : ((catalogEntry && catalogEntry.model) ? catalogEntry.model : requestedModel);
    const provider = this.findProvider(mappedModelName, catalogEntry);
    if (!provider) {
      ws.send(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}` } }));
      return;
    }

    const apiKey = this.resolveKey(provider.api_key);
    if (!apiKey) {
      ws.send(JSON.stringify({ error: { message: `API Key is missing. Configure keys via http://localhost:8765/dashboard` } }));
      return;
    }

    const callVisionBridge = catalogEntry ? !!catalogEntry.vision_bridge_enabled : false;
    const processedReqBody = await processVisionBridge(reqBody, callVisionBridge ? this.config : undefined);

    const chatBody = responsesToChat(processedReqBody, mappedModelName, sessionId);
    
    // Maintain conversation history locally in the proxy as the client does not send full history in input.
    this.customModelSessions.add(sessionIdStr);
    const isFirstTurn = !processedReqBody.previous_response_id;
    
    if (isFirstTurn) {
      this.customConversationHistory.set(sessionIdStr, chatBody.messages);
    } else {
      const existingHistory = this.customConversationHistory.get(sessionIdStr) || [];
      if (existingHistory.length === 0) {
        this.customConversationHistory.set(sessionIdStr, chatBody.messages);
      } else {
        const incomingMessages = chatBody.messages.filter((m: any) => m.role !== "system");
        const updatedHistory = mergeHistory(existingHistory, incomingMessages);
        this.customConversationHistory.set(sessionIdStr, updatedHistory);
      }
    }
    chatBody.messages = (this.customConversationHistory.get(sessionIdStr) || []).map((m: any) => {
      if (m.role === "assistant" && !m.content && (!m.tool_calls || m.tool_calls.length === 0)) {
        return { ...m, content: " " };
      }
      return m;
    });

    // Sanitize empty/null content fields for MiniMax model
    if (mappedModelName.toLowerCase().includes("minimax")) {
      for (const m of chatBody.messages) {
        if (m.content === null || m.content === undefined || m.content === "") {
          m.content = " ";
        }
      }
      const hasUser = chatBody.messages.some((m: any) => m.role === "user");
      if (!hasUser) {
        chatBody.messages.push({ role: "user", content: " " });
      }
    }

    const namespaceMap = extractNamespaceMap(processedReqBody.tools);
    let streamState: ResponsesStreamState | null = null;

    if (isStream) {
      console.log(`[OpenCodex WS Proxy] Instantiating streamState before fetch...`);
      const responseMetadata = {
        session_id: reqBody.client_metadata?.session_id || sessionIdStr,
        thread_id: reqBody.client_metadata?.thread_id,
        turn_id: reqBody.client_metadata?.turn_id,
        "x-codex-turn-metadata": reqBody.client_metadata?.["x-codex-turn-metadata"],
      };

      streamState = new ResponsesStreamState(
        requestedModel,
        namespaceMap,
        sessionId,
        (textChunk) => {
          const msg = JSON.stringify({ type: "model_chunk", text: textChunk });
          for (const wsClient of this.activeWsClients) {
            try { wsClient.send(msg); } catch {}
          }
        },
        (fullText) => {
          const msg = JSON.stringify({ type: "model_done", text: fullText });
          for (const wsClient of this.activeWsClients) {
            try { wsClient.send(msg); } catch {}
          }
        },
        responseMetadata,
        false,
        {
          get: () => this.sessionSequenceNumberMap.get(sessionIdStr) || 1,
          set: (seq: number) => this.sessionSequenceNumberMap.set(sessionIdStr, seq)
        }
      );
      const hasActiveDesktop = Array.from(this.desktopWsClients).some(
        (c: any) => c.sessionId === sessionIdStr
      );
      if (!hasActiveDesktop) {
        console.log(`[OpenCodex WS Proxy] No active desktop connection for session ${sessionIdStr} yet. Delaying stream start by 500ms...`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await streamState.start(async (payload) => {
        broadcastToClients(payload);
      });
      if (isPrewarm) {
        console.log(`[OpenCodex WS Proxy] Simulating prewarm response locally...`);
        await streamState.finish(async (payload) => {
          broadcastToClients(payload);
        });
        return;
      }
    }

    if (catalogEntry?.backend_provider === "antigravity") {
      let antigravityStreamFinalized = false;
      try {
        console.log(`[OpenCodex WS Proxy] Routing to Antigravity streamGenerateContent API...`);
        const token = this.resolveKey("antigravity-cli-auto");
        
        let originalModel = catalogEntry.slug || requestedModel;
        if (originalModel.includes("flash")) originalModel = "gemini-3.5-flash-low";
        else if (originalModel.includes("pro") || originalModel.includes("claude") || originalModel.includes("sonnet") || originalModel.includes("opus") || originalModel === "gpt-5.5" || originalModel === "gpt-5.6-terra") originalModel = "gemini-3.1-pro-low";
        else if (originalModel === "gpt-5.4-mini") originalModel = "gemini-3.5-flash-low";
        else originalModel = "gemini-3.5-flash-low";

        console.log(`[OpenCodex WS Proxy] Mapped model: ${requestedModel} -> ${originalModel}`);

        const contents: any[] = [];
        for (const m of chatBody.messages) {
          if (m.role === "system") continue;
          const role = m.role === "assistant" ? "model" : "user";
          const text = m.content || "";
          if (contents.length > 0 && contents[contents.length - 1].role === role) {
            contents[contents.length - 1].parts[0].text += "\n" + text;
          } else {
            contents.push({
              role,
              parts: [{ text }]
            });
          }
        }
        if (contents.length > 0 && contents[0].role === "model") {
          contents.unshift({
            role: "user",
            parts: [{ text: "Hello" }]
          });
        }

        const antigravityPayload = {
          project: "default-cli-project",
          model: originalModel,
          request: {
            contents: contents,
            generationConfig: {}
          }
        };

        const antigravityAbort = new AbortController();
        const antigravityTimeout = setTimeout(() => antigravityAbort.abort(), 120000);
        const response = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/hub/2.2.1 darwin/arm64",
            "Accept-Encoding": "gzip"
          },
          body: JSON.stringify(antigravityPayload),
          signal: antigravityAbort.signal,
          dispatcher: fetchDispatcher
        });
        clearTimeout(antigravityTimeout);

        console.log(`[OpenCodex WS Proxy] Antigravity response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          let userFriendlyMsg = `Antigravity API Error: ${response.status} - ${errorText}`;
          if (response.status === 401) {
            // Do not keep serving an expired OAuth token on the next turn.
            // The Antigravity CLI may refresh the Keychain entry independently.
            this.antigravityTokenCache = "";
            this.antigravityTokenCacheTime = 0;
            this.antigravityTokenExpiry = 0;
            userFriendlyMsg = `[OpenCodex Proxy Error] Antigravity 登录凭证已过期/无效，请在终端（PowerShell 或 CMD）运行 "agy login" 重新登录激活权限！`;
          }
          console.error(userFriendlyMsg);
          if (isStream && streamState && !antigravityStreamFinalized) {
            try {
              await streamState.finish(async (payload) => {
                broadcastToClients(payload);
              });
              antigravityStreamFinalized = true;
            } catch {}
          }
          ws.send(JSON.stringify({ error: { message: userFriendlyMsg } }));
          return;
        }

        if (isStream && streamState) {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          const processAntigravitySseLine = async (line: string) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]" || !trimmed.startsWith("data: ")) return;
            try {
              const data = JSON.parse(trimmed.slice(6));
              const parts = data.response?.candidates?.[0]?.content?.parts
                || data.candidates?.[0]?.content?.parts
                || [];
              const text = Array.isArray(parts)
                ? parts.map((part: any) => typeof part?.text === "string" ? part.text : "").join("")
                : "";
              if (text) {
                await streamState.writeChatDelta(async (payload) => {
                  broadcastToClients(payload);
                }, { choices: [{ delta: { content: text } }] });
              }
            } catch (pe: any) {
              console.error(`[OpenCodex WS Proxy] Antigravity parse chunk error: ${pe.message}`);
            }
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                // Some SSE servers close without a final blank line. Flush
                // the last complete JSON event instead of silently dropping it.
                if (buffer.trim()) await processAntigravitySseLine(buffer);
                break;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                await processAntigravitySseLine(line);
              }
            }
          } finally {
            reader.releaseLock();
          }

          console.log(`[OpenCodex WS Proxy] Finalizing Antigravity stream...`);
          await streamState.finish(async (payload) => {
            broadcastToClients(payload);
          });
          antigravityStreamFinalized = true;

          const assistantMsg = streamState.getAssistantMessage();
          if (assistantMsg) {
            const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
            this.customConversationHistory.set(sessionIdStr, currentHistory.concat(assistantMsg));
          }
        }
        return;
      } catch (err: any) {
        console.error(`[OpenCodex WS Proxy Antigravity Handler Error] ${err.message}`);
        if (isStream && streamState && !antigravityStreamFinalized) {
          try {
            await streamState.finish(async (payload) => {
              broadcastToClients(payload);
            });
            antigravityStreamFinalized = true;
          } catch {}
        }
        ws.send(JSON.stringify({ error: { message: err.message } }));
        return;
      }
    }

    try {
      console.log(`[OpenCodex WS Proxy] Sending request to upstream: ${provider.base_url}/chat/completions`);
      const response = await fetch(`${provider.base_url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(chatBody),
        dispatcher: fetchDispatcher
      });

      console.log(`[OpenCodex WS Proxy] Upstream response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[OpenCodex WS Proxy] Upstream error response: ${errorText}`);
        ws.send(JSON.stringify({ error: { message: errorText } }));
        return;
      }

      if (isStream && streamState) {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let chunkCount = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              console.log(`[OpenCodex WS Proxy] Upstream stream reader finished. Total chunks: ${chunkCount}`);
              break;
            }
            chunkCount++;
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
                  broadcastToClients(payload);
                }, chunk);
              } catch (parseErr: any) {
                console.error(`[OpenCodex WS Proxy] Error parsing or writing delta: ${parseErr.message}`);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        console.log(`[OpenCodex WS Proxy] Finalizing stream...`);
        await streamState.finish(async (payload) => {
          broadcastToClients(payload);
        });

        const assistantMsg = streamState.getAssistantMessage();
        if (assistantMsg) {
          const sessionIdStr = sessionId ? String(sessionId) : "default";
          const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
          this.customConversationHistory.set(sessionIdStr, currentHistory.concat(assistantMsg));
        }
        console.log(`[OpenCodex WS Proxy] Stream processing completely finished.`);
      } else {
        const rawText = await response.text();
        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch {
          data = { error: rawText.slice(0, 250) };
        }
        const responseBody = chatCompletionToResponse(data, requestedModel, namespaceMap);
        ws.send(JSON.stringify(responseBody));

        const choice = (data.choices || [{}])[0];
        const message = choice.message;
        if (message) {
          const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
          this.customConversationHistory.set(sessionIdStr, currentHistory.concat(message));
        }
      }
    } catch (err: any) {
      console.error(`[OpenCodex WS Proxy Local Handler Error] ${err.message}`);
      ws.send(JSON.stringify({ error: { message: err.message } }));
    }
  }

  private initCodexMcp() {
    if (this.mcpProcess) return;
    console.error("[OpenCodex MCP Manager] Starting persistent codex mcp-server...");
    
    this.mcpProcess = spawn("/Applications/ChatGPT.app/Contents/Resources/codex", ["mcp-server"]);
    this.mcpStdoutBuffer = "";

    this.mcpProcess.stdout.on("data", (chunk: Buffer) => {
      this.mcpStdoutBuffer += chunk.toString("utf-8");
      let newlineIdx;
      while ((newlineIdx = this.mcpStdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.mcpStdoutBuffer.substring(0, newlineIdx).trim();
        this.mcpStdoutBuffer = this.mcpStdoutBuffer.substring(newlineIdx + 1);
        if (line) {
          try {
            const data = JSON.parse(line);
            
            // Check for streamed events/notifications
            if (data.method === "codex/event" && data.params && data.params.msg) {
              const msg = data.params.msg;
              const reqIdStr = data.params._meta?.requestId;
              const reqId = reqIdStr ? parseInt(reqIdStr, 10) : NaN;
              
              if (!isNaN(reqId) && this.mcpRequests.has(reqId)) {
                const req = this.mcpRequests.get(reqId)!;
                if (msg.type === "agent_message_content_delta" && typeof msg.delta === "string") {
                  req.accumulatedReply += msg.delta;
                  if (req.onDelta) {
                    req.onDelta(msg.delta);
                  }
                }
              }
            } 
            // Check for responses to tools/call requests
            else if (data.id !== undefined && this.mcpRequests.has(data.id)) {
              const req = this.mcpRequests.get(data.id)!;
              this.mcpRequests.delete(data.id);
              
              if (data.error) {
                req.reject(new Error(data.error.message || "MCP call failed"));
              } else {
                const threadId = data.result?.structuredContent?.threadId || data.result?.threadId;
                const content = data.result?.structuredContent?.content || req.accumulatedReply;
                req.resolve({ threadId, reply: content });
              }
            }
          } catch (e) {
            // Not valid JSON
          }
        }
      }
    });

    this.mcpProcess.stderr.on("data", (chunk: Buffer) => {
      console.error(`[OpenCodex MCP STDERR] ${chunk.toString().trim().split("\n")[0]}`);
    });

    this.mcpProcess.on("close", (code: number) => {
      console.error(`[OpenCodex MCP Manager] codex mcp-server exited with code ${code}`);
      this.mcpProcess = null;
      // Reject any pending requests
      for (const [id, req] of this.mcpRequests.entries()) {
        req.reject(new Error("MCP process closed"));
      }
      this.mcpRequests.clear();
      
      // Auto-restart after a brief delay
      setTimeout(() => this.initCodexMcp(), 2000);
    });

    // Send initialization
    setTimeout(() => {
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            clientName: "opencodex-voice-bridge",
            clientVersion: "1.0.0",
            protocolVersion: "2024-11-05"
          },
          id: ++this.mcpRequestId
        }) + "\n");
      }
    }, 500);

    setTimeout(() => {
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        }) + "\n");
      }
    }, 1000);
  }

  public askMcp(prompt: string, threadId?: string, onDelta?: (text: string) => void): Promise<{ threadId: string; reply: string }> {
    return new Promise((resolve, reject) => {
      if (!this.mcpProcess) {
        this.initCodexMcp();
      }
      
      const id = ++this.mcpRequestId;
      this.mcpRequests.set(id, { resolve, reject, onDelta, accumulatedReply: "" });

      const useThreadId = threadId && threadId !== "default" ? threadId : null;
      const toolName = useThreadId ? "codex-reply" : "codex";
      
      const args: any = { prompt };
      if (useThreadId) {
        args.threadId = useThreadId;
      } else {
        // First message configuration override
        args.config = {
          approval_policy: "never"
        };
      }

      const request = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args
        },
        id
      };

      console.error(`[OpenCodex MCP Manager] Sending request ${id} (tool: ${toolName}, thread: ${useThreadId || "new"})`);
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify(request) + "\n");
      } else {
        this.mcpRequests.delete(id);
        reject(new Error("MCP process not initialized"));
      }
    });
  }

  public injectPromptViaCDP(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      try {
        // Query Electron page URL via CDP to find the correct debugger URL
        fetch("http://127.0.0.1:8315/json")
          .then(res => res.json())
          .then((targets: any) => {
            const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
            if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
              console.error("[OpenCodex CDP] Page target or debugger URL not found.");
              resolve("connection_failed");
              return;
            }
            
            const cdpWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
            let completed = false;
            
            cdpWs.on("open", () => {
              const evalExpr = `
                (() => {
                  const el = document.querySelector('.ProseMirror');
                  if (!el) return 'ProseMirror not found';
                  el.focus();
                  
                  // Select all
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  
                  // Type text
                  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
                  
                  // Dispatch events
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
                  
                  setTimeout(() => {
                    const sendBtn = Array.from(document.querySelectorAll('button')).find(b => b.className.includes('size-token-button-composer'));
                    if (sendBtn) {
                      sendBtn.click();
                      console.log('Send button clicked via CDP!');
                    }
                  }, 50);
                  
                  return 'Injected';
                })()
              `;
              cdpWs.send(JSON.stringify({
                id: 1,
                method: "Runtime.evaluate",
                params: {
                  expression: evalExpr,
                  returnByValue: true
                }
              }));
            });
            
            cdpWs.on("message", (data) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.id === 1) {
                  if (!completed) {
                    completed = true;
                    cdpWs.close();
                    const val = msg.result?.result?.value;
                    console.log(`[OpenCodex CDP] Evaluation result: ${val}`);
                    if (val === "Injected") {
                      resolve("success");
                    } else {
                      resolve("element_not_found");
                    }
                  }
                }
              } catch {}
            });
            
            cdpWs.on("error", (err) => {
              console.error("[OpenCodex CDP WS Err]", err);
              if (!completed) {
                completed = true;
                resolve("connection_failed");
              }
            });
          })
          .catch(err => {
            console.error("[OpenCodex CDP JSON Err]", err.message);
            resolve("connection_failed");
          });
      } catch (err: any) {
        console.error("[OpenCodex CDP Fail]", err.message);
        resolve("connection_failed");
      }
    });
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

function getPreferredCodexCwd(): string {
  try {
    const sessionsDir = join(homedir(), ".codex", "sessions");
    const recentFiles = findRolloutFiles(sessionsDir)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 20);
    for (const file of recentFiles) {
      const content = readFileSync(file, "utf-8");
      if (content.includes(OPENCODEX_MEMORY_TURN_ID)) continue;
      const firstLine = content.split("\n", 1)[0];
      const metadata = JSON.parse(firstLine);
      const cwd = metadata.type === "session_meta" ? metadata.payload?.cwd : "";
      if (typeof cwd === "string" && cwd && existsSync(cwd) && statSync(cwd).isDirectory()) {
        return cwd;
      }
    }
  } catch {}
  return homedir();
}

function isImportedResponseItem(item: any): boolean {
  return item?.type === "response_item"
    && item.payload?.type === "message"
    && String(item.payload?.internal_chat_message_metadata_passthrough?.turn_id || "").startsWith(OPENCODEX_MEMORY_TURN_ID);
}

function messageTextFromResponseItem(item: any): string {
  const content = Array.isArray(item?.payload?.content) ? item.payload.content : [];
  return content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
}

function repairImportedSessionProjection(rolloutPath: string, cwd = homedir(), model = "gpt-5.5"): boolean {
  if (!rolloutPath || !existsSync(rolloutPath)) {
    return false;
  }

  let lines: string[];
  try {
    lines = readFileSync(rolloutPath, "utf-8").split(/\r?\n/).filter(Boolean);
  } catch {
    return false;
  }

  const records = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  });
  const importedItems = records.filter(isImportedResponseItem);
  if (importedItems.length === 0) return false;

  const isCurrentProjection = records.some((item: any) => item?.type === "turn_context"
    && item.payload?.source === OPENCODEX_MEMORY_TURN_ID
    && item.payload?.import_projection_version === IMPORT_PROJECTION_VERSION)
    && importedItems.every((item: any) => isNativeMessageId(item.payload?.id));
  if (isCurrentProjection) return false;

  // The desktop renderer groups bubbles by turn lifecycle, not only by the
  // `role` field. Build one native-shaped turn per imported user message.
  const firstRecord = records.find((item: any) => item?.type === "session_meta");
  if (!firstRecord) return false;
  const reconstructed: any[] = [firstRecord];
  const baseTime = Date.now();
  let tick = 0;
  let activeTurnId = "";
  let lastAssistantMessage = "";
  const timestamp = () => new Date(baseTime + tick++ * 10).toISOString();
  const completeActiveTurn = () => {
    if (!activeTurnId) return;
    reconstructed.push({
      timestamp: timestamp(),
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: activeTurnId,
        last_agent_message: lastAssistantMessage,
        completed_at: Math.floor((baseTime + tick * 10) / 1000),
        duration_ms: 0,
        time_to_first_token_ms: 0
      }
    });
    activeTurnId = "";
    lastAssistantMessage = "";
  };
  const startTurn = () => {
    activeTurnId = `${OPENCODEX_MEMORY_TURN_ID}-${randomUUID()}`;
    reconstructed.push({
      timestamp: timestamp(),
      type: "turn_context",
      payload: {
        turn_id: activeTurnId,
        cwd,
        workspace_roots: [cwd],
        model,
        source: OPENCODEX_MEMORY_TURN_ID,
        import_projection_version: IMPORT_PROJECTION_VERSION
      }
    });
    reconstructed.push({
      timestamp: timestamp(),
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: activeTurnId,
        started_at: Math.floor((baseTime + tick * 10) / 1000),
        model_context_window: 200000,
        collaboration_mode_kind: "default"
      }
    });
  };

  for (const record of importedItems) {
    const role = record.payload?.role;
    const message = messageTextFromResponseItem(record);
    if ((role !== "user" && role !== "assistant") || !message || /^image\/(?:png|jpe?g|gif|webp)$/i.test(message.trim())) continue;
    if (role === "user") {
      completeActiveTurn();
      startTurn();
    } else if (!activeTurnId) {
      startTurn();
    }

    const messageId = nativeMessageId(record.payload?.id);
    const responseItem = {
      type: "response_item",
      payload: {
        type: "message",
        id: messageId,
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text: message }],
        ...(role === "assistant" ? { phase: "final_answer" } : {}),
        internal_chat_message_metadata_passthrough: { turn_id: activeTurnId }
      }
    };
    const messageEvent = {
      type: "event_msg",
      payload: role === "user"
        ? { type: "user_message", client_id: messageId, message, images: [], local_images: [], text_elements: [] }
        : { type: "agent_message", message, phase: "final_answer", memory_citation: null }
    };
    // Native rollouts place a user response item before its event, but place
    // the assistant event before its final response item. Desktop uses that
    // ordering while reconstructing the left/right transcript.
    if (role === "assistant") {
      reconstructed.push({ timestamp: timestamp(), ...messageEvent });
      reconstructed.push({ timestamp: timestamp(), ...responseItem });
    } else {
      reconstructed.push({ timestamp: timestamp(), ...responseItem });
      reconstructed.push({ timestamp: timestamp(), ...messageEvent });
    }
    if (role === "assistant") lastAssistantMessage = message;
  }
  completeActiveTurn();

  writeFileSync(rolloutPath, `${reconstructed.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf-8");
  return true;
}

function appendImportedSessionProjection(
  rolloutPath: string,
  title: string,
  memory: OpenCodexMemoryPackage,
  cwd: string,
  model: string
): void {
  if (!rolloutPath || !existsSync(rolloutPath)) {
    throw new Error("Codex did not create a readable rollout file");
  }

  // `thread/inject_items` normally writes the message records for us. It does
  // not, however, create the lifecycle events the desktop renderer uses.
  // Repair those records in place instead of duplicating the conversation.
  if (repairImportedSessionProjection(rolloutPath, cwd, model)) return;

  const existingRollout = readFileSync(rolloutPath, "utf-8");
  const hasImportedItems = existingRollout.includes(OPENCODEX_MEMORY_TURN_ID);
  if (hasImportedItems) return;

  const projection: any[] = [];
  const baseTime = Date.now();
  const turnId = OPENCODEX_MEMORY_TURN_ID;
  let lastAssistantMessage = "";

  projection.push({
    timestamp: new Date(baseTime).toISOString(),
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd,
      workspace_roots: [cwd],
      model,
      source: OPENCODEX_MEMORY_TURN_ID,
      import_projection_version: IMPORT_PROJECTION_VERSION
    }
  });
  projection.push({
    timestamp: new Date(baseTime).toISOString(),
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId, started_at: Math.floor(baseTime / 1000), model_context_window: 200000, collaboration_mode_kind: "default" }
  });

  for (let i = 0; i < memory.messages.length; i++) {
    const msg = memory.messages[i];
    if (!["system", "developer", "user", "assistant"].includes(msg.role)) continue;

    const timestamp = new Date(baseTime + i * 1000).toISOString();
    const msgId = nativeMessageId(msg.source_id);

    // Codex Desktop reconstructs a thread from response_item records. The old
    // importer wrote only event_msg records, which made the imported thread
    // visible in the list but empty in the actual conversation window.
    projection.push({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        id: msgId,
        role: msg.role,
        content: [{
          type: msg.role === "assistant" ? "output_text" : "input_text",
          text: msg.content
        }],
        ...(msg.role === "assistant" ? { phase: "final_answer" } : {}),
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    });

    if (msg.role === "user" || msg.role === "assistant") {
      if (msg.role === "assistant") lastAssistantMessage = msg.content;
      projection.push({
        timestamp,
        type: "event_msg",
        payload: {
          type: msg.role === "user" ? "user_message" : "agent_message",
          message: msg.content,
          ...(msg.role === "user" ? { client_id: msgId, images: [], local_images: [], text_elements: [] } : { phase: "final_answer", memory_citation: null })
        }
      });
    }
  }

  projection.push({
    timestamp: new Date(baseTime + memory.messages.length * 1000).toISOString(),
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: lastAssistantMessage,
      completed_at: Math.floor((baseTime + memory.messages.length * 1000) / 1000),
      duration_ms: memory.messages.length * 1000,
      time_to_first_token_ms: 0
    }
  });

  const prefix = existingRollout.trimEnd();
  const lines = `${prefix}${prefix ? "\n" : ""}${projection.map((item) => JSON.stringify(item)).join("\n")}\n`;
  writeFileSync(rolloutPath, lines, "utf-8");
  // Keep the fallback path structurally identical to app-server injection:
  // the renderer needs one completed lifecycle per user turn to retain roles.
  repairImportedSessionProjection(rolloutPath, cwd, model);
}

function repairSessionProjectionForMode(rolloutPath: string, nativeMode: boolean): boolean {
  let changed = repairImportedSessionProjection(rolloutPath);
  if (!nativeMode || !existsSync(rolloutPath)) return changed;

  let records: any[];
  try {
    records = readFileSync(rolloutPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return changed;
  }

  const normalizedIds = new Map<string, string>();
  for (const record of records) {
    const payload = record?.payload;
    if (record?.type !== "response_item" || !payload || typeof payload.id !== "string") continue;

    if (payload.type === "message" && !isNativeMessageId(payload.id)) {
      const normalized = nativeMessageId(payload.id);
      normalizedIds.set(payload.id, normalized);
      payload.id = normalized;
      changed = true;
    } else if (payload.type === "function_call" && !isNativeFunctionCallId(payload.id)) {
      const normalized = nativeFunctionCallId(payload.id);
      normalizedIds.set(payload.id, normalized);
      payload.id = normalized;
      changed = true;
    }
  }

  const sanitized = records.filter((record: any) => {
    const payload = record?.payload;
    const id = payload?.id || record?.id;
    if (record?.type === "response_item"
      && payload?.type === "reasoning"
      && isGatewayLocalReasoningId(id)) {
      changed = true;
      return false;
    }
    if (record?.type === "event_msg"
      && payload?.type === "user_message"
      && typeof payload.client_id === "string"
      && normalizedIds.has(payload.client_id)) {
      payload.client_id = normalizedIds.get(payload.client_id);
      changed = true;
    }
    return true;
  });

  if (changed) {
    writeFileSync(rolloutPath, `${sanitized.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf-8");
  }
  return changed;
}

async function updateImportedThreadState(threadId: string, preview: string): Promise<void> {
  const databasePath = join(homedir(), ".codex", "state_5.sqlite");
  if (!existsSync(databasePath)) return;

  try {
    // @ts-ignore
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.prepare(`
        UPDATE threads
        SET thread_source = 'user',
            preview = ?,
            first_user_message = ?
        WHERE id = ?
      `).run(preview, preview, threadId);
    } finally {
      database.close();
    }
    return;
  } catch {}

  const escapeSql = (value: string) => value.replace(/'/g, "''");
  const result = spawnSync("sqlite3", [
    databasePath,
    `PRAGMA busy_timeout=5000; UPDATE threads SET thread_source='user', preview='${escapeSql(preview)}', first_user_message='${escapeSql(preview)}' WHERE id='${escapeSql(threadId)}';`
  ], { encoding: "utf-8" });
  if (result.status !== 0) {
    console.error(`[OpenCodex Memory Bridge] Unable to update Codex thread index: ${result.stderr || result.error?.message || "unknown error"}`);
  }
}

async function importMemoryIntoCodex(memory: OpenCodexMemoryPackage): Promise<{
  id: string;
  name: string;
  message_count: number;
  event_count: number;
}> {
  const fallbackTitle = `Imported conversation ${new Date().toLocaleDateString()}`;
  const threadName = String(memory.title || fallbackTitle).slice(0, 200);
  const sourceCwd = memory.source?.cwd;
  let importCwd = getPreferredCodexCwd();
  if (sourceCwd && existsSync(sourceCwd)) {
    try {
      if (statSync(sourceCwd).isDirectory()) importCwd = sourceCwd;
    } catch {}
  }
  const responseItems = toResponsesItems(memory);

  const newSid = await withCodexAppServer(async (client) => {
    let createdThreadId = "";
    try {
      const startResult = await client.call("thread/start", {
        cwd: importCwd,
        threadSource: "user"
      }, 60000);
      createdThreadId = String(startResult.thread?.id || "");
      if (!createdThreadId) throw new Error("Codex did not return a thread id");

      for (let index = 0; index < responseItems.length; index += 200) {
        await client.call("thread/inject_items", {
          threadId: createdThreadId,
          items: responseItems.slice(index, index + 200)
        }, 60000);
      }

      await client.call("thread/name/set", {
        threadId: createdThreadId,
        name: threadName
      });
      const readResult = await client.call("thread/read", {
        threadId: createdThreadId,
        includeTurns: false
      });
      appendImportedSessionProjection(
        String(readResult.thread?.path || ""),
        threadName,
        memory,
        importCwd,
        String(startResult.model || "gpt-5.5")
      );
      await client.call("thread/list", { limit: 20, sourceKinds: [] });
      return createdThreadId;
    } catch (error) {
      if (createdThreadId) {
        try {
          await client.call("thread/archive", { threadId: createdThreadId });
        } catch {}
      }
      throw error;
    }
  });

  await updateImportedThreadState(
    newSid,
    `Imported memory: ${threadName} (${memory.messages.length} messages)`
  );
  return {
    id: newSid,
    name: threadName,
    message_count: memory.messages.length,
    event_count: memory.events?.length || 0
  };
}
