import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export const SUBSCRIPTION_ACCOUNT_PROVIDERS = ["antigravity", "grok", "claude", "cursor"] as const;
export type SubscriptionProvider = typeof SUBSCRIPTION_ACCOUNT_PROVIDERS[number];
export type SubscriptionRotationMode = "fixed" | "round_robin";
export type SubscriptionAccountAuthStatus = "ready" | "missing" | "disabled" | "cooldown";

export interface SubscriptionAccount {
  id: string;
  provider: SubscriptionProvider;
  label: string;
  profile_dir: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
  last_error?: string;
  failure_count: number;
  cooldown_until?: string;
}

export interface SubscriptionAccountView extends SubscriptionAccount {
  auth_status: SubscriptionAccountAuthStatus;
}

export interface SubscriptionPoolSettings {
  mode: SubscriptionRotationMode;
  default_account_id: string | null;
  scheduler_cursor: number;
  updated_at: string;
}

export interface SubscriptionLoginProfile {
  id: string;
  provider: SubscriptionProvider;
  label: string;
  profile_dir: string;
}

type AccountInput = { provider?: unknown; id?: unknown; label?: unknown; enabled?: unknown };

function nowIso(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeId(value: unknown): string {
  return stringValue(value, 80).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeProvider(value: unknown): SubscriptionProvider | null {
  const provider = stringValue(value, 40).toLowerCase();
  return (SUBSCRIPTION_ACCOUNT_PROVIDERS as readonly string[]).includes(provider)
    ? provider as SubscriptionProvider
    : null;
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

const VOLATILE_CREDENTIAL_KEYS = new Set([
  "access_token", "accessToken", "token", "key", "expires_at", "expiresAt", "expiry",
  "expires_in", "expiresIn", "updated_at", "updatedAt", "last_used_at", "lastUsedAt",
]);

function credentialPayload(provider: SubscriptionProvider, profileDir: string): unknown {
  for (const filePath of credentialFiles(provider, profileDir)) {
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {}
  }
  return null;
}

function stableIdentityValues(value: unknown, key = "", output: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => stableIdentityValues(item, key, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const isIdentityKey = normalizedKey === "sub"
    || normalizedKey.includes("email")
    || normalizedKey.includes("userid")
    || normalizedKey.includes("accountid")
    || normalizedKey.includes("accountuuid")
    || normalizedKey.includes("useruuid")
    || normalizedKey.includes("organizationuuid")
    || normalizedKey.includes("organizationid")
    || normalizedKey.includes("subject")
    || normalizedKey.includes("username")
    || normalizedKey.includes("refreshtoken")
    || normalizedKey === "login";
  for (const [childKey, childValue] of Object.entries(value)) {
    if (isIdentityKey && (typeof childValue === "string" || typeof childValue === "number")) {
      output.push(`${normalizedKey}:${String(childValue)}`);
    } else {
      stableIdentityValues(childValue, childKey, output);
    }
  }
  return output;
}

function canonicalCredential(value: unknown, stripVolatile: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalCredential(item, stripVolatile));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !stripVolatile || !VOLATILE_CREDENTIAL_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, childValue]) => [key, canonicalCredential(childValue, stripVolatile)]));
}

function credentialFingerprint(provider: SubscriptionProvider, profileDir: string): string | null {
  const payload = credentialPayload(provider, profileDir);
  if (payload === null) return null;
  const identities = [...new Set(stableIdentityValues(payload))].sort();
  const comparable = identities.length ? { provider, identities } : canonicalCredential(payload, true);
  const serialized = JSON.stringify(comparable);
  if (!serialized || serialized === "{}" || serialized === "[]") {
    return createHash("sha256").update(`${provider}:${JSON.stringify(canonicalCredential(payload, false))}`).digest("hex");
  }
  return createHash("sha256").update(`${provider}:${serialized}`).digest("hex");
}

