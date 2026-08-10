import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fetchUpstream } from "./upstream_fetch.js";
import { APP_VERSION } from "../version.js";

/**
 * Read-only official Codex account usage.
 *
 * The native Codex binary already exposes `account/rateLimits/read`. OpenCodex
 * invokes that existing protocol in an isolated CODEX_HOME and only adapts
 * the returned snapshot for the dashboard. No native app-server code or auth
 * token is copied into the gateway state.
 */

export const OFFICIAL_CHATGPT_USAGE_SOURCE = "official:account/rateLimits/read";
const USAGE_CACHE_TTL_MS = 45_000;
const USAGE_RETRY_COOLDOWN_MS = 15_000;
const USAGE_REQUEST_TIMEOUT_MS = 20_000;
// Official `/wham/usage` is account-scoped and can be sensitive to bursts
// from several freshly spawned app-server processes. Probe one profile at a
// time; a failed probe is retried once before the cached snapshot is marked
// stale.
const MAX_CONCURRENT_USAGE_PROBES = 1;
const USAGE_NATIVE_ATTEMPTS = 2;
const USAGE_RETRY_DELAY_MS = 600;

export type ChatGptAccountUsageStatus = "fresh" | "stale" | "unavailable";
export type ChatGptUsageWindowKind = "five_hour" | "weekly" | "other";

export interface ChatGptUsageWindow {
  kind: ChatGptUsageWindowKind;
  label: string;
  used_percent: number;
  remaining_percent: number;
  window_minutes: number | null;
  resets_at: number | null;
}

export interface ChatGptUsageCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface ChatGptAccountUsage {
  status: ChatGptAccountUsageStatus;
  source: typeof OFFICIAL_CHATGPT_USAGE_SOURCE;
  checked_at: string;
  fetched_at?: string;
  plan_type?: string | null;
  five_hour?: ChatGptUsageWindow;
  weekly?: ChatGptUsageWindow;
  additional_windows?: ChatGptUsageWindow[];
  credits?: ChatGptUsageCredits | null;
  rate_limit_reached_type?: string | null;
  spend_control_reached?: boolean | null;
  error?: string;
}

type JsonRecord = Record<string, any>;
type UsageAccount = { id: string; profile_dir: string };
type UsageCacheEntry = {
  usage: ChatGptAccountUsage;
  fetched_at_ms: number;
  checked_at_ms: number;
};

type PersistedUsageCache = {
  schema_version?: number;
  accounts?: Record<string, Partial<UsageCacheEntry>>;
};

/**
 * Return the usage score used by the account pool.
 *
 * The score is the highest currently-known utilization across the official
 * windows. Choosing the lowest score protects the most constrained window;
 * missing official data stays unknown instead of being treated as zero.
 */
