import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  ChatGptAccountUsageService,
  type ChatGptAccountUsage,
  usageSelectionScore,
} from "./chatgpt_account_usage.js";

/**
 * Local account-pool control plane for official ChatGPT/Codex logins.
 *
 * This store deliberately persists metadata and isolated CODEX_HOME paths,
 * never access tokens. Each profile can be authenticated separately with the
 * native Codex login flow. Request execution remains in the outer OpenCodex
 * bridge; native app-server code is not changed here.
 */

export const CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION = 1;
export type ChatGptAccountRotationMode = "fixed" | "round_robin";
export type ChatGptAccountAuthStatus = "ready" | "missing" | "reauth_required" | "cooldown" | "disabled";

export interface ChatGptAccount {
  id: string;
  label: string;
  profile_dir: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
  last_error?: string;
  failure_count: number;
  cooldown_until?: string;
  needs_reauth?: boolean;
}

export interface ChatGptAccountView extends ChatGptAccount {
  auth_status: ChatGptAccountAuthStatus;
  usage?: ChatGptAccountUsage;
}

export interface ChatGptAccountPoolSettings {
  rotation_enabled: boolean;
  mode: ChatGptAccountRotationMode;
  default_account_id: string | null;
  scheduler_cursor: number;
  updated_at: string;
}

type AccountInput = {
  id?: unknown;
  label?: unknown;
  enabled?: unknown;
};

function stringValue(value: unknown, maxLength = 240): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value || "");
  return raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token[=:][^\s,}]+/gi, "token=[redacted]")
    .replace(/(?:api[_-]?key|secret)[=:][^\s,}]+/gi, "credential=[redacted]")
    .trim()
    .slice(0, 320);
}

function normalizeId(value: unknown): string {
  return stringValue(value, 80).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPresentFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function normalizeAccount(value: unknown, profileRoot: string): ChatGptAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = normalizeId(source.id);
  const label = stringValue(source.label, 120);
  if (!id || !label) return null;
  const createdAt = stringValue(source.created_at || source.createdAt, 80) || nowIso();
  const updatedAt = stringValue(source.updated_at || source.updatedAt, 80) || createdAt;
  const profileDir = path.join(profileRoot, id);
  const failureCount = Number.isFinite(Number(source.failure_count))
    ? Math.max(0, Math.min(100, Math.floor(Number(source.failure_count))))
    : 0;
  return {
    id,
    label,
    profile_dir: profileDir,
    enabled: source.enabled !== false,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(stringValue(source.last_used_at || source.lastUsedAt, 80)
      ? { last_used_at: stringValue(source.last_used_at || source.lastUsedAt, 80) }
      : {}),
    ...(safeError(source.last_error || source.lastError)
      ? { last_error: safeError(source.last_error || source.lastError) }
      : {}),
    failure_count: failureCount,
    ...(stringValue(source.cooldown_until || source.cooldownUntil, 80)
      ? { cooldown_until: stringValue(source.cooldown_until || source.cooldownUntil, 80) }
      : {}),
    ...(source.needs_reauth === true || source.needsReauth === true ? { needs_reauth: true } : {}),
  };
}

function normalizeSettings(value: unknown, fallback?: ChatGptAccountPoolSettings): ChatGptAccountPoolSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  // Account rotation is an explicit capability. Merely storing official
  // account profiles must never make a Desktop Bridge takeover active.
  const rawRotationEnabled = source.rotation_enabled ?? source.rotationEnabled;
  const rotationEnabled = typeof rawRotationEnabled === "boolean"
    ? rawRotationEnabled
    : fallback?.rotation_enabled === true;
  const mode = source.mode === "fixed" ? "fixed" : "round_robin";
  const defaultAccountId = normalizeId(source.default_account_id || source.defaultAccountId);
  const schedulerCursor = Number.isFinite(Number(source.scheduler_cursor))
    ? Math.max(0, Math.floor(Number(source.scheduler_cursor)))
    : 0;
  return {
    rotation_enabled: rotationEnabled,
    mode,
    default_account_id: defaultAccountId || null,
    scheduler_cursor: schedulerCursor,
    updated_at: stringValue(source.updated_at || source.updatedAt, 80) || nowIso(),
  };
}