function writeJsonSecure(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function credentialFiles(provider: SubscriptionProvider, profileDir: string): string[] {
  switch (provider) {
    case "grok": return [path.join(profileDir, "auth.json")];
    case "claude": return [
      path.join(profileDir, ".credentials.json"),
      path.join(profileDir, "credentials.json"),
      path.join(profileDir, "claude_desktop_auth.json"),
    ];
    case "antigravity": return [path.join(profileDir, "auth.json")];
    case "cursor": return [path.join(profileDir, "credentials.json")];
  }
}

export function subscriptionCredentialFiles(provider: SubscriptionProvider, profileDir: string): string[] {
  return credentialFiles(provider, profileDir);
}

export function subscriptionProfileHasCredential(provider: SubscriptionProvider, profileDir: string): boolean {
  return credentialFiles(provider, profileDir).some((filePath) => {
    try { return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0; } catch { return false; }
  });
}

function normalizeAccount(value: unknown, profileRoot: string): SubscriptionAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const provider = normalizeProvider(source.provider);
  const id = normalizeId(source.id);
  const label = stringValue(source.label, 120);
  if (!provider || !id || !label) return null;
  const createdAt = stringValue(source.created_at || source.createdAt, 80) || nowIso();
  const updatedAt = stringValue(source.updated_at || source.updatedAt, 80) || createdAt;
  const profileDir = path.join(profileRoot, provider, id);
  const failureCount = Number.isFinite(Number(source.failure_count))
    ? Math.max(0, Math.min(100, Math.floor(Number(source.failure_count))))
    : 0;
  return {
    id,
    provider,
    label,
    profile_dir: profileDir,
    enabled: source.enabled !== false,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(stringValue(source.last_used_at || source.lastUsedAt, 80)
      ? { last_used_at: stringValue(source.last_used_at || source.lastUsedAt, 80) }
      : {}),
    ...(stringValue(source.last_error || source.lastError, 320)
      ? { last_error: stringValue(source.last_error || source.lastError, 320) }
      : {}),
    failure_count: failureCount,
    ...(stringValue(source.cooldown_until || source.cooldownUntil, 80)
      ? { cooldown_until: stringValue(source.cooldown_until || source.cooldownUntil, 80) }
      : {}),
  };
}

function normalizeSettings(value: unknown): SubscriptionPoolSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mode = source.mode === "fixed" ? "fixed" : "round_robin";
  const defaultAccountId = normalizeId(source.default_account_id || source.defaultAccountId);
  const schedulerCursor = Number.isFinite(Number(source.scheduler_cursor))
    ? Math.max(0, Math.floor(Number(source.scheduler_cursor)))
    : 0;
  return {
    mode,
    default_account_id: defaultAccountId || null,
    scheduler_cursor: schedulerCursor,
    updated_at: stringValue(source.updated_at || source.updatedAt, 80) || nowIso(),
  };
}

export class SubscriptionAccountPool {
  public readonly dataDir: string;
  private readonly accountsPath: string;
  private readonly settingsPath: string;
  private readonly profileRoot: string;

  constructor(dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex")) {
    this.dataDir = dataDir;
    this.accountsPath = path.join(dataDir, "subscription_accounts.json");
    this.settingsPath = path.join(dataDir, "subscription_account_settings.json");
    this.profileRoot = path.join(dataDir, "subscription-accounts");
  }

  public listAccounts(providerValue?: unknown): SubscriptionAccountView[] {
    const provider = providerValue === undefined ? null : normalizeProvider(providerValue);
    if (providerValue !== undefined && !provider) return [];
    return this.loadAccounts()
      .filter((account) => !provider || account.provider === provider)
      .map((account) => ({ ...account, auth_status: this.authStatus(account) }));
  }

  public getAccount(providerValue: unknown, idValue: unknown): SubscriptionAccountView | null {
    const provider = normalizeProvider(providerValue);
    const id = normalizeId(idValue);
    if (!provider || !id) return null;
    return this.listAccounts(provider).find((account) => account.id === id) || null;
  }

  public findDuplicateCredential(providerValue: unknown, profileDir: string, excludeId?: unknown): SubscriptionAccountView | null {
    const provider = normalizeProvider(providerValue);
    const fingerprint = provider ? credentialFingerprint(provider, profileDir) : null;
    const excluded = normalizeId(excludeId);
    if (!provider || !fingerprint) return null;
    const duplicate = this.loadAccounts()
      .filter((account) => account.provider === provider && account.id !== excluded)
      .find((account) => credentialFingerprint(provider, account.profile_dir) === fingerprint);
    return duplicate ? { ...duplicate, auth_status: this.authStatus(duplicate) } : null;
  }

  public compactDuplicateAccounts(providerValue: unknown): number {
    const provider = normalizeProvider(providerValue);
    if (!provider) return 0;
    const accounts = this.loadAccounts();
    const seen = new Set<string>();
    const kept: SubscriptionAccount[] = [];
    let removed = 0;
    for (const account of accounts) {
      if (account.provider !== provider) {
        kept.push(account);
        continue;
      }
      // Older builds persisted a pool record before the browser/CLI login
      // succeeded. Those records are not usable accounts and should not stay
      // as permanent "待登录" entries now that login profiles are temporary.
      if (!subscriptionProfileHasCredential(provider, account.profile_dir)) {
        removed++;
        continue;
      }
      const fingerprint = credentialFingerprint(provider, account.profile_dir);
      if (fingerprint && seen.has(fingerprint)) {
        removed++;
        continue;
      }
      if (fingerprint) seen.add(fingerprint);
      kept.push(account);
    }
    if (removed) this.saveAccounts(kept);
    return removed;
  }

