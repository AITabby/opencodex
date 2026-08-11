/**
 * Credential Store for CodexBridge (OpenCodex V2)
 * Handles API Key resolution from providers.json, environment variables, or disk configuration.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { ProviderConfig, ProviderCredential, ProviderCredentialStatus, ProviderPoolMode } from "../core/types.js";

export type ResolvedProviderCredential = {
  id: string;
  apiKey: string;
  credential?: ProviderCredential;
};

const PROVIDER_KEYCHAIN_SERVICE = "OpenCodex Provider Credential";
const LEGACY_PROVIDER_KEYCHAIN_REFERENCE_PREFIX = "keychain:provider:";
const PROVIDER_KEYCHAIN_LOOKUP_CONCURRENCY = 24;

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

/**
 * Provider references written by early App builds omitted the Keychain
 * service name (for example `keychain:provider:opencode-go`).  The account
 * part is still correct, so repair only that known legacy shape; references
 * for other Keychain services are left untouched.
 */
export function normalizeProviderCredentialReference(reference: unknown): string {
  const value = String(reference || "").trim();
  if (!value) return "";
  const canonicalPrefix = `keychain:${PROVIDER_KEYCHAIN_SERVICE}:`;
  if (value.startsWith(canonicalPrefix)) return value;
  if (value.startsWith(LEGACY_PROVIDER_KEYCHAIN_REFERENCE_PREFIX)) {
    return `${canonicalPrefix}${value.slice("keychain:".length)}`;
  }
  return value;
}