export function usageSelectionScore(usage: ChatGptAccountUsage | undefined): number | null {
  if (!usage || usage.status === "unavailable") return null;
  const values = [
    usage.five_hour?.used_percent,
    usage.weekly?.used_percent,
    ...(usage.additional_windows || []).map((window) => window.used_percent),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeEpochSeconds(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  return numeric > 100_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function normalizeWindowMinutes(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric === null || numeric < 0 ? null : Math.floor(numeric);
}

function normalizeWindowKind(windowMinutes: number | null): ChatGptUsageWindowKind {
  if (windowMinutes === 300) return "five_hour";
  if (windowMinutes === 10_080) return "weekly";
  return "other";
}

function windowLabel(kind: ChatGptUsageWindowKind, windowMinutes: number | null): string {
  if (kind === "five_hour") return "5 小时窗口";
  if (kind === "weekly") return "周窗口";
  return windowMinutes ? `${windowMinutes} 分钟窗口` : "官方窗口";
}

function normalizeWindow(value: unknown): ChatGptUsageWindow | null {
  const source = asRecord(value);
  if (!source) return null;
  const used = finiteNumber(source.usedPercent ?? source.used_percent);
  if (used === null) return null;
  const usedPercent = Math.max(0, Math.min(100, used));
  const windowMinutes = normalizeWindowMinutes(
    source.windowDurationMins ?? source.window_duration_mins ?? source.window_minutes,
  );
  const kind = normalizeWindowKind(windowMinutes);
  return {
    kind,
    label: windowLabel(kind, windowMinutes),
    used_percent: usedPercent,
    remaining_percent: Math.max(0, 100 - usedPercent),
    window_minutes: windowMinutes,
    resets_at: normalizeEpochSeconds(source.resetsAt ?? source.resets_at),
  };
}

function normalizeCredits(value: unknown): ChatGptUsageCredits | null {
  const source = asRecord(value);
  if (!source) return null;
  return {
    has_credits: source.hasCredits === true || source.has_credits === true,
    unlimited: source.unlimited === true,
    balance: source.balance === null || source.balance === undefined
      ? null
      : String(source.balance),
  };
}

function usageSnapshots(raw: unknown): JsonRecord[] {
  const root = asRecord(raw);
  if (!root) return [];
  const snapshots: JsonRecord[] = [];
  const byLimitId = asRecord(root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id);
  if (byLimitId) {
    const codex = asRecord(byLimitId.codex);
    if (codex) snapshots.push(codex);
    for (const [key, value] of Object.entries(byLimitId)) {
      if (key === "codex") continue;
      const snapshot = asRecord(value);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  const single = asRecord(root.rateLimits ?? root.rate_limits);
  if (single) snapshots.push(single);
  if (snapshots.length === 0 && (root.primary || root.secondary || root.credits || root.planType || root.plan_type)) {
    snapshots.push(root);
  }
  return snapshots;
}

/**
 * Normalize the native `account/rateLimits/read` response without inventing
 * quota values. Unknown window lengths remain visible as additional windows.
 */
export function normalizeOfficialRateLimits(raw: unknown, fetchedAt = new Date().toISOString()): ChatGptAccountUsage {
  const snapshots = usageSnapshots(raw);
  const primaryWindows = snapshots.flatMap((snapshot) => [
    normalizeWindow(snapshot.primary),
    normalizeWindow(snapshot.secondary),
  ].filter((window): window is ChatGptUsageWindow => Boolean(window)));

  const byKind = new Map<ChatGptUsageWindowKind, ChatGptUsageWindow>();
  const additional: ChatGptUsageWindow[] = [];
  for (const window of primaryWindows) {
    if (window.kind === "other") {
      if (!additional.some((item) => item.window_minutes === window.window_minutes)) additional.push(window);
      continue;
    }
    if (!byKind.has(window.kind)) byKind.set(window.kind, window);
  }

  const first = snapshots[0];
  const credits = normalizeCredits(first?.credits ?? first?.credits_snapshot);
  const planType = first?.planType ?? first?.plan_type ?? null;
  const rateLimitReachedType = first?.rateLimitReachedType ?? first?.rate_limit_reached_type ?? null;
  const spendControlReached = first?.spendControlReached ?? first?.spend_control_reached ?? null;
  const hasRecognizedData = Boolean(
    byKind.size > 0
    || additional.length > 0
    || credits
    || planType
    || rateLimitReachedType
    || spendControlReached !== null,
  );

  return {
    status: hasRecognizedData ? "fresh" : "unavailable",
    source: OFFICIAL_CHATGPT_USAGE_SOURCE,
    checked_at: fetchedAt,
    ...(hasRecognizedData ? { fetched_at: fetchedAt } : { error: "官方返回未包含可识别的额度字段" }),
    ...(planType !== null ? { plan_type: String(planType) } : { plan_type: null }),
    ...(byKind.get("five_hour") ? { five_hour: byKind.get("five_hour") } : {}),
    ...(byKind.get("weekly") ? { weekly: byKind.get("weekly") } : {}),
    ...(additional.length > 0 ? { additional_windows: additional } : {}),
    ...(credits ? { credits } : {}),
    ...(rateLimitReachedType !== null ? { rate_limit_reached_type: String(rateLimitReachedType) } : { rate_limit_reached_type: null }),
    ...(spendControlReached !== null ? { spend_control_reached: Boolean(spendControlReached) } : { spend_control_reached: null }),
  };
}

function unavailableUsage(reason: string, checkedAt = new Date().toISOString()): ChatGptAccountUsage {
  return {
    status: "unavailable",
    source: OFFICIAL_CHATGPT_USAGE_SOURCE,
    checked_at: checkedAt,
    error: reason,
  };
}

function readProfileAccess(profileDir: string): { accessToken: string; accountId: string } {
  const authPath = path.join(profileDir, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as JsonRecord;
  const accessToken = typeof auth?.tokens?.access_token === "string" ? auth.tokens.access_token.trim() : "";
  const accountId = typeof auth?.tokens?.account_id === "string" ? auth.tokens.account_id.trim() : "";
  if (!accessToken) throw new Error("账号认证目录缺少官方 access token");
  return { accessToken, accountId };
}

function normalizeUsageEndpointWindow(value: unknown): JsonRecord | null {
  const source = asRecord(value);
  if (!source) return null;
  const usedPercent = source.used_percent ?? source.usedPercent;
  if (finiteNumber(usedPercent) === null) return null;
  const windowSeconds = source.limit_window_seconds
    ?? source.limitWindowSeconds
    ?? source.window_duration_seconds
    ?? source.windowDurationSeconds;
  const windowMinutes = finiteNumber(windowSeconds) === null
    ? (source.window_duration_mins ?? source.windowDurationMins ?? source.window_minutes)
    : Number(windowSeconds) / 60;
  return {
    usedPercent,
    ...(windowMinutes !== undefined ? { windowDurationMins: windowMinutes } : {}),
    ...(source.reset_at !== undefined ? { resetsAt: source.reset_at } : {}),
    ...(source.resetAt !== undefined ? { resetsAt: source.resetAt } : {}),
    ...(source.resets_at !== undefined ? { resetsAt: source.resets_at } : {}),
    ...(source.resetsAt !== undefined ? { resetsAt: source.resetsAt } : {}),
  };
}

/**
 * The native protocol normally returns this shape already. Some native
 * versions expose the same official data as the raw `/wham/usage` payload;
 * adapt only known field names and keep the existing normalizer authoritative.
 */
function normalizeUsageEndpointPayload(raw: unknown): unknown {
  const root = asRecord(raw);
  if (!root) return raw;
  if (root.rateLimits || root.rate_limits || root.rateLimitsByLimitId || root.rate_limits_by_limit_id) return raw;
  const rate = asRecord(root.rate_limit ?? root.rateLimit ?? root.usage);
  if (!rate) return raw;
  const primary = normalizeUsageEndpointWindow(rate.primary_window ?? rate.primaryWindow ?? rate.primary);
  const secondary = normalizeUsageEndpointWindow(rate.secondary_window ?? rate.secondaryWindow ?? rate.secondary);
  if (!primary && !secondary) return raw;
  return {
    rateLimits: {
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(root.credits ? { credits: root.credits } : {}),
      ...(root.plan_type || root.planType || root.plan || root.account_plan
        ? { planType: root.plan_type ?? root.planType ?? root.plan ?? root.account_plan }
        : {}),
      ...(rate.rate_limit_reached_type || rate.rateLimitReachedType
        ? { rateLimitReachedType: rate.rate_limit_reached_type ?? rate.rateLimitReachedType }
        : {}),
      ...(rate.spend_control_reached !== undefined || rate.spendControlReached !== undefined
        ? { spendControlReached: rate.spend_control_reached ?? rate.spendControlReached }
        : {}),
    },
  };
}

async function readRateLimitsViaOfficialHttp(profileDir: string): Promise<unknown> {
  const { accessToken, accountId } = readProfileAccess(profileDir);
  const response = await fetchUpstream("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      "User-Agent": "CodexSplit Account Usage",
    },
    maxAttempts: 2,
    timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
    operation: "account-usage-http",
    transport: "node_https",
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new Error(`官方额度 HTTP ${response.status}${text ? `：${text}` : ""}`);
  }
  return normalizeUsageEndpointPayload(await response.json());
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const cleaned = raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token[=:][^\s,}]+/gi, "token=[redacted]")
    .trim()
    .slice(0, 240);
  return cleaned || "官方额度查询失败";
}

function executableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() && Boolean(fs.statSync(filePath).mode & 0o111);
  } catch {
    return false;
  }
}

export function resolveNativeCodexPath(): string {
  const configured = [process.env.OPENCODEX_NATIVE_CODEX_PATH, process.env.OPENCODEX_NATIVE_CLI_PATH]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const candidates = [
    ...configured,
    path.join(os.homedir(), ".codex", "packages", "standalone", "current", "bin", "codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  return candidates.find(executableFile) || candidates[0] || "codex";
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, value: unknown): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readRateLimitsFromNative(profileDir: string, nativePath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(nativePath, ["app-server"], {
      env: {
        ...process.env,
        CODEX_HOME: profileDir,
        CODEX_CLI_PATH: undefined,
        OPENCODEX_PROVIDER_BRIDGE_PATH: undefined,
        OPENCODEX_PROVIDER_SPLIT: undefined,
        OPENCODEX_PROVIDER_BRIDGE_RUNTIME: undefined,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    let buffer = "";
    let settled = false;
    let rateLimitRequestSent = false;
    const timer = setTimeout(() => settleReject(new Error("官方额度查询超时")), USAGE_REQUEST_TIMEOUT_MS);

    const stop = (): void => {
      try { child.stdin.end(); } catch {}
      if (!child.killed) {
        try { child.kill("SIGTERM"); } catch {}
      }
    };
    const settleResolve = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(value);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error instanceof Error ? error : new Error(String(error || "官方额度查询失败")));
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: JsonRecord;
        try { message = JSON.parse(line) as JsonRecord; } catch { continue; }
        if (message.id === "opencodex-usage-initialize") {
          if (message.error) {
            settleReject(new Error(String(message.error.message || "native app-server 初始化失败")));
            return;
          }
          if (!rateLimitRequestSent) {
            rateLimitRequestSent = true;
            writeJsonLine(child, {
              id: "opencodex-usage-rate-limits",
              method: "account/rateLimits/read",
              params: {},
            });
          }
        } else if (message.id === "opencodex-usage-rate-limits") {
          if (message.error) {
            settleReject(new Error(String(message.error.message || "官方额度查询失败")));
            return;
          }
          settleResolve(message.result);
        }
      }
    });
    // Native diagnostics are intentionally not forwarded to the dashboard.
    child.stderr.on("data", () => {});
    child.once("error", (error) => settleReject(error));
    child.once("exit", (code, signal) => {
      if (!settled) settleReject(new Error(`native app-server exited (${signal || code || "unknown"})`));
    });

    try {
      writeJsonLine(child, {
        id: "opencodex-usage-initialize",
        method: "initialize",
        params: {
          clientInfo: { name: "CodexSplit Account Usage", version: APP_VERSION },
          capabilities: { experimentalApi: true, requestAttestation: true },
        },
      });
    } catch (error) {
      settleReject(error);
    }
  });
}

