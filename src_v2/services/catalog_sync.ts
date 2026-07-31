/**
 * Dynamic Model Catalog Sync Service for CodexBridge (OpenCodex V2)
 * Dynamically queries active provider /v1/models APIs to fetch the user's REAL subscribed models.
 * ZERO hardcoded model lists in code.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ProviderConfig } from "../core/types.js";
import { CredentialStore } from "./credential_store.js";

import { stripManagedCodexConfig } from "../server/gateway.js";

const DEFAULT_REASONING_PRESETS = [
  { effort: "low", description: "Minimal reasoning for simple tasks" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
];

export function getActualContextWindow(modelSlug: string, apiContextWindow?: number): number {
  if (typeof apiContextWindow === "number" && apiContextWindow > 0) return apiContextWindow;
  const s = modelSlug.toLowerCase();
  if (s.includes("gemini-2.5-pro") || s.includes("gemini-1.5-pro") || s.includes("gemini-3.6-pro") || s.includes("gemini-pro")) return 2097152;
  if (s.includes("gemini")) return 1048576;
  if (s.includes("claude")) return 200000;
  if (s.includes("grok")) return 200000;
  if (s.includes("minimax")) return 1000000;
  if (s.includes("kimi")) return 262144;
  if (s.includes("glm")) return 200000;
  if (s.includes("deepseek")) return 128000;
  if (s.includes("qwen")) return 131072;
  return 200000;
}

export function buildFullCatalogEntry(modelSlug: string, providerName: string, apiContextWindow?: number): any {
  const actualContext = getActualContextWindow(modelSlug, apiContextWindow);
  const compactLimit = Math.floor(actualContext * 0.8);
  const truncLimit = Math.floor(actualContext * 0.2);

  return {
    slug: modelSlug,
    model: modelSlug,
    display_name: modelSlug,
    backend_model: modelSlug,
    backend_provider: providerName,
    provider: "opencodex",
    model_provider: "opencodex",
    description: `${providerName}: ${modelSlug} (${actualContext.toLocaleString()} context)`,
    context_window: actualContext,
    max_context_window: actualContext,
    auto_compact_token_limit: compactLimit,
    truncation_policy: { mode: "tokens", limit: truncLimit },
    default_reasoning_level: "medium",
    supported_reasoning_levels: DEFAULT_REASONING_PRESETS,
    default_reasoning_summary: "none",
    reasoning_summary_format: "none",
    supports_reasoning_summaries: true,
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
    upgrade: null,
    priority: 100,
    prefer_websockets: false,
    available_in_plans: ["free", "plus", "pro", "team", "business", "enterprise"],
    base_instructions: "You are a helpful AI coding assistant in Codex.",
    supports_computer_use: true,
    supports_mcp: true,
    vision_bridge_enabled: true,
  };
}

export class CatalogSyncService {
  private static catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");

  public static syncCustomModelsToCodexCache(): void {
    try {
      const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
      const catPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
      if (!fs.existsSync(cachePath) || !fs.existsSync(catPath)) return;

      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      const cat = JSON.parse(fs.readFileSync(catPath, "utf-8"));
      if (!Array.isArray(cache.models) || !Array.isArray(cat.models)) return;

      const existingMap = new Map<string, any>();
      for (const m of cache.models) {
        existingMap.set(m.slug, m);
      }

      for (const m of cat.models) {
        if (!m.slug.startsWith("gpt-") && !m.slug.startsWith("o1") && !m.slug.startsWith("o3")) {
          existingMap.set(m.slug, {
            ...m,
            provider: "opencodex",
            model_provider: "opencodex"
          });
        }
      }

      cache.models = Array.from(existingMap.values());
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
    } catch {}
  }

  public static getOfficialModels(): any[] {
    try {
      const configPath = path.join(os.homedir(), ".codex", "config.toml");
      if (!fs.existsSync(configPath)) return [];
      const backup = fs.readFileSync(configPath, "utf-8");
      const tempContent = stripManagedCodexConfig(backup);
      fs.writeFileSync(configPath, tempContent, "utf-8");
      try {
        const raw = execFileSync("/Applications/ChatGPT.app/Contents/Resources/codex", ["debug", "models"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
        const json = JSON.parse(raw);
        return (json.models || []).filter((m: any) => m.slug !== "codex-auto-review");
      } finally {
        fs.writeFileSync(configPath, backup, "utf-8");
      }
    } catch {
      return [];
    }
  }

  public static async fetchLiveModels(provider: ProviderConfig): Promise<string[]> {
    const rawUrl = (provider as any).baseUrl || (provider as any).base_url || (provider as any).url || "";
    if (!rawUrl) return [];

    const apiKey = CredentialStore.resolveApiKey(provider);
    const modelsEndpoint = rawUrl.endsWith("/models")
      ? rawUrl
      : `${rawUrl.replace(/\/$/, "")}/models`;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await fetch(modelsEndpoint, { method: "GET", headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const json: any = await res.json();
        if (Array.isArray(json.data)) {
          const ids = json.data.map((item: any) => item.id).filter(Boolean);
          if (ids.length > 0) return ids;
        }
      }
    } catch {
      // Fallback to configured models on network error
    }
    return provider.models || [];
  }

  public static async syncCatalog(providers: ProviderConfig[]): Promise<void> {
    try {
      const catalogDir = path.dirname(CatalogSyncService.catalogPath);
      if (!fs.existsSync(catalogDir)) {
        fs.mkdirSync(catalogDir, { recursive: true });
      }

      const modelsMap = new Map<string, any>();

      for (const p of providers) {
        const apiKey = CredentialStore.resolveApiKey(p);
        if (!apiKey || apiKey.endsWith("-cli-auto")) continue; // Skip providers without key or auto-subscription keys

        let liveModels = await CatalogSyncService.fetchLiveModels(p);
        if (liveModels.length === 0 && Array.isArray(p.models)) {
          liveModels = p.models;
        }

        for (const modelSlug of liveModels) {
          const lower = modelSlug.toLowerCase();
          const full = buildFullCatalogEntry(modelSlug, p.name);
          modelsMap.set(lower, full);
        }
      }

      const officialModels = CatalogSyncService.getOfficialModels();
      for (const off of officialModels) {
        if (!modelsMap.has(off.slug.toLowerCase())) {
          modelsMap.set(off.slug.toLowerCase(), off);
        }
      }

      const catalogModels = Array.from(modelsMap.values()).map(m => ({
        ...m,
        supports_reasoning_summaries: m.supports_reasoning_summaries ?? true,
        reasoning_summary_format: m.reasoning_summary_format ?? "none"
      }));

      const updatedCatalog = { models: catalogModels };
      fs.writeFileSync(CatalogSyncService.catalogPath, JSON.stringify(updatedCatalog, null, 2), "utf-8");
    } catch (err: any) {
      console.error(`[CatalogSyncService] Could not sync catalog: ${err.message}`);
    }
  }
}
