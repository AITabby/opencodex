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
import { NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS } from "./computer_use_native.js";

import { stripManagedCodexConfig } from "../server/gateway.js";

const DEFAULT_REASONING_PRESETS = [
  { effort: "low", description: "轻度推理（速度优先）" },
  { effort: "medium", description: "中等推理（速度与深度平衡）" },
  { effort: "high", description: "深度推理（复杂任务）" },
];

const EXTRA_REASONING_DESCRIPTIONS: Record<string, string> = {
  minimal: "最小推理",
  xhigh: "极高推理",
  max: "最高推理",
  ultra: "极限推理",
  none: "不使用推理",
};

function reasoningDescription(effort: string): string | undefined {
  return DEFAULT_REASONING_PRESETS.find((level) => level.effort === effort)?.description
    || EXTRA_REASONING_DESCRIPTIONS[effort];
}

// Codex requires a positive context window and truncation policy to parse a
// catalog entry. This is only a schema-safe fallback for manually configured
// models whose provider has not published context metadata; it does not claim
// that the upstream model actually supports this window.
const DEFAULT_CATALOG_CONTEXT_WINDOW = 200_000;

function withComputerUseCatalogInstructions(model: any): any {
  if (!model?.supports_computer_use) return model;
  const base = typeof model.base_instructions === "string" ? model.base_instructions.trim() : "";
  if (base.includes(NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS)) return model;
  return {
    ...model,
    base_instructions: base
      ? `${base}\n\n${NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS}`
      : NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS,
  };
}

function isNativeCodexCacheModel(model: any): boolean {
  const slug = String(model?.slug || "").trim().toLowerCase();
  if (!slug) return false;
  const provider = String(model?.provider || model?.model_provider || "").trim().toLowerCase();
  return provider === "openai" || /^(gpt-|o1|o3|codex-|chatgpt)/i.test(slug);
}

export function getDefaultReasoningPresets(): Array<{ effort: string; description: string }> {
  return DEFAULT_REASONING_PRESETS.map((level) => ({ ...level }));
}

function normalizeReasoningLevels(value: any): Array<{ effort: string; description?: string }> {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,|]+/)
      : value && typeof value === "object"
        ? Object.entries(value).map(([effort, description]) => ({ effort, description }))
        : [];
  const result: Array<{ effort: string; description?: string }> = [];
  const seen = new Set<string>();
  const addLevel = (raw: any, inheritedDescription = ""): void => {
    if (Array.isArray(raw)) {
      for (const item of raw) addLevel(item, inheritedDescription);
      return;
    }

    // models.dev and several OpenAI-compatible /models endpoints describe
    // discrete effort levels as { type: "effort", values: [...] }. The old
    // parser only looked for raw.effort and therefore silently converted this
    // valid shape into an empty list.
    if (raw && typeof raw === "object" && Array.isArray(raw.values)) {
      const type = String(raw.type || "").trim().toLowerCase();
      if (!type || type === "effort") {
        const description = typeof raw.description === "string" ? raw.description.trim() : inheritedDescription;
        for (const item of raw.values) addLevel(item, description);
      }
      // toggle and budget_tokens describe reasoning capabilities, but they do
      // not provide desktop-selectable effort names.
      return;
    }

    const effort = typeof raw === "string"
      ? raw.trim().toLowerCase()
      : String(raw?.effort || raw?.reasoning_effort || raw?.reasoningEffort || raw?.level || raw?.value || raw?.name || raw?.id || "").trim().toLowerCase();
    if (!effort || effort === "toggle" || effort === "budget_tokens" || seen.has(effort)) return;
    const reportedDescription = typeof raw === "object" && typeof raw?.description === "string"
      ? raw.description.trim()
      : "";
    const description = reasoningDescription(effort)
      || reportedDescription
      || inheritedDescription
      || `推理档位：${effort}`;
    // Codex requires a description for every supported_reasoning_levels item.
    // Providers commonly publish only the extra effort name (for example
    // `xhigh` or `max`), so never emit a partially shaped level here.
    result.push({ effort, description });
    seen.add(effort);
  };
  for (const raw of values) addLevel(raw);
  return result;
}

/**
 * Read exact reasoning options when a provider or registry publishes them.
 * `undefined` means the source did not say; an empty array means it explicitly
 * said there are no enumerated options. The catalog resolver keeps both cases
 * automatic-only until a provider or registry returns real effort names.
 */