function normalizedProviderUrl(provider: any): string {
  return String(provider?.baseUrl || provider?.base_url || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

function canonicalProviderPresetId(provider: any): string {
  const preset = String(provider?.preset_id || "").trim().toLowerCase();
  const name = String(provider?.name || "").trim().toLowerCase();
  const url = normalizedProviderUrl(provider);
  // OpenCode Go was stored under both `opencode` and `opencode-go` by older
  // app builds. Treat those records as one provider only when the endpoint
  // confirms the alias, so an unrelated custom provider named opencode is not
  // merged accidentally.
  if (preset === "opencode-go" || (name === "opencode" && url.includes("opencode.ai/zen/go"))) {
    return "opencode-go";
  }
  return preset;
}

export function providerIdentityKey(provider: ProviderConfig): string {
  const preset = canonicalProviderPresetId(provider);
  const name = String((provider as any)?.name || "").trim().toLowerCase();
  const url = normalizedProviderUrl(provider);
  if (preset) return `provider:${preset}|url:${url}`;
  return name ? `name:${name}|url:${url}` : `anonymous:${url}`;
}

function providerRecordScore(provider: any): number {
  let score = 0;
  if (canonicalProviderPresetId(provider)) score += 100;
  if (String(provider?.preset_id || "").trim()) score += 20;
  const refs = [
    provider?.credential_ref,
    ...(Array.isArray(provider?.credentials) ? provider.credentials.map((credential: any) => credential?.credential_ref) : []),
  ].map((reference) => normalizeProviderCredentialReference(reference));
  if (refs.some((reference) => reference.startsWith(`keychain:${PROVIDER_KEYCHAIN_SERVICE}:`))) score += 5;
  if (Array.isArray(provider?.models) && provider.models.length > 0) score += 1;
  if (Array.isArray(provider?.credentials) && provider.credentials.some((credential: any) => credential?.status === "ready")) score += 3;
  return score;
}

function mergedCredentialId(baseId: string, reference: string, used: Set<string>): string {
  const normalizedBase = String(baseId || "credential").trim() || "credential";
  if (!used.has(normalizedBase)) return normalizedBase;
  const suffix = createHash("sha256").update(String(reference || normalizedBase)).digest("hex").slice(0, 10);
  let candidate = `${normalizedBase}-legacy-${suffix}`;
  let index = 2;
  while (used.has(candidate)) candidate = `${normalizedBase}-legacy-${suffix}-${index++}`;
  return candidate;
}

function mergeProviderRecords(first: any, second: any): any {
  const preferred = providerRecordScore(second) > providerRecordScore(first) ? second : first;
  const other = preferred === first ? second : first;
  const merged: any = { ...other, ...preferred };

  for (const field of ["models"] as const) {
    const values = [
      ...(Array.isArray(other?.[field]) ? other[field] : []),
      ...(Array.isArray(preferred?.[field]) ? preferred[field] : []),
    ];
    if (values.length > 0) merged[field] = Array.from(new Set(values));
  }
  for (const field of ["model_protocols", "model_test_status", "model_metadata"] as const) {
    const values = { ...(other?.[field] || {}), ...(preferred?.[field] || {}) };
    if (Object.keys(values).length > 0) merged[field] = values;
  }

  const preferredCredentials = Array.isArray(preferred?.credentials) ? preferred.credentials : [];
  const otherCredentials = Array.isArray(other?.credentials) ? other.credentials : [];
  const credentials: ProviderCredential[] = preferredCredentials.map((credential: ProviderCredential) => ({ ...credential }));
  const usedIds = new Set(credentials.map((credential) => credential.id));
  const usedRefs = new Set(credentials.map((credential) => credential.credential_ref).filter(Boolean));
  for (const rawCredential of otherCredentials) {
    const credential = { ...rawCredential, credential_ref: normalizeProviderCredentialReference(rawCredential.credential_ref) } as ProviderCredential;
    if (credential.credential_ref && usedRefs.has(credential.credential_ref)) continue;
    const originalId = credential.id;
    credential.id = mergedCredentialId(originalId, credential.credential_ref, usedIds);
    if (credential.id !== originalId && (!credential.label || credential.label === "API Key 1")) {
      credential.label = `${credential.label || "API Key"}（旧记录）`;
    }
    credentials.push(credential);
    usedIds.add(credential.id);
    if (credential.credential_ref) usedRefs.add(credential.credential_ref);
  }
  if (credentials.length > 0) {
    merged.credentials = credentials;
    if (!merged.active_credential_id || !credentials.some((credential) => credential.id === merged.active_credential_id)) {
      merged.active_credential_id = credentials[0].id;
    }
    const active = credentials.find((credential) => credential.id === merged.active_credential_id);
    if (active?.credential_ref) merged.credential_ref = active.credential_ref;
  }

  return merged;
}

/** Merge duplicate provider records without exposing or copying API secrets. */
export function dedupeProviderConfigs(providers: ProviderConfig[]): ProviderConfig[] {
  const groups = new Map<string, any>();
  for (const rawProvider of Array.isArray(providers) ? providers : []) {
    if (!rawProvider || typeof rawProvider !== "object") continue;
    const provider: any = { ...(rawProvider as any) };
    const key = providerIdentityKey(provider);
    const existing = groups.get(key);
    groups.set(key, existing ? mergeProviderRecords(existing, provider) : provider);
  }
  return Array.from(groups.values()).map((provider: any) => {
    const canonicalPreset = canonicalProviderPresetId(provider);
    if (canonicalPreset === "opencode-go") {
      provider.preset_id = "opencode-go";
      provider.name = "opencode";
    }
    return provider;
  }) as ProviderConfig[];
}

export function normalizeProviderPoolMode(value: unknown): ProviderPoolMode {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "round_robin") return "round_robin";
  if (mode === "failover") return "failover";
  return "fixed";
}

export function providerCredentialStatusLabel(status: ProviderCredentialStatus | string | undefined): string {
  switch (status) {
    case "ready": return "可用";
    case "expired": return "已失效";
    case "failed": return "检测失败";
    case "cooldown": return "冷却中";
    case "missing": return "Key 不存在";
    default: return "未检测";
  }
}

export function maskProviderApiKey(apiKey: string): string {
  const value = String(apiKey || "");
  if (!value) return "Key 未找到";
  return value.length <= 4 ? `••••${value}` : `••••••••${value.slice(-4)}`;
}

function credentialCoolingDown(credential: ProviderCredential, now = Date.now()): boolean {
  if (credential.status !== "cooldown" || !credential.cooldown_until) return false;
  const until = Date.parse(credential.cooldown_until);
  return Number.isFinite(until) && until > now;
}

function credentialUsable(credential: ProviderCredential, excluded: Set<string>, now = Date.now()): boolean {
  if (excluded.has(credential.id)) return false;
  if (credential.status === "expired" || credential.status === "missing") return false;
  return !credentialCoolingDown(credential, now);
}

/** Pure credential ordering used by the runtime selector and unit tests. */
export function chooseProviderCredentialId(
  credentials: ProviderCredential[],
  mode: ProviderPoolMode = "fixed",
  activeCredentialId = "",
  excludedIds: string[] = [],
  cursorId = "",
): string {
  const list = Array.isArray(credentials) ? credentials : [];
  const excluded = new Set(excludedIds);
  const usable = list.filter((credential) => credentialUsable(credential, excluded));
  if (usable.length === 0) return "";

  const preferred = usable.find((credential) => credential.id === activeCredentialId);
  if (mode === "fixed") return preferred?.id || (activeCredentialId ? "" : usable[0].id);
  if (mode === "failover") return preferred?.id || usable[0].id;

  const cursorIndex = usable.findIndex((credential) => credential.id === cursorId);
  return usable[(cursorIndex + 1 + usable.length) % usable.length].id;
}

/**
 * Restore-native keeps provider identities, endpoints, and credentials, but
 * removes every selected-model field.  Keeping this as a pure transformation
 * makes it safe to reuse from the dashboard reset route and from tests.
 */
export function clearProviderModelSelections(providers: ProviderConfig[]): ProviderConfig[] {
  const modelFields = [
    "models",
    "selected_models",
    "active_models",
    "model_protocols",
    "model_metadata",
    "models_metadata",
    "model_context_windows",
    "context_windows",
    "model_test_status",
    "last_test_status",
    "last_test_at",
    "last_test_message",
  ];

  return (Array.isArray(providers) ? providers : []).map((rawProvider: ProviderConfig) => {
    const provider: any = { ...(rawProvider as any), models: [] };
    for (const field of modelFields) {
      if (field !== "models") delete provider[field];
    }
    return provider as ProviderConfig;
  });
}

export class CredentialStore {
  private static readonly providerService = PROVIDER_KEYCHAIN_SERVICE;
  private static get providersConfigPath(): string {
    const dataDir = String(process.env.OPENCODEX_DATA_DIR || "").trim() || path.join(os.homedir(), ".opencodex");
    return path.join(dataDir, "providers.json");
  }
  private static get legacyProvidersConfigPath(): string {
    const primaryPath = path.resolve(CredentialStore.providersConfigPath);
    const legacyPath = path.resolve(path.join(os.homedir(), ".opencodex", "providers.json"));
    return path.dirname(primaryPath) === path.dirname(legacyPath) ? "" : legacyPath;
  }
  private static cachedProviders: ProviderConfig[] = [];
  private static lastMtime = 0;
  private static lastProvidersConfigPath = "";
  private static rotationCursors = new Map<string, string>();

  private static normalizeCredential(raw: any, index: number): ProviderCredential | null {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || `credential-${index + 1}`).trim();
    if (!id) return null;
    const rawCredentialRef = String(raw.credential_ref || "").trim();
    const credentialRef = normalizeProviderCredentialReference(rawCredentialRef);
    const repairedReference = Boolean(rawCredentialRef && credentialRef !== rawCredentialRef);
    const rawStatus = String(raw.status || "unknown");
    const status = repairedReference ? "unknown" : ( ["unknown", "ready", "expired", "failed", "cooldown", "missing"].includes(rawStatus)
      ? rawStatus as ProviderCredentialStatus
      : "unknown");
    return {
      id,
      label: String(raw.label || `API Key ${index + 1}`).trim() || `API Key ${index + 1}`,
      credential_ref: credentialRef,
      status,
      ...(repairedReference
        ? { status_message: "已修复 Keychain 引用，尚未检测" }
        : (raw.status_message ? { status_message: String(raw.status_message).slice(0, 500) } : {})),
      ...(!repairedReference && Number.isFinite(Number(raw.status_code)) ? { status_code: Number(raw.status_code) } : {}),
      ...(!repairedReference && Number.isFinite(Number(raw.failure_count)) ? { failure_count: Number(raw.failure_count) } : {}),
      ...(raw.cooldown_until ? { cooldown_until: String(raw.cooldown_until) } : {}),
      ...(!repairedReference && raw.last_checked_at ? { last_checked_at: String(raw.last_checked_at) } : {}),
      ...(raw.last_used_at ? { last_used_at: String(raw.last_used_at) } : {}),
      ...(raw.created_at ? { created_at: String(raw.created_at) } : {}),
    };
  }

  private static ensureCredentialMetadata(provider: any): ProviderCredential[] {
    if (!provider || typeof provider !== "object") return [];
    const rawProviderRef = String(provider.credential_ref || "").trim();
    const providerRef = normalizeProviderCredentialReference(rawProviderRef);
    if (providerRef) provider.credential_ref = providerRef;
    let credentials = Array.isArray(provider.credentials)
      ? provider.credentials.map((raw: any, index: number) => CredentialStore.normalizeCredential(raw, index)).filter(Boolean) as ProviderCredential[]
      : [];
    if (credentials.length === 0 && provider.credential_ref) {
      credentials = [{
        id: "default",
        label: "API Key 1",
        credential_ref: providerRef || String(provider.credential_ref),
        status: "unknown",
        created_at: new Date().toISOString(),
      }];
    }
    if (credentials.length > 0) {
      provider.credentials = credentials;
      if (!provider.active_credential_id || !credentials.some((credential) => credential.id === provider.active_credential_id)) {
        provider.active_credential_id = credentials[0].id;
      }
    }
    return credentials;
  }

  public static findProvider(providers: ProviderConfig[], providerName: string): any | undefined {
    const normalized = String(providerName || "").trim().toLowerCase();
    const list = Array.isArray(providers) ? providers : [];
    // A preset id is the stable UI identity. Prefer it over a legacy name so
    // an old duplicate cannot receive a new Key or a remove/test operation.
    return list.find((provider: any) => String(provider?.preset_id || "").trim().toLowerCase() === normalized)
      || list.find((provider: any) => String(provider?.name || "").trim().toLowerCase() === normalized) as any;
  }

  private static credentialAccount(provider: any, credentialId: string): string {
    const name = String(provider?.name || "custom").trim() || "custom";
    return credentialId === "default"
      ? `provider:${name}`
      : `provider:${name}:credential:${credentialId}`;
  }

  private static credentialSecret(provider: any, credential: ProviderCredential): string {
    if (credential.credential_ref) {
      const value = CredentialStore.readProviderSecret(credential.credential_ref);
      if (value) return value;
    }
    if (credential.id === "default" && provider?.api_key) {
      return String(provider.api_key).trim();
    }
    if (provider?.api_key_env && process.env[provider.api_key_env]) {
      return String(process.env[provider.api_key_env] || "").trim();
    }
    return "";
  }

  private static readProviderSecretAsync(reference: string): Promise<string> {
    const normalizedReference = normalizeProviderCredentialReference(reference);
    if (process.platform !== "darwin" || !normalizedReference.startsWith(`keychain:${CredentialStore.providerService}:`)) {
      return Promise.resolve("");
    }
    const account = normalizedReference.slice(`keychain:${CredentialStore.providerService}:`.length);
    return new Promise((resolve) => {
      execFile("security", [
        "find-generic-password", "-a", account, "-s", CredentialStore.providerService, "-w",
      ], {
        encoding: "utf-8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        resolve(error ? "" : String(stdout || "").trim());
      });
    });
  }

  private static async credentialSecretAsync(provider: any, credential: ProviderCredential): Promise<string> {
    if (credential.credential_ref) {
      const value = await CredentialStore.readProviderSecretAsync(credential.credential_ref);
      if (value) return value;
    }
    if (credential.id === "default" && provider?.api_key) {
      return String(provider.api_key).trim();
    }
    if (provider?.api_key_env && process.env[provider.api_key_env]) {
      return String(process.env[provider.api_key_env] || "").trim();
    }
    return "";
  }

  private static publicCredential(provider: ProviderConfig, credential: ProviderCredential, apiKey: string): any {
    let status = credential.status || "unknown";
    if (!apiKey) status = "missing";
    else if (status === "cooldown" && !credentialCoolingDown(credential)) status = "ready";
    const statusMessage = status === "missing"
      ? "Keychain 中没有找到该 Key"
      : status === "ready" && credential.status === "cooldown"
        ? "冷却已结束，可再次使用"
        : credential.status_message || "";
    return {
      id: credential.id,
      label: credential.label || credential.id,
      masked: maskProviderApiKey(apiKey),
      status,
      status_label: providerCredentialStatusLabel(status),
      status_message: statusMessage,
      status_code: status === "ready" && credential.status === "cooldown" ? undefined : credential.status_code,
      failure_count: credential.failure_count || 0,
      cooldown_until: credential.cooldown_until,
      last_checked_at: credential.last_checked_at,
      last_used_at: credential.last_used_at,
      created_at: credential.created_at,
      active: credential.id === (provider as any).active_credential_id,
    };
  }

  private static providerCredentials(provider: ProviderConfig): ProviderCredential[] {
    return CredentialStore.ensureCredentialMetadata(provider as any);
  }

  public static loadProviders(): ProviderConfig[] {
    try {
      const primaryPath = CredentialStore.providersConfigPath;
      const sourcePath = fs.existsSync(primaryPath)
        ? primaryPath
        : (CredentialStore.legacyProvidersConfigPath && fs.existsSync(CredentialStore.legacyProvidersConfigPath)
          ? CredentialStore.legacyProvidersConfigPath
          : "");
      if (sourcePath) {
        const stat = fs.statSync(sourcePath);
        if (sourcePath === CredentialStore.lastProvidersConfigPath
          && stat.mtimeMs === CredentialStore.lastMtime
          && CredentialStore.cachedProviders.length > 0) {
          return CredentialStore.cachedProviders;
        }
        const raw = fs.readFileSync(sourcePath, "utf-8");
        const data = JSON.parse(raw);
        const rawProviders = (Array.isArray(data) ? data : data.providers || []) as ProviderConfig[];
        CredentialStore.cachedProviders = rawProviders;
        const beforeMigration = JSON.stringify(rawProviders);
        // The macOS app now stores runtime state under Application Support,
        // while older installations kept this index under ~/.opencodex.
        // Read the legacy index once and save only its metadata into the new
        // location. API secrets remain in Keychain and are never copied here.
        let migrated = sourcePath !== primaryPath;
        if (process.platform === "darwin") {
          for (const provider of CredentialStore.cachedProviders as any[]) {
            if (provider.api_key && !provider.credential_ref) {
              try {
                CredentialStore.storeProviderSecret(provider, provider.api_key);
                migrated = true;
              } catch (error: any) {
                console.error(`[OpenCodex] Could not migrate ${provider.name} credential to Keychain: ${error.message}`);
              }
            }
          }
        }
        for (const provider of CredentialStore.cachedProviders as any[]) CredentialStore.ensureCredentialMetadata(provider);
        CredentialStore.cachedProviders = dedupeProviderConfigs(CredentialStore.cachedProviders);
        if (JSON.stringify(CredentialStore.cachedProviders) !== beforeMigration) migrated = true;
        if (migrated) CredentialStore.saveProviders(CredentialStore.cachedProviders);
        const finalPath = fs.existsSync(primaryPath) ? primaryPath : sourcePath;
        CredentialStore.lastMtime = fs.statSync(finalPath).mtimeMs;
        CredentialStore.lastProvidersConfigPath = finalPath;
        return CredentialStore.cachedProviders;
      }
    } catch {
      // Return empty array on read errors
    }
    return [];
  }

  public static setApiKey(providerName: string, apiKey: string): void {
    const providers = CredentialStore.loadProviders();
    let p = CredentialStore.findProvider(providers, providerName);
    if (p) {
      CredentialStore.setApiKeyOnProviders(providers, providerName, apiKey);
    } else {
      const created: any = { name: providerName, type: "openai-compatible", baseUrl: "" };
      providers.push(created);
      CredentialStore.setApiKeyOnProviders(providers, providerName, apiKey);
    }
  }

  /** Attach a credential to a provider already present in the current list. */
  public static setApiKeyOnProviders(providers: ProviderConfig[], providerName: string, apiKey: string): void {
    const list = Array.isArray(providers) ? providers : [];
    const provider = CredentialStore.findProvider(list, providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} was not found while saving its credential`);
    }
    const credentials = CredentialStore.providerCredentials(provider);
    const selected = credentials.find((credential) => credential.id === provider.active_credential_id) || credentials[0];
    const credentialId = selected?.id || "default";
    const credentialRef = selected?.credential_ref || (credentialId === "default" ? String(provider.credential_ref || "") : "");
    const nextRef = CredentialStore.storeProviderSecret(provider, apiKey, credentialId, credentialRef);
    const nextCredential: ProviderCredential = selected || {
      id: credentialId,
      label: "API Key 1",
      credential_ref: nextRef,
      status: "unknown",
      created_at: new Date().toISOString(),
    };
    nextCredential.credential_ref = nextRef;
    nextCredential.status = "unknown";
    nextCredential.status_message = "已保存，尚未检测";
    delete nextCredential.status_code;
    delete nextCredential.cooldown_until;
    delete nextCredential.last_checked_at;
    if (!selected) credentials.push(nextCredential);
    provider.credentials = credentials;
    provider.active_credential_id = credentialId;
    if (credentialId === "default") provider.credential_ref = nextRef;
    CredentialStore.saveProviders(list);
  }

  /** Add a new independent API Key to an existing provider pool. */
  public static addApiKeyCredential(
    providers: ProviderConfig[],
    providerName: string,
    apiKey: string,
    label = "",
  ): ProviderCredential {
    const list = Array.isArray(providers) ? providers : [];
    const provider = CredentialStore.findProvider(list, providerName);
    if (!provider) throw new Error(`Provider ${providerName} was not found while adding its credential`);
    const value = String(apiKey || "").trim();
    if (!value) throw new Error("API Key 不能为空");
    const credentials = CredentialStore.providerCredentials(provider);
    const id = `key-${randomUUID()}`;
    const credential: ProviderCredential = {
      id,
      label: String(label || `API Key ${credentials.length + 1}`).trim().slice(0, 120) || `API Key ${credentials.length + 1}`,
      credential_ref: "",
      status: "unknown",
      status_message: "已保存，尚未检测",
      created_at: new Date().toISOString(),
    };
    credential.credential_ref = CredentialStore.storeProviderSecret(provider, value, id);
    credentials.push(credential);
    provider.credentials = credentials;
    if (!provider.active_credential_id) provider.active_credential_id = credentials[0].id;
    // A newly-created two-key pool should actually rotate by default. If the
    // user had explicitly selected fixed/failover, retain that choice.
    if (credentials.length === 2 && !provider.pool_mode) provider.pool_mode = "round_robin";
    CredentialStore.saveProviders(list);
    return credential;
  }

  public static removeApiKeyCredential(
    providers: ProviderConfig[],
    providerName: string,
    credentialId: string,
  ): ProviderCredential {
    const list = Array.isArray(providers) ? providers : [];
    const provider = CredentialStore.findProvider(list, providerName);
    if (!provider) throw new Error(`Provider ${providerName} was not found while removing its credential`);
    const credentials = CredentialStore.providerCredentials(provider);
    const index = credentials.findIndex((credential) => credential.id === credentialId);
    if (index < 0) throw new Error("没有找到要移除的 API Key");
    const [removed] = credentials.splice(index, 1);
    CredentialStore.deleteCredentialSecret(removed);
    if (credentials.length === 0) {
      delete provider.credentials;
      delete provider.active_credential_id;
      delete provider.pool_mode;
      if (provider.credential_ref === removed.credential_ref) delete provider.credential_ref;
    } else {
      provider.credentials = credentials;
      if (provider.active_credential_id === credentialId) provider.active_credential_id = credentials[0].id;
      if (provider.credential_ref === removed.credential_ref) {
        provider.credential_ref = credentials[0].credential_ref;
      }
    }
    CredentialStore.saveProviders(list);
    return removed;
  }

  public static setProviderPoolPolicy(
    providers: ProviderConfig[],
    providerName: string,
    mode: ProviderPoolMode,
    activeCredentialId = "",
  ): void {
    const list = Array.isArray(providers) ? providers : [];
    const provider = CredentialStore.findProvider(list, providerName);
    if (!provider) throw new Error(`Provider ${providerName} was not found while saving its pool policy`);
    const credentials = CredentialStore.providerCredentials(provider);
    const normalizedMode = normalizeProviderPoolMode(mode);
    if (activeCredentialId && !credentials.some((credential) => credential.id === activeCredentialId)) {
      throw new Error("指定的 API Key 不存在");
    }
    provider.pool_mode = normalizedMode;
    if (activeCredentialId) provider.active_credential_id = activeCredentialId;
    else if (!provider.active_credential_id && credentials.length > 0) provider.active_credential_id = credentials[0].id;
    CredentialStore.saveProviders(list);
  }

  public static getProviderPoolMode(provider: ProviderConfig): ProviderPoolMode {
    return normalizeProviderPoolMode((provider as any)?.pool_mode);
  }

  public static getProviderCredentialsPublic(provider: ProviderConfig): any[] {
    const entries = CredentialStore.providerCredentials(provider);
    return entries.map((credential) => CredentialStore.publicCredential(
      provider,
      credential,
      CredentialStore.credentialSecret(provider as any, credential),
    ));
  }

  /**
   * Read the dashboard's complete provider list without blocking the gateway
   * event loop on one synchronous Keychain process per credential.
   */
  public static async getProvidersCredentialsPublicAsync(providers: ProviderConfig[]): Promise<any[][]> {
    const list = Array.isArray(providers) ? providers : [];
    const groups = list.map((provider) => ({ provider, entries: CredentialStore.providerCredentials(provider) }));
    const jobs = groups.flatMap((group) => group.entries.map((credential) => ({
      provider: group.provider,
      credential,
    })));
    const secrets = await mapWithConcurrency(
      jobs,
      PROVIDER_KEYCHAIN_LOOKUP_CONCURRENCY,
      (job) => CredentialStore.credentialSecretAsync(job.provider, job.credential),
    );
    let secretIndex = 0;
    return groups.map((group) => group.entries.map((credential) =>
      CredentialStore.publicCredential(group.provider, credential, secrets[secretIndex++] || ""),
    ));
  }

  public static resolveApiKeyWithCredential(provider: ProviderConfig): ResolvedProviderCredential {
    const credentials = CredentialStore.providerCredentials(provider);
    const mode = CredentialStore.getProviderPoolMode(provider);
    const activeId = String((provider as any).active_credential_id || "");
    const providerName = String((provider as any).name || "").trim().toLowerCase();
    const excluded: string[] = [];
    const cursor = CredentialStore.rotationCursors.get(providerName) || "";
    for (let attempt = 0; attempt < credentials.length; attempt++) {
      const id = chooseProviderCredentialId(credentials, mode, activeId, excluded, cursor);
      if (!id) break;
      const credential = credentials.find((entry) => entry.id === id);
      if (!credential) break;
      const apiKey = CredentialStore.credentialSecret(provider as any, credential);
      if (apiKey) {
        if (mode === "round_robin") CredentialStore.rotationCursors.set(providerName, id);
        credential.last_used_at = new Date().toISOString();
        return { id, apiKey, credential };
      }
      excluded.push(id);
    }

    // Keep environment-backed and legacy non-Keychain providers working. The
    // returned empty id deliberately disables pool failover for these paths.
    const legacyKey = String((provider as any).api_key || "").trim();
    if (legacyKey) return { id: "", apiKey: legacyKey };
    const envKey = (provider as any).api_key_env && process.env[(provider as any).api_key_env]
      ? String(process.env[(provider as any).api_key_env] || "").trim()
      : "";
    if (envKey) return { id: "", apiKey: envKey };
    return { id: "" , apiKey: "" };
  }

  public static resolveApiKeyCredential(provider: ProviderConfig, credentialId: string): ResolvedProviderCredential | null {
    const credential = CredentialStore.providerCredentials(provider).find((entry) => entry.id === credentialId);
    if (!credential) return null;
    return {
      id: credential.id,
      apiKey: CredentialStore.credentialSecret(provider as any, credential),
      credential,
    };
  }

  public static selectNextApiKeyCredential(providerName: string, failedCredentialId: string): ResolvedProviderCredential | null {
    const providers = CredentialStore.loadProviders();
    const provider = CredentialStore.findProvider(providers, providerName);
    if (!provider) return null;
    const mode = CredentialStore.getProviderPoolMode(provider);
    if (mode === "fixed") return null;
    const credentials = CredentialStore.providerCredentials(provider);
    const activeId = String(provider.active_credential_id || "");
    const cursor = failedCredentialId || CredentialStore.rotationCursors.get(String(provider.name || "").toLowerCase()) || "";
    const excluded = [failedCredentialId];
    for (let attempt = 0; attempt < credentials.length; attempt++) {
      const id = chooseProviderCredentialId(credentials, mode, activeId, excluded, cursor);
      if (!id) return null;
      const credential = credentials.find((entry) => entry.id === id);
      if (!credential) return null;
      const apiKey = CredentialStore.credentialSecret(provider, credential);
      if (apiKey) {
        CredentialStore.rotationCursors.set(String(provider.name || "").toLowerCase(), id);
        credential.last_used_at = new Date().toISOString();
        return { id, apiKey, credential };
      }
      excluded.push(id);
    }
    return null;
  }

  public static markProviderCredentialSuccess(providerName: string, credentialId: string): void {
    if (!credentialId) return;
    const providers = CredentialStore.loadProviders();
    const provider = CredentialStore.findProvider(providers, providerName);
    const credential = provider && CredentialStore.providerCredentials(provider).find((entry) => entry.id === credentialId);
    if (!provider || !credential) return;
    credential.status = "ready";
    credential.status_message = "最近一次请求成功";
    credential.last_checked_at = new Date().toISOString();
    credential.failure_count = 0;
    delete credential.status_code;
    delete credential.cooldown_until;
    CredentialStore.saveProviders(providers);
  }

  public static markProviderCredentialFailure(
    providerName: string,
    credentialId: string,
    statusCode: number,
    message: string,
  ): void {
    if (!credentialId) return;
    const providers = CredentialStore.loadProviders();
    const provider = CredentialStore.findProvider(providers, providerName);
    const credential = provider && CredentialStore.providerCredentials(provider).find((entry) => entry.id === credentialId);
    if (!provider || !credential) return;
    const now = new Date();
    const authFailure = statusCode === 401 || statusCode === 403 || /invalid|unauthori[sz]ed|expired|bad[-_ ]credentials|authentication_error/i.test(String(message || ""));
    const rateLimited = statusCode === 429 || /rate.?limit|too many requests|quota/i.test(String(message || ""));
    credential.status = authFailure ? "expired" : rateLimited ? "cooldown" : "failed";
    const safeMessage = authFailure
      ? `上游拒绝此 API Key${statusCode ? `（HTTP ${statusCode}）` : ""}`
      : rateLimited
        ? `上游限流${statusCode ? `（HTTP ${statusCode}）` : ""}`
        : String(message || "最近一次请求失败")
          .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/(?:api[_ -]?key|token|secret)\s*[=:：]\s*[^\s,;]+/gi, "credential=[redacted]")
          .slice(0, 500);
    credential.status_message = safeMessage;
    credential.status_code = Number.isFinite(statusCode) && statusCode > 0 ? statusCode : undefined;
    credential.last_checked_at = now.toISOString();
    credential.failure_count = Number(credential.failure_count || 0) + 1;
    if (rateLimited && !authFailure) credential.cooldown_until = new Date(now.getTime() + 60_000).toISOString();
    else if (!authFailure && statusCode === 0) credential.cooldown_until = new Date(now.getTime() + 15_000).toISOString();
    else delete credential.cooldown_until;
    CredentialStore.saveProviders(providers);
  }

  private static deleteCredentialSecret(credential: ProviderCredential): void {
    if (!credential?.credential_ref) return;
    const prefix = `keychain:${CredentialStore.providerService}:`;
    const reference = normalizeProviderCredentialReference(credential.credential_ref);
    if (!reference.startsWith(prefix)) return;
    const account = reference.slice(prefix.length);
    CredentialStore.deleteKeychainSecret(CredentialStore.providerService, account);
  }

  private static storeProviderSecret(provider: any, apiKey: string, credentialId = "default", existingRef = ""): string {
    if (process.platform !== "darwin") {
      throw new Error("OpenCodex provider credentials require macOS Keychain");
    }
    const existingPrefix = `keychain:${CredentialStore.providerService}:`;
    const normalizedExistingRef = normalizeProviderCredentialReference(existingRef);
    const account = normalizedExistingRef.startsWith(existingPrefix)
      ? normalizedExistingRef.slice(existingPrefix.length)
      : CredentialStore.credentialAccount(provider, credentialId);
    CredentialStore.writeKeychainSecret(CredentialStore.providerService, account, apiKey);
    const reference = `keychain:${CredentialStore.providerService}:${account}`;
    provider.credential_ref = provider.credential_ref || reference;
    delete provider.api_key;
    return reference;
  }

  public static writeKeychainSecret(service: string, account: string, secret: string): void {
    if (process.platform !== "darwin") {
      throw new Error("OpenCodex credentials require macOS Keychain");
    }
    const result = spawnSync("security", [
      "add-generic-password", "-U", "-a", account, "-s", service, "-w", secret
    ], { encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "Could not save credential to Keychain");
    }
  }

  public static deleteKeychainSecret(service: string, account: string): void {
    if (process.platform !== "darwin") return;
    spawnSync("security", [
      "delete-generic-password", "-a", account, "-s", service
    ], { encoding: "utf-8" });
  }

  public static saveProviders(providers: ProviderConfig[]): void {
    try {
      const dir = path.dirname(CredentialStore.providersConfigPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const safeProviders = providers.map((provider: any) => {
        const { api_key: _apiKey, refresh_token: _refreshToken, ...safeProvider } = provider;
        return safeProvider;
      });
      fs.writeFileSync(CredentialStore.providersConfigPath, JSON.stringify({ providers: safeProviders }, null, 2), { encoding: "utf-8", mode: 0o600 });
      fs.chmodSync(CredentialStore.providersConfigPath, 0o600);
      CredentialStore.cachedProviders = safeProviders;
      CredentialStore.lastMtime = fs.statSync(CredentialStore.providersConfigPath).mtimeMs;
      CredentialStore.lastProvidersConfigPath = CredentialStore.providersConfigPath;
    } catch (e: any) {
      console.error(`Failed to save providers config: ${e.message}`);
    }
  }

  public static resolveApiKey(provider: ProviderConfig): string {
    return CredentialStore.resolveApiKeyWithCredential(provider).apiKey;
  }

  private static readProviderSecret(reference: string): string {
    const normalizedReference = normalizeProviderCredentialReference(reference);
    if (process.platform !== "darwin" || !normalizedReference.startsWith(`keychain:${CredentialStore.providerService}:`)) return "";
    const account = normalizedReference.slice(`keychain:${CredentialStore.providerService}:`.length);
    const result = spawnSync("security", [
      "find-generic-password", "-a", account, "-s", CredentialStore.providerService, "-w"
    ], { encoding: "utf-8" });
    return result.status === 0 ? result.stdout.trim() : "";
  }

  public static readKeychainSecret(service: string, reference: string | undefined): string {
    if (typeof reference !== "string" || !reference.startsWith(`keychain:${service}:`) || process.platform !== "darwin") return "";
    const account = reference.slice(`keychain:${service}:`.length);
    const result = spawnSync("security", [
      "find-generic-password",
      "-a", account,
      "-s", service,
      "-w"
    ], { encoding: "utf-8" });
    return result.status === 0 ? result.stdout.trim() : "";
  }
}