export class ChatGptAccountUsageService {
  private readonly cache = new Map<string, UsageCacheEntry>();
  private readonly inflight = new Map<string, Promise<ChatGptAccountUsage>>();
  private readonly cachePath: string;

  constructor(dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex")) {
    this.cachePath = path.join(dataDir, "chatgpt_account_usage.json");
    this.loadPersistedCache();
  }

  public getCached(accountId: string): ChatGptAccountUsage | undefined {
    return this.cache.get(accountId)?.usage;
  }

  public getCachedScore(accountId: string): number | null {
    return usageSelectionScore(this.getCached(accountId));
  }

  /** Refresh account usage without delaying the first user request. */
  public refreshInBackground(accounts: UsageAccount[], forceRefresh = false): void {
    void this.readMany(accounts, forceRefresh).catch(() => {
      // The cached official snapshot remains usable. A later dashboard or
      // bridge request can retry after the short retry cooldown.
    });
  }

  public async read(account: UsageAccount, forceRefresh = false): Promise<ChatGptAccountUsage> {
    const now = Date.now();
    const cached = this.cache.get(account.id);
    if (!forceRefresh && cached && now - cached.fetched_at_ms < USAGE_CACHE_TTL_MS) {
      return cached.usage;
    }
    if (!forceRefresh && cached && now - cached.checked_at_ms < USAGE_RETRY_COOLDOWN_MS) {
      return cached.usage;
    }
    const running = this.inflight.get(account.id);
    if (running) return running;

    const request = this.fetch(account, cached);
    this.inflight.set(account.id, request);
    try {
      return await request;
    } finally {
      if (this.inflight.get(account.id) === request) this.inflight.delete(account.id);
    }
  }