export function extractModelReasoningLevels(model: any): Array<{ effort: string; description?: string }> | undefined {
  if (!model || typeof model !== "object") return undefined;
  for (const key of [
    "supported_reasoning_levels",
    "supported_reasoning_efforts",
    "reasoning_efforts",
    "reasoning_levels",
    "reasoning_options",
    "supportedReasoningEfforts",
    "reasoningEfforts",
    "reasoningLevels",
    "reasoningOptions",
  ]) {
    if (Object.prototype.hasOwnProperty.call(model, key)) return normalizeReasoningLevels(model[key]);
  }
  const nested = model.reasoning && typeof model.reasoning === "object"
    ? model.reasoning
    : model.capabilities && typeof model.capabilities === "object"
      ? model.capabilities
      : undefined;
  if (nested) {
    for (const key of ["efforts", "levels", "options", "supported_efforts", "supported_levels"]) {
      if (Object.prototype.hasOwnProperty.call(nested, key)) return normalizeReasoningLevels(nested[key]);
    }
  }
  return undefined;
}

function withDefaultReasoningLevels(
  discovered: Array<{ effort: string; description?: string }>,
): Array<{ effort: string; description?: string }> {
  const byEffort = new Map(discovered.map((level) => [level.effort, level]));
  const baseline = DEFAULT_REASONING_PRESETS.map((level) => ({ ...level }));
  const extras = discovered
    .filter((level) => !DEFAULT_REASONING_PRESETS.some((base) => base.effort === level.effort))
    .map((level) => ({
      ...level,
      description: reasoningDescription(level.effort) || level.description || `推理档位：${level.effort}`,
    }));
  return [...baseline, ...extras];
}

/**
 * Resolve the picker levels for one model. low/medium/high are the stable
 * Codex baseline for every imported model unless the provider explicitly
 * marks it as non-reasoning; provider-returned levels outside that baseline
 * are appended verbatim.
 * An explicit non-reasoning model remains automatic-only.
 */
function resolveModelReasoningLevels(model: any): Array<{ effort: string; description?: string }> {
  const discovered = extractModelReasoningLevels(model);
  // A provider/registry can publish both a boolean capability flag and an
  // explicit effort enum. The enum is the more precise contract for the
  // picker and must not be discarded just because the broad flag is false
  // (some registries use that flag for a different reasoning capability).
  if (model?.reasoning === false) return discovered || [];
  if (discovered && discovered.length > 0) return withDefaultReasoningLevels(discovered);
  return withDefaultReasoningLevels([]);
}

export function applyDefaultReasoningCapabilities(model: any): any {
  const levels = resolveModelReasoningLevels(model);
  const result = { ...model, supported_reasoning_levels: levels };
  if (levels.length > 0) {
    const defaultValue = model?.default_reasoning_level ?? model?.defaultReasoningEffort ?? model?.defaultReasoningLevel;
    const requested = String(typeof defaultValue === "object"
      ? defaultValue?.effort || defaultValue?.reasoningEffort || ""
      : defaultValue || "").trim().toLowerCase();
    result.default_reasoning_level = levels.some((level) => level.effort === requested)
      ? requested
      : levels.some((level) => level.effort === "medium")
        ? "medium"
        : levels[0].effort;
  } else {
    delete result.default_reasoning_level;
  }
  return result;
}

export type ProviderModelDescriptor = {
  id: string;
  context_window?: number;
  max_context_window?: number;
  context_window_source?: "provider_metadata" | "model_registry" | "unknown";
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  reasoning?: boolean;
  default_reasoning_level?: string;
  metadata_source?: string;
  metadata_updated_at?: string;
};

function positiveContextValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

/** Read the common context-window names returned by OpenAI-compatible /models APIs. */
export function extractModelContextWindow(model: any): number | undefined {
  if (!model || typeof model !== "object") return undefined;

  // models.dev publishes the authoritative context window under
  // `limit.context`. Some compatible /models endpoints use the same nested
  // shape (or `limits`), so inspect those containers before the legacy
  // top-level aliases. Without this, a valid model is written without
  // context_window and Codex silently omits it from the desktop picker.
  const limitContainers = [
    model.limit,
    model.limits,
    model.capabilities?.limit,
    model.capabilities?.limits,
  ];
  for (const container of limitContainers) {
    if (!container || typeof container !== "object") continue;
    for (const key of ["context", "context_window", "context_length", "max_context", "max_context_window", "input"]) {
      const value = positiveContextValue(container[key]);
      if (value) return value;
    }
  }

  for (const key of [
    "context_window",
    "max_context_window",
    "context_length",
    "contextWindow",
    "contextLength",
    "max_context_length",
    "max_input_tokens",
    "maxInputTokens",
    "input_token_limit",
    "inputTokenLimit",
  ]) {
    const value = positiveContextValue(model[key]);
    if (value) return value;
  }
  return undefined;
}

