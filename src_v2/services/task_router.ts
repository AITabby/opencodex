import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AgentProfile,
  AgentProfileStore,
  AgentRouteEvent,
  AgentRoutingMode,
  AgentTaskSource,
} from "./agent_profile_store.js";

export interface RoutingCatalogModel {
  slug: string;
  backend_model: string;
  provider: string;
  display_name?: string;
  protocol?: string;
  context_window?: number;
  max_context_window?: number;
  context_window_source?: "provider_metadata" | "model_registry" | "unknown";
  context_window_confidence?: "exact" | "unknown";
  metadata_source?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  default_reasoning_level?: string;
  reasoning?: boolean;
  available: boolean;
  catalog_source: "custom" | "native";
}

export interface TaskRouteRequest {
  source: AgentTaskSource;
  task_id?: string;
  task_text?: string;
  task_type?: string;
  tags?: string[];
  profile_id?: string;
  forced_model?: string;
  reasoning_effort?: string;
  /** Keep an explicitly selected per-turn effort verbatim at the provider boundary. */
  preserve_reasoning_effort?: boolean;
  required_tools?: string[];
  permission?: string;
}

export interface ResolvedTaskRoute {
  ok: boolean;
  mode: AgentRoutingMode;
  profile_id?: string;
  profile_name?: string;
  model?: string;
  backend_model?: string;
  provider?: string;
  protocol?: string;
  reasoning_effort?: string;
  tools?: string[];
  permission?: string;
  reason: string;
  unavailable?: boolean;
  catalog_model?: RoutingCatalogModel;
}

export const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const DEFAULT_REASONING_LEVELS = DEFAULT_REASONING_EFFORTS.map((effort) => ({ effort }));

function clean(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function list(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => clean(item, 120)).filter(Boolean))).slice(0, max);
}

function lower(value: unknown): string {
  return clean(value, 400).toLowerCase();
}

function normalizeReasoningForModel(model: RoutingCatalogModel, requestedValue?: string, preserveExplicit = false): string | undefined {
  const declaredSupported = (model.supported_reasoning_levels || [])
    .map((level) => lower(level.effort))
    .filter(Boolean);

  // Keep an explicit provider enum authoritative even when a broad
  // `reasoning: false` flag is also present. Only an explicit false with no
  // returned levels means that this model is automatic-only.
  if (model.reasoning === false && declaredSupported.length === 0) return undefined;
  const supported = declaredSupported.length > 0
    ? declaredSupported
    : DEFAULT_REASONING_LEVELS.map((level) => level.effort);

  const requested = lower(requestedValue);
  if (requested && supported.includes(requested)) return requested;
  // The value may come from the Desktop/Web picker rather than from a saved
  // Profile. In that case do not silently turn an explicit `max`/`xhigh` into
  // the model's default merely because an older local catalog is incomplete.
  // The provider remains the authority: if it rejects the value, the gateway
  // records the returned enum and refreshes the shared catalog.
  if (requested && preserveExplicit) return requested;

  if (supported.length === 0) return undefined;

  const declaredDefault = lower(model.default_reasoning_level);
  if (declaredDefault && supported.includes(declaredDefault)) return declaredDefault;
  return supported[0];
}