  public createAccount(input: AccountInput = {}): SubscriptionAccountView {
    const provider = normalizeProvider(input.provider);
    if (!provider) throw new Error("OAuth Provider 不受支持");
    const accounts = this.loadAccounts();
    const profile = this.createLoginProfile({
      ...input,
      label: stringValue(input.label, 120) || `${provider} 账号 ${accounts.filter((account) => account.provider === provider).length + 1}`,
    });
    const timestamp = nowIso();
    const account: SubscriptionAccount = {
      ...profile,
      enabled: input.enabled !== false,
      created_at: timestamp,
      updated_at: timestamp,
      failure_count: 0,
    };
    this.saveAccounts([...accounts, account]);
    return { ...account, auth_status: this.authStatus(account) };
  }

  public createLoginProfile(input: AccountInput = {}): SubscriptionLoginProfile {
    const provider = normalizeProvider(input.provider);
    if (!provider) throw new Error("OAuth Provider 不受支持");
    const accounts = this.loadAccounts();
    const requestedId = normalizeId(input.id);
    const id = requestedId || `account-${randomUUID().slice(0, 8)}`;
    if (accounts.some((account) => account.provider === provider && account.id === id)) {
      throw new Error(`${provider} OAuth 账号 ID 已存在：${id}`);
    }
    const label = stringValue(input.label, 120) || `${provider} 账号 ${accounts.filter((account) => account.provider === provider).length + 1}`;
    const profile: SubscriptionLoginProfile = {
      id,
      provider,
      label,
      profile_dir: path.join(this.profileRoot, provider, id),
    };
    fs.mkdirSync(profile.profile_dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(profile.profile_dir, 0o700); } catch {}
    return profile;
  }

  public registerLoginProfile(profile: SubscriptionLoginProfile, enabled = true): SubscriptionAccountView {
    const provider = normalizeProvider(profile.provider);
    const id = normalizeId(profile.id);
    if (!provider || !id) throw new Error("OAuth 登录账号参数无效");
    const accounts = this.loadAccounts();
    const existing = accounts.find((account) => account.provider === provider && account.id === id);
    if (existing) return { ...existing, auth_status: this.authStatus(existing) };
    const timestamp = nowIso();
    const account: SubscriptionAccount = {
      id,
      provider,
      label: stringValue(profile.label, 120) || `${provider} 账号 ${accounts.filter((account) => account.provider === provider).length + 1}`,
      profile_dir: path.join(this.profileRoot, provider, id),
      enabled,
      created_at: timestamp,
      updated_at: timestamp,
      failure_count: 0,
    };
    this.saveAccounts([...accounts, account]);
    return { ...account, auth_status: this.authStatus(account) };
  }

  public discardLoginProfile(profile: SubscriptionLoginProfile): void {
    const root = path.resolve(this.profileRoot) + path.sep;
    const target = path.resolve(profile.profile_dir);
    if (!target.startsWith(root)) return;
    const existing = this.loadAccounts().some((account) => account.provider === profile.provider && account.id === profile.id);
    if (existing) return;
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }

  public updateAccount(providerValue: unknown, idValue: unknown, input: AccountInput): SubscriptionAccountView {
    const provider = normalizeProvider(providerValue);
    const id = normalizeId(idValue);
    if (!provider || !id) throw new Error("OAuth 账号参数无效");
    const accounts = this.loadAccounts();
    const index = accounts.findIndex((account) => account.provider === provider && account.id === id);
    if (index < 0) throw new Error("OAuth 账号不存在");
    const current = accounts[index];
    accounts[index] = {
      ...current,
      ...(stringValue(input.label, 120) ? { label: stringValue(input.label, 120) } : {}),
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      updated_at: nowIso(),
    };
    this.saveAccounts(accounts);
    return { ...accounts[index], auth_status: this.authStatus(accounts[index]) };
  }