export function normalizeProviderModelDescriptor(value: any): ProviderModelDescriptor | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || value.slug || value.model || value.name || "").trim();
  if (!id) return null;
  const context = extractModelContextWindow(value);
  const reasoningLevels = extractModelReasoningLevels(value);
  return {
    id,
    ...(context ? { context_window: context, max_context_window: context } : {}),
    ...(reasoningLevels !== undefined ? { supported_reasoning_levels: reasoningLevels } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(typeof (value.default_reasoning_level ?? value.defaultReasoningEffort ?? value.defaultReasoningLevel) === "string"
      ? { default_reasoning_level: value.default_reasoning_level ?? value.defaultReasoningEffort ?? value.defaultReasoningLevel }
      : {}),
  };
}

function providerMetadataEntry(provider: any, modelSlug: string): any | undefined {
  const requested = String(modelSlug || "").trim().toLowerCase();
  if (!requested || !provider || typeof provider !== "object") return undefined;
  const keys = [requested, String(modelSlug || "").trim()];
  const maps = [
    provider.model_context_windows,
    provider.context_windows,
    provider.model_metadata,
    provider.models_metadata,
  ];
  for (const map of maps) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (keys.includes(String(key).trim()) || String(key).trim().toLowerCase() === requested) return value;
    }
  }
  const collections = [provider.models, provider.model_metadata, provider.models_metadata];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const raw of collection) {
      const descriptor = normalizeProviderModelDescriptor(raw);
      if (descriptor?.id.toLowerCase() === requested) return raw;
    }
  }
  return undefined;
}

/**
 * Codex Desktop's cache is also a capability source for imported models. A
 * provider may expose only a bare model id from /models while the desktop
 * catalog already knows the exact selectable effort enum, including `max`.
 */
function codexModelCacheMetadata(modelSlug: string): any | undefined {
  const requested = String(modelSlug || "").trim().toLowerCase();
  if (!requested) return undefined;
  try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const models = Array.isArray(cache?.models) ? cache.models : [];
    return models.find((model: any) => [model?.slug, model?.id, model?.model, model?.backend_model]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
      .includes(requested));
  } catch {
    return undefined;
  }
}

export function getProviderModelContextWindow(provider: any, modelSlug: string): number | undefined {
  const metadata = providerMetadataEntry(provider, modelSlug);
  return getProviderReportedContextWindow(metadata);
}

export function getProviderModelMetadata(provider: any, modelSlug: string): any | undefined {
  return providerMetadataEntry(provider, modelSlug);
}

export function getActualContextWindow(_modelSlug: string, apiContextWindow?: number): number | undefined {
  // This function only accepts a value supplied directly by the active
  // provider path. Registry metadata is deliberately handled separately and
  // must not enlarge an unknown model beyond the conservative fallback.
  return positiveContextValue(apiContextWindow);
}

function contextWindowSource(value: any): "provider_metadata" | "model_registry" | "unknown" | undefined {
  if (!value || typeof value !== "object") return undefined;
  const explicit = String(value.context_window_source || "").trim().toLowerCase();
  if (explicit === "provider_metadata" || explicit === "model_registry" || explicit === "unknown") return explicit;
  const metadata = String(value.metadata_source || "").trim().toLowerCase();
  if (metadata === "provider_metadata") return "provider_metadata";
  if (metadata === "model_registry") return "model_registry";
  return undefined;
}

function getProviderReportedContextWindow(value: any): number | undefined {
  const context = extractModelContextWindow(value);
  if (!context) return undefined;
  const source = contextWindowSource(value);
  return source === "model_registry" || source === "unknown" ? undefined : context;
}

function getRegistryContextWindow(value: any): number | undefined {
  const context = extractModelContextWindow(value);
  if (!context) return undefined;
  return contextWindowSource(value) === "model_registry" ? context : undefined;
}

