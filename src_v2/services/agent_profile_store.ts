import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const AGENT_PROFILE_SCHEMA_VERSION = 1;
export const AGENT_ROUTING_SCHEMA_VERSION = 1;

export type AgentRoutingMode = "auto" | "forced" | "off";
export type AgentTaskSource = "gpt-live" | "main-agent" | "subagent" | "manual";

export interface AgentModelRef {
  provider: string;
  backend_model: string;
  catalog_slug?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  task_types: string[];
  tags: string[];
  model_ref: AgentModelRef | null;
  reasoning_effort?: string;
  permission?: string;
  tools: string[];
  fallback_profile_ids: string[];
  live_enabled: boolean;
  subagent_enabled: boolean;
  enabled: boolean;
  priority: number;
  updated_at: string;
}

export interface AgentRoutingSettings {
  mode: AgentRoutingMode;
  default_profile_id: string | null;
  forced_profile_id: string | null;
  forced_model: string | null;
  strict_matching: boolean;
  updated_at: string;
}

export interface AgentRouteEvent {
  id: string;
  timestamp: string;
  source: AgentTaskSource;
  task_id?: string;
  profile_id?: string;
  model?: string;
  backend_model?: string;
  provider?: string;
  reasoning_effort?: string;
  status: "resolved" | "unavailable" | "failed";
  reason?: string;
}

function stringValue(value: unknown, maxLength = 400): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function stringList(value: unknown, maxItems = 64, maxLength = 80): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => stringValue(item, maxLength))
    .filter(Boolean))).slice(0, maxItems);
}

function nullableString(value: unknown, maxLength = 200): string | null {
  const result = stringValue(value, maxLength);
  return result || null;
}

function normalizeMode(value: unknown): AgentRoutingMode {
  return value === "auto" || value === "forced" || value === "off" ? value : "off";
}

function normalizeModelRef(value: unknown): AgentModelRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  // Imported custom catalogs may not declare a provider namespace. In that
  // case the stable backend model/slug is still a valid user binding; do not
  // discard the whole Profile just because provider is blank.
  const provider = stringValue(source.provider, 120).toLowerCase();
  const backendModel = stringValue(source.backend_model || source.backendModel || source.model, 240);
  const catalogSlug = nullableString(source.catalog_slug || source.catalogSlug || source.slug, 240);
  if (!backendModel) return null;
  return {
    provider,
    backend_model: backendModel,
    ...(catalogSlug ? { catalog_slug: catalogSlug } : {}),
  };
}

function normalizeProfile(value: unknown): AgentProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = stringValue(source.id, 80).replace(/[^a-zA-Z0-9._-]/g, "-");
  const name = stringValue(source.name, 120);
  if (!id || !name) return null;
  const now = new Date().toISOString();
  const priority = Number.isFinite(Number(source.priority)) ? Math.max(-1000, Math.min(1000, Number(source.priority))) : 0;
  return {
    id,
    name,
    description: stringValue(source.description, 1000),
    task_types: stringList(source.task_types || source.taskTypes),
    tags: stringList(source.tags),
    model_ref: normalizeModelRef(source.model_ref || source.modelRef),
    reasoning_effort: nullableString(source.reasoning_effort || source.reasoningEffort, 40) || undefined,
    permission: nullableString(source.permission, 80) || undefined,
    tools: stringList(source.tools, 64, 120),
    fallback_profile_ids: stringList(source.fallback_profile_ids || source.fallbackProfileIds, 16, 80),
    live_enabled: source.live_enabled !== false && source.liveEnabled !== false,
    subagent_enabled: source.subagent_enabled !== false && source.subagentEnabled !== false,
    enabled: source.enabled !== false,
    priority,
    updated_at: stringValue(source.updated_at || source.updatedAt, 80) || now,
  };
}