function retryAfterMilliseconds(value: unknown): number | null {
  const seen = new Set<object>();
  const visit = (current: unknown, key = "", depth = 0): number | null => {
    if (depth > 5 || current === null || current === undefined) return null;
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    const isRetryAfter = normalizedKey === "retryafter"
      || normalizedKey === "retryafterseconds"
      || normalizedKey === "retryafterms";
    if (isRetryAfter) {
      if (typeof current === "number" && Number.isFinite(current)) {
        const milliseconds = normalizedKey === "retryafterms" ? current : current * 1000;
        return Math.max(1_000, Math.min(60 * 60 * 1000, milliseconds));
      }
      if (typeof current === "string") {
        const numeric = Number(current.trim());
        if (Number.isFinite(numeric)) {
          const milliseconds = normalizedKey === "retryafterms" ? numeric : numeric * 1000;
          return Math.max(1_000, Math.min(60 * 60 * 1000, milliseconds));
        }
        const date = Date.parse(current);
        if (Number.isFinite(date)) return Math.max(1_000, Math.min(60 * 60 * 1000, date - Date.now()));
      }
    }
    if (typeof current !== "object") return null;
    if (seen.has(current as object)) return null;
    seen.add(current as object);
    if (Array.isArray(current)) {
      for (const entry of current) {
        const result = visit(entry, key, depth + 1);
        if (result !== null) return result;
      }
      return null;
    }
    for (const [childKey, child] of Object.entries(current as Record<string, unknown>)) {
      const result = visit(child, childKey, depth + 1);
      if (result !== null) return result;
    }
    return null;
  };
  return visit(value);
}

export class ChatGptAccountPool {
  public readonly dataDir: string;
  private readonly accountsPath: string;
  private readonly settingsPath: string;
  private readonly profileRoot: string;
  private readonly usageService: ChatGptAccountUsageService;

  constructor(dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex")) {
    this.dataDir = dataDir;
    this.accountsPath = path.join(dataDir, "chatgpt_accounts.json");
    this.settingsPath = path.join(dataDir, "chatgpt_account_settings.json");
    this.profileRoot = path.join(dataDir, "chatgpt-accounts");
    this.usageService = new ChatGptAccountUsageService(dataDir);
  }

  public listAccounts(): ChatGptAccountView[] {
    const payload = readJson(this.accountsPath);
    const values = Array.isArray(payload) ? payload : payload?.accounts;
    if (!Array.isArray(values)) return [];
    return values
      .map((value) => normalizeAccount(value, this.profileRoot))
      .filter((account): account is ChatGptAccount => Boolean(account))
      .map((account) => ({ ...account, auth_status: this.authStatus(account) }));
  }

  public getAccount(idValue: unknown): ChatGptAccountView | null {
    const id = normalizeId(idValue);
    if (!id) return null;
    return this.listAccounts().find((account) => account.id === id) || null;
  }

  public prepareAccountLogin(idValue: unknown): void {
    const account = this.getAccount(idValue);
    if (!account) throw new Error("ChatGPT 账号不存在");
    this.ensureProfileDirectory(account);
  }

  /**
   * Attach a read-only official usage snapshot to each account for the Web
   * dashboard. The persisted account metadata remains quota-free; usage is
   * cached in memory and is never written beside auth.json.
   */
  public async listAccountsWithUsage(forceRefresh = false): Promise<ChatGptAccountView[]> {
    const accounts = this.listAccounts();
    const ready = accounts.filter((account) => account.auth_status === "ready" && account.enabled);
    const usageById = await this.usageService.readMany(ready, forceRefresh);
    return accounts.map((account) => {
      if (account.auth_status !== "ready" || !account.enabled) {
        return {
          ...account,
          usage: {
            status: "unavailable",
            source: "official:account/rateLimits/read",
            checked_at: new Date().toISOString(),
            error: account.auth_status === "missing" ? "账号尚未登录" : "账号当前不可用",
          } satisfies ChatGptAccountUsage,
        };
      }
      return { ...account, usage: usageById.get(account.id) };
    });
  }