export function buildFullCatalogEntry(
  modelSlug: string,
  providerName: string,
  apiContextWindow?: number,
  protocol: "chat" | "responses" = "chat",
  capabilities: any = undefined,
): any {
  const directContext = getActualContextWindow(modelSlug, apiContextWindow);
  const providerMetadataContext = getProviderReportedContextWindow(capabilities);
  const registryContext = getRegistryContextWindow(capabilities);
  const reportedContext = directContext || providerMetadataContext;
  // A matched model-registry record is the model's published capability, not
  // an unknown-model guess. Only use the schema fallback when neither the
  // provider nor the registry knows this model.
  const catalogContext = reportedContext || registryContext || DEFAULT_CATALOG_CONTEXT_WINDOW;
  const reasoningLevels = resolveModelReasoningLevels(capabilities);
  const defaultValue = capabilities?.default_reasoning_level ?? capabilities?.defaultReasoningEffort ?? capabilities?.defaultReasoningLevel;
  const requestedDefaultReasoning = String(typeof defaultValue === "object"
    ? defaultValue?.effort || defaultValue?.reasoningEffort || ""
    : defaultValue || "").trim().toLowerCase();
  const defaultReasoning = reasoningLevels.some((level) => level.effort === requestedDefaultReasoning)
    ? requestedDefaultReasoning
    : reasoningLevels.some((level) => level.effort === "medium")
      ? "medium"
      : reasoningLevels[0]?.effort;
  const contextSource = reportedContext
    ? "provider_metadata"
    : registryContext
      ? "model_registry"
      : "unknown";
  const entry: any = {
    slug: modelSlug,
    model: modelSlug,
    display_name: modelSlug,
    backend_model: modelSlug,
    backend_provider: providerName,
    protocol,
    backend_protocol: protocol,
    provider: "opencodex",
    model_provider: "opencodex",
    description: `${providerName}: ${modelSlug} (${catalogContext.toLocaleString()} context${reportedContext ? "" : "; fallback until provider metadata is available"})`,
    context_window_source: contextSource,
    context_window_confidence: reportedContext || registryContext ? "exact" : "unknown",
    context_window: catalogContext,
    max_context_window: catalogContext,
    auto_compact_token_limit: Math.floor(catalogContext * 0.8),
    truncation_policy: { mode: "tokens", limit: Math.floor(catalogContext * 0.2) },
    supported_reasoning_levels: reasoningLevels,
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
    base_instructions: withComputerUseCatalogInstructions({
      base_instructions: "You are a helpful AI coding assistant in Codex.",
      supports_computer_use: true,
    }).base_instructions,
    supports_computer_use: true,
    supports_mcp: true,
    vision_bridge_enabled: true,
    // Third-party chat models can delegate image generation to the native
    // Codex Responses image tool. This capability is independent from
    // the model's own vision input capability.
    supports_image_generation: true,
    image_generation_mode: "native_responses",
  };
  if (defaultReasoning) entry.default_reasoning_level = defaultReasoning;
  if (typeof capabilities?.reasoning === "boolean") entry.reasoning = capabilities.reasoning;
  return entry;
}

type ModelRegistryRecord = {
  id: string;
  provider?: string;
  metadata: any;
};

const MODEL_REGISTRY_URL = "https://models.dev/api.json";

function registryModelLike(value: any): boolean {
  return Boolean(value && typeof value === "object" && (
    value.limit || value.context_window || value.contextLength || value.reasoning_options !== undefined
      || value.reasoning !== undefined || value.modalities || value.base_model || value.baseModel
  ));
}

function appendRegistryRecord(records: ModelRegistryRecord[], id: unknown, value: any, provider?: string): void {
  const modelId = String(id || value?.id || value?.model || value?.slug || "").trim();
  if (!modelId || !registryModelLike(value)) return;
  records.push({ id: modelId, ...(provider ? { provider } : {}), metadata: value });
}

/** Accept the current models.dev provider->models shape and simple list shapes. */
export function flattenModelRegistry(payload: any): ModelRegistryRecord[] {
  const records: ModelRegistryRecord[] = [];
  const addCollection = (collection: any, provider?: string): void => {
    if (Array.isArray(collection)) {
      for (const item of collection) appendRegistryRecord(records, item?.id || item?.model || item?.slug, item, provider);
      return;
    }
    if (!collection || typeof collection !== "object") return;
    for (const [id, value] of Object.entries(collection)) appendRegistryRecord(records, id, value, provider);
  };

  if (Array.isArray(payload)) {
    addCollection(payload);
    return records;
  }
  if (!payload || typeof payload !== "object") return records;
  if (Array.isArray(payload.data)) addCollection(payload.data);
  if (payload.models) addCollection(payload.models);

  for (const [providerId, providerValue] of Object.entries(payload)) {
    if (providerId === "data" || providerId === "models") continue;
    if (Array.isArray((providerValue as any)?.models) || (providerValue as any)?.models) {
      addCollection((providerValue as any).models, providerId);
      continue;
    }
    if (registryModelLike(providerValue)) appendRegistryRecord(records, providerId, providerValue, undefined);
  }

  return records;
}