function normalizeSettings(value: unknown): AgentRoutingSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    mode: normalizeMode(source.mode),
    default_profile_id: nullableString(source.default_profile_id || source.defaultProfileId, 80),
    forced_profile_id: nullableString(source.forced_profile_id || source.forcedProfileId, 80),
    forced_model: nullableString(source.forced_model || source.forcedModel, 240),
    strict_matching: source.strict_matching === true || source.strictMatching === true,
    updated_at: stringValue(source.updated_at || source.updatedAt, 80) || new Date().toISOString(),
  };
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export class AgentProfileStore {
  public readonly dataDir: string;
  private readonly profilesPath: string;
  private readonly routingPath: string;
  private readonly eventsPath: string;

  constructor(dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex")) {
    this.dataDir = dataDir;
    this.profilesPath = path.join(dataDir, "agent_profiles.json");
    this.routingPath = path.join(dataDir, "live_routing.json");
    this.eventsPath = path.join(dataDir, "agent_routing_events.jsonl");
  }

  public loadProfiles(): AgentProfile[] {
    const payload = readJson(this.profilesPath);
    const values = Array.isArray(payload) ? payload : payload?.profiles;
    if (!Array.isArray(values)) return [];
    return values.map(normalizeProfile).filter((profile): profile is AgentProfile => Boolean(profile));
  }

  public saveProfiles(profiles: unknown[]): AgentProfile[] {
    const normalized = profiles.map(normalizeProfile).filter((profile): profile is AgentProfile => Boolean(profile));
    const unique = Array.from(new Map(normalized.map((profile) => [profile.id, profile])).values());
    const payload = {
      schema_version: AGENT_PROFILE_SCHEMA_VERSION,
      profiles: unique,
      updated_at: new Date().toISOString(),
    };
    this.writeJson(this.profilesPath, payload);
    return unique;
  }

  public upsertProfile(value: unknown): AgentProfile {
    const normalized = normalizeProfile(value);
    if (!normalized) throw new Error("Agent Profile 缺少有效的 id 或 name");
    const profiles = this.loadProfiles().filter((profile) => profile.id !== normalized.id);
    profiles.push(normalized);
    this.saveProfiles(profiles);
    return normalized;
  }

  public deleteProfile(id: unknown): boolean {
    const profileId = stringValue(id, 80);
    const profiles = this.loadProfiles();
    const next = profiles.filter((profile) => profile.id !== profileId);
    if (next.length === profiles.length) return false;
    this.saveProfiles(next);
    const settings = this.loadRoutingSettings();
    let changed = false;
    for (const key of ["default_profile_id", "forced_profile_id"] as const) {
      if (settings[key] === profileId) {
        settings[key] = null;
        changed = true;
      }
    }
    if (changed) this.saveRoutingSettings(settings);
    return true;
  }

  public loadRoutingSettings(): AgentRoutingSettings {
    return normalizeSettings(readJson(this.routingPath));
  }

  public saveRoutingSettings(value: unknown): AgentRoutingSettings {
    const normalized = normalizeSettings(value);
    normalized.updated_at = new Date().toISOString();
    this.writeJson(this.routingPath, {
      schema_version: AGENT_ROUTING_SCHEMA_VERSION,
      ...normalized,
    });
    return normalized;
  }

  public appendRouteEvent(event: Omit<AgentRouteEvent, "id" | "timestamp">): AgentRouteEvent {
    const record: AgentRouteEvent = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
      ...event,
    };
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(this.eventsPath, 0o600); } catch {}
    this.trimEvents();
    return record;
  }

  public readRouteEvents(limit = 100): AgentRouteEvent[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    try {
      return fs.readFileSync(this.eventsPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-safeLimit)
        .map((line) => JSON.parse(line))
        .filter((event) => event && typeof event === "object");
    } catch {
      return [];
    }
  }

  private writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }

  private trimEvents(): void {
    try {
      const lines = fs.readFileSync(this.eventsPath, "utf-8").split(/\r?\n/).filter(Boolean);
      if (lines.length <= 500) return;
      fs.writeFileSync(this.eventsPath, `${lines.slice(-500).join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
    } catch {}
  }
}

export function normalizeAgentProfile(value: unknown): AgentProfile | null {
  return normalizeProfile(value);
}

export function normalizeAgentRoutingSettings(value: unknown): AgentRoutingSettings {
  return normalizeSettings(value);
}