  public refreshUsageInBackground(forceRefresh = false): void {
    const accounts = this.listAccounts()
      .filter((account) => account.auth_status === "ready" && account.enabled)
      .map((account) => ({ id: account.id, profile_dir: account.profile_dir }));
    this.usageService.refreshInBackground(accounts, forceRefresh);
  }

  public createAccount(input: AccountInput = {}): ChatGptAccountView {
    const accounts = this.loadAccounts();
    const requestedId = normalizeId(input.id);
    const id = requestedId || `account-${randomUUID().slice(0, 8)}`;
    if (accounts.some((account) => account.id === id)) {
      throw new Error(`ChatGPT 账号 ID 已存在：${id}`);
    }
    const label = stringValue(input.label, 120) || `ChatGPT 账号 ${accounts.length + 1}`;
    const timestamp = nowIso();
    const account: ChatGptAccount = {
      id,
      label,
      profile_dir: path.join(this.profileRoot, id),
      enabled: input.enabled !== false,
      created_at: timestamp,
      updated_at: timestamp,
      failure_count: 0,
    };
    this.ensureProfileDirectory(account);
    this.saveAccounts([...accounts, account]);
    return { ...account, auth_status: this.authStatus(account) };
  }

  public updateAccount(idValue: unknown, input: AccountInput): ChatGptAccountView {
    const id = normalizeId(idValue);
    const accounts = this.loadAccounts();
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) throw new Error(`ChatGPT 账号不存在：${id}`);
    const current = accounts[index];
    const next: ChatGptAccount = {
      ...current,
      ...(stringValue(input.label, 120) ? { label: stringValue(input.label, 120) } : {}),
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      updated_at: nowIso(),
    };
    this.ensureProfileDirectory(next);
    accounts[index] = next;
    this.saveAccounts(accounts);
    return { ...next, auth_status: this.authStatus(next) };
  }

  /**
   * Removes only the account-pool record. The isolated profile directory is
   * deliberately preserved so a user can recover or delete its login state
   * explicitly instead of losing credentials as a side effect.
   */
  public removeAccount(idValue: unknown): { id: string; profile_dir: string; preserved_profile: true } | null {
    const id = normalizeId(idValue);
    const accounts = this.loadAccounts();
    const account = accounts.find((candidate) => candidate.id === id);
    if (!account) return null;
    this.saveAccounts(accounts.filter((candidate) => candidate.id !== id));
    const settings = this.getSettings();
    if (settings.default_account_id === id) {
      this.saveSettings({ ...settings, default_account_id: null });
    }
    return { id, profile_dir: account.profile_dir, preserved_profile: true };
  }

  public getSettings(): ChatGptAccountPoolSettings {
    return normalizeSettings(readJson(this.settingsPath));
  }

  public saveSettings(value: unknown): ChatGptAccountPoolSettings {
    const current = normalizeSettings(value, this.getSettings());
    const accountIds = new Set(this.loadAccounts().map((account) => account.id));
    if (current.default_account_id && !accountIds.has(current.default_account_id)) {
      current.default_account_id = null;
    }
    current.updated_at = nowIso();
    this.writeJson(this.settingsPath, {
      schema_version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION,
      ...current,
    });
    return current;
  }

  public rotationEnabled(): boolean {
    return this.getSettings().rotation_enabled === true;
  }

  /**
   * Select the official account for one upstream request.
   *
   * `round_robin` is the compatibility name for quota-aware pool mode. It
   * uses a persisted weighted ring: accounts with more official remaining
   * quota receive more slots, while unknown usage receives a conservative
   * equal base slot. It is not lowest-usage sorting and not random rotation.
   */
  public selectForInvocation(explicitId?: unknown): ChatGptAccountView | null {
    const settings = this.getSettings();
    if (!settings.rotation_enabled) return null;
    const accounts = this.listAccounts();
    const explicit = normalizeId(explicitId);
    const requested = explicit ? accounts.find((account) => account.id === explicit) : null;
    if (requested?.auth_status === "ready" && requested.enabled) {
      this.touch(requested.id);
      return { ...requested, last_used_at: nowIso() };
    }

    const ready = accounts.filter((account) => account.auth_status === "ready" && account.enabled);
    if (!ready.length) return null;

    const selected: ChatGptAccountView | undefined = settings.mode === "round_robin"
      ? this.selectWeighted(ready)
      : ready.find((account) => account.id === settings.default_account_id) || ready[0];
    if (!selected) return null;
    this.touch(selected.id);
    return { ...selected, last_used_at: nowIso() };
  }

  /**
   * Returns the next ready profile for the current upstream request after an
   * official quota/limit response. The failed account is excluded even if its
   * cooldown has not yet been persisted by the caller.
   */
  public selectNextAvailable(currentId?: unknown): ChatGptAccountView | null {
    const settings = this.getSettings();
    if (!settings.rotation_enabled) return null;
    const current = normalizeId(currentId);
    const accounts = this.listAccounts();
    const ready = accounts.filter((account) =>
      account.enabled
      && account.auth_status === "ready"
      && account.id !== current,
    );
    if (!ready.length) return null;

    const selected = settings.mode === "round_robin"
      ? this.selectWeighted(ready)
      : (current ? undefined : ready.find((account) => account.id === settings.default_account_id))
        || [...ready].sort((left, right) => {
          const leftTime = left.last_used_at || left.created_at;
          const rightTime = right.last_used_at || right.created_at;
          return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
        })[0];
    if (!selected) return null;
    this.touch(selected.id);
    return { ...selected, last_used_at: nowIso() };
  }

  public automaticFailoverEnabled(): boolean {
    const settings = this.getSettings();
    return settings.rotation_enabled && settings.mode === "round_robin";
  }

  public markSuccess(idValue: unknown): void {
    this.updateRuntimeState(idValue, (account) => ({
      ...account,
      failure_count: 0,
      last_error: undefined,
      cooldown_until: undefined,
      needs_reauth: undefined,
      last_used_at: nowIso(),
      updated_at: nowIso(),
    }));
  }

  public markAuthFailure(idValue: unknown, error: unknown): void {
    this.updateRuntimeState(idValue, (account) => ({
      ...account,
      needs_reauth: true,
      last_error: safeError(error) || "官方账号需要重新登录",
      cooldown_until: undefined,
      updated_at: nowIso(),
    }));
  }

  public markAuthSuccess(idValue: unknown): void {
    this.updateRuntimeState(idValue, (account) => ({
      ...account,
      needs_reauth: undefined,
      last_error: undefined,
      cooldown_until: undefined,
      failure_count: 0,
      updated_at: nowIso(),
    }));
  }

  public markFailure(idValue: unknown, error: unknown): void {
    this.updateRuntimeState(idValue, (account) => {
      const failureCount = Math.min(100, account.failure_count + 1);
      const cooldownMs = Math.min(5 * 60 * 1000, 15 * 1000 * (2 ** Math.min(failureCount - 1, 4)));
      const retryAfterMs = retryAfterMilliseconds(error);
      return {
        ...account,
        failure_count: failureCount,
        last_error: safeError(error) || "账号请求失败",
        cooldown_until: new Date(Date.now() + Math.max(cooldownMs, retryAfterMs || 0)).toISOString(),
        last_used_at: nowIso(),
        updated_at: nowIso(),
      };
    });
  }

  /**
   * Usage quotas usually reset much later than a transport retry window. Keep
   * a hard-limit account out of automatic selection for one hour so a new
   * request does not immediately cycle back to the exhausted profile. The
   * bridge still leaves the profile intact and the user can re-enable it or
   * edit the persisted state when the provider quota resets.
   */
  public markQuotaFailure(idValue: unknown, error: unknown): void {
    this.updateRuntimeState(idValue, (account) => {
      const failureCount = Math.min(100, account.failure_count + 1);
      return {
        ...account,
        failure_count: failureCount,
        last_error: safeError(error) || "账号额度已耗尽",
        cooldown_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        last_used_at: nowIso(),
        updated_at: nowIso(),
      };
    });
  }

  private loadAccounts(): ChatGptAccount[] {
    const payload = readJson(this.accountsPath);
    const values = Array.isArray(payload) ? payload : payload?.accounts;
    if (!Array.isArray(values)) return [];
    return values
      .map((value) => normalizeAccount(value, this.profileRoot))
      .filter((account): account is ChatGptAccount => Boolean(account));
  }

  private authStatus(account: ChatGptAccount): ChatGptAccountAuthStatus {
    if (!account.enabled) return "disabled";
    if (account.cooldown_until && Date.parse(account.cooldown_until) > Date.now()) return "cooldown";
    if (account.needs_reauth) return "reauth_required";
    return isPresentFile(path.join(account.profile_dir, "auth.json")) ? "ready" : "missing";
  }

  private selectWeighted(accounts: ChatGptAccountView[]): ChatGptAccountView | undefined {
    const ordered = [...accounts].sort((left, right) => {
      return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
    });
    const weighted = ordered.flatMap((account) => {
      const weight = this.usageWeight(account.id);
      return Array.from({ length: weight }, () => account);
    });
    const slots = weighted.length > 0 ? weighted : ordered;
    if (!slots.length) return undefined;
    const settings = this.getSettings();
    const index = settings.scheduler_cursor % slots.length;
    const selected = slots[index];
    this.saveSettings({ ...settings, scheduler_cursor: settings.scheduler_cursor + 1 });
    return selected;
  }

  private usageWeight(accountId: string): number {
    const usage = this.usageService.getCached(accountId);
    const score = usageSelectionScore(usage);
    const exhausted = Boolean(
      usage && (
        usage.spend_control_reached === true
        || Boolean(String(usage.rate_limit_reached_type || "").trim())
        || (score !== null && score >= 100)
      ),
    );
    if (exhausted) return 0;
    if (score === null) return 1;
    // Ten discrete slots keep the scheduler deterministic while giving
    // higher remaining official quota more capacity over the ring.
    return Math.max(1, Math.min(10, Math.ceil((100 - score) / 10)));
  }

  private ensureProfileDirectory(account: ChatGptAccount): void {
    fs.mkdirSync(account.profile_dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(account.profile_dir, 0o700); } catch {}
    const configPath = path.join(account.profile_dir, "config.toml");
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, "cli_auth_credentials_store = \"file\"\n", { encoding: "utf-8", mode: 0o600 });
      try { fs.chmodSync(configPath, 0o600); } catch {}
    }
  }

  private touch(id: string): void {
    this.updateRuntimeState(id, (account) => ({ ...account, last_used_at: nowIso(), updated_at: nowIso() }));
  }

  private updateRuntimeState(idValue: unknown, update: (account: ChatGptAccount) => ChatGptAccount): void {
    const id = normalizeId(idValue);
    if (!id) return;
    const accounts = this.loadAccounts();
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) return;
    accounts[index] = update(accounts[index]);
    this.saveAccounts(accounts);
  }

  private saveAccounts(accounts: ChatGptAccount[]): void {
    const normalized = accounts
      .map((account) => normalizeAccount(account, this.profileRoot))
      .filter((account): account is ChatGptAccount => Boolean(account));
    this.writeJson(this.accountsPath, {
      schema_version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION,
      accounts: normalized,
      updated_at: nowIso(),
    });
  }

  private writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }
}