function capabilityTokens(value: unknown): string[] {
  const parts = lower(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens: string[] = [];
  for (const part of parts) {
    if (/^[\u3400-\u9fff]+$/u.test(part)) {
      tokens.push(part);
      for (let index = 0; index + 1 < part.length; index += 1) {
        tokens.push(part.slice(index, index + 2));
      }
    } else if (part.length >= 2) {
      tokens.push(part);
    }
  }
  return Array.from(new Set(tokens)).filter((token) => token.length >= 2).slice(0, 160);
}

function catalogValue(entry: any, keys: string[]): string {
  for (const key of keys) {
    const value = clean(entry?.[key], 300);
    if (value) return value;
  }
  return "";
}

function catalogPositiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function catalogContextValue(entry: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = catalogPositiveNumber(entry?.[key]);
    if (value) return value;
  }
  for (const container of [entry?.limit, entry?.limits, entry?.capabilities?.limit, entry?.capabilities?.limits]) {
    if (!container || typeof container !== "object") continue;
    for (const key of keys) {
      const value = catalogPositiveNumber(container[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function modelFromEntry(entry: any, source: "custom" | "native"): RoutingCatalogModel | null {
  const slug = catalogValue(entry, ["slug", "id", "model"]);
  const backendModel = catalogValue(entry, ["backend_model", "backendModel", "model", "slug", "id"]);
  if (!slug || !backendModel) return null;
  const rawReasoningLevels = entry?.supported_reasoning_levels
    ?? entry?.supportedReasoningEfforts
    ?? entry?.supported_reasoning_efforts
    ?? entry?.reasoning_efforts
    ?? entry?.reasoningEfforts
    ?? entry?.reasoning_levels
    ?? entry?.reasoningLevels;
  const reasoningLevels = Array.isArray(rawReasoningLevels)
    ? rawReasoningLevels
      .map((item: any) => ({
        effort: clean(item?.effort ?? item?.reasoning_effort ?? item?.reasoningEffort ?? item?.value ?? item, 40),
        description: clean(item?.description, 300) || undefined,
      }))
      .filter((item: any) => item.effort)
    : undefined;
  const rawDefaultReasoning = entry?.default_reasoning_level
    ?? entry?.defaultReasoningEffort
    ?? entry?.defaultReasoningLevel;
  const defaultReasoning = typeof rawDefaultReasoning === "object"
    ? clean(rawDefaultReasoning?.effort ?? rawDefaultReasoning?.reasoningEffort, 40)
    : clean(rawDefaultReasoning, 40);
  const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
  const contextWindow = catalogContextValue(entry, ["context_window", "contextWindow", "context_length", "contextLength"]);
  const maxContextWindow = catalogContextValue(entry, ["max_context_window", "maxContextWindow", "max_context_length", "maxContextLength"]);
  const contextSource = ["provider_metadata", "model_registry", "unknown"].includes(String(entry?.context_window_source || "").trim().toLowerCase())
    ? String(entry.context_window_source).trim().toLowerCase() as "provider_metadata" | "model_registry" | "unknown"
    : undefined;
  const contextConfidence = ["exact", "unknown"].includes(String(entry?.context_window_confidence || "").trim().toLowerCase())
    ? String(entry.context_window_confidence).trim().toLowerCase() as "exact" | "unknown"
    : undefined;
  const effectiveReasoningLevels = reasoning === false
    ? (reasoningLevels || [])
      : reasoningLevels && reasoningLevels.length > 0
      ? [
        ...DEFAULT_REASONING_LEVELS.map((level) => reasoningLevels.find((declared) => declared.effort.toLowerCase() === level.effort) || level),
        ...reasoningLevels.filter((declared) => !DEFAULT_REASONING_LEVELS.some((level) => declared.effort.toLowerCase() === level.effort)),
      ]
      : DEFAULT_REASONING_LEVELS;
  const effectiveDefaultReasoning = effectiveReasoningLevels && effectiveReasoningLevels.length > 0
    ? (effectiveReasoningLevels.some((level) => level.effort.toLowerCase() === defaultReasoning.toLowerCase())
      ? defaultReasoning
      : effectiveReasoningLevels.some((level) => level.effort === "medium")
        ? "medium"
        : effectiveReasoningLevels[0].effort)
    : undefined;
  return {
    slug,
    backend_model: backendModel,
    provider: lower(catalogValue(entry, ["backend_provider", "provider", "owner"]) || (source === "native" ? "native" : "")),
    display_name: catalogValue(entry, ["display_name", "displayName", "name"]) || undefined,
    protocol: catalogValue(entry, ["protocol", "backend_protocol"]) || undefined,
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(maxContextWindow ? { max_context_window: maxContextWindow } : {}),
    ...(contextSource ? { context_window_source: contextSource } : {}),
    ...(contextConfidence ? { context_window_confidence: contextConfidence } : {}),
    ...(typeof entry?.metadata_source === "string" && entry.metadata_source.trim()
      ? { metadata_source: entry.metadata_source.trim() }
      : {}),
    supported_reasoning_levels: effectiveReasoningLevels,
    default_reasoning_level: effectiveDefaultReasoning,
    reasoning,
    available: entry?.available !== false,
    catalog_source: source,
  };
}

export function readRoutingCatalog(
  dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex"),
  nativeDataDir = path.join(os.homedir(), ".codex"),
): RoutingCatalogModel[] {
  const sources: Array<{ filePath: string; source: "custom" | "native" }> = [
    // This is Codex's existing model capability interface/cache. It carries
    // the exact per-model reasoning options returned by the native catalog.
    { filePath: path.join(nativeDataDir, "models_cache.json"), source: "native" },
    // Keep the older filename as a compatibility fallback for installations
    // that still publish the catalog under this name.
    { filePath: path.join(nativeDataDir, "models_catalog.json"), source: "native" },
    { filePath: path.join(dataDir, "custom_model_catalog.json"), source: "custom" },
  ];
  const result = new Map<string, RoutingCatalogModel>();
  for (const source of sources) {
    let payload: any;
    try { payload = JSON.parse(fs.readFileSync(source.filePath, "utf-8")); } catch { continue; }
    const entries = Array.isArray(payload) ? payload : payload?.models;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const model = modelFromEntry(entry, source.source);
      if (!model) continue;
      // Native models are mirrored into custom_model_catalog.json when the
      // gateway is managed. Merge duplicate capability records instead of
      // letting a stale Desktop cache hide a newly imported extra level such
      // as DeepSeek `max` from the Web routing directory.
      if (model.slug.toLowerCase() === "codex-auto-review") continue;
      const key = model.slug.toLowerCase();
      const previous = result.get(key);
      if (!previous) {
        result.set(key, model);
        continue;
      }
      const levels = new Map<string, { effort: string; description?: string }>();
      for (const level of previous.supported_reasoning_levels || []) levels.set(level.effort.toLowerCase(), level);
      for (const level of model.supported_reasoning_levels || []) {
        const normalizedEffort = level.effort.toLowerCase();
        if (!levels.has(normalizedEffort) || level.description) levels.set(normalizedEffort, level);
      }
      const mergedLevels = Array.from(levels.values());
      const mergedDefault = [model.default_reasoning_level, previous.default_reasoning_level]
        .map((value) => lower(value))
        .find((value) => value && mergedLevels.some((level) => level.effort.toLowerCase() === value));
      result.set(key, {
        ...previous,
        ...model,
        supported_reasoning_levels: mergedLevels,
        ...(mergedDefault ? { default_reasoning_level: mergedDefault } : {}),
      });
    }
  }
  return Array.from(result.values()).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function extractTaskText(value: any): string {
  if (typeof value === "string") return clean(value, 4000);
  if (!value || typeof value !== "object") return "";
  const parts: string[] = [];
  const visit = (current: any, key = "", depth = 0): void => {
    if (depth > 5 || current == null) return;
    if (typeof current === "string") {
      if (!key || /^(input|text|content|message|prompt|task|instructions|summary)$/i.test(key)) parts.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key, depth + 1);
      return;
    }
    if (typeof current !== "object") return;
    for (const [childKey, childValue] of Object.entries(current)) {
      if (/^(instructions|input|messages|text|task|prompt|message|content|client_metadata)$/i.test(childKey) || typeof childValue === "object") {
        visit(childValue, childKey, depth + 1);
      }
    }
  };
  visit(value);
  return Array.from(new Set(parts.map((part) => clean(part, 4000)).filter(Boolean))).slice(-8).join("\n").slice(0, 8000);
}

function matchingProfileScore(profile: AgentProfile, request: TaskRouteRequest): { score: number; reason: string } {
  let score = profile.priority;
  const reasons: string[] = [];
  const requestedType = lower(request.task_type);
  const requestedTags = new Set(list(request.tags).map((item) => item.toLowerCase()));
  const profileTypes = new Set(profile.task_types.map((item) => item.toLowerCase()));
  const profileTags = new Set(profile.tags.map((item) => item.toLowerCase()));

  if (requestedType) {
    if (profileTypes.has(requestedType)) {
      score += 100;
      reasons.push(`task_type=${requestedType}`);
    } else if (profileTags.has(requestedType)) {
      score += 65;
      reasons.push(`tag=${requestedType}`);
    }
  }
  for (const tag of requestedTags) {
    if (profileTypes.has(tag) || profileTags.has(tag)) {
      score += 20;
      reasons.push(`tag=${tag}`);
    }
  }

  const requiredTools = list(request.required_tools).map((item) => item.toLowerCase());
  const profileTools = new Set(profile.tools.map((item) => item.toLowerCase()));
  if (requiredTools.length > 0) {
    const missing = requiredTools.filter((tool) => !profileTools.has(tool));
    if (missing.length > 0) return { score: -100000, reason: `missing_tools=${missing.join(",")}` };
    score += requiredTools.length * 12;
    reasons.push("required_tools");
  }

  if (request.permission && profile.permission === request.permission) {
    score += 12;
    reasons.push(`permission=${request.permission}`);
  }

  // When the caller cannot provide a structured task_type (the native
  // subagent bridge often only gives us the task text), use only labels the
  // user authored in this Profile. This is deliberately not a developer-owned
  // keyword table and never infers a provider's capability from its name.
  const taskTokens = capabilityTokens(request.task_text);
  if (taskTokens.length > 0) {
    const userLabels = capabilityTokens([profile.name, profile.description, ...profile.task_types, ...profile.tags].join(" "));
    const matchedLabels = userLabels.filter((label) => taskTokens.includes(label));
    if (matchedLabels.length > 0) {
      score += Math.min(60, matchedLabels.length * 10);
      reasons.push(`user_capabilities=${Array.from(new Set(matchedLabels)).slice(0, 6).join("|")}`);
    }
  }
  return { score, reason: reasons.join(",") || "profile_priority" };
}

export class TaskRouter {
  public readonly store: AgentProfileStore;

  constructor(store = new AgentProfileStore()) {
    this.store = store;
  }

  public listProfiles(): AgentProfile[] {
    return this.store.loadProfiles();
  }

  public listModels(): RoutingCatalogModel[] {
    return readRoutingCatalog(this.store.dataDir);
  }

  public getSettings() {
    return this.store.loadRoutingSettings();
  }

  /**
   * Normalize a parent/native reasoning value for a concrete target model.
   * A parent turn can advertise `max` while a child only accepts low/medium/
   * high, or has no selectable effort enum at all. In both cases the target
   * model must win: use its declared default/first level, or omit the field
   * when the catalog says the model is automatic-only.
   */
  public normalizeReasoningEffort(modelValue: string, requestedValue?: string, preserveExplicit = false): string | undefined {
    const requested = lower(modelValue);
    const model = this.listModels().find((entry) =>
      entry.slug.toLowerCase() === requested ||
      entry.backend_model.toLowerCase() === requested ||
      entry.display_name?.toLowerCase() === requested,
    );
    if (!model) return clean(requestedValue, 40) || undefined;
    return normalizeReasoningForModel(model, requestedValue, preserveExplicit);
  }

  public resolve(request: TaskRouteRequest): ResolvedTaskRoute {
    const settings = this.store.loadRoutingSettings();
    const profiles = this.store.loadProfiles();
    const catalog = this.listModels();
    const source = request.source || "manual";

    const explicitModel = clean(request.forced_model);
    if (explicitModel) {
      return this.resolveModel(explicitModel, undefined, request, catalog, "explicit forced model");
    }

    const explicitProfileId = clean(request.profile_id, 80);
    if (explicitProfileId) {
      const profile = profiles.find((item) => item.id === explicitProfileId);
      if (!profile) return this.unavailable(request, "requested profile is not configured");
      if (!profile.enabled) return this.unavailable(request, `profile ${profile.id} is disabled`, profile);
      if (request.source === "gpt-live" && !profile.live_enabled) return this.unavailable(request, `profile ${profile.id} is not enabled for GPT-Live`, profile);
      if (request.source === "subagent" && !profile.subagent_enabled) return this.unavailable(request, `profile ${profile.id} is not enabled for subagents`, profile);
      return this.resolveProfile(profile, request, catalog, "explicit profile", profiles);
    }

    if (settings.mode === "off") {
      return { ok: false, mode: "off", reason: "routing is disabled" };
    }

    if (settings.mode === "forced") {
      if (settings.forced_model) return this.resolveModel(settings.forced_model, undefined, request, catalog, "forced routing model");
      if (settings.forced_profile_id) {
        const profile = profiles.find((item) => item.id === settings.forced_profile_id);
        if (!profile) return this.unavailable(request, "forced profile is not configured");
        if (!profile.enabled) return this.unavailable(request, `forced profile ${profile.id} is disabled`, profile);
        if (request.source === "gpt-live" && !profile.live_enabled) return this.unavailable(request, `forced profile ${profile.id} is not enabled for GPT-Live`, profile);
        if (request.source === "subagent" && !profile.subagent_enabled) return this.unavailable(request, `forced profile ${profile.id} is not enabled for subagents`, profile);
        return this.resolveProfile(profile, request, catalog, "forced routing profile", profiles);
      }
      return { ok: false, mode: "forced", reason: "forced routing is enabled but no model or profile is selected" };
    }

    const candidates = profiles
      .filter((profile) => profile.enabled)
      .filter((profile) => source !== "gpt-live" || profile.live_enabled)
      .filter((profile) => source !== "subagent" || profile.subagent_enabled)
      .map((profile) => ({ profile, ...matchingProfileScore(profile, request) }))
      .filter((item) => item.score > -100000)
      .sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id));

    const requestedType = lower(request.task_type);
    const matched = candidates.find((item) => item.reason.includes("user_capabilities=") || (requestedType && (item.profile.task_types.some((type) => type.toLowerCase() === requestedType) || item.profile.tags.some((tag) => tag.toLowerCase() === requestedType))));
    const defaultProfile = settings.default_profile_id
      ? candidates.find((item) => item.profile.id === settings.default_profile_id)
      : undefined;
    const selected = matched || (requestedType && settings.strict_matching ? undefined : defaultProfile || candidates[0]);

    if (!selected) {
      return this.unavailable(request, requestedType ? `no profile matched task_type=${requestedType}` : "no enabled profile is configured");
    }
    return this.resolveProfile(selected.profile, request, catalog, `auto: ${selected.reason}`, profiles);
  }

  public record(request: TaskRouteRequest, route: ResolvedTaskRoute, status: AgentRouteEvent["status"] = route.ok ? "resolved" : "unavailable"): AgentRouteEvent {
    return this.store.appendRouteEvent({
      source: request.source,
      task_id: request.task_id,
      profile_id: route.profile_id,
      model: route.model,
      backend_model: route.backend_model,
      provider: route.provider,
      reasoning_effort: route.reasoning_effort,
      status,
      reason: route.reason,
    });
  }

  private resolveProfile(profile: AgentProfile, request: TaskRouteRequest, catalog: RoutingCatalogModel[], reason: string, profiles: AgentProfile[]): ResolvedTaskRoute {
    const direct = this.resolveProfileDirect(profile, request, catalog, reason);
    if (direct.ok || profile.fallback_profile_ids.length === 0) return direct;
    for (const fallbackId of profile.fallback_profile_ids) {
      const fallback = profiles.find((candidate) => candidate.id === fallbackId && candidate.enabled);
      if (!fallback) continue;
      if (request.source === "gpt-live" && !fallback.live_enabled) continue;
      if (request.source === "subagent" && !fallback.subagent_enabled) continue;
      const fallbackRoute = this.resolveProfileDirect(fallback, request, catalog, `${reason}; explicit fallback=${fallback.id}`);
      if (fallbackRoute.ok) return fallbackRoute;
    }
    return direct;
  }

  private resolveProfileDirect(profile: AgentProfile, request: TaskRouteRequest, catalog: RoutingCatalogModel[], reason: string): ResolvedTaskRoute {
    if (!profile.model_ref) return this.unavailable(request, `profile ${profile.id} has no model binding`, profile);
    return this.resolveModel(profile.model_ref.catalog_slug || profile.model_ref.backend_model, profile, request, catalog, reason, profile.model_ref);
  }

  private resolveModel(modelValue: string, profile: AgentProfile | undefined, request: TaskRouteRequest, catalog: RoutingCatalogModel[], reason: string, modelRef?: { provider?: string; backend_model?: string; catalog_slug?: string }): ResolvedTaskRoute {
    const requested = lower(modelValue);
    const expectedProvider = lower(modelRef?.provider);
    const expectedBackend = lower(modelRef?.backend_model);
    const model = catalog.find((entry) => {
      if (expectedProvider && entry.provider !== expectedProvider) return false;
      return (modelRef?.catalog_slug && entry.slug.toLowerCase() === lower(modelRef.catalog_slug)) ||
        (expectedBackend && entry.backend_model.toLowerCase() === expectedBackend) ||
        (!modelRef && (entry.slug.toLowerCase() === requested || entry.backend_model.toLowerCase() === requested || entry.display_name?.toLowerCase() === requested));
    });
    if (!model || !model.available) {
      return this.unavailable(request, `model ${modelValue} is not available in the local catalog`, profile);
    }
    const requestedReasoning = clean(request.reasoning_effort, 40);
    const profileReasoning = profile?.reasoning_effort;
    // A saved Web Profile is the durable model binding. Once a Profile has
    // been selected or explicitly bound, its reasoning setting must remain
    // authoritative across routing modes; task-level values are only a
    // fallback for models without a bound Profile.
    const configuredReasoning = profileReasoning || requestedReasoning;
    const reasoning = normalizeReasoningForModel(
      model,
      configuredReasoning,
      Boolean(!profileReasoning && request.preserve_reasoning_effort && requestedReasoning),
    );
    return {
      ok: true,
      mode: this.store.loadRoutingSettings().mode,
      profile_id: profile?.id,
      profile_name: profile?.name,
      model: model.slug,
      backend_model: model.backend_model,
      provider: model.provider,
      protocol: model.protocol,
      reasoning_effort: reasoning || undefined,
      tools: profile?.tools,
      permission: profile?.permission,
      reason,
      catalog_model: model,
    };
  }

  private unavailable(request: TaskRouteRequest, reason: string, profile?: AgentProfile): ResolvedTaskRoute {
    const route: ResolvedTaskRoute = {
      ok: false,
      mode: this.store.loadRoutingSettings().mode,
      profile_id: profile?.id,
      profile_name: profile?.name,
      reason,
      unavailable: true,
    };
    this.record(request, route);
    return route;
  }
}
