/**
 * OpenCodex Proxy Server
 * Connects standard Codex requests to selected API providers (DeepSeek, SiliconFlow, OpenAI, Custom).
 * Hosts the local glassmorphic dashboard at http://localhost:8765/dashboard.
 * Broadcasts real-time terminal logs to dashboard sessions using SSE.
 */

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

import {
  responsesToChat,
  chatCompletionToResponse,
  extractNamespaceMap,
  ResponsesStreamState,
  processVisionBridge
} from "./translator.js";

import { getDashboardHtml } from "./dashboard.js";

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
  private config!: ProxyConfig;
  private configDir = join(homedir(), ".opencodex");

  constructor() {
    this.ensureConfigDir();
    this.loadConfig();
    this.autoPatchCodexConfig();
  }

  private ensureConfigDir() {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  private loadConfig() {
    const p = join(this.configDir, "providers.json");
    if (existsSync(p)) {
      try {
        this.config = JSON.parse(readFileSync(p, "utf-8"));
        console.error(`[OpenCodex] Loaded providers configuration: ${p}`);
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

  private buildCatalogFromModelNames(names: string[]): any {
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
      models.push({
        slug: modelName,
        model: modelName,
        display_name: modelName,
        provider,
        description: `Custom model: ${modelName}${provider ? ` (${provider})` : ""}`,
        context_window: 200000,
        max_context_window: 200000,
        auto_compact_token_limit: 120000,
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
base_url = "http://localhost:8765/v1"
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
base_url = "http://localhost:8765/v1"
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

  start(port: number) {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => this.handle(req, res, body));
    });
    this.server.listen(port, "0.0.0.0");
    console.error(`[OpenCodex] Unified HTTP server listening on port ${port}`);
    console.error(`[OpenCodex] Web Dashboard UI → http://localhost:${port}/dashboard`);
  }

  stop() {
    this.server?.close();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, session_id");
    
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // ─── Web Dashboard Routes ───
    if (path === "/dashboard" || path === "/dashboard/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getDashboardHtml());
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
          this.config.providers = data.providers;
        } else {
          this.config.providers = [
            { name: data.primary.name, base_url: data.primary.base_url, api_key: data.primary.api_key },
            { name: "opencode", base_url: data.opencode.base_url || "https://opencode.ai/zen/go/v1", api_key: data.opencode.api_key || "", vision_model: data.opencode.model || "mimo-v2.5" }
          ];
        }

        this.saveConfig();

        if (data.models && Array.isArray(data.models)) {
          const existing = this.getModelCatalog();
          const existingNames = new Set((existing.models || []).map((m: any) => m.model));
          const merged = [...new Set([...data.models, ...existingNames])];
          const catalog = this.buildCatalogFromModelNames(merged);
          this.saveModelCatalog(catalog);
          console.log(`[OpenCodex] Merged models: ${merged.length} total (${existingNames.size} kept, ${data.models.length} from input).`);
        }

        this.patchCodexConfig();
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
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        catalog: catalog.models?.map((m: any) => ({
          id: m.slug,
          model: m.model,
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
        const activeIds = data.active || [];
        const catalog = this.getModelCatalog();
        
        if (catalog.models) {
          catalog.models.forEach((m: any) => {
            m.visibility = activeIds.includes(m.slug) ? "list" : "hide";
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

    if (path === "/api/test-log" && req.method === "POST") {
      console.log("[OpenCodex] Test log from dashboard at " + new Date().toLocaleTimeString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
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

    // ─── Standard Gateway Routes ───

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "1.0.0", opencodex: true }));
      return;
    }

    if (path === "/v1/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.config, null, 2));
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
      this.handleResponses(body, res);
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

  private async handleResponses(body: string, res: http.ServerResponse) {
    let reqBody: any;
    try {
      reqBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
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

    const chatBody = responsesToChat(processedReqBody, upstreamModel);
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
    const reqBody = JSON.parse(body);
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

    const upstreamModel = model;
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
}

function stripManagedBlocks(content: string): string {
  return content.replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "").trim();
}

function getDefaultCatalog() {
  return { models: [] };
}