export function extractReasoningLevelsFromProviderError(body: string): Array<{ effort: string; description?: string }> {
  const source = String(body || "");
  const match = source.match(/(?:Input should be|must be one of)\s+([^\]}\n]+)/i);
  if (!match) return [];
  const levels = Array.from(match[1].matchAll(/["']([a-z][a-z0-9_-]*)["']/gi))
    .map((item) => item[1].toLowerCase());
  return normalizeReasoningLevels(levels);
}

function normalizeRegistryIdentity(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/^models\//, "");
}

export function registryIdentityCandidates(value: unknown): string[] {
  const normalized = normalizeRegistryIdentity(value);
  if (!normalized) return [];
  const parts = normalized.split("/").filter(Boolean);
  const candidates = [normalized, parts.at(-1) || normalized];
  // Compatible providers commonly expose reasoning/deployment variants as a
  // suffix (for example gemini-3.6-flash-medium), while the registry records
  // the base model (gemini-3.6-flash). This is identity normalization, not a
  // context-size guess: the context still comes from the matched registry.
  for (const candidate of [...candidates]) {
    const base = candidate.replace(/-(?:minimal|low|medium|high|max|xhigh|thinking|reasoning)$/i, "");
    if (base && base !== candidate) candidates.push(base);
  }
  return Array.from(new Set(candidates));
}

function providerRegistryHints(provider: any): string[] {
  const values = [provider?.name, provider?.preset_id, provider?.type, provider?.baseUrl, provider?.base_url];
  const hints = new Set<string>();
  for (const value of values) {
    const text = String(value || "").toLowerCase();
    for (const token of text.split(/[^a-z0-9]+/).filter((part) => part.length >= 3)) hints.add(token);
    if (text) hints.add(text);
  }
  return Array.from(hints);
}

function normalizedProviderRegistryIds(provider: any): string[] {
  return Array.from(new Set([
    provider?.name,
    provider?.preset_id,
    provider?.type,
  ]
    .map((value) => normalizeRegistryIdentity(value))
    .filter(Boolean)));
}

type ModelRegistryMatch = {
  metadata: any;
  providerMatched: boolean;
};

export function findModelRegistryMatch(payload: any, provider: any, modelSlug: string): ModelRegistryMatch | undefined {
  const target = registryIdentityCandidates(modelSlug);
  if (target.length === 0) return undefined;
  const hints = providerRegistryHints(provider);
  const providerIds = normalizedProviderRegistryIds(provider);
  let best: { score: number; metadata: any; provider?: string } | undefined;
  for (const record of flattenModelRegistry(payload)) {
    const recordIds = [record.id, record.metadata?.model, record.metadata?.id, record.metadata?.base_model, record.metadata?.baseModel]
      .flatMap(registryIdentityCandidates);
    const exact = recordIds.some((candidate) => target.includes(candidate));
    if (!exact) continue;
    let score = record.id && target.includes(normalizeRegistryIdentity(record.id)) ? 100 : 80;
    const providerId = normalizeRegistryIdentity(record.provider);
    if (providerId && hints.some((hint) => hint === providerId || hint.includes(providerId) || providerId.includes(hint))) score += 20;
    if (record.metadata?.base_model || record.metadata?.baseModel) score -= 2;
    if (!best || score > best.score) best = { score, metadata: record.metadata, provider: record.provider };
  }
  if (!best) return undefined;

  // A model registry entry that belongs to the configured provider (for
  // example models.dev's `opencode-go` catalog for an OpenCode Go endpoint)
  // describes the model as served through that route. It is trustworthy
  // provider metadata, even when the compatible /models response only
  // returns bare ids. A generic model match remains conservative.
  const providerMatched = Boolean(best.provider && providerIds.includes(normalizeRegistryIdentity(best.provider)));
  return { metadata: best.metadata, providerMatched };
}

export class CatalogSyncService {
  private static catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
  private static modelRegistryCachePath = path.join(os.homedir(), ".opencodex", "model_registry_cache.json");
  private static modelRegistryPayload: any | null = null;
  private static modelRegistryLoadedAt = 0;

  private static readModelRegistryCache(): any | null {
    if (CatalogSyncService.modelRegistryPayload) return CatalogSyncService.modelRegistryPayload;
    try {
      const cached = JSON.parse(fs.readFileSync(CatalogSyncService.modelRegistryCachePath, "utf-8"));
      if (cached?.payload) {
        CatalogSyncService.modelRegistryPayload = cached.payload;
        CatalogSyncService.modelRegistryLoadedAt = Number(cached.fetched_at || 0);
        return cached.payload;
      }
      CatalogSyncService.modelRegistryPayload = cached;
      CatalogSyncService.modelRegistryLoadedAt = 0;
      return cached;
    } catch {
      return null;
    }
  }

  public static async refreshModelRegistry(force = false): Promise<any | null> {
    const cached = CatalogSyncService.readModelRegistryCache();
    const cacheAge = Date.now() - CatalogSyncService.modelRegistryLoadedAt;
    if (!force && cached && cacheAge >= 0 && cacheAge < 12 * 60 * 60 * 1000) return cached;
    try {
      const response = await fetch(MODEL_REGISTRY_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(4500),
      });
      if (!response.ok) return cached;
      const payload = await response.json();
      if (!payload || typeof payload !== "object") return cached;
      CatalogSyncService.modelRegistryPayload = payload;
      CatalogSyncService.modelRegistryLoadedAt = Date.now();
      try {
        fs.mkdirSync(path.dirname(CatalogSyncService.modelRegistryCachePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(CatalogSyncService.modelRegistryCachePath, JSON.stringify({ fetched_at: CatalogSyncService.modelRegistryLoadedAt, payload }, null, 2), { encoding: "utf-8", mode: 0o600 });
      } catch {}
      return payload;
    } catch {
      return cached;
    }
  }

  public static getKnownModelMetadata(provider: any, modelSlug: string): any | undefined {
    const explicit = providerMetadataEntry(provider, modelSlug);
    const registryMatch = findModelRegistryMatch(CatalogSyncService.readModelRegistryCache(), provider, modelSlug);
    const registry = registryMatch?.metadata;
    const desktopCache = codexModelCacheMetadata(modelSlug);
    if (!explicit && !registry && !desktopCache) return undefined;
    const explicitContext = extractModelContextWindow(explicit);
    const registryContext = extractModelContextWindow(registry);
    const explicitSource = contextWindowSource(explicit);
    const explicitContextIsLive = Boolean(explicitContext && explicitSource !== "model_registry" && explicitSource !== "unknown");
    const explicitLevels = extractModelReasoningLevels(explicit);
    const registryLevels = extractModelReasoningLevels(registry);
    const desktopLevels = extractModelReasoningLevels(desktopCache);
    const registrySource = registryMatch?.providerMatched ? "provider_metadata" : "model_registry";
    // The Desktop cache is derived and can contain an older third-party
    // projection. Keep its reasoning capabilities as a compatibility source,
    // but never let its context window override the provider or registry.
    const desktopCapabilities = desktopCache && typeof desktopCache === "object"
      ? { ...desktopCache }
      : undefined;
    if (desktopCapabilities) {
      delete desktopCapabilities.context_window;
      delete desktopCapabilities.max_context_window;
      delete desktopCapabilities.context_window_source;
      delete desktopCapabilities.context_window_confidence;
    }
    return {
      ...(registry && typeof registry === "object" ? registry : {}),
      ...(desktopCapabilities || {}),
      ...(explicit && typeof explicit === "object" ? explicit : {}),
      ...(explicitContextIsLive
        ? {
          context_window: explicitContext,
          max_context_window: explicitContext,
          context_window_source: "provider_metadata",
        }
        : registryContext
          ? {
            context_window: registryContext,
            max_context_window: registryContext,
            context_window_source: registrySource,
          }
          : {}),
      ...(explicitLevels !== undefined || desktopLevels !== undefined || registryLevels !== undefined
        ? { supported_reasoning_levels: explicitLevels !== undefined ? explicitLevels : desktopLevels !== undefined ? desktopLevels : registryLevels }
        : {}),
      metadata_source: registryMatch?.providerMatched
        ? "provider_metadata"
        : explicit?.metadata_source
          ? explicit.metadata_source
          : explicitContextIsLive || explicitLevels !== undefined || desktopLevels !== undefined
            ? "provider_metadata"
            : registrySource,
    };
  }

  /**
   * Native Codex owns the official cache entries. Every other entry is a
   * projection of custom_model_catalog.json, so rebuilding the cache from
   * that file also removes models that were deleted or cleared during a
   * restore. The previous implementation only overlaid new entries and left
   * stale third-party models behind forever.
   */
  public static mergeCatalogModelsIntoCodexCache(existingModels: any[], catalogModels: any[]): any[] {
    const next = new Map<string, any>();
    for (const model of Array.isArray(existingModels) ? existingModels : []) {
      const slug = String(model?.slug || "").trim();
      if (!slug || !isNativeCodexCacheModel(model)) continue;
      next.set(slug, model);
    }

    for (const model of Array.isArray(catalogModels) ? catalogModels : []) {
      const slug = String(model?.slug || "").trim();
      if (!slug || isNativeCodexCacheModel(model)) continue;
      next.set(slug, withComputerUseCatalogInstructions(applyDefaultReasoningCapabilities({
        ...model,
        provider: "opencodex",
        model_provider: "opencodex",
      })));
    }
    return Array.from(next.values());
  }

  public static syncCustomModelsToCodexCache(): boolean {
    try {
      const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
      const catPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
      if (!fs.existsSync(cachePath) || !fs.existsSync(catPath)) return false;

      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      const cat = JSON.parse(fs.readFileSync(catPath, "utf-8"));
      if (!Array.isArray(cache.models) || !Array.isArray(cat.models)) return false;

      cache.models = CatalogSyncService.mergeCatalogModelsIntoCodexCache(cache.models, cat.models);
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
      return true;
    } catch (error: any) {
      // Do not hide permission/path/parse failures. In the packaged app this
      // is the boundary that determines whether Codex can see third-party
      // models after a restart.
      console.warn(`[OpenCodex Catalog] Could not sync Codex model cache: ${error?.message || error}`);
      return false;
    }
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

  public static async fetchLiveModels(provider: ProviderConfig): Promise<ProviderModelDescriptor[]> {
    const rawUrl = (provider as any).baseUrl || (provider as any).base_url || (provider as any).url || "";
    if (!rawUrl) return [];

    const apiKey = CredentialStore.resolveApiKey(provider);
    const modelsEndpoint = rawUrl.endsWith("/models")
      ? rawUrl
      : `${rawUrl.replace(/\/$/, "")}/models`;

    let models: ProviderModelDescriptor[] = [];
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await fetch(modelsEndpoint, { method: "GET", headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const json: any = await res.json();
        const modelList = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
        if (modelList.length > 0) {
          models = modelList
            .map((item: any) => normalizeProviderModelDescriptor(item))
            .filter((item: ProviderModelDescriptor | null): item is ProviderModelDescriptor => Boolean(item));
        }
      }
    } catch {
      // Fallback to configured models on network error
    }
    if (models.length === 0) {
      models = (Array.isArray(provider.models) ? provider.models : [])
        .map((item: any) => normalizeProviderModelDescriptor(item))
        .filter((item: ProviderModelDescriptor | null): item is ProviderModelDescriptor => Boolean(item));
    }
    return CatalogSyncService.enrichLiveModels(provider, models);
  }

  private static async enrichLiveModels(provider: ProviderConfig, models: ProviderModelDescriptor[]): Promise<ProviderModelDescriptor[]> {
    if (models.length === 0) return models;
    const needsRegistry = models.some((model) => extractModelContextWindow(model) === undefined || extractModelReasoningLevels(model) === undefined);
    const registry = needsRegistry
      ? await CatalogSyncService.refreshModelRegistry()
      : CatalogSyncService.readModelRegistryCache();

    return models.map((model) => {
      const registryMatch = findModelRegistryMatch(registry, provider, model.id);
      const registryMetadata = registryMatch?.metadata;
      // A provider validation response is a stronger, model-specific
      // capability signal than a shared registry entry. In particular, the
      // registry may advertise `max` while Xiaomi/OpenCode rejects it for the
      // exact DeepSeek deployment. Keep the learned provider metadata in the
      // catalog refresh path so the invalid level is not reintroduced.
      const providerMetadata = getProviderModelMetadata(provider, model.id);
      const registryContext = extractModelContextWindow(registryMetadata);
      const registryLevels = extractModelReasoningLevels(registryMetadata);
      const directContext = extractModelContextWindow(model);
      const directLevels = extractModelReasoningLevels(model);
      const providerContext = extractModelContextWindow(providerMetadata);
      const providerLevels = extractModelReasoningLevels(providerMetadata);
      const selectedLevels = directLevels !== undefined ? directLevels : providerLevels !== undefined ? providerLevels : registryLevels;
      const contextSource = directContext
        ? "provider_metadata"
        : providerContext
          ? "provider_metadata"
        : registryContext
          ? (registryMatch?.providerMatched ? "provider_metadata" : "model_registry")
          : "unknown";
      return {
        ...model,
        ...(directContext || providerContext || registryContext ? { context_window: directContext || providerContext || registryContext, max_context_window: directContext || providerContext || registryContext } : {}),
        ...(contextSource !== "unknown" ? { context_window_source: contextSource } : {}),
        ...(selectedLevels !== undefined
          ? { supported_reasoning_levels: selectedLevels }
          : {}),
        ...(typeof model.reasoning === "boolean" || typeof providerMetadata?.reasoning === "boolean" || typeof registryMetadata?.reasoning === "boolean"
          ? { reasoning: typeof model.reasoning === "boolean" ? model.reasoning : typeof providerMetadata?.reasoning === "boolean" ? providerMetadata.reasoning : registryMetadata.reasoning }
          : {}),
        ...((directContext || providerContext || directLevels !== undefined || providerLevels !== undefined)
          ? { metadata_source: "provider_metadata" }
          : (registryContext || registryLevels !== undefined)
            ? { metadata_source: registryMatch?.providerMatched ? "provider_metadata" : "model_registry" }
            : {}),
      };
    });
  }

  public static modelMetadataMap(provider: ProviderConfig, models: ProviderModelDescriptor[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const model of models) {
      const context = extractModelContextWindow(model);
      const levels = extractModelReasoningLevels(model);
      if (!context && levels === undefined && typeof model.reasoning !== "boolean") continue;
      const source = context
        ? (model.context_window_source || (model.metadata_source === "model_registry" ? "model_registry" : "provider_metadata"))
        : undefined;
      result[model.id] = {
        ...(context ? { context_window: context, max_context_window: context } : {}),
        ...(source ? { context_window_source: source } : {}),
        ...(levels !== undefined ? { supported_reasoning_levels: levels } : {}),
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        ...(model.default_reasoning_level ? { default_reasoning_level: model.default_reasoning_level } : {}),
        ...(model.metadata_source ? { metadata_source: model.metadata_source } : {}),
      };
    }
    return result;
  }

  /**
   * Merge a fresh discovery result without allowing a registry-only refresh to
   * erase a previously verified provider context window. Providers often
   * return model ids but omit capability fields on a later /models call.
   */
  public static mergeProviderModelMetadata(previous: Record<string, any> | undefined, discovered: Record<string, any> | undefined): Record<string, any> {
    const result: Record<string, any> = { ...(previous || {}) };
    for (const [modelId, rawMetadata] of Object.entries(discovered || {})) {
      const prior = result[modelId] && typeof result[modelId] === "object" ? result[modelId] : {};
      const next = rawMetadata && typeof rawMetadata === "object" ? rawMetadata : {};
      const priorLiveContext = getProviderReportedContextWindow(prior);
      const nextLiveContext = getProviderReportedContextWindow(next);
      const merged: any = { ...prior, ...next };

      if (priorLiveContext && !nextLiveContext) {
        merged.context_window = priorLiveContext;
        merged.max_context_window = priorLiveContext;
        merged.context_window_source = "provider_metadata";
        if (next.metadata_source === "model_registry" || !next.metadata_source) {
          merged.metadata_source = prior.metadata_source || "provider_metadata";
        }
      }
      result[modelId] = merged;
    }
    return result;
  }

  /** Learn an exact provider enum from a validation response, without retrying at a different effort. */
  public static learnReasoningLevelsFromProviderError(providerName: string, modelSlug: string, body: string): boolean {
    const levels = extractReasoningLevelsFromProviderError(body);
    if (levels.length === 0) return false;
    const owner = String(providerName || "").trim().toLowerCase();
    const backend = String(modelSlug || "").trim();
    if (!owner || !backend) return false;

    const providers = CredentialStore.loadProviders();
    const provider = providers.find((item: any) => String(item?.name || item?.preset_id || "").trim().toLowerCase() === owner);
    if (!provider) return false;

    const existing = getProviderModelMetadata(provider, backend) || {};
    const nextMetadata = {
      ...existing,
      supported_reasoning_levels: levels,
      metadata_source: "provider_metadata",
      metadata_updated_at: new Date().toISOString(),
    };
    provider.model_metadata = { ...(provider.model_metadata || {}), [backend]: nextMetadata };
    CredentialStore.saveProviders(providers);

    try {
      const rawCatalog = fs.existsSync(CatalogSyncService.catalogPath)
        ? JSON.parse(fs.readFileSync(CatalogSyncService.catalogPath, "utf-8"))
        : undefined;
      if (rawCatalog && Array.isArray(rawCatalog.models)) {
        let changed = false;
        for (const model of rawCatalog.models) {
          const modelOwner = String(model?.backend_provider || "").trim().toLowerCase();
          const modelBackend = String(model?.backend_model || "").trim().toLowerCase();
          if (modelOwner !== owner || modelBackend !== backend.toLowerCase()) continue;
          model.supported_reasoning_levels = levels;
          model.default_reasoning_level = levels.some((level) => level.effort === "medium") ? "medium" : levels[0].effort;
          model.context_window_source = model.context_window_source || "unknown";
          changed = true;
        }
        if (changed) {
          fs.writeFileSync(CatalogSyncService.catalogPath, JSON.stringify(rawCatalog, null, 2), "utf-8");
          CatalogSyncService.syncCustomModelsToCodexCache();
        }
      }
    } catch {}
    return true;
  }

  /** Refresh provider metadata without changing the configured model list. */
  public static async refreshConfiguredProviderMetadata(providers: ProviderConfig[]): Promise<boolean> {
    let changed = false;
    await Promise.all((Array.isArray(providers) ? providers : []).map(async (provider) => {
      if (!provider?.baseUrl && !(provider as any)?.base_url) return;
      const liveModels = await CatalogSyncService.fetchLiveModels(provider);
      const discovered = CatalogSyncService.modelMetadataMap(provider, liveModels);
      if (Object.keys(discovered).length === 0) return;
      const previous = provider.model_metadata || {};
      const next = CatalogSyncService.mergeProviderModelMetadata(previous, discovered);
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        provider.model_metadata = next;
        changed = true;
      }
    }));
    return changed;
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
          liveModels = p.models
            .map((item: any) => normalizeProviderModelDescriptor(item))
            .filter((item: ProviderModelDescriptor | null): item is ProviderModelDescriptor => Boolean(item));
        }

        for (const model of liveModels) {
          const lower = model.id.toLowerCase();
          const protocol = (p as any).model_protocols?.[model.id] === "responses" ? "responses" : "chat";
          const liveContext = model.context_window_source === "provider_metadata"
            ? model.context_window
            : undefined;
          const full = buildFullCatalogEntry(model.id, p.name, liveContext, protocol, model);
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