  public removeAccount(providerValue: unknown, idValue: unknown): { provider: SubscriptionProvider; id: string; profile_dir: string; preserved_profile: true } | null {
    const provider = normalizeProvider(providerValue);
    const id = normalizeId(idValue);
    if (!provider || !id) return null;
    const accounts = this.loadAccounts();
    const account = accounts.find((candidate) => candidate.provider === provider && candidate.id === id);
    if (!account) return null;
    this.saveAccounts(accounts.filter((candidate) => candidate.provider !== provider || candidate.id !== id));
    const settings = this.getSettings(provider);
    if (settings.default_account_id === id) this.saveSettings(provider, { ...settings, default_account_id: null });
    return { provider, id, profile_dir: account.profile_dir, preserved_profile: true };
  }

  public getSettings(providerValue: unknown): SubscriptionPoolSettings {
    const provider = normalizeProvider(providerValue);
    if (!provider) throw new Error("OAuth Provider 不受支持");
    const payload = readJson(this.settingsPath);
    const source = payload?.providers?.[provider] || {};
    const settings = normalizeSettings(source);
    const accountIds = new Set(this.loadAccounts().filter((account) => account.provider === provider).map((account) => account.id));
    if (settings.default_account_id && !accountIds.has(settings.default_account_id)) settings.default_account_id = null;
    return settings;
  }

  public saveSettings(providerValue: unknown, value: unknown): SubscriptionPoolSettings {
    const provider = normalizeProvider(providerValue);
    if (!provider) throw new Error("OAuth Provider 不受支持");
    const current = normalizeSettings(value);
    const accountIds = new Set(this.loadAccounts().filter((account) => account.provider === provider).map((account) => account.id));
    if (current.default_account_id && !accountIds.has(current.default_account_id)) current.default_account_id = null;
    current.updated_at = nowIso();
    const payload = readJson(this.settingsPath) || { schema_version: 1, providers: {} };
    payload.schema_version = 1;
    payload.providers = payload.providers && typeof payload.providers === "object" ? payload.providers : {};
    payload.providers[provider] = current;
    writeJsonSecure(this.settingsPath, payload);
    return current;
  }

  public selectForRequest(providerValue: unknown): SubscriptionAccountView | null {
    const provider = normalizeProvider(providerValue);
    if (!provider) return null;
    this.compactDuplicateAccounts(provider);
    const accounts = this.listAccounts(provider).filter((account) =>
      account.enabled && account.auth_status === "ready",
    );
    if (!accounts.length) return null;
    const settings = this.getSettings(provider);
    let selected: SubscriptionAccountView | undefined;
    if (settings.mode === "fixed") {
      selected = accounts.find((account) => account.id === settings.default_account_id) || accounts[0];
    } else {
      const ordered = [...accounts].sort((left, right) =>
        left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
      selected = ordered[settings.scheduler_cursor % ordered.length];
      this.saveSettings(provider, { ...settings, scheduler_cursor: settings.scheduler_cursor + 1 });
    }
    if (!selected) return null;
    this.touch(provider, selected.id);
    return { ...selected, last_used_at: nowIso() };
  }

  public describe(providerValue: unknown): { accounts: SubscriptionAccountView[]; settings: SubscriptionPoolSettings } {
    const provider = normalizeProvider(providerValue);
    if (!provider) throw new Error("OAuth Provider 不受支持");
    this.compactDuplicateAccounts(provider);
    return { accounts: this.listAccounts(provider), settings: this.getSettings(provider) };
  }

  private loadAccounts(): SubscriptionAccount[] {
    const payload = readJson(this.accountsPath);
    const values = Array.isArray(payload) ? payload : payload?.accounts;
    if (!Array.isArray(values)) return [];
    return values.map((value) => normalizeAccount(value, this.profileRoot)).filter((account): account is SubscriptionAccount => Boolean(account));
  }

  private authStatus(account: SubscriptionAccount): SubscriptionAccountAuthStatus {
    if (!account.enabled) return "disabled";
    if (account.cooldown_until && Date.parse(account.cooldown_until) > Date.now()) return "cooldown";
    return subscriptionProfileHasCredential(account.provider, account.profile_dir) ? "ready" : "missing";
  }

  private touch(provider: SubscriptionProvider, id: string): void {
    const accounts = this.loadAccounts();
    const index = accounts.findIndex((account) => account.provider === provider && account.id === id);
    if (index < 0) return;
    accounts[index] = { ...accounts[index], last_used_at: nowIso(), updated_at: nowIso() };
    this.saveAccounts(accounts);
  }

  private saveAccounts(accounts: SubscriptionAccount[]): void {
    writeJsonSecure(this.accountsPath, { schema_version: 1, accounts, updated_at: nowIso() });
  }
}