  public async readMany(accounts: UsageAccount[], forceRefresh = false): Promise<Map<string, ChatGptAccountUsage>> {
    const result = new Map<string, ChatGptAccountUsage>();
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < accounts.length) {
        const index = nextIndex++;
        const account = accounts[index];
        result.set(account.id, await this.read(account, forceRefresh));
      }
    };
    const workerCount = Math.min(MAX_CONCURRENT_USAGE_PROBES, accounts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return result;
  }

  private async fetch(account: UsageAccount, previous?: UsageCacheEntry): Promise<ChatGptAccountUsage> {
    const checkedAt = new Date().toISOString();
    try {
      let nativeResult: unknown;
      let lastError: unknown;
      for (let attempt = 1; attempt <= USAGE_NATIVE_ATTEMPTS; attempt += 1) {
        try {
          nativeResult = await readRateLimitsFromNative(account.profile_dir, resolveNativeCodexPath());
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < USAGE_NATIVE_ATTEMPTS) await delay(USAGE_RETRY_DELAY_MS);
        }
      }
      if (lastError) throw lastError;
      const usage = normalizeOfficialRateLimits(nativeResult, checkedAt);
      if (usage.status === "unavailable") throw new Error(usage.error || "官方返回未包含额度字段");
      this.cache.set(account.id, {
        usage,
        fetched_at_ms: Date.now(),
        checked_at_ms: Date.now(),
      });
      this.persistCache();
      return usage;
    } catch (error) {
      let finalError: unknown = error;
      // Keep the native protocol as the primary source. If the native helper
      // cannot reach `/wham/usage`, use the same official endpoint directly
      // with this isolated profile's token; this still avoids local quota
      // estimation and never sends the token to the dashboard or gateway.
      try {
        const directResult = await readRateLimitsViaOfficialHttp(account.profile_dir);
        const directUsage = normalizeOfficialRateLimits(directResult, checkedAt);
        if (directUsage.status === "unavailable") {
          throw new Error(directUsage.error || "官方返回未包含可识别的额度字段");
        }
        this.cache.set(account.id, {
          usage: directUsage,
          fetched_at_ms: Date.now(),
          checked_at_ms: Date.now(),
        });
        this.persistCache();
        return directUsage;
      } catch (directError) {
        finalError = new Error(`native: ${safeError(error)}; direct: ${safeError(directError)}`);
      }

      const message = safeError(finalError);
      if (previous?.usage && previous.usage.status !== "unavailable") {
        const stale: ChatGptAccountUsage = {
          ...previous.usage,
          status: "stale",
          checked_at: checkedAt,
          error: message,
        };
        this.cache.set(account.id, {
          usage: stale,
          fetched_at_ms: previous.fetched_at_ms,
          checked_at_ms: Date.now(),
        });
        this.persistCache();
        return stale;
      }
      const unavailable = unavailableUsage(message, checkedAt);
      this.cache.set(account.id, {
        usage: unavailable,
        fetched_at_ms: 0,
        checked_at_ms: Date.now(),
      });
      this.persistCache();
      return unavailable;
    }
  }

  private loadPersistedCache(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as PersistedUsageCache;
      const accounts = parsed?.accounts;
      if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return;
      for (const [accountId, value] of Object.entries(accounts)) {
        const usage = value?.usage;
        if (!usage || typeof usage !== "object" || usage.source !== OFFICIAL_CHATGPT_USAGE_SOURCE) continue;
        const fetchedAt = Number(value.fetched_at_ms);
        const checkedAt = Number(value.checked_at_ms);
        if (!Number.isFinite(fetchedAt) || !Number.isFinite(checkedAt)) continue;
        this.cache.set(accountId, {
          usage: usage as ChatGptAccountUsage,
          fetched_at_ms: fetchedAt,
          checked_at_ms: checkedAt,
        });
      }
    } catch {
      // A missing or interrupted cache must never prevent account routing.
    }
  }

  private persistCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
      const accounts: Record<string, UsageCacheEntry> = {};
      for (const [accountId, entry] of this.cache) accounts[accountId] = entry;
      const temporaryPath = `${this.cachePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ schema_version: 1, accounts }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, this.cachePath);
      try { fs.chmodSync(this.cachePath, 0o600); } catch {}
    } catch {
      // Usage remains available in memory even if the optional cache cannot
      // be persisted because another OpenCodex process is writing it.
    }
  }
}
