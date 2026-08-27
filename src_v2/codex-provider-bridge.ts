/**
 * Provider-aware stdio bridge for the native Codex app-server.
 *
 * The native app-server and its internal `spawn_agent` lifecycle remain
 * untouched. This bridge supplies a local request-level Egress URL: ordinary
 * native requests leave through ChatGPT, while a provider-owned model is
 * selected only for the current HTTP request and leaves through the local
 * OpenCodex gateway. The native app-server remains the sole owner of the
 * thread id, rollout file, history, archive state, and turn lifecycle.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RequestDecompressor } from "./core/decompressor.js";
import { isNativeControlPlaneModel } from "./core/model_identity.js";
import { copySafeResponseHeaders, writeHttpResponseChunked } from "./services/http_stream.js";
import { fetchUpstream, upstreamErrorDetails } from "./services/upstream_fetch.js";
import { normalizeLegacyTurnInput } from "./services/image_input.js";
import { bindResponseAbort, linkAbortSignal, readWithAbortAndTimeout } from "./services/request_lifecycle.js";
import { copyNativeRequestHeaders, handleWebRtcProxy, nativeLiveCallTarget, normalizeNativeLiveCallBody, readNativeAccessToken } from "./server/webrtc_proxy.js";
import { ChatGptAccountPool, type ChatGptAccountView } from "./services/chatgpt_account_pool.js";
import { APP_VERSION } from "./version.js";

export type CodexProvider = "openai" | "opencodex";

type JsonRecord = Record<string, any>;

type ProviderRuntime = {
  provider: CodexProvider;
  child: ChildProcessWithoutNullStreams;
  initialized: boolean;
  stopping: boolean;
  queue: Array<{ message: JsonRecord; pending?: PendingRequest }>;
  healthyTimer?: ReturnType<typeof setTimeout>;
};

type PendingParentRequest = {
  kind: "parent";
  id: unknown;
  method: string;
  params: JsonRecord;
  runtime: ProviderRuntime;
  request?: JsonRecord;
  recoveryAttempts?: number;
  externalThreadId?: string;
  physicalThreadId?: string;
  displayModel?: string;
  displayProvider?: CodexProvider;
  displayReasoning?: string;
  onResponse?: (message: JsonRecord) => JsonRecord | null;
};

type PendingInternalRequest = {
  kind: "internal";
  method: string;
  runtime: ProviderRuntime;
  request?: JsonRecord;
  recoveryAttempts?: number;
  suppressThreadId?: string;
  onResponse: (message: JsonRecord) => void;
};

type PendingRequest = PendingParentRequest | PendingInternalRequest;

type PendingServerRequest = {
  childId: unknown;
  runtime: ProviderRuntime;
  method: string;
};

type RuntimeRecoveryRequest = {
  message: JsonRecord;
  pending: PendingRequest;
  attempts: number;
};

type ThreadRoute = {
  externalId: string;
  nativeId: string;
  nativePath?: string;
  archived?: boolean;
  retiredNativeIds?: string[];
  selectedModel: string;
  threadSource?: string;
  threadOrigin?: "desktop" | "gpt-live";
  parentThreadId?: string;
  legacySourceId?: string;
  legacySourcePath?: string;
  legacyModel?: string;
  settings?: JsonRecord;
};

type NativeSubagentDisplaySettings = {
  model?: string;
  effort?: string;
};

type NativeSubagentDisplayUpdate = NativeSubagentDisplaySettings & {
  threadId: string;
};

type LegacyThread = {
  id: string;
  model: string;
  path?: string;
};

type EnsureCanonicalOptions = {
  // Opening an existing thread can carry the Desktop-wide picker model. Do
  // not use that value to infer a provider migration when the durable route
  // has not been created yet; discover the physical thread first.
  preserveRequestedModel?: boolean;
};

type GatewaySubagentEvent = {
  seq: number;
  type: "started" | "completed" | "failed" | "cancel_requested";
  task_id: string;
  parent_task_id?: string;
  parent_turn_id?: string;
  task?: JsonRecord;
  created_at?: string;
};

type SubagentEventPoller = {
  cursor: number;
  startedAt: number;
  parentTurnId?: string;
  stopAt?: number;
  inFlight: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

// Images are first-class Codex input. Keep a finite transport guard for a
// genuinely pathological request, but do not reject ordinary screenshots or
// downgrade them to text merely because they are Base64-encoded.
const MAX_THIRD_PARTY_TURN_BYTES = 16 * 1024 * 1024;
const MAX_CHILD_REQUEST_BYTES = 16 * 1024 * 1024;
// A native app-server crash is a runtime fault, not a Desktop/session fault.
// Keep the bridge process and its stdio contract alive while replacing only
// the dead child. Backoff prevents a broken binary from creating a restart
// storm that could take down the gateway or consume the machine.
const RUNTIME_RESTART_BASE_DELAY_MS = 100;
const RUNTIME_RESTART_MAX_DELAY_MS = 5_000;
const RUNTIME_HEALTHY_RESET_MS = 15_000;
const MAX_RUNTIME_RECOVERY_ATTEMPTS = 3;
const TURN_INTERRUPT_WATCHDOG_MS = 8_000;
const EGRESS_STREAM_IDLE_TIMEOUT_MS = 600_000;
const RECOVERABLE_RUNTIME_METHODS = new Set([
  "thread/list",
  "thread/read",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "thread/settings/update",
]);
// A fast provider turn can create both lifecycle events before the native
// app-server emits turn/started and before the first sideband poll. The cursor
// is durable, so filtering by the poller's exact start time would discard the
// completion permanently.
const SUBAGENT_EVENT_REPLAY_GRACE_MS = 60_000;

const NATIVE_PROVIDER: CodexProvider = "openai";
const GATEWAY_PROVIDER: CodexProvider = "opencodex";
// Use the configured OpenAI-compatible provider name for the native child's
// process-scoped Egress. The URL is injected per child, while the gateway
// retains the same provider name for its local configuration and diagnostics.
const NATIVE_EGRESS_PROVIDER = GATEWAY_PROVIDER;

function codexHomeDir(): string {
  return cleanString(process.env.OPENCODEX_CODEX_HOME || process.env.CODEX_HOME)
    || path.join(os.homedir(), ".codex");
}

function isArchivedNativeRolloutPath(filePath: string): boolean {
  const archivedRoot = path.resolve(path.join(codexHomeDir(), "archived_sessions"));
  const resolvedPath = path.resolve(String(filePath || ""));
  return resolvedPath === archivedRoot || resolvedPath.startsWith(`${archivedRoot}${path.sep}`);
}

function opencodexDataDir(): string {
  return cleanString(process.env.OPENCODEX_DATA_DIR) || path.join(os.homedir(), ".opencodex");
}

function modelCatalogFiles(): string[] {
  return [
    path.join(opencodexDataDir(), "custom_model_catalog.json"),
    path.join(codexHomeDir(), "models_cache.json"),
    path.join(codexHomeDir(), "models_catalog.json"),
  ];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) || "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function thirdPartyTurnInputError(params: JsonRecord): string | null {
  if (jsonByteLength(params) > MAX_THIRD_PARTY_TURN_BYTES) {
    return "第三方桥已阻止本轮超大输入：为保护其他会话，过大的请求不会进入共享运行时，请缩短内容后重试。";
  }
  return null;
}

function modelSlug(model: unknown): string {
  if (typeof model === "string") return model.trim();
  if (!model || typeof model !== "object") return "";
  const value = model as JsonRecord;
  return cleanString(value.slug || value.id || value.model || value.name);
}

function modelOwner(model: JsonRecord): string {
  return cleanString(
    // `provider`/`model_provider` identify the Codex route. The
    // `backend_provider` field identifies the upstream vendor and can be
    // `openai` even for a user-configured OpenAI-compatible gateway model.
    model.model_provider
      || model.modelProvider
      || model.provider
      || model.owner
      || model.backend_provider
      || model.backendProvider,
  ).toLowerCase();
}

function modelEntries(catalogs: unknown[]): JsonRecord[] {
  const entries: JsonRecord[] = [];
  for (const catalog of catalogs) {
    if (!catalog || typeof catalog !== "object") continue;
    const models = Array.isArray(catalog)
      ? catalog
      : Array.isArray((catalog as JsonRecord).models)
        ? (catalog as JsonRecord).models
        : [];
    for (const model of models) {
      if (model && typeof model === "object") entries.push(model as JsonRecord);
    }
  }
  return entries;
}

function providerFromOwner(owner: string): CodexProvider | null {
  if (!owner || owner === "native" || owner === "openai" || owner === "codex") return NATIVE_PROVIDER;
  if (owner === GATEWAY_PROVIDER || owner.length > 0) return GATEWAY_PROVIDER;
  return null;
}

function isOfficialModelSlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  return normalized.startsWith("openai/")
    || (!normalized.includes("/") && /^(?:gpt-|o\d|codex-|chatgpt)/i.test(slug));
}

/**
 * Resolve the provider from the imported catalog first. Unknown models are
 * only treated as native when they belong to an official naming family.
 */
export function classifyProviderModel(model: unknown, catalogs: unknown[] = []): CodexProvider | null {
  const slug = modelSlug(model);
  if (!slug) return null;
  const normalized = slug.toLowerCase();

  // Official model identity is authoritative. A stale imported catalog can
  // incorrectly retain `provider: opencodex` for a bare GPT slug; allowing
  // that metadata to win sends an official turn through the gateway.
  if (isOfficialModelSlug(slug)) return NATIVE_PROVIDER;

  const entries = modelEntries(catalogs);
  const exact = entries.find((entry) => modelSlug(entry).toLowerCase() === normalized);
  if (exact) {
    // A provider namespace is an explicit routing boundary. Never send a
    // namespaced non-OpenAI model to the native ChatGPT account, even when a
    // stale cache reports its upstream/backend owner as `openai`.
    if (normalized.includes("/") && !normalized.startsWith("openai/")) {
      return GATEWAY_PROVIDER;
    }
    const owner = modelOwner(exact);
    if (owner) return providerFromOwner(owner);
    if (isOfficialModelSlug(slug)) return NATIVE_PROVIDER;
    return normalized.includes("/") ? GATEWAY_PROVIDER : NATIVE_PROVIDER;
  }

  if (normalized.includes("/")) return GATEWAY_PROVIDER;
  return null;
}

function readCatalogs(): unknown[] {
  const configured = cleanString(process.env.OPENCODEX_MODEL_CATALOG_PATH);
  const defaults = modelCatalogFiles();
  const files = configured ? [configured, ...defaults] : defaults;
  const catalogs: unknown[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      catalogs.push(JSON.parse(fs.readFileSync(resolved, "utf8")));
    } catch {}
  }
  return catalogs;
}

function classifyRuntimeModel(model: unknown): CodexProvider | null {
  return classifyProviderModel(model, readCatalogs());
}

function nativeDefaultModel(): string {
  const configured = cleanString(process.env.OPENCODEX_NATIVE_MODEL);
  if (configured && classifyRuntimeModel(configured) === NATIVE_PROVIDER) return configured;
  try {
    const configPath = path.join(codexHomeDir(), "config.toml");
    const content = fs.readFileSync(configPath, "utf8");
    const match = content.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    const model = cleanString(match?.[1]);
    if (model && classifyRuntimeModel(model) === NATIVE_PROVIDER) return model;
  } catch {}
  return "gpt-5.5";
}

function normalizeProvider(value: unknown): CodexProvider | null {
  const provider = cleanString(value).toLowerCase();
  if (provider === NATIVE_PROVIDER) return NATIVE_PROVIDER;
  if (provider === GATEWAY_PROVIDER) return GATEWAY_PROVIDER;
  return null;
}

/**
 * Only an explicit official quota/rate-limit response is allowed to move a
 * logical conversation to another ChatGPT account. Transport failures such as
 * 502, ECONNRESET, timeouts, and generic 400s must stay on the current account
 * so a temporary network problem cannot silently change login state.
 */
export function isOfficialQuotaFailure(value: unknown): boolean {
  const strings: string[] = [];
  const statuses: number[] = [];
  const seen = new Set<object>();
  const collect = (current: unknown, depth: number): void => {
    if (depth > 5 || current === null || current === undefined) return;
    if (typeof current === "string") {
      strings.push(current);
      return;
    }
    if (typeof current === "number") {
      if (Number.isFinite(current)) statuses.push(current);
      return;
    }
    if (typeof current !== "object") return;
    if (seen.has(current as object)) return;
    seen.add(current as object);
    if (Array.isArray(current)) {
      for (const entry of current) collect(entry, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(current as JsonRecord)) {
      if (/^(?:status|statusCode|httpStatus)$/i.test(key) && typeof child === "number") {
        statuses.push(child);
      }
      collect(child, depth + 1);
    }
  };
  collect(value, 0);
  const text = strings.join(" ").toLowerCase();
  if (statuses.includes(429) || /\b429\b/.test(text)) return true;
  if (statuses.includes(402) && /(quota|credit|billing|usage|limit)/i.test(text)) return true;
  if (statuses.includes(403) && /(quota|rate\s*limit|usage\s*limit|too\s+many\s+requests|limit\s+(?:reached|exceeded))/i.test(text)) {
    return true;
  }
  return /insufficient[_\s-]*quota|rate[_\s-]*limit|ratelimit|usage[_\s-]*limit|too\s+many\s+requests|(?:quota|usage|request)\s+limit\s+(?:reached|exceeded)|(?:quota|usage)\s+(?:has\s+been\s+)?exceeded|limit\s+(?:has\s+been\s+)?reached|exceeded\s+(?:your\s+)?(?:current\s+)?(?:quota|usage|limit)|使用上限|额度(?:已)?(?:耗尽|不足)|配额(?:已)?(?:耗尽|不足)|达到(?:了)?(?:使用|额度|配额)?上限|请在[^。\n]{0,80}(?:后|之后)(?:重试|再试)/i.test(text);
}

export function isHardOfficialQuotaFailure(value: unknown): boolean {
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) || "";
  } catch {
    text = String(value);
  }
  return /(insufficient[_\s-]*quota|\bquota\b|usage[_\s-]*limit|\bcredits?\b|\bbilling\b|使用上限|额度(?:已)?(?:耗尽|不足)|配额(?:已)?(?:耗尽|不足)|达到(?:了)?(?:使用|额度|配额)?上限|升级套餐|充值额度)/i.test(text)
    && !/(rate[_\s-]*limit|ratelimit|too\s+many\s+requests)/i.test(text);
}

/**
 * Authentication failures change account health, but are not quota failures.
 * They mark the isolated profile for re-login so future sessions avoid it;
 * generic transport errors and model-validation errors stay on the current
 * account and never trigger account rotation.
 */
export function isOfficialAuthFailure(value: unknown): boolean {
  const text = typeof value === "string"
    ? value
    : (() => {
      try { return JSON.stringify(value) || ""; } catch { return String(value); }
    })();
  if (/(?:"?status(?:Code|_code)?"?\s*[:=]\s*)?401\b/i.test(text)) return true;
  return /\b403\b/i.test(text)
    && /(unauthori[sz]ed|authentication|auth(?:entication)?\s+required|invalid\s+(?:api\s+)?key|invalid\s+token|token\s+(?:has\s+)?expired|expired\s+token|credential|login\s+required|not\s+authenticated|account\s+(?:is\s+)?(?:disabled|suspended|not\s+authorized))/i.test(text);
}

type HeaderBag = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderBag, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return cleanString(value[0]);
  return cleanString(value);
}

type OfficialAccountCredential = {
  localId: string;
  upstreamId: string;
  token: string;
};

/**
 * Owns only the official upstream credential currently used by Native Egress.
 *
 * This is deliberately request/upstream state, not conversation state. The
 * native app-server keeps its process, thread IDs, history, and response
 * protocol unchanged while this controller changes the bearer credential at
 * the HTTP boundary after an explicit official quota response.
 */
export class OfficialAccountRouter {
  private rotationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly pool: ChatGptAccountPool) {}

  private authMetadata(account: ChatGptAccountView): { token: string; upstreamId: string } {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(account.profile_dir, "auth.json"), "utf8"));
      const token = cleanString(auth?.tokens?.access_token);
      const upstreamId = cleanString(auth?.tokens?.account_id) || account.id;
      return { token, upstreamId };
    } catch {
      return { token: "", upstreamId: account.id };
    }
  }

  private credentialFor(account: ChatGptAccountView | undefined): OfficialAccountCredential | null {
    if (!account || account.auth_status !== "ready" || !account.enabled) return null;
    const metadata = this.authMetadata(account);
    const token = metadata.token || readNativeAccessToken(account.id);
    if (!token) return null;
    return {
      localId: account.id,
      upstreamId: metadata.upstreamId,
      token,
    };
  }

  /**
   * Select only the official credential for this upstream request.
   *
   * This intentionally has no active-account cache and never reads an
   * incoming conversation/thread account hint. Fixed mode therefore follows
   * the current dashboard-selected account on the next request, while
   * round-robin mode advances for each request independently of sessions.
   */
  public credentialForRequest(_req: http.IncomingMessage): OfficialAccountCredential | null {
    // The account pool is an explicit, independent capability. A Desktop
    // Bridge process may be running solely for third-party routing; that must
    // never replace the credential of a truly native GPT request by itself.
    if (!this.pool.rotationEnabled()) return null;
    const selected = this.pool.selectForInvocation(process.env.OPENCODEX_CHATGPT_ACCOUNT_ID) || undefined;
    const credential = this.credentialFor(selected);
    if (!credential) return null;
    console.error(`[OpenCodex Official Egress] request account=${credential.localId}`);
    return credential;
  }

  public async failover(failedId: string, error: unknown): Promise<OfficialAccountCredential | null> {
    if (!this.pool.rotationEnabled()) return null;
    const previous = this.rotationTail;
    let release: () => void = () => {};
    this.rotationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (!this.pool.automaticFailoverEnabled()) return null;

      if (isHardOfficialQuotaFailure(error)) this.pool.markQuotaFailure(failedId, error);
      else this.pool.markFailure(failedId, error);
      const next = this.pool.selectNextAvailable(failedId);
      const credential = this.credentialFor(next || undefined);
      if (credential) {
        console.error(`[OpenCodex Official Egress] quota failover ${failedId} -> ${credential.localId}`);
      } else {
        console.error(`[OpenCodex Official Egress] no available account after ${failedId} quota failure`);
      }
      return credential;
    } finally {
      release();
    }
  }

  public markAuthFailure(localId: string, error: unknown): void {
    this.pool.markAuthFailure(localId, error);
  }
}

type NativeLiveAccountBinding = {
  credential: OfficialAccountCredential;
  expiresAt: number;
};

const NATIVE_LIVE_ACCOUNT_BINDING_TTL_MS = 15 * 60 * 1000;
const MAX_NATIVE_LIVE_ACCOUNT_BINDINGS = 256;

function safeNativeLiveCallId(value: unknown): string {
  const normalized = cleanString(value);
  return /^[A-Za-z0-9._-]{1,240}$/.test(normalized) ? normalized : "";
}

function collectNativeLiveCallIds(value: unknown, output: Set<string>, key = "", depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (normalizedKey.includes("callid") || normalizedKey.includes("realtimesessionid")) {
      const id = safeNativeLiveCallId(value);
      if (id) output.add(id);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectNativeLiveCallIds(entry, output, key, depth + 1);
    return;
  }
  for (const [childKey, child] of Object.entries(value as JsonRecord)) {
    collectNativeLiveCallIds(child, output, childKey, depth + 1);
  }
}

/** Extract the native V3 call id needed by the following sideband WebSocket. */
export function extractNativeLiveCallIds(body: Buffer | string, headers: Headers | HeaderBag = {}): string[] {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  const ids = new Set<string>();
  try {
    collectNativeLiveCallIds(JSON.parse(text), ids);
  } catch {
    // Native Live responses are normally JSON, but the regex fallback keeps
    // the binding working if a compatible upstream wraps the response.
  }
  for (const match of text.matchAll(/\brtc_[A-Za-z0-9._-]+\b/g)) {
    const id = safeNativeLiveCallId(match[0]);
    if (id) ids.add(id);
  }
  const headerNames = ["x-call-id", "x-session-id", "x-realtime-session-id", "x-codex-call-id", "location"];
  for (const name of headerNames) {
    const value = headers instanceof Headers ? headers.get(name) : headerValue(headers, name);
    const id = safeNativeLiveCallId(value);
    if (id) ids.add(id);
    if (value) {
      for (const match of value.matchAll(/\brtc_[A-Za-z0-9._-]+\b/g)) {
        const headerId = safeNativeLiveCallId(match[0]);
        if (headerId) ids.add(headerId);
      }
    }
  }
  return Array.from(ids);
}

class NativeLiveAccountBindings {
  private readonly bindings = new Map<string, NativeLiveAccountBinding>();
  private latest: NativeLiveAccountBinding | null = null;
  private latestCallIdValue = "";
  private latestCallIdExpiresAt = 0;

  public remember(body: Buffer, response: Response, credential: OfficialAccountCredential | null): void {
    const callIds = extractNativeLiveCallIds(body, response.headers);
    if (callIds.length > 0) {
      this.latestCallIdValue = callIds[0];
      this.latestCallIdExpiresAt = Date.now() + NATIVE_LIVE_ACCOUNT_BINDING_TTL_MS;
    }
    if (!credential) {
      this.prune();
      return;
    }
    const binding = {
      credential,
      expiresAt: Date.now() + NATIVE_LIVE_ACCOUNT_BINDING_TTL_MS,
    };
    this.latest = binding;
    for (const callId of callIds) {
      this.bindings.delete(callId);
      this.bindings.set(callId, binding);
    }
    this.prune();
  }

  public forCall(callId: string): OfficialAccountCredential | null {
    this.prune();
    const binding = this.bindings.get(callId);
    if (!binding) return null;
    binding.expiresAt = Date.now() + NATIVE_LIVE_ACCOUNT_BINDING_TTL_MS;
    this.bindings.delete(callId);
    this.bindings.set(callId, binding);
    return binding.credential;
  }

  public latestCredential(): OfficialAccountCredential | null {
    this.prune();
    if (!this.latest) return null;
    this.latest.expiresAt = Date.now() + NATIVE_LIVE_ACCOUNT_BINDING_TTL_MS;
    return this.latest.credential;
  }

  public latestCallId(): string {
    this.prune();
    return this.latestCallIdValue;
  }

  private prune(): void {
    const now = Date.now();
    for (const [callId, binding] of this.bindings) {
      if (binding.expiresAt <= now) this.bindings.delete(callId);
    }
    if (this.latest && this.latest.expiresAt <= now) this.latest = null;
    if (this.latestCallIdExpiresAt <= now) {
      this.latestCallIdValue = "";
      this.latestCallIdExpiresAt = 0;
    }
    while (this.bindings.size > MAX_NATIVE_LIVE_ACCOUNT_BINDINGS) {
      const oldest = this.bindings.keys().next().value;
      if (oldest === undefined) break;
      this.bindings.delete(oldest);
    }
  }
}

function turnMetadataFromHeaders(headers: HeaderBag): JsonRecord {
  const raw = headerValue(headers, "x-codex-turn-metadata");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function nativeLiveOrigin(body: unknown, headers: HeaderBag): string {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  const metadata = value.client_metadata && typeof value.client_metadata === "object"
    ? value.client_metadata as JsonRecord
    : {};
  const headerMetadata = turnMetadataFromHeaders(headers);
  return cleanString(
    value.subagent_origin
      || value.subagent_source
      || metadata.subagent_origin
      || metadata.subagent_source
      || headerMetadata.subagent_origin
      || headerMetadata.subagent_source
      || headerValue(headers, "x-codex-subagent-source"),
  ).toLowerCase();
}

function isLiveOrigin(origin: string): boolean {
  return origin === "gpt-live"
    || origin === "gpt_live"
    || origin === "realtime"
    || origin === "realtime_voice";
}

function nativeSubagentParentIdentityValues(body: unknown, headers: HeaderBag): Set<string> {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  const bodyMetadata = value.client_metadata && typeof value.client_metadata === "object"
    ? value.client_metadata as JsonRecord
    : {};
  const headerMetadata = turnMetadataFromHeaders(headers);
  return new Set([
    headerValue(headers, "x-codex-parent-thread-id"),
    headerMetadata.parent_thread_id,
    headerMetadata.parent_task_id,
    bodyMetadata.parent_thread_id,
    bodyMetadata.parent_task_id,
    value.parent_thread_id,
    value.parent_task_id,
  ].map(cleanString).filter(Boolean));
}

function nativeSubagentIdentityValues(body: unknown, headers: HeaderBag, additionalId = ""): string[] {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  const bodyMetadata = value.client_metadata && typeof value.client_metadata === "object"
    ? value.client_metadata as JsonRecord
    : {};
  const headerMetadata = turnMetadataFromHeaders(headers);
  const candidates = [
    headerMetadata.child_thread_id,
    headerMetadata.subagent_thread_id,
    headerMetadata.thread_id,
    headerMetadata.session_id,
    headerMetadata.conversation_id,
    bodyMetadata.child_thread_id,
    bodyMetadata.subagent_thread_id,
    bodyMetadata.thread_id,
    bodyMetadata.session_id,
    bodyMetadata.conversation_id,
    value.child_thread_id,
    value.subagent_thread_id,
    value.thread_id,
    value.session_id,
    value.conversation_id,
    value.task_id,
    headerValue(headers, "thread-id"),
    headerValue(headers, "session-id"),
  ].map(cleanString).filter(Boolean);
  const parentIdentities = nativeSubagentParentIdentityValues(body, headers);
  return Array.from(new Set(candidates)).filter((identity) => !parentIdentities.has(identity));
}

function nativeSubagentThreadIdentityValues(body: unknown, headers: HeaderBag, additionalId = ""): string[] {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  const bodyMetadata = value.client_metadata && typeof value.client_metadata === "object"
    ? value.client_metadata as JsonRecord
    : {};
  const headerMetadata = turnMetadataFromHeaders(headers);
  const candidates = [
    headerMetadata.child_thread_id,
    headerMetadata.subagent_thread_id,
    headerMetadata.thread_id,
    bodyMetadata.child_thread_id,
    bodyMetadata.subagent_thread_id,
    bodyMetadata.thread_id,
    value.child_thread_id,
    value.subagent_thread_id,
    value.thread_id,
    headerValue(headers, "thread-id"),
    additionalId,
  ].map(cleanString).filter(Boolean);
  const parentIdentities = nativeSubagentParentIdentityValues(body, headers);
  return Array.from(new Set(candidates)).filter((identity) => !parentIdentities.has(identity));
}

function rememberNativeSubagentDisplaySettings(
  displaySettings: Map<string, NativeSubagentDisplaySettings>,
  body: unknown,
  headers: HeaderBag,
  responseHeaders: Headers,
): NativeSubagentDisplayUpdate | null {
  const model = cleanString(responseHeaders.get("x-opencodex-subagent-model"));
  const effort = cleanString(responseHeaders.get("x-opencodex-subagent-reasoning-effort"));
  const taskId = cleanString(responseHeaders.get("x-opencodex-subagent-task-id"));
  const responseThreadId = cleanString(responseHeaders.get("x-opencodex-subagent-thread-id"));
  if (!model && !effort) return null;
  const parentIdentities = nativeSubagentParentIdentityValues(body, headers);
  const explicitThreadId = responseThreadId && !parentIdentities.has(responseThreadId)
    ? responseThreadId
    : "";
  const identities = Array.from(new Set([
    explicitThreadId,
    ...nativeSubagentIdentityValues(body, headers, taskId),
  ].filter(Boolean))).filter((identity) => !parentIdentities.has(identity));
  if (!identities.length) return null;
  for (const identity of identities) {
    const next = { ...(displaySettings.get(identity) || {}) };
    if (model) next.model = model;
    if (effort) next.effort = effort;
    // Refresh insertion order so active child threads survive the bounded map.
    displaySettings.delete(identity);
    displaySettings.set(identity, next);
  }
  while (displaySettings.size > 2048) {
    const oldest = displaySettings.keys().next().value;
    if (oldest === undefined) break;
    displaySettings.delete(oldest);
  }
  // Only a child/thread-specific identity is safe for an actual native
  // settings update. A session id can belong to the parent conversation and
  // must remain a display-only alias unless the request also carries the
  // explicit child thread id.
  const threadId = explicitThreadId || nativeSubagentThreadIdentityValues(body, headers, taskId)[0];
  if (!threadId) return null;
  return {
    threadId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Native Codex marks an internally-created child at the HTTP boundary. The
 * bridge must use this request metadata as the routing boundary; the parent
 * process and its global provider remain native OpenAI.
 */
export function isNativeSubagentRequest(body: unknown, headers: HeaderBag = {}): boolean {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  const metadata = value.client_metadata && typeof value.client_metadata === "object"
    ? value.client_metadata as JsonRecord
    : {};
  const headerMetadata = turnMetadataFromHeaders(headers);
  const subagentHeader = headerValue(headers, "x-openai-subagent");
  const subagentOrigin = cleanString(
    value.subagent_origin
      || value.subagent_source
      || metadata.subagent_origin
      || metadata.subagent_source
      || headerMetadata.subagent_origin
      || headerMetadata.subagent_source
      || headerValue(headers, "x-codex-subagent-source"),
  ).toLowerCase();
  // `subagent_origin` describes where a child came from; it is not itself a
  // child marker. Native GPT-Live can carry that source on the parent Live
  // turn, and routing that parent through the provider gateway drops the
  // native realtime/text lifecycle. Require an actual child boundary first.
  const explicitChildMarker = Boolean(
    subagentHeader
    || headerMetadata.thread_source === "subagent"
    || headerMetadata.subagent_kind
    || headerValue(headers, "x-codex-parent-thread-id")
    || metadata["x-openai-subagent"] === true
    || metadata["x-openai-subagent"] === "1"
    || metadata.thread_source === "subagent"
    || value.thread_source === "subagent"
    || value.source?.subagent === true,
  );
  if (explicitChildMarker) return true;

  // Some GPT-Live child revisions expose only the Live origin plus the
  // request-scoped child override/task identity. Preserve that compatible
  // shape, but never let the origin alone move the native parent.
  const liveChildIdentity = Boolean(
    value.model_override
    || metadata.model_override
    || value.subagent_task_id
    || metadata.subagent_task_id
    || metadata.subagentTaskId
    || value.child_thread_id
    || value.subagent_thread_id
    || metadata.child_thread_id
    || metadata.subagent_thread_id,
  );
  return liveChildIdentity && (
    subagentOrigin === "gpt-live"
    || subagentOrigin === "gpt_live"
    || subagentOrigin === "realtime"
    || subagentOrigin === "realtime_voice"
  );
}

export function isNativeLiveParentRequest(body: unknown, headers: HeaderBag = {}): boolean {
  return isLiveOrigin(nativeLiveOrigin(body, headers)) && !isNativeSubagentRequest(body, headers);
}

export function isNativeLiveChildRequest(body: unknown, headers: HeaderBag = {}): boolean {
  return isLiveOrigin(nativeLiveOrigin(body, headers)) && isNativeSubagentRequest(body, headers);
}

function requestModelMetadata(body: unknown): JsonRecord {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  return value.client_metadata && typeof value.client_metadata === "object" && !Array.isArray(value.client_metadata)
    ? value.client_metadata as JsonRecord
    : {};
}

function requestModelSlug(body: unknown, headers: HeaderBag): string {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  const metadata = requestModelMetadata(body);
  const subagentOverride = isNativeSubagentRequest(body, headers)
    ? metadata.model_override
    : undefined;
  return modelSlug(
    metadata.opencodex_model_override
      || subagentOverride
      || value.model
      || value.model_id,
  )
    || headerValue(headers, "x-codex-model")
    || headerValue(headers, "x-model");
}

export function isNativeControlPlaneRequest(body: unknown, headers: HeaderBag = {}): boolean {
  return isNativeControlPlaneModel(requestModelSlug(body, headers));
}

export function nativeEgressRoute(body: unknown, headers: HeaderBag = {}): "native" | "gateway" {
  // GPT-Live's parent conversation never enters the provider gateway. The
  // only gateway boundary is an explicitly marked child thread.
  if (isNativeLiveParentRequest(body, headers)) return "native";
  const selectedModel = requestModelSlug(body, headers);
  if (classifyRuntimeModel(selectedModel) === GATEWAY_PROVIDER) return "gateway";
  if (isNativeControlPlaneRequest(body, headers)) return "native";
  return isNativeSubagentRequest(body, headers) ? "gateway" : "native";
}

/**
 * Turn the bridge's request-scoped provider selection into the body expected
 * by the HTTP gateway. The native app-server keeps its safe transport model;
 * only the local gateway hop receives the third-party model slug.
 */
export function rewriteNativeGatewayRequestBody(body: unknown, headers: HeaderBag = {}): JsonRecord {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  const selectedModel = requestModelSlug(value, headers);
  if (
    nativeEgressRoute(value, headers) === "gateway"
    && classifyRuntimeModel(selectedModel) === GATEWAY_PROVIDER
    && modelSlug(value.model) !== selectedModel
  ) {
    return { ...value, model: selectedModel };
  }
  return value;
}

function configuredGatewayPort(): number {
  const candidates: unknown[] = [process.env.OPENCODEX_GATEWAY_PORT, process.env.OPENCODEX_PORT];
  try {
    const configPath = cleanString(process.env.OPENCODEX_CODEX_CONFIG_PATH)
      || path.join(codexHomeDir(), "config.toml");
    const config = fs.readFileSync(configPath, "utf8");
    for (const match of config.matchAll(/base_url\s*=\s*["']http:\/\/127\.0\.0\.1:(\d+)\/v1["']/g)) {
      candidates.push(match[1]);
    }
  } catch {
    // The fixed default remains the safe local gateway fallback.
  }
  candidates.push("8765");
  for (const candidate of candidates) {
    const port = Number.parseInt(cleanString(candidate), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  }
  return 8765;
}

function providerBridgeAdminToken(): string {
  const configured = cleanString(process.env.OPENCODEX_ADMIN_TOKEN);
  if (configured) return configured;
  const configuredPath = cleanString(process.env.OPENCODEX_ADMIN_TOKEN_PATH);
  const candidates = [
    configuredPath,
    path.join(opencodexDataDir(), "admin_token"),
    path.join(os.homedir(), ".opencodex", "admin_token"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const token = fs.readFileSync(candidate, "utf8").trim();
      if (token) return token;
    } catch {
      // The gateway may be configured without an admin token in a test
      // harness. Event polling remains best-effort in that case.
    }
  }
  return "";
}

/**
 * The native Live socket is owned by the local egress, while third-party Live
 * work is owned by the gateway's Responses handler. Notify the gateway when
 * the socket closes so it can abort only the Live-scoped provider requests.
 */
async function notifyGatewayLiveClosed(callId = ""): Promise<void> {
  const token = providerBridgeAdminToken();
  if (!token) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    await fetch(`http://127.0.0.1:${configuredGatewayPort()}/api/live-session/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        reason: `native Live WebSocket closed${callId ? ` call=${callId}` : ""}`,
        keys: callId ? [callId] : [],
      }),
      signal: controller.signal,
    });
  } catch {
    // The gateway may already be restarting. The native socket close remains
    // authoritative and the next gateway start resets Live state as well.
  } finally {
    clearTimeout(timer);
  }
}

function nativeEgressPath(pathname: string, basePath = "/v1"): string {
  const pathValue = pathname || "/";
  if (basePath !== "/v1") {
    if (pathValue === basePath) return "/";
    if (pathValue.startsWith(`${basePath}/`)) {
      const relativePath = pathValue.slice(basePath.length);
      // A runtime may append the conventional /v1 prefix even when the
      // configured override already ends in /v1. Both spellings target the
      // same local egress endpoint.
      if (relativePath === "/v1") return "/";
      if (relativePath.startsWith("/v1/")) return relativePath.slice(3);
      return relativePath;
    }
    return "";
  }
  if (pathValue === "/v1" || pathValue === "/") return "/";
  return pathValue.startsWith("/v1/") ? pathValue.slice(3) : (pathValue.startsWith("/") ? pathValue : `/${pathValue}`);
}

/**
 * The native Live create call is API-shaped at the local boundary but is not
 * a normal ChatGPT backend path. Keep it in the native official lane and
 * normalize multipart `{sdp, session}` into the ChatGPT backend JSON shape.
 */
export function isNativeLiveCreateCall(pathname: string, basePath = "/v1"): boolean {
  return nativeEgressPath(pathname, basePath) === "/live";
}

function nativeUpstreamTarget(pathname: string, search: string, basePath: string): string {
  const nativeBase = cleanString(process.env.OPENCODEX_NATIVE_UPSTREAM_BASE_URL).replace(/\/$/, "");
  const pathValue = `/backend-api/codex${nativeEgressPath(pathname, basePath)}`;
  return `${nativeBase || "https://chatgpt.com"}${pathValue}${search}`;
}

function gatewayUpstreamTarget(pathname: string, search: string, basePath: string): string {
  const pathValue = nativeEgressPath(pathname, basePath);
  const gatewayPath = pathValue === "/" || pathValue.startsWith("/v1/") ? pathValue : `/v1${pathValue}`;
  return `http://127.0.0.1:${configuredGatewayPort()}${gatewayPath}${search}`;
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const maxBytes = 64 * 1024 * 1024;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        fail(new Error("Native egress request body exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (settled) return;
      settled = true;
      const rawBody = Buffer.concat(chunks);
      const encoding = headerValue(req.headers, "content-encoding");
      resolve(RequestDecompressor.decompressBody(rawBody, encoding));
    });
    req.once("aborted", () => fail(new Error("Native egress request was aborted")));
    req.once("error", (error) => fail(error));
  });
}

function localEgressHeaders(
  req: http.IncomingMessage,
  credential?: OfficialAccountCredential | null,
): Record<string, string> {
  const headers = copyNativeRequestHeaders(req, credential ? {
    nativeAccessToken: credential.token,
    nativeAccountId: credential.upstreamId,
    forceNativeAccessToken: true,
  } : {}, true);
  // The bridge sends the decompressed request bytes. Keep the upstream from
  // trying to decode them a second time and avoid compressed response bodies
  // while streaming back into native Codex.
  headers["accept-encoding"] = "identity";
  return headers;
}

type NativeEgressRequestPreparation = {
  prepareRequest?: (credential: OfficialAccountCredential | null) => {
    body: Buffer;
    headers: Record<string, string>;
  };
  onResponseBody?: (body: Buffer, credential: OfficialAccountCredential | null, response: Response) => void;
  maxAttempts?: number;
  timeoutMs?: number;
};

async function readBufferedResponse(response: Response): Promise<Buffer> {
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return Buffer.alloc(0);
  }
}

function writeBufferedResponse(
  res: http.ServerResponse,
  response: Response,
  body: Buffer,
): void {
  res.writeHead(response.status, copySafeResponseHeaders(response.headers));
  res.end(body);
}

function writeNativeEgressFallback(res: http.ServerResponse): void {
  const body = JSON.stringify({
    error: {
      message: "Responses WebSocket transport is disabled; use HTTP",
      type: "upgrade_required",
    },
  });
  res.writeHead(426, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "Sec-WebSocket-Version": "13",
    "Connection": "close",
  });
  res.end(body);
}

function writeNativeEgressUpgradeFallback(socket: import("node:stream").Duplex): void {
  const body = JSON.stringify({
    error: {
      message: "Responses WebSocket transport is disabled; use HTTP",
      type: "upgrade_required",
    },
  });
  socket.end([
    "HTTP/1.1 426 Upgrade Required",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Sec-WebSocket-Version: 13",
    "Connection: close",
    "",
    body,
  ].join("\r\n"));
}

function isNativeLiveUpgradeEndpoint(endpoint: string): boolean {
  const normalizedEndpoint = normalizeNativeLiveEndpoint(endpoint);
  return normalizedEndpoint === "/live"
    || normalizedEndpoint.startsWith("/live/")
    || normalizedEndpoint === "/realtime";
}

function normalizeNativeLiveEndpoint(endpoint: string): string {
  let normalizedEndpoint = endpoint.replace(/\/+$/, "") || "/";
  while (normalizedEndpoint.startsWith("/v1/")) normalizedEndpoint = normalizedEndpoint.slice(3);
  if (normalizedEndpoint === "/v1") return "/";
  return normalizedEndpoint;
}

function nativeLiveUpgradeCallId(req: http.IncomingMessage, endpoint: string): string {
  const normalizedEndpoint = normalizeNativeLiveEndpoint(endpoint);
  if (normalizedEndpoint.startsWith("/live/")) {
    try {
      return safeNativeLiveCallId(decodeURIComponent(normalizedEndpoint.slice("/live/".length)));
    } catch {
      return "";
    }
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  for (const key of ["call_id", "callId", "session_id", "sessionId", "realtime_session_id", "realtimeSessionId"]) {
    const value = safeNativeLiveCallId(url.searchParams.get(key));
    if (value) return value;
  }
  for (const key of ["x-call-id", "x-session-id", "x-realtime-session-id", "x-codex-call-id"]) {
    const value = safeNativeLiveCallId(headerValue(req.headers, key));
    if (value) return value;
  }
  return "";
}

export function nativeLiveUpgradeRequestUrl(requestUrl: string, endpoint: string, callId = ""): string {
  const url = new URL(requestUrl || "/", "http://127.0.0.1");
  const normalizedEndpoint = normalizeNativeLiveEndpoint(endpoint);
  const hasQueryCallId = ["call_id", "callId"].some((key) => Boolean(url.searchParams.get(key)));
  const upstreamEndpoint = normalizedEndpoint === "/live" && callId && !hasQueryCallId
    ? `/live/${encodeURIComponent(callId)}`
    : normalizedEndpoint;
  if (normalizedEndpoint === "/realtime" && callId && !hasQueryCallId) {
    url.searchParams.set("call_id", callId);
  }
  return `/v1${upstreamEndpoint}${url.search}`;
}

function proxyNativeLiveUpgrade(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  endpoint: string,
  accountRouter: OfficialAccountRouter,
  liveBindings: NativeLiveAccountBindings,
  onLiveClosed?: (callId: string) => void,
): void {
  const requestUrl = req.url || "/";
  const requestCallId = nativeLiveUpgradeCallId(req, endpoint);
  const callId = requestCallId || (isNativeLiveUpgradeEndpoint(endpoint) ? liveBindings.latestCallId() : "");
  const credential = (callId ? liveBindings.forCall(callId) : null)
    || (isNativeLiveUpgradeEndpoint(endpoint) ? liveBindings.latestCredential() : null)
    || accountRouter.credentialForRequest(req);
  const nativeAccessToken = credential?.token || readNativeAccessToken();
  const upstreamRequestUrl = nativeLiveUpgradeRequestUrl(requestUrl, endpoint, callId);
  console.error(`[OpenCodex Native Egress] native-live websocket ${endpoint}${callId ? ` call=${callId}` : ""} -> ${upstreamRequestUrl}${credential ? ` account=${credential.localId}` : ""}`);
  handleWebRtcProxy(req, socket, head, {
    requestUrl: upstreamRequestUrl,
    nativeAccessToken,
    nativeAccountId: credential?.upstreamId || undefined,
    forceNativeAccessToken: Boolean(credential),
    forceNativeSession: true,
    nativeLiveSideband: ["/realtime", "/live"].some((prefix) => {
      const normalizedEndpoint = normalizeNativeLiveEndpoint(endpoint);
      return normalizedEndpoint === prefix || normalizedEndpoint.startsWith(`${prefix}/`);
    }),
    onClose: (reason) => {
      console.error(`[OpenCodex Native Egress] native-live websocket closed${callId ? ` call=${callId}` : ""}: ${reason}`);
      onLiveClosed?.(callId);
    },
  });
}

async function proxyNativeEgressRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer,
  operation: string,
  transport: "undici" | "node_https" = "undici",
  onResponseHeaders?: (headers: Headers) => void,
  accountRouter?: OfficialAccountRouter,
  requestPreparation?: NativeEgressRequestPreparation,
): Promise<void> {
  const responseAbort = bindResponseAbort(res);
  const requestController = new AbortController();
  const onRequestAbort = (): void => {
    requestController.abort(new DOMException("Native egress request was aborted", "AbortError"));
  };
  if (req.aborted) onRequestAbort();
  else {
    req.once("aborted", onRequestAbort);
    req.once("error", onRequestAbort);
  }
  const unlinkResponseAbort = linkAbortSignal(responseAbort.signal, requestController);
  try {
    let credential = accountRouter?.credentialForRequest(req) || null;
    while (true) {
      const prepared = requestPreparation?.prepareRequest
        ? requestPreparation.prepareRequest(credential)
        : { headers: localEgressHeaders(req, credential), body };
      const upstreamRes = await fetchUpstream(targetUrl, {
        method: req.method || "POST",
        headers: prepared.headers,
        body: prepared.body as any,
        // Retry only pre-response connection failures. fetchUpstream returns as
        // soon as headers arrive, so streaming responses are never replayed.
        maxAttempts: requestPreparation?.maxAttempts ?? 3,
        timeoutMs: requestPreparation?.timeoutMs ?? 600_000,
        operation,
        transport,
        signal: requestController.signal,
      });

      // Only official error responses are inspected here. A successful stream
      // is passed through immediately; once output starts it is not replayed.
      if (accountRouter && credential && upstreamRes.status >= 400) {
        const errorBody = await readBufferedResponse(upstreamRes);
        if (requestController.signal.aborted) return;
        const errorValue = {
          status: upstreamRes.status,
          body: errorBody.toString("utf8"),
        };
        if (isOfficialAuthFailure(errorValue)) {
          accountRouter.markAuthFailure(credential.localId, errorValue);
        }
        if (isOfficialQuotaFailure(errorValue)) {
          const next = await accountRouter.failover(credential.localId, errorValue);
          if (next) {
            credential = next;
            continue;
          }
        }
        writeBufferedResponse(res, upstreamRes, errorBody);
        return;
      }

      onResponseHeaders?.(upstreamRes.headers);
      if (requestPreparation?.onResponseBody) {
        // Native Live's signaling response is a small SDP/session envelope.
        // Buffer only this explicitly opted-in response so the call id can be
        // bound to the same official account before its sideband WebSocket.
        const responseBody = await readBufferedResponse(upstreamRes);
        requestPreparation.onResponseBody(responseBody, credential, upstreamRes);
        writeBufferedResponse(res, upstreamRes, responseBody);
        return;
      }
      res.writeHead(upstreamRes.status, copySafeResponseHeaders(upstreamRes.headers));
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        try {
          while (true) {
            const result = await readWithAbortAndTimeout(
              () => reader.read(),
              requestController.signal,
              EGRESS_STREAM_IDLE_TIMEOUT_MS,
              "Native Egress response stream was idle for too long",
              () => { void reader.cancel(); },
            );
            if (result.done) break;
            await writeHttpResponseChunked(res, result.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
      return;
    }
  } catch (error: any) {
    const details = upstreamErrorDetails(error);
    console.error(`[OpenCodex Native Egress] ${operation} failed:`, {
      ...details,
      attempts: error?.attempts,
    });
    if (requestController.signal.aborted) {
      if (!res.writableEnded && !res.destroyed) res.end();
    } else if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: error?.message || "native egress request failed",
        type: "upstream_unreachable",
        retryable: Boolean(error?.retryable),
        attempts: error?.attempts,
        cause_code: details.code,
      }));
    }
  } finally {
    unlinkResponseAbort();
    responseAbort.cleanup();
    req.off("aborted", onRequestAbort);
    req.off("error", onRequestAbort);
  }
}

async function handleNativeEgressRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  basePath: string,
  accountRouter: OfficialAccountRouter,
  liveBindings: NativeLiveAccountBindings,
  subagentDisplaySettings: Map<string, NativeSubagentDisplaySettings>,
  onSubagentDisplaySettings?: (update: NativeSubagentDisplayUpdate) => void,
  resolveModelForRequest?: (body: JsonRecord, headers: HeaderBag) => string,
): Promise<void> {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const endpoint = nativeEgressPath(requestUrl.pathname, basePath);
  if (!endpoint) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "native egress route not found" }));
    return;
  }
  const websocketRequest = req.method === "GET"
    || req.headers.upgrade?.toLowerCase() === "websocket"
    || (req.headers.connection || "").toLowerCase().includes("upgrade");
  if (websocketRequest) {
    writeNativeEgressFallback(res);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
    res.end(JSON.stringify({ error: "native egress only accepts POST requests" }));
    return;
  }
  const body = await readRequestBody(req);
  let parsedBody: JsonRecord = {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) parsedBody = value as JsonRecord;
  } catch {
    // The native endpoint will return the authoritative malformed-body error.
  }
  const nativeLiveCall = isNativeLiveCreateCall(requestUrl.pathname, basePath);
  // The native app-server generates its own x-codex-turn-metadata header and
  // drops bridge-only client_metadata fields. Recover the selected provider
  // from the durable thread route before deciding where /responses goes.
  const explicitModel = requestModelSlug(parsedBody, req.headers);
  const resolvedModel = endpoint === "/responses"
    ? cleanString(resolveModelForRequest?.(parsedBody, req.headers))
    : "";
  const selectedModel = resolvedModel && classifyRuntimeModel(resolvedModel) === GATEWAY_PROVIDER
    ? resolvedModel
    : explicitModel;
  const route = nativeLiveCall
    ? "native"
    : classifyRuntimeModel(selectedModel) === GATEWAY_PROVIDER
      ? "gateway"
      : nativeEgressRoute(parsedBody, req.headers);
  const routedBody = route === "gateway" && selectedModel && modelSlug(parsedBody.model) !== selectedModel
    ? { ...parsedBody, model: selectedModel }
    : parsedBody;
  const rewrittenGatewayBody = rewriteNativeGatewayRequestBody(routedBody, req.headers);
  const gatewayBody = route === "gateway" && !nativeLiveCall
    && rewrittenGatewayBody !== parsedBody
    ? Buffer.from(JSON.stringify(rewrittenGatewayBody), "utf8")
    : body;
  const targetUrl = nativeLiveCall
    ? nativeLiveCallTarget(requestUrl.search)
    : route === "gateway"
    ? gatewayUpstreamTarget(requestUrl.pathname, requestUrl.search, basePath)
    : nativeUpstreamTarget(requestUrl.pathname, requestUrl.search, basePath);
  console.error(`[OpenCodex Native Egress] ${nativeLiveCall ? "native-live" : route} ${endpoint}`);
  // Third-party requests normally preserve the desktop bearer because the
  // gateway itself authenticates locally. The gateway's image sidecar is the
  // exception: when a provider rejects an image, it must use the official
  // subscription selected by the account pool, not the desktop's login
  // account. Bind that credential only on the local gateway hop; the gateway
  // still uses the provider API key for the actual third-party request.
  const gatewayCredential = route === "gateway" && !nativeLiveCall
    ? accountRouter.credentialForRequest(req)
    : null;
  const liveCallId = route === "gateway" && !nativeLiveCall && isNativeLiveChildRequest(parsedBody, req.headers)
    ? liveBindings.latestCallId()
    : "";
  const gatewayRequestPreparation = route === "gateway" && !nativeLiveCall
    ? {
      prepareRequest: () => {
        const headers = localEgressHeaders(req, gatewayCredential);
        if (liveCallId) headers["x-opencodex-live-call-id"] = liveCallId;
        return { headers, body: gatewayBody };
      },
    }
    : undefined;
  await proxyNativeEgressRequest(
    req,
    res,
    targetUrl,
    body,
    `native-${nativeLiveCall ? "live" : route}-${endpoint.replace(/^\//, "") || "root"}`,
    // Account takeover is an HTTP-header concern; keep the original upstream
    // transport so enabling the pool cannot change native connection behavior.
    "undici",
    route === "gateway" && !nativeLiveCall ? (responseHeaders) => {
      const update = rememberNativeSubagentDisplaySettings(subagentDisplaySettings, parsedBody, req.headers, responseHeaders);
      if (update) onSubagentDisplaySettings?.(update);
    } : undefined,
    route === "native" || nativeLiveCall ? accountRouter : undefined,
    nativeLiveCall ? {
      // Creating a Live session is not safely replayable after the upstream
      // receives the request. The native backend also expects JSON rather than
      // the multipart shape used at the local `/v1/live` boundary.
      maxAttempts: 1,
      timeoutMs: 120_000,
      prepareRequest: (credential) => {
        const headers = localEgressHeaders(req, credential);
        const normalizedBody = normalizeNativeLiveCallBody(body, headers["content-type"] || "");
        headers["content-type"] = "application/json";
        headers["openai-alpha"] = "quicksilver=v2";
        return { headers, body: normalizedBody };
      },
      onResponseBody: (responseBody, credential, response) => {
        if (response.status < 400) liveBindings.remember(responseBody, response, credential);
      },
    } : gatewayRequestPreparation,
  );
}

type NativeEgressRouter = {
  server: http.Server;
  port: number;
  basePath: string;
  liveBindings: NativeLiveAccountBindings;
  subagentDisplaySettings: Map<string, NativeSubagentDisplaySettings>;
};

type CliEgressRouter = {
  server: http.Server;
  port: number;
  basePath: string;
  liveBindings: NativeLiveAccountBindings;
};

async function startNativeEgressRouter(
  accountRouter: OfficialAccountRouter,
  onSubagentDisplaySettings?: (update: NativeSubagentDisplayUpdate) => void,
  onLiveClosed?: (callId: string) => void,
  resolveModelForRequest?: (body: JsonRecord, headers: HeaderBag) => string,
): Promise<NativeEgressRouter> {
  const basePath = `/__opencodex_native_egress_${randomBytes(16).toString("hex")}/v1`;
  const liveBindings = new NativeLiveAccountBindings();
  const subagentDisplaySettings = new Map<string, NativeSubagentDisplaySettings>();
  const server = http.createServer((req, res) => {
    void handleNativeEgressRequest(req, res, basePath, accountRouter, liveBindings, subagentDisplaySettings, onSubagentDisplaySettings, resolveModelForRequest).catch((error) => {
      console.error(`[OpenCodex Native Egress] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const endpoint = nativeEgressPath(requestUrl.pathname, basePath);
    if (isNativeLiveUpgradeEndpoint(endpoint)) {
      proxyNativeLiveUpgrade(req, socket, head, endpoint, accountRouter, liveBindings, onLiveClosed);
    } else if (endpoint) {
      writeNativeEgressUpgradeFallback(socket);
    }
    else socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("native egress bridge did not receive a local port");
  }
  const port = address.port;
  console.error(`[OpenCodex Native Egress] listening on 127.0.0.1:${port}; gateway target port ${configuredGatewayPort()}`);
  return { server, port, basePath, liveBindings, subagentDisplaySettings };
}

/**
 * Route a standalone CLI request without changing the native CLI's provider
 * configuration. The CLI sends every request to this short-lived local HTTP
 * bridge; official models leave through the native ChatGPT backend, while
 * provider-owned models enter the OpenCodex gateway.
 */
export function cliEgressRoute(body: unknown, headers: HeaderBag = {}): "native" | "gateway" {
  // Keep standalone CLI and Desktop app-server on one request boundary. In
  // particular, a native GPT child whose selected model lives in
  // `client_metadata.model_override` (including GPT-Live children) must enter
  // the gateway, while native control-plane children remain native.
  return nativeEgressRoute(body, headers);
}

function cliEgressHeaders(
  req: http.IncomingMessage,
  credential?: OfficialAccountCredential | null,
): Record<string, string> {
  const headers = copyNativeRequestHeaders(req, credential ? {
    nativeAccessToken: credential.token,
    nativeAccountId: credential.upstreamId,
    forceNativeAccessToken: true,
  } : {}, true);
  headers["accept-encoding"] = "identity";
  return headers;
}

async function proxyCliEgressRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer,
  operation: string,
  transport: "undici" | "node_https" = "undici",
  accountRouter?: OfficialAccountRouter,
): Promise<void> {
  const responseAbort = bindResponseAbort(res);
  const requestController = new AbortController();
  const onRequestAbort = (): void => {
    requestController.abort(new DOMException("CLI egress request was aborted", "AbortError"));
  };
  if (req.aborted) onRequestAbort();
  else {
    req.once("aborted", onRequestAbort);
    req.once("error", onRequestAbort);
  }
  const unlinkResponseAbort = linkAbortSignal(responseAbort.signal, requestController);
  try {
    const method = req.method || "GET";
    let credential = accountRouter?.credentialForRequest(req) || null;
    while (true) {
      const upstreamRes = await fetchUpstream(targetUrl, {
        method,
        headers: cliEgressHeaders(req, credential),
        body: method === "GET" || method === "HEAD" ? undefined : body as any,
        // Official CLI requests use the same direct ChatGPT upstream as the
        // native desktop path; tolerate transient TLS/socket resets there too.
        maxAttempts: 3,
        timeoutMs: 600_000,
        operation,
        transport,
        signal: requestController.signal,
      });
      if (requestController.signal.aborted) return;
      if (accountRouter && credential && upstreamRes.status >= 400) {
        const errorBody = await readBufferedResponse(upstreamRes);
        if (requestController.signal.aborted) return;
        const errorValue = {
          status: upstreamRes.status,
          body: errorBody.toString("utf8"),
        };
        if (isOfficialAuthFailure(errorValue)) {
          accountRouter.markAuthFailure(credential.localId, errorValue);
        }
        if (isOfficialQuotaFailure(errorValue)) {
          const next = await accountRouter.failover(credential.localId, errorValue);
          if (next) {
            credential = next;
            continue;
          }
        }
        writeBufferedResponse(res, upstreamRes, errorBody);
        return;
      }

      res.writeHead(upstreamRes.status, copySafeResponseHeaders(upstreamRes.headers));
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        try {
          while (true) {
            const result = await readWithAbortAndTimeout(
              () => reader.read(),
              requestController.signal,
              EGRESS_STREAM_IDLE_TIMEOUT_MS,
              "CLI Egress response stream was idle for too long",
              () => { void reader.cancel(); },
            );
            if (result.done) break;
            await writeHttpResponseChunked(res, result.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
      return;
    }
  } catch (error: any) {
    const details = upstreamErrorDetails(error);
    console.error(`[OpenCodex CLI Egress] ${operation} failed:`, {
      ...details,
      attempts: error?.attempts,
    });
    if (requestController.signal.aborted) {
      if (!res.writableEnded && !res.destroyed) res.end();
    } else if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: error?.message || "CLI egress request failed",
        type: "upstream_unreachable",
        retryable: Boolean(error?.retryable),
        attempts: error?.attempts,
        cause_code: details.code,
      }));
    }
  } finally {
    unlinkResponseAbort();
    responseAbort.cleanup();
    req.off("aborted", onRequestAbort);
    req.off("error", onRequestAbort);
  }
}

async function handleCliEgressRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  basePath: string,
  accountRouter: OfficialAccountRouter,
  liveBindings: NativeLiveAccountBindings,
): Promise<void> {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const endpoint = nativeEgressPath(requestUrl.pathname, basePath);
  if (!endpoint) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "CLI egress route not found" }));
    return;
  }
  const websocketRequest = req.headers.upgrade?.toLowerCase() === "websocket"
    || (req.headers.connection || "").toLowerCase().includes("upgrade");
  if (websocketRequest) {
    writeNativeEgressFallback(res);
    return;
  }

  const body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readRequestBody(req);
  let parsedBody: JsonRecord = {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) parsedBody = value as JsonRecord;
  } catch {
    // Let the selected upstream return the authoritative malformed-body error.
  }
  const nativeLiveCall = isNativeLiveCreateCall(requestUrl.pathname, basePath);
  const route = nativeLiveCall ? "native" : cliEgressRoute(parsedBody, req.headers);
  const rewrittenGatewayBody = rewriteNativeGatewayRequestBody(parsedBody, req.headers);
  const gatewayBody = route === "gateway" && !nativeLiveCall
    && rewrittenGatewayBody !== parsedBody
    ? Buffer.from(JSON.stringify(rewrittenGatewayBody), "utf8")
    : body;
  const targetUrl = nativeLiveCall
    ? nativeLiveCallTarget(requestUrl.search)
    : route === "gateway"
    ? gatewayUpstreamTarget(requestUrl.pathname, requestUrl.search, basePath)
    : nativeUpstreamTarget(requestUrl.pathname, requestUrl.search, basePath);
  console.error(`[OpenCodex CLI Egress] ${nativeLiveCall ? "native-live" : route} ${endpoint} model=${modelSlug(parsedBody.model) || "(default)"}`);
  if (nativeLiveCall) {
    await proxyNativeEgressRequest(
      req,
      res,
      targetUrl,
      body,
      "cli-native-live",
      "node_https",
      undefined,
      accountRouter,
      {
        maxAttempts: 1,
        timeoutMs: 120_000,
        prepareRequest: (credential) => {
          const headers = localEgressHeaders(req, credential);
          const normalizedBody = normalizeNativeLiveCallBody(body, headers["content-type"] || "");
          headers["content-type"] = "application/json";
          headers["openai-alpha"] = "quicksilver=v2";
          return { headers, body: normalizedBody };
        },
        onResponseBody: (responseBody, credential, response) => {
          if (response.status < 400) liveBindings.remember(responseBody, response, credential);
        },
      },
    );
    return;
  }
  await proxyCliEgressRequest(
    req,
    res,
    targetUrl,
    gatewayBody,
    `cli-${route}-${endpoint.replace(/^\//, "") || "root"}`,
    // The CLI account router also changes only the credential, not transport.
    "undici",
    route === "native" ? accountRouter : undefined,
  );
}

async function startCliEgressRouter(
  accountRouter: OfficialAccountRouter,
  onLiveClosed?: (callId: string) => void,
): Promise<CliEgressRouter> {
  const basePath = "/v1";
  const liveBindings = new NativeLiveAccountBindings();
  const server = http.createServer((req, res) => {
    void handleCliEgressRequest(req, res, basePath, accountRouter, liveBindings).catch((error) => {
      console.error(`[OpenCodex CLI Egress] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const endpoint = nativeEgressPath(requestUrl.pathname, basePath);
    if (isNativeLiveUpgradeEndpoint(endpoint)) {
      proxyNativeLiveUpgrade(req, socket, head, endpoint, accountRouter, liveBindings, onLiveClosed);
    } else {
      writeNativeEgressUpgradeFallback(socket);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("CLI egress bridge did not receive a local port");
  }
  const port = address.port;
  console.error(`[OpenCodex CLI Egress] listening on 127.0.0.1:${port}; gateway target port ${configuredGatewayPort()}`);
  return { server, port, basePath, liveBindings };
}

export function nativeRuntimeArgs(args: string[], egressPort: number, egressBasePath = "/v1"): string[] {
  const nativeEgressBaseUrl = `http://127.0.0.1:${egressPort}${egressBasePath}`;
  // Codex derives the native V3 WebSocket path from the realtime base. Keep
  // the `/realtime` semantic suffix here; the runtime normalizes it to the
  // `/live/<call_id>` sideband path before the local egress handles Upgrade.
  const nativeRealtimeWebSocketBaseUrl = `ws://127.0.0.1:${egressPort}${egressBasePath}/realtime`;
  const overrides = [
    // Force the native child onto an OpenAI-compatible provider so even the
    // Desktop app-server's ChatGPT-account path crosses this local Egress.
    // Egress still decides per request whether the model is official (native
    // account) or provider-owned (CodexSplit gateway).
    "-c", `model_provider=${NATIVE_EGRESS_PROVIDER}`,
    "-c", `model_providers.${NATIVE_EGRESS_PROVIDER}.base_url=${nativeEgressBaseUrl}`,
    "-c", `model_providers.${NATIVE_EGRESS_PROVIDER}.wire_api=responses`,
    "-c", `model_providers.${NATIVE_EGRESS_PROVIDER}.requires_openai_auth=false`,
    // Keep the legacy OpenAI base override too for child revisions that read
    // it before resolving the configured provider.
    "-c", `openai_base_url=${nativeEgressBaseUrl}`,
    // Live also crosses this Egress as a transparent native transport. The
    // HTTP call creation and WebSocket sideband have separate settings; the
    // latter must use ws:// so the runtime performs a real Upgrade instead of
    // issuing a plain HTTP request that receives the local 426 fallback.
    "-c", `experimental_realtime_webrtc_call_base_url=${nativeEgressBaseUrl}`,
    "-c", `experimental_realtime_ws_base_url=${nativeRealtimeWebSocketBaseUrl}`,
    // Responses WebSockets remain disabled because task metadata is routed on
    // the HTTP request. This does not disable the separate native Live channel.
    "-c", "features.responses_websockets=false",
    "-c", "features.responses_websockets_v2=false",
  ];
  const appServerIndex = args.indexOf("app-server");
  if (appServerIndex < 0) return [...overrides, ...args];
  return [
    ...args.slice(0, appServerIndex),
    ...overrides,
    ...args.slice(appServerIndex),
  ];
}

function requestIdKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function threadIdFrom(value: unknown): string {
  return cleanString(value);
}

function writeParent(value: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function responseError(id: unknown, message: string, code = -32001): JsonRecord {
  return { id, error: { code, message } };
}

function requestWithParams(message: JsonRecord, params: JsonRecord): JsonRecord {
  return { ...message, params };
}

function stripRequestProvider(params: JsonRecord): JsonRecord {
  const next = { ...params };
  delete next.modelProvider;
  return next;
}

function rewriteNativeTransportModel(
  params: JsonRecord,
  model: string,
  stripDesktopTransportMetadata = false,
): JsonRecord {
  const next = { ...params };
  // Desktop includes a full config snapshot on some control-plane requests.
  // It is not a request-scoped setting and can overwrite the child process's
  // dynamic Egress provider/base URL, so the worker must use its own process
  // config for every transport model.
  delete next.config;
  if (stripDesktopTransportMetadata) {
    // Desktop's collaboration/Responses metadata selects its in-process
    // ChatGPT transport. Passing it to the native child can bypass the local
    // Egress or validate the picker model against the ChatGPT account. Send
    // the selected provider model as the actual transport model instead; keep
    // client_metadata as a route hint for runtimes that normalize the model.
    for (const key of [
      "collaborationMode",
      "collaboration_mode",
      "responsesapiClientMetadata",
      "responsesApiClientMetadata",
      "responses_api_client_metadata",
    ]) delete next[key];
    return next;
  }
  // Keep native-only model metadata aligned for official turns. Provider
  // turns take the early return above so their picker metadata cannot select
  // the official ChatGPT transport.
  for (const key of ["collaborationMode", "collaboration_mode"]) {
    const collaboration = next[key];
    if (!collaboration || typeof collaboration !== "object" || Array.isArray(collaboration)) continue;
    const settings = (collaboration as JsonRecord).settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
    next[key] = {
      ...(collaboration as JsonRecord),
      settings: {
        ...(settings as JsonRecord),
        model,
      },
    };
  }
  return next;
}

export function normalizeThreadListParams(params: JsonRecord = {}): JsonRecord {
  const nextParams = { ...params };
  nextParams.modelProviders = [];
  return nextParams;
}

function nativeCodexPath(): string {
  return cleanString(process.env.OPENCODEX_NATIVE_CODEX_PATH)
    || "/Applications/ChatGPT.app/Contents/Resources/codex";
}

function nativeCliPath(): string {
  const candidates = [
    cleanString(process.env.OPENCODEX_NATIVE_CLI_PATH),
    cleanString(process.env.OPENCODEX_NATIVE_CODEX_PATH),
    path.join(os.homedir(), ".codex", "packages", "standalone", "current", "bin", "codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).mode & 0o111) || nativeCodexPath();
}

function isAppServerInvocation(args: string[]): boolean {
  const index = args.indexOf("app-server");
  return index >= 0 && args[index + 1] !== "daemon";
}

function passthroughNative(args: string[]): void {
  const native = spawn(nativeCodexPath(), args, {
    env: { ...process.env, CODEX_CLI_PATH: undefined },
    stdio: "inherit",
  });
  native.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

async function runCliProviderBridge(args: string[]): Promise<void> {
  const accountPool = new ChatGptAccountPool();
  // Usage refresh belongs to the dashboard/control plane. The request Egress
  // must not start an unrelated official-network worker during every native
  // app-server launch; account-pool selection can use the last cached view.
  const accountRouter = new OfficialAccountRouter(accountPool);
  const cliEgress = await startCliEgressRouter(accountRouter, (callId) => {
    void notifyGatewayLiveClosed(callId);
  });
  const configuredAccounts = accountPool.listAccounts();
  if (configuredAccounts.length > 0) console.error("[OpenCodex CLI Egress] official account pool is managed at the HTTP egress");
  const nativeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_CLI_PATH: undefined,
    OPENCODEX_PROVIDER_BRIDGE_PATH: undefined,
    OPENCODEX_PROVIDER_SPLIT: undefined,
    OPENCODEX_PROVIDER_BRIDGE_RUNTIME: undefined,
  };
  const native = spawn(nativeCliPath(), nativeRuntimeArgs(args, cliEgress.port, cliEgress.basePath), {
    env: nativeEnv,
    stdio: "inherit",
  });

  let finished = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!native.killed) native.kill(signal);
  };
  const closeEgress = async (): Promise<void> => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    try {
      cliEgress.server.closeAllConnections?.();
      await new Promise<void>((resolve) => cliEgress.server.close(() => resolve()));
    } catch {
      // The child process result remains authoritative when cleanup races exit.
    }
  };
  const finish = async (code: number | null, signal: NodeJS.Signals | null, error?: Error): Promise<void> => {
    if (finished) return;
    finished = true;
    if (error) console.error(`[OpenCodex CLI Egress] native CLI failed: ${error.message}`);
    await closeEgress();
    process.exitCode = signal ? 1 : (code ?? 1);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  native.once("error", (error) => {
    void finish(1, null, error);
  });
  native.once("exit", (code, signal) => {
    void finish(code, signal);
  });
}


async function runProviderBridge(): Promise<void> {
  const args = process.argv.slice(2);
  if (!isAppServerInvocation(args)) {
    passthroughNative(args);
    return;
  }

  // Standalone CLI invocations stay on the thin request-scoped Egress. Desktop
  // is launched with the JSON-RPC supervisor because its app-server can replace
  // the startup HTTP transport from thread config and drop bridge-only metadata
  // before the request reaches Egress.
  if (process.env.OPENCODEX_LEGACY_PROVIDER_BRIDGE !== "1") {
    await runCliProviderBridge(args);
    return;
  }

  const accountPool = new ChatGptAccountPool();
  accountPool.refreshUsageInBackground();
  const accountRouter = new OfficialAccountRouter(accountPool);
  let applyNativeSubagentDisplaySettings: ((update: NativeSubagentDisplayUpdate) => void) | null = null;
  const nativeEgress = await startNativeEgressRouter(accountRouter, (update) => {
    const modelProvider = update.model
      ? (classifyRuntimeModel(update.model) || (update.model.includes("/") ? GATEWAY_PROVIDER : NATIVE_PROVIDER))
      : GATEWAY_PROVIDER;
    writeParent({
      method: "thread/settings/updated",
      params: {
        threadId: update.threadId,
        threadSettings: {
          ...(update.model ? { model: update.model } : {}),
          modelProvider,
          ...(update.effort ? { effort: update.effort } : {}),
        },
      },
    });
    applyNativeSubagentDisplaySettings?.(update);
  }, (callId) => {
    void notifyGatewayLiveClosed(callId);
  }, (body, headers) => {
    const explicitModel = requestModelSlug(body, headers);
    if (classifyRuntimeModel(explicitModel) === GATEWAY_PROVIDER) return explicitModel;
    // Native Codex replaces bridge-only metadata with x-codex-turn-metadata.
    // Use its durable session/thread identity to recover the provider route.
    for (const identity of nativeSubagentIdentityValues(body, headers)) {
      const route = routeForThreadId(identity);
      if (route && providerForModel(route.selectedModel) === GATEWAY_PROVIDER) {
        return route.selectedModel;
      }
    }
    return "";
  });
  const nativeSubagentDisplaySettings = nativeEgress.subagentDisplaySettings;

  const runtimeByProvider = new Map<CodexProvider, ProviderRuntime>();
  const runtimes = new Set<ProviderRuntime>();
  const pendingRequests = new Map<string, PendingRequest>();
  const pendingServerRequests = new Map<string, PendingServerRequest>();
  const outputBuffers = new Map<ProviderRuntime, string>();
  const legacyThreads = new Map<string, LegacyThread>();
  const activeTurns = new Map<string, {
    provider: CodexProvider;
    physicalThreadId: string;
    outputStarted: boolean;
    parentTurnId?: string;
    interruptTimer?: ReturnType<typeof setTimeout>;
  }>();
  const subagentEventPollers = new Map<string, SubagentEventPoller>();
  const gatewayPort = configuredGatewayPort();
  const gatewayAdminToken = providerBridgeAdminToken();
  const pendingSelectedModels = new Map<string, string>();
  const failedProviderRoutes = new Set<string>();
  const suppressedNotifications = new Map<string, number>();
  const runtimeRestartTimers = new Map<CodexProvider, ReturnType<typeof setTimeout>>();
  const runtimeRestartAttempts = new Map<CodexProvider, number>();
  const runtimeRecoveryQueues = new Map<CodexProvider, RuntimeRecoveryRequest[]>();
  const routes = loadThreadRoutes();
  const pendingParentInitializations: Array<{ id: unknown }> = [];
  let internalRequestCounter = 0;
  let serverRequestCounter = 0;
  let inputBuffer = "";
  let bridgeStopping = false;
  let lastInitializeResult: JsonRecord | null = null;

  function statePath(): string {
    const configured = cleanString(process.env.OPENCODEX_PROVIDER_SESSION_MAP_PATH);
    if (configured) return configured;
    const dataDir = cleanString(process.env.OPENCODEX_DATA_DIR);
    return path.join(dataDir || opencodexDataDir(), "provider-session-routes.json");
  }

  function loadThreadRoutes(): Map<string, ThreadRoute> {
    const result = new Map<string, ThreadRoute>();
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
      const saved = parsed && typeof parsed === "object" && parsed.threads && typeof parsed.threads === "object"
        ? Object.values(parsed.threads as JsonRecord)
        : [];
      for (const entry of saved) {
        if (!entry || typeof entry !== "object") continue;
        const value = entry as JsonRecord;
        const externalId = cleanString(value.externalId);
        const savedNativeId = cleanString(value.nativeId);
        if (!externalId) continue;
        const nativeId = externalId.startsWith("019") || externalId.startsWith("thread-") ? externalId : (savedNativeId || externalId);
        result.set(externalId, {
          externalId,
          nativeId,
          nativePath: cleanString(value.nativePath) || undefined,
          archived: value.archived === true ? true : undefined,
          retiredNativeIds: Array.isArray(value.retiredNativeIds)
            ? value.retiredNativeIds.map(cleanString).filter(Boolean).slice(-16)
            : undefined,
          selectedModel: cleanString(value.selectedModel) || nativeDefaultModel(),
          threadSource: cleanString(value.threadSource) || undefined,
          threadOrigin: cleanString(value.threadOrigin).toLowerCase() === "gpt-live" ? "gpt-live" : undefined,
          parentThreadId: cleanString(value.parentThreadId) || undefined,
          legacySourceId: cleanString(value.legacySourceId) || undefined,
          legacySourcePath: cleanString(value.legacySourcePath) || undefined,
          legacyModel: cleanString(value.legacyModel) || undefined,
          settings: value.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
            ? cloneValue(value.settings as JsonRecord)
            : undefined,
        });
      }
    } catch {}
    return result;
  }

  function persistRoutes(): void {
    try {
      const file = statePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const threads: JsonRecord = {};
      for (const [externalId, route] of routes) {
        threads[externalId] = {
          externalId: route.externalId,
          nativeId: route.nativeId,
          nativePath: route.nativePath,
          archived: route.archived,
          retiredNativeIds: route.retiredNativeIds,
          selectedModel: route.selectedModel,
          threadSource: route.threadSource,
          threadOrigin: route.threadOrigin,
          parentThreadId: route.parentThreadId,
          legacySourceId: route.legacySourceId,
          legacySourcePath: route.legacySourcePath,
          legacyModel: route.legacyModel,
          settings: route.settings,
        };
      }
      const tempFile = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tempFile, JSON.stringify({ version: 1, threads }, null, 2), { mode: 0o600 });
      fs.renameSync(tempFile, file);
    } catch (error) {
      console.warn("[CodexSplit Provider Bridge] Could not persist session routes: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  function saveRoute(route: ThreadRoute): ThreadRoute {
    const display = nativeDisplaySettingsForRoute(route);
    applyDisplaySettingsToRoute(route, display);
    routes.set(route.externalId, route);
    persistRoutes();
    return route;
  }

  function updateRouteNativePath(route: ThreadRoute, thread: JsonRecord): void {
    const resolvedPath = cleanString(thread.path);
    if (!resolvedPath || resolvedPath === route.nativePath) return;
    // Codex can move a rollout between sessions/ and archived_sessions/ while
    // retaining the same thread id. Keep the bridge route aligned with the
    // path returned by the native app-server before a later resume uses it.
    route.nativePath = resolvedPath;
    saveRoute(route);
  }

  function isArchivedThreadResponse(response: JsonRecord): boolean {
    const error = response.error && typeof response.error === "object"
      ? response.error as JsonRecord
      : {};
    const message = cleanString(error.message).toLowerCase();
    return message.includes("is archived")
      || message.includes("codex unarchive")
      || message.includes("unarchive it first");
  }

  function shouldRepairArchivedRoute(route: ThreadRoute): boolean {
    // Native conversations keep their native archive semantics. Older bridge
    // versions left some provider routes with a stale archive flag; repair
    // that route state when the native app-server reports the archived error.
    return providerForModel(route.selectedModel) === GATEWAY_PROVIDER;
  }

  function restoreArchivedProviderRoute(
    route: ThreadRoute,
    native: ProviderRuntime,
    callback: (restored: boolean) => void,
  ): void {
    if (!shouldRepairArchivedRoute(route)) {
      callback(false);
      return;
    }

    sendInternal(native, "thread/unarchive", { threadId: route.nativeId }, (response) => {
      if (response.error) {
        callback(false);
        return;
      }

      const result = response.result && typeof response.result === "object"
        ? response.result as JsonRecord
        : {};
      const thread = result.thread && typeof result.thread === "object"
        ? result.thread as JsonRecord
        : {};
      updateRouteNativePath(route, thread);

      // The protocol result is version-dependent. A follow-up read gives the
      // bridge the canonical active path when the native app-server only
      // returns an empty unarchive result.
      sendInternal(native, "thread/read", { threadId: route.nativeId, includeTurns: false }, (read) => {
        if (!read.error) {
          const readResult = read.result && typeof read.result === "object"
            ? read.result as JsonRecord
            : {};
          const readThread = readResult.thread && typeof readResult.thread === "object"
            ? readResult.thread as JsonRecord
            : {};
          updateRouteNativePath(route, readThread);
        }

        // If the native response omitted the new path, never send the stale
        // archived path on the retry. Native can resolve the active rollout by
        // id, and a subsequent read/resume will persist the fresh path.
        if (isArchivedNativeRolloutPath(route.nativePath || "")) route.nativePath = undefined;
        route.archived = false;
        saveRoute(route);
        callback(true);
      });
    });
  }

  function requestKey(runtime: ProviderRuntime, id: unknown): string {
    return runtime.provider + "\u0000" + requestIdKey(id);
  }

  function parentRequestIdInUse(id: unknown): boolean {
    const key = requestIdKey(id);
    if (pendingServerRequests.has(key)) return true;
    for (const runtime of runtimes) {
      if (pendingRequests.has(requestKey(runtime, id))) return true;
    }
    return false;
  }

  function notificationKey(runtime: ProviderRuntime, threadId: string): string {
    return runtime.provider + "\u0000" + threadId;
  }

  function cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function providerForModel(model: string, fallback: CodexProvider = NATIVE_PROVIDER): CodexProvider {
    return classifyRuntimeModel(model) || fallback;
  }

  function collaborationModel(params: JsonRecord): string {
    for (const key of ["collaborationMode", "collaboration_mode"]) {
      const collaboration = params[key];
      if (!collaboration || typeof collaboration !== "object" || Array.isArray(collaboration)) continue;
      const settings = (collaboration as JsonRecord).settings;
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      const model = modelSlug((settings as JsonRecord).model);
      if (model) return model;
    }
    return "";
  }

  function selectedModel(params: JsonRecord, route?: ThreadRoute): string {
    return modelSlug(params.model) || route?.selectedModel || nativeDefaultModel();
  }

  function threadMetadata(params: JsonRecord): JsonRecord {
    return params.client_metadata && typeof params.client_metadata === "object" && !Array.isArray(params.client_metadata)
      ? params.client_metadata as JsonRecord
      : {};
  }

  function threadSource(params: JsonRecord): string {
    const metadata = threadMetadata(params);
    return cleanString(
      params.threadSource
      || params.thread_source
      || metadata.thread_source
      || metadata.threadSource,
    ).toLowerCase();
  }

  function threadOrigin(params: JsonRecord): "desktop" | "gpt-live" | undefined {
    const metadata = threadMetadata(params);
    const value = cleanString(
      params.subagent_origin
      || params.subagent_source
      || params.parent_thread_source
      || metadata.subagent_origin
      || metadata.subagent_source
      || metadata.parent_thread_source,
    ).toLowerCase();
    if (["gpt-live", "gpt_live", "realtime", "realtime_voice"].includes(value)) return "gpt-live";
    if (["desktop", "main-agent", "main_agent"].includes(value)) return "desktop";
    return undefined;
  }

  function parentThreadId(params: JsonRecord): string | undefined {
    const metadata = threadMetadata(params);
    return cleanString(
      params.parent_thread_id
      || params.parent_task_id
      || metadata.parent_thread_id
      || metadata.parentThreadId
      || metadata.parent_task_id,
    ) || undefined;
  }

  function isNativeSubagentThread(route: ThreadRoute): boolean {
    return route.threadSource === "subagent" || Boolean(route.parentThreadId);
  }

  function nativeSubagentTurnParams(params: JsonRecord, route: ThreadRoute, selected: string): JsonRecord {
    const metadata = threadMetadata(params);
    const turnId = cleanString(params.turnId || params.turn_id || metadata.turn_id)
      || `turn-${randomBytes(8).toString("hex")}`;
    const taskId = `thread-${route.externalId}-${randomBytes(8).toString("hex")}`;
    return {
      ...params,
      // The native app-server must receive a native transport model. The
      // explicit provider target travels as model_override and is resolved by
      // the gateway after the request reaches the subagent boundary.
      model: nativeDefaultModel(),
      client_metadata: {
        ...metadata,
        "x-openai-subagent": "1",
        thread_source: "subagent",
        subagent_origin: route.threadOrigin === "gpt-live" ? "gpt-live" : "desktop",
        subagent_task_id: taskId,
        session_id: route.externalId,
        thread_id: route.externalId,
        parent_task_id: route.parentThreadId || metadata.parent_task_id || route.externalId,
        turn_id: turnId,
        model_override: selected,
      },
    };
  }

  function selectedTurnModel(params: JsonRecord, route: ThreadRoute): string {
    // Desktop's current protocol puts the picker selection in
    // collaborationMode.settings.model while leaving turn/start.model empty
    // (or at the native physical GPT model). Use that field as the selected
    // provider target; otherwise a fresh third-party conversation is silently
    // rebound to the native GPT route created by thread/start.
    const topLevel = modelSlug(params.model);
    const pickerModel = collaborationModel(params);
    const explicit = topLevel || pickerModel;
    const pending = pendingSelectedModels.get(route.externalId);
    const explicitProvider = explicit ? providerForModel(explicit) : null;
    // A model change is committed by thread/settings/update. Desktop can
    // echo the native physical provider on a later turn even when this local
    // route is bound to a third-party model; that transport detail must not
    // erase the durable selected model after a restart.
    if (explicit && explicitProvider === NATIVE_PROVIDER) return explicit;
    if (
      failedProviderRoutes.has(route.externalId)
      && normalizeProvider(params.modelProvider) === NATIVE_PROVIDER
    ) {
      // After a failed provider request, Desktop may send the next turn with
      // only the native provider marker. Treat that as the user's escape back
      // to native GPT, but do not apply the same heuristic after a restart.
      return nativeDefaultModel();
    }
    // The picker can race its settings/update acknowledgement: the next
    // turn may still carry the old provider-owned slug while the committed
    // model is already native. Preserve the explicit settings boundary in
    // that one stale-field case; an actual native model slug still wins
    // above, and a provider-owned selection without a native pending value
    // remains explicit below.
    if (
      pending
      && providerForModel(pending) === NATIVE_PROVIDER
      && explicitProvider === GATEWAY_PROVIDER
      && normalizeProvider(params.modelProvider) === GATEWAY_PROVIDER
    ) {
      return pending;
    }
    if (explicit) return explicit;
    if (pending) return pending;
    return route.selectedModel || nativeDefaultModel();
  }

  function nativeModel(params: JsonRecord, route?: ThreadRoute): string {
    const explicit = modelSlug(params.model);
    if (explicit && providerForModel(explicit) === NATIVE_PROVIDER) return explicit;
    if (route?.selectedModel && providerForModel(route.selectedModel) === NATIVE_PROVIDER) return route.selectedModel;
    return nativeDefaultModel();
  }

  function rememberSettings(route: ThreadRoute, params: JsonRecord): void {
    const next = { ...(route.settings || {}) };
    for (const key of [
      "cwd",
      "approvalPolicy",
      "approvalsReviewer",
      "sandbox",
      "runtimeWorkspaceRoots",
      "serviceTier",
      "config",
      "developerInstructions",
      "baseInstructions",
      "personality",
      "permissions",
    ]) {
      if (params[key] !== undefined && params[key] !== null) next[key] = params[key];
    }
    route.settings = next;
  }

  function routeForNativeId(nativeId: string): ThreadRoute | null {
    for (const route of routes.values()) {
      if (route.nativeId === nativeId) return route;
    }
    return null;
  }

  function routeForThreadId(threadId: string): ThreadRoute | null {
    const normalized = cleanString(threadId);
    if (!normalized) return null;
    return routes.get(normalized) || routeForNativeId(normalized);
  }

  function nativeDisplaySettingsForRoute(route: ThreadRoute, physicalThreadId = route.nativeId): NativeSubagentDisplaySettings | undefined {
    return nativeSubagentDisplaySettings.get(physicalThreadId)
      || nativeSubagentDisplaySettings.get(route.externalId);
  }

  function applyDisplaySettingsToRoute(route: ThreadRoute, display?: NativeSubagentDisplaySettings): void {
    const effort = cleanString(display?.effort);
    if (!effort) return;
    const currentConfig = route.settings?.config && typeof route.settings.config === "object" && !Array.isArray(route.settings.config)
      ? route.settings.config as JsonRecord
      : {};
    route.settings = {
      ...(route.settings || {}),
      effort,
      config: {
        ...currentConfig,
        model_reasoning_effort: effort,
      },
    };
  }

  function isRetiredNativeId(nativeId: string): boolean {
    for (const route of routes.values()) {
      if (route.retiredNativeIds?.includes(nativeId)) return true;
    }
    return false;
  }

  function emitError(id: unknown, message: string, code = -32001): void {
    if (id !== undefined && id !== null) writeParent(responseError(id, message, code));
  }

  function addSuppression(runtime: ProviderRuntime, threadId?: string): void {
    if (!threadId) return;
    const key = notificationKey(runtime, threadId);
    suppressedNotifications.set(key, (suppressedNotifications.get(key) || 0) + 1);
  }

  function releaseSuppression(runtime: ProviderRuntime, threadId?: string): void {
    if (!threadId) return;
    const key = notificationKey(runtime, threadId);
    const remaining = (suppressedNotifications.get(key) || 0) - 1;
    if (remaining > 0) suppressedNotifications.set(key, remaining);
    else suppressedNotifications.delete(key);
  }

  function isSuppressed(runtime: ProviderRuntime, threadId: string): boolean {
    return (suppressedNotifications.get(notificationKey(runtime, threadId)) || 0) > 0;
  }

  function subagentEventParentIds(externalId: string): Set<string> {
    const parentIds = new Set<string>([externalId]);
    const route = routes.get(externalId);
    if (route?.nativeId) parentIds.add(route.nativeId);
    const active = activeTurns.get(externalId);
    if (active?.physicalThreadId) parentIds.add(active.physicalThreadId);
    return parentIds;
  }

  function subagentEventItem(event: GatewaySubagentEvent, parentThreadId: string): JsonRecord {
    const task = event.task && typeof event.task === "object" ? event.task : {};
    const isStarted = event.type === "started";
    const isCancelled = event.type === "cancel_requested";
    const isFailed = event.type === "failed";
    const agentStatus = isStarted
      ? "running"
      : isCancelled
        ? "interrupted"
        : isFailed
          ? "errored"
          : "completed";
    const message = cleanString(task.error)
      || cleanString(task.output).slice(0, 12_000)
      || (isCancelled ? "子代理取消请求已记录" : "");
    return {
      type: "collabAgentToolCall",
      id: `opencodex-collab-${cleanString(event.task_id)}`,
      senderThreadId: parentThreadId,
      receiverThreadIds: [cleanString(event.task_id)],
      status: isStarted ? "inProgress" : (isFailed || isCancelled ? "failed" : "completed"),
      tool: "spawnAgent",
      agentsStates: {
        [cleanString(event.task_id)]: {
          status: agentStatus,
          ...(message ? { message } : {}),
        },
      },
      ...(cleanString(task.model) ? { model: cleanString(task.model) } : {}),
      ...(cleanString(task.prompt) ? { prompt: cleanString(task.prompt) } : {}),
      ...(cleanString(task.reasoning_effort) ? { reasoningEffort: cleanString(task.reasoning_effort) } : {}),
    };
  }

  function emitSubagentEvent(externalId: string, state: SubagentEventPoller, event: GatewaySubagentEvent): void {
    const taskId = cleanString(event.task_id);
    if (!taskId) return;
    const active = activeTurns.get(externalId);
    const parentTurnId = state.parentTurnId || event.parent_turn_id || active?.parentTurnId || `turn-${taskId}`;
    const item = subagentEventItem(event, externalId);
    const params: JsonRecord = {
      threadId: externalId,
      turnId: parentTurnId,
      item,
    };
    if (event.type === "started") params.startedAtMs = Date.now();
    else params.completedAtMs = Date.now();
    writeParent({
      method: event.type === "started" ? "item/started" : "item/completed",
      params,
    });
  }

  function scheduleSubagentEventPoll(externalId: string, delayMs: number): void {
    const state = subagentEventPollers.get(externalId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void pollSubagentEvents(externalId);
    }, delayMs);
    (state.timer as any)?.unref?.();
  }

  async function pollSubagentEvents(externalId: string): Promise<void> {
    const state = subagentEventPollers.get(externalId);
    if (!state || state.inFlight || !gatewayAdminToken) return;
    state.inFlight = true;
    try {
      const endpoint = `http://127.0.0.1:${gatewayPort}/api/agent-tasks/events?after=${encodeURIComponent(String(state.cursor))}&limit=500`;
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${gatewayAdminToken}` },
        signal: AbortSignal.timeout(1200),
      });
      if (!response.ok) return;
      const payload: any = await response.json();
      const events = Array.isArray(payload?.events) ? payload.events as GatewaySubagentEvent[] : [];
      const parentIds = subagentEventParentIds(externalId);
      for (const event of events) {
        const sequence = Number(event?.seq || 0);
        if (!Number.isFinite(sequence) || sequence <= state.cursor) continue;
        state.cursor = Math.max(state.cursor, sequence);
        if (!event.parent_task_id || !parentIds.has(cleanString(event.parent_task_id))) continue;
        const createdAt = Date.parse(cleanString(event.created_at));
        if (Number.isFinite(createdAt) && createdAt < state.startedAt - SUBAGENT_EVENT_REPLAY_GRACE_MS) continue;
        emitSubagentEvent(externalId, state, event);
      }
      const nextCursor = Number(payload?.next_cursor || 0);
      if (Number.isFinite(nextCursor)) state.cursor = Math.max(state.cursor, nextCursor);
    } catch {
      // The gateway may be stopped independently. The native GPT lane must
      // remain untouched; the event sideband simply retries on the next tick.
    } finally {
      state.inFlight = false;
      if (subagentEventPollers.get(externalId) !== state) return;
      if (state.stopAt && Date.now() >= state.stopAt) {
        if (state.timer) clearTimeout(state.timer);
        subagentEventPollers.delete(externalId);
        return;
      }
      scheduleSubagentEventPoll(externalId, state.stopAt ? 100 : 250);
    }
  }

  function startSubagentEventPolling(externalId: string, parentTurnId?: string): void {
    if (!externalId || !gatewayAdminToken) return;
    let state = subagentEventPollers.get(externalId);
    if (!state) {
      state = { cursor: 0, startedAt: Date.now(), inFlight: false };
      subagentEventPollers.set(externalId, state);
    } else if (state.stopAt) {
      state.startedAt = Date.now();
    }
    state.stopAt = undefined;
    if (parentTurnId) state.parentTurnId = parentTurnId;
    scheduleSubagentEventPoll(externalId, 0);
  }

  function drainSubagentEventPolling(externalId: string): void {
    const state = subagentEventPollers.get(externalId);
    if (!state) return;
    state.stopAt = Date.now() + 1500;
    scheduleSubagentEventPoll(externalId, 0);
  }

  function stopSubagentEventPolling(externalId: string): void {
    const state = subagentEventPollers.get(externalId);
    if (state?.timer) clearTimeout(state.timer);
    subagentEventPollers.delete(externalId);
  }

  function rewriteThreadIds(value: any, physicalId: string, externalId: string): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) rewriteThreadIds(entry, physicalId, externalId);
      return;
    }
    const record = value as JsonRecord;
    if (record.threadId === physicalId) record.threadId = externalId;
    if (record.thread && typeof record.thread === "object") {
      const thread = record.thread as JsonRecord;
      if (thread.id === physicalId) thread.id = externalId;
    }
    if (
      record.id === physicalId
      && ("model" in record || "modelProvider" in record || "path" in record || "turns" in record || "cwd" in record)
    ) {
      record.id = externalId;
    }
    for (const child of Object.values(record)) rewriteThreadIds(child, physicalId, externalId);
  }

  function decorateThreadModel(value: any, model?: string, provider?: CodexProvider, effort?: string): void {
    if (!value || typeof value !== "object" || (!model && !effort)) return;
    if (Array.isArray(value)) {
      for (const entry of value) decorateThreadModel(entry, model, provider, effort);
      return;
    }
    const record = value as JsonRecord;
    const modelProvider = model ? (provider || providerForModel(model)) : undefined;
    if (model && record.thread && typeof record.thread === "object") {
      const thread = record.thread as JsonRecord;
      thread.model = model;
      thread.modelProvider = modelProvider;
    }
    if (record.threadSettings && typeof record.threadSettings === "object") {
      const settings = record.threadSettings as JsonRecord;
      if (model) {
        settings.model = model;
        settings.modelProvider = modelProvider;
      }
      if (effort) settings.effort = effort;
    }
    if (effort && ("reasoningEffort" in record || "effort" in record)) {
      if ("reasoningEffort" in record) record.reasoningEffort = effort;
      if ("effort" in record && !record.threadSettings) record.effort = effort;
    }
    if (
      model
      && typeof record.id === "string"
      && ("model" in record || "modelProvider" in record || "path" in record || "turns" in record || "cwd" in record)
    ) {
      record.model = model;
      record.modelProvider = modelProvider;
    }
    for (const child of Object.values(record)) decorateThreadModel(child, model, provider, effort);
  }

  function decorateParentResponse(message: JsonRecord, pending: PendingParentRequest): JsonRecord {
    const output = cloneValue(message);
    if (pending.externalThreadId && pending.physicalThreadId) {
      rewriteThreadIds(output, pending.physicalThreadId, pending.externalThreadId);
    }
    if (pending.displayModel || pending.displayReasoning) {
      decorateThreadModel(output, pending.displayModel, pending.displayProvider, pending.displayReasoning);
    }
    const resultObj = (output.result && typeof output.result === "object") ? (output.result as JsonRecord) : null;
    const threadObj = (resultObj && resultObj.thread && typeof resultObj.thread === "object") ? (resultObj.thread as JsonRecord) : null;
    if (threadObj && Array.isArray(threadObj.turns) && threadObj.turns.length > 0) {
      threadObj.status = { type: "loaded" };
    }
    return output;
  }

  function emitSyntheticSettings(threadId: string, model: string, effort?: string): void {
    writeParent({
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: {
          model,
          modelProvider: providerForModel(model),
          ...(effort ? { effort } : {}),
        },
      },
    });
  }

  function writeChild(runtime: ProviderRuntime, message: JsonRecord, pending?: PendingRequest): void {
    if (runtime.stopping || runtime.child.stdin.destroyed) {
      const error = responseError(message.id, "Codex " + runtime.provider + " app-server is unavailable");
      if (pending?.kind === "internal") pending.onResponse(error);
      else if (pending?.kind === "parent") emitError(pending.id, cleanString(error.error?.message));
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      const reason = "Codex " + runtime.provider + " request could not be serialized: "
        + (error instanceof Error ? error.message : String(error));
      if (pending?.kind === "internal") pending.onResponse(responseError(message.id, reason));
      else if (pending?.kind === "parent") emitError(pending.id, reason);
      return;
    }
    const requestBytes = Buffer.byteLength(serialized, "utf8");
    if (requestBytes > MAX_CHILD_REQUEST_BYTES) {
      const reason = "Codex " + runtime.provider + " request was rejected before reaching the app-server because it is too large ("
        + requestBytes + " bytes)";
      console.warn("[CodexSplit Provider Bridge] " + reason);
      if (pending?.kind === "internal") pending.onResponse(responseError(message.id, reason));
      else if (pending?.kind === "parent") emitError(pending.id, reason, -32602);
      return;
    }
    if (pending && message.id !== undefined && message.id !== null) {
      pending.request = message;
      pendingRequests.set(requestKey(runtime, message.id), pending);
    }
    try {
      runtime.child.stdin.write(serialized + "\n");
    } catch (error) {
      const reason = "Codex " + runtime.provider + " app-server write failed: "
        + (error instanceof Error ? error.message : String(error));
      // An EPIPE/write failure is an unexpected child fault. Retire only this
      // runtime and let the supervisor replace it; stopping the bridge here
      // would make every Desktop conversation depend on one broken turn.
      restartRuntime(runtime, reason);
      if (!pending || (message.id !== undefined && message.id !== null)) return;
      if (pending.kind === "internal") pending.onResponse(responseError(message.id, reason));
      else emitError(pending.id, reason);
    }
  }

  function queueOrWrite(runtime: ProviderRuntime, message: JsonRecord, pending?: PendingRequest): void {
    if (runtime.initialized) writeChild(runtime, message, pending);
    else runtime.queue.push({ message, pending });
  }

  function flushQueue(runtime: ProviderRuntime): void {
    const queued = runtime.queue.splice(0);
    for (const entry of queued) writeChild(runtime, entry.message, entry.pending);
  }

  function sendInternal(
    runtime: ProviderRuntime,
    method: string,
    params: JsonRecord,
    onResponse: (message: JsonRecord) => void,
    suppressThreadId?: string,
  ): void {
    const id = "opencodex-internal-" + (++internalRequestCounter);
    if (suppressThreadId) addSuppression(runtime, suppressThreadId);
    queueOrWrite(runtime, { id, method, params }, {
      kind: "internal",
      method,
      runtime,
      suppressThreadId,
      onResponse: (message) => {
        try {
          onResponse(message);
        } finally {
          if (suppressThreadId) setTimeout(() => releaseSuppression(runtime, suppressThreadId), 0);
        }
      },
    });
  }

  applyNativeSubagentDisplaySettings = (update): void => {
    if (!update.effort) return;
    const route = routeForThreadId(update.threadId);
    if (route) {
      // The native app-server starts every child with its own default effort
      // (usually low). Keep the resolved Profile effort in the bridge route as
      // well, otherwise a later thread/read or settings update can resurrect
      // that native default after the gateway already selected high/max.
      applyDisplaySettingsToRoute(route, update);
      saveRoute(route);
    }
    const native = ensureRuntime(NATIVE_PROVIDER);
    if (!native || native.stopping) return;
    // Persist the selected effort through the native protocol on the child
    // thread itself. The synthetic notification above is still useful for
    // clients that consume bridge notifications directly, but a nested native
    // app-server may filter that notification before it reaches Desktop.
    sendInternal(native, "thread/settings/update", {
      threadId: update.threadId,
      effort: update.effort,
    }, (response) => {
      if (response.error) {
        console.warn("[CodexSplit Provider Bridge] Could not persist child reasoning display: " + cleanString(response.error.message));
      }
    });
  };

  function sendParent(
    runtime: ProviderRuntime,
    original: JsonRecord,
    method: string,
    params: JsonRecord,
    options: Omit<PendingParentRequest, "kind" | "id" | "method" | "params" | "runtime"> = {},
  ): void {
    queueOrWrite(runtime, requestWithParams(original, params), {
      kind: "parent",
      id: original.id,
      method,
      params,
      runtime,
      ...options,
    });
  }

  function registerServerRequest(runtime: ProviderRuntime, message: JsonRecord, output: JsonRecord): JsonRecord {
    if (message.id === undefined || message.id === null) return output;
    let parentId = message.id;
    if (parentRequestIdInUse(parentId)) {
      do {
        parentId = "opencodex-server-request-" + (++serverRequestCounter);
      } while (parentRequestIdInUse(parentId));
      console.warn(
        "[CodexSplit Provider Bridge] Rewriting colliding server request id "
        + requestIdKey(message.id) + " for parent routing",
      );
    }
    pendingServerRequests.set(requestIdKey(parentId), {
      childId: message.id,
      runtime,
      method: cleanString(message.method),
    });
    if (parentId === message.id) return output;
    return { ...output, id: parentId };
  }

  function forwardParentServerResponse(message: JsonRecord): boolean {
    if (message.id === undefined || message.id === null) return false;
    const key = requestIdKey(message.id);
    const pending = pendingServerRequests.get(key);
    if (!pending) return false;
    pendingServerRequests.delete(key);
    const response = { ...message, id: pending.childId };
    if (pending.runtime.stopping || pending.runtime.child.stdin.destroyed) {
      console.warn(
        "[CodexSplit Provider Bridge] Dropping server response for stopped "
        + pending.runtime.provider + " request " + key,
      );
      return true;
    }
    // This is a JSON-RPC response to a child-originated server request. It
    // must be written verbatim: adding params or registering it as a new
    // pending request changes the protocol direction and strands the child.
    writeChild(pending.runtime, response);
    return true;
  }

  function detachRuntime(runtime: ProviderRuntime): void {
    if (runtime.healthyTimer) {
      clearTimeout(runtime.healthyTimer);
      runtime.healthyTimer = undefined;
    }
    outputBuffers.delete(runtime);
    runtimes.delete(runtime);
    if (runtimeByProvider.get(runtime.provider) === runtime) {
      runtimeByProvider.delete(runtime.provider);
    }
  }

  function scheduleRuntimeRestart(provider: CodexProvider, reason: string): void {
    if (bridgeStopping || runtimeByProvider.has(provider) || runtimeRestartTimers.has(provider)) return;
    const attempt = runtimeRestartAttempts.get(provider) || 0;
    runtimeRestartAttempts.set(provider, attempt + 1);
    const delay = Math.min(
      RUNTIME_RESTART_MAX_DELAY_MS,
      RUNTIME_RESTART_BASE_DELAY_MS * (2 ** Math.min(attempt, 6)),
    );
    console.warn(
      `[CodexSplit Provider Bridge] ${provider} runtime will be restarted in ${delay}ms: ${reason}`,
    );
    const timer = setTimeout(() => {
      runtimeRestartTimers.delete(provider);
      if (bridgeStopping || runtimeByProvider.has(provider)) return;
      try {
        spawnRuntime(provider);
      } catch (error) {
        const nextReason = "Codex " + provider + " runtime restart failed: "
          + (error instanceof Error ? error.message : String(error));
        console.error("[CodexSplit Provider Bridge] " + nextReason);
        scheduleRuntimeRestart(provider, nextReason);
      }
    }, delay);
    timer.unref?.();
    runtimeRestartTimers.set(provider, timer);
  }

  function markRuntimeHealthy(runtime: ProviderRuntime): void {
    if (runtime.healthyTimer) clearTimeout(runtime.healthyTimer);
    runtime.healthyTimer = setTimeout(() => {
      if (runtimeByProvider.get(runtime.provider) === runtime && runtime.initialized) {
        runtimeRestartAttempts.delete(runtime.provider);
      }
    }, RUNTIME_HEALTHY_RESET_MS);
    runtime.healthyTimer.unref?.();
  }

  function clearRuntimeState(runtime: ProviderRuntime): void {
    for (const [externalId, active] of activeTurns) {
      if (active.provider === runtime.provider) {
        if (active.interruptTimer) clearTimeout(active.interruptTimer);
        activeTurns.delete(externalId);
        stopSubagentEventPolling(externalId);
      }
    }
  }

  function clearActiveTurn(externalId: string): void {
    const active = activeTurns.get(externalId);
    if (active?.interruptTimer) clearTimeout(active.interruptTimer);
    activeTurns.delete(externalId);
  }

  function scheduleTurnInterruptWatchdog(externalId: string, active: {
    provider: CodexProvider;
    physicalThreadId: string;
    outputStarted: boolean;
    parentTurnId?: string;
    interruptTimer?: ReturnType<typeof setTimeout>;
  }): void {
    if (active.interruptTimer) clearTimeout(active.interruptTimer);
    active.interruptTimer = setTimeout(() => {
      if (activeTurns.get(externalId) !== active) return;
      const runtime = runtimeByProvider.get(active.provider);
      if (!runtime || runtime.stopping) return;
      const reason = `Codex ${active.provider} turn/interrupt 超时，已重启共享运行时以释放其他会话`;
      console.error(`[CodexSplit Provider Bridge] ${reason} thread=${externalId}`);
      restartRuntime(runtime, reason);
    }, TURN_INTERRUPT_WATCHDOG_MS);
    active.interruptTimer.unref?.();
  }

  function canRecoverAfterRuntimeFailure(pending: PendingRequest): boolean {
    return RECOVERABLE_RUNTIME_METHODS.has(pending.method)
      && Boolean(pending.request)
      && pending.request?.id !== undefined
      && pending.request?.id !== null;
  }

  function queueForRuntimeRecovery(entry: RuntimeRecoveryRequest): boolean {
    if (entry.attempts >= MAX_RUNTIME_RECOVERY_ATTEMPTS) return false;
    const queue = runtimeRecoveryQueues.get(entry.pending.runtime.provider) || [];
    queue.push(entry);
    runtimeRecoveryQueues.set(entry.pending.runtime.provider, queue);
    return true;
  }

  function replayRuntimeRecovery(runtime: ProviderRuntime): void {
    const queue = runtimeRecoveryQueues.get(runtime.provider);
    if (!queue || queue.length === 0) return;
    runtimeRecoveryQueues.delete(runtime.provider);
    for (const entry of queue) {
      const pending = {
        ...entry.pending,
        runtime,
        recoveryAttempts: entry.attempts + 1,
      } as PendingRequest;
      queueOrWrite(runtime, entry.message, pending);
    }
  }

  function failRuntime(runtime: ProviderRuntime, reason: string, preserveParentInitialization = false): void {
    clearRuntimeState(runtime);
    const matched = [...pendingRequests.entries()].filter(([, entry]) => entry.runtime === runtime);
    for (const [key, entry] of matched) {
      pendingRequests.delete(key);
      if (
        preserveParentInitialization
        && canRecoverAfterRuntimeFailure(entry)
        && queueForRuntimeRecovery({
          message: entry.request as JsonRecord,
          pending: entry,
          attempts: entry.recoveryAttempts || 0,
        })
      ) continue;
      const error = responseError(entry.kind === "parent" ? entry.id : undefined, reason);
      if (entry.kind === "internal") entry.onResponse(error);
      else emitError(entry.id, reason);
    }
    for (const [key, entry] of pendingServerRequests) {
      if (entry.runtime === runtime) pendingServerRequests.delete(key);
    }
    for (const queued of runtime.queue.splice(0)) {
      if (!queued.pending) continue;
      if (
        preserveParentInitialization
        && canRecoverAfterRuntimeFailure(queued.pending)
        && queueForRuntimeRecovery({
          message: queued.message,
          pending: queued.pending,
          attempts: queued.pending.recoveryAttempts || 0,
        })
      ) continue;
      const error = responseError(queued.message.id, reason);
      if (queued.pending.kind === "internal") queued.pending.onResponse(error);
      else emitError(queued.pending.id, reason);
    }
    if (runtime.provider === NATIVE_PROVIDER && !preserveParentInitialization) {
      while (pendingParentInitializations.length > 0) {
        const parent = pendingParentInitializations.shift();
        if (parent) emitError(parent.id, reason);
      }
    }
  }

  function stopRuntime(runtime: ProviderRuntime, reason = "Codex " + runtime.provider + " app-server stopped"): void {
    if (runtime.stopping) return;
    runtime.stopping = true;
    detachRuntime(runtime);
    failRuntime(runtime, reason);
    if (!runtime.child.killed) runtime.child.kill("SIGTERM");
  }

  function restartRuntime(runtime: ProviderRuntime, reason: string): void {
    if (runtime.stopping) return;
    runtime.stopping = true;
    detachRuntime(runtime);
    // `initialize` is the bridge's durable parent handshake. Keep it pending
    // across a child replacement so a startup crash is retried internally
    // instead of being surfaced as a fatal Desktop-wide failure.
    failRuntime(runtime, reason, true);
    if (!runtime.child.killed) runtime.child.kill("SIGTERM");
    scheduleRuntimeRestart(runtime.provider, reason);
  }

  function consumeOutput(runtime: ProviderRuntime, chunk: Buffer | string): void {
    const previous = outputBuffers.get(runtime) || "";
    const lines = (previous + chunk.toString()).split(/\r?\n/);
    outputBuffers.set(runtime, lines.pop() || "");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleChildMessage(runtime, JSON.parse(line) as JsonRecord, line);
      } catch (error) {
        // stdout is the app-server JSONL protocol. A malformed child line is
        // diagnostic data, never a message that may be copied to the parent.
        console.error("[CodexSplit Provider Bridge] Invalid child stdout JSON: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  function spawnRuntime(provider: CodexProvider): ProviderRuntime {
    const childArgs = provider === NATIVE_PROVIDER ? nativeRuntimeArgs(args, nativeEgress.port, nativeEgress.basePath) : args;
    // Official account rotation happens at Native Egress. Never create a
    // second native app-server for account rotation; that would split the
    // native conversation store.
    const child = spawn(nativeCodexPath(), childArgs, {
      env: {
        ...process.env,
        CODEX_CLI_PATH: undefined,
        OPENCODEX_PROVIDER_BRIDGE_RUNTIME: provider,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const runtime: ProviderRuntime = { provider, child, initialized: false, stopping: false, queue: [] };
    runtimes.add(runtime);
    runtimeByProvider.set(provider, runtime);
    outputBuffers.set(runtime, "");
    child.stdout.on("data", (chunk) => consumeOutput(runtime, chunk));
    // `stdin.write()` can report a dead child asynchronously through EPIPE;
    // a try/catch around write() cannot catch that event. Without this
    // listener Node treats the broken pipe as an uncaught stream error and
    // terminates the whole bridge, taking every Desktop conversation with it.
    child.stdin.on("error", (error) => {
      if (!runtime.stopping) {
        restartRuntime(runtime, "Codex " + provider + " app-server stdin failed: " + error.message);
      }
    });
    child.stderr.pipe(process.stderr);
    child.once("error", (error) => {
      if (!runtime.stopping) {
        console.error("[CodexSplit Provider Bridge] " + provider + " app-server failed: " + error.message);
        restartRuntime(runtime, "Codex " + provider + " app-server failed: " + error.message);
      }
    });
    child.once("exit", (code, signal) => {
      const reason = "Codex " + provider + " app-server exited (" + (signal || code || "unknown") + ")";
      if (!runtime.stopping && !bridgeStopping) {
        runtime.stopping = true;
        detachRuntime(runtime);
        failRuntime(runtime, reason, true);
        scheduleRuntimeRestart(provider, reason);
      } else {
        detachRuntime(runtime);
      }
    });
    const initializeId = "opencodex-provider-initialize-" + (++internalRequestCounter);
    // The nested app-server is a CLI-style transport worker, not the Desktop
    // frontend. Keep its initialize handshake minimal; forwarding Desktop's
    // client/capability identity makes Codex select the ChatGPT/Desktop
    // transport and ignore the process-scoped compatible-provider Egress.
    const initializeParams = {
      clientInfo: { name: "CodexSplit Provider Bridge", version: APP_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: true },
    };
    pendingRequests.set(requestKey(runtime, initializeId), {
      kind: "internal",
      method: "initialize",
      runtime,
      onResponse: (message) => {
        if (message.error) {
          restartRuntime(runtime, "Codex " + provider + " initialization failed: " + (cleanString(message.error.message) || "unknown error"));
          return;
        }
        if (message.result && typeof message.result === "object") lastInitializeResult = message.result as JsonRecord;
        runtime.initialized = true;
        markRuntimeHealthy(runtime);
        if (provider === NATIVE_PROVIDER) {
          while (pendingParentInitializations.length > 0) {
            const parent = pendingParentInitializations.shift();
            if (!parent) continue;
            writeParent({
              id: parent.id,
              result: lastInitializeResult || {
                userAgent: "codex/1.0",
                codexHome: codexHomeDir(),
                platformFamily: process.platform === "win32" ? "windows" : "unix",
                platformOs: process.platform === "darwin" ? "macos" : process.platform,
              },
            });
          }
        }
        replayRuntimeRecovery(runtime);
        flushQueue(runtime);
      },
    });
    try {
      child.stdin.write(JSON.stringify({ id: initializeId, method: "initialize", params: initializeParams }) + "\n");
    } catch (error) {
      restartRuntime(runtime, "Codex " + provider + " initialization write failed: "
        + (error instanceof Error ? error.message : String(error)));
    }
    return runtime;
  }

  function ensureRuntime(provider: CodexProvider): ProviderRuntime {
    const existing = runtimeByProvider.get(provider);
    return existing && !existing.stopping ? existing : spawnRuntime(provider);
  }

  function nativeRuntimeForRoute(route?: ThreadRoute): ProviderRuntime {
    // Conversation routes always use the shared native runtime. Account IDs
    // are selected only at the official HTTP Egress boundary.
    return ensureRuntime(NATIVE_PROVIDER);
  }

  function nativeTurnPending(
    parent: JsonRecord,
    params: JsonRecord,
    route: ThreadRoute,
    selected: string,
    runtime: ProviderRuntime,
    physicalThreadId: string,
    displayReasoning?: string,
    displayProvider: CodexProvider = providerForModel(selected),
  ): PendingParentRequest {
    return {
      kind: "parent",
      id: parent.id,
      method: "turn/start",
      params,
      runtime,
      externalThreadId: route.externalId,
      physicalThreadId,
      displayModel: selected,
      displayProvider,
      displayReasoning,
    };
  }

  // A quota response is retried by OfficialAccountRouter at the HTTP Egress
  // boundary. Native app-server account failover is intentionally absent:
  // changing an account must never create, migrate, or replace a thread.

  function sendNativeTurnAttempt(
    parent: JsonRecord,
    originalParams: JsonRecord,
    route: ThreadRoute,
    selected: string,
    native: ProviderRuntime,
    physicalThreadId: string,
    transportModel = selected,
  ): void {
    const selectedProvider = providerForModel(selected);
    const originalMetadata = originalParams.client_metadata
      && typeof originalParams.client_metadata === "object"
      && !Array.isArray(originalParams.client_metadata)
      ? originalParams.client_metadata as JsonRecord
      : {};
    const routedMetadata = selectedProvider === GATEWAY_PROVIDER
      ? {
          ...originalMetadata,
          // The native app-server remains the sole owner of this local thread.
          // This request-scoped value is consumed only by Native Egress and is
          // replaced with the selected provider model on the gateway hop.
          opencodex_model_override: selected,
          session_id: originalMetadata.session_id || route.externalId,
          thread_id: originalMetadata.thread_id || route.externalId,
        }
      : Object.fromEntries(
          Object.entries(originalMetadata).filter(([key]) => key !== "opencodex_model_override"),
        );
    const nextParams = rewriteNativeTransportModel({
      ...stripRequestProvider({
        ...originalParams,
        threadId: physicalThreadId,
        model: transportModel,
        ...(Object.keys(routedMetadata).length > 0 ? { client_metadata: routedMetadata } : {}),
      }),
      ...(selectedProvider === GATEWAY_PROVIDER ? { modelProvider: NATIVE_EGRESS_PROVIDER } : {}),
    }, transportModel, selectedProvider === GATEWAY_PROVIDER);
    activeTurns.set(route.externalId, {
      provider: NATIVE_PROVIDER,
      physicalThreadId,
      outputStarted: false,
    });
    sendParent(native, parent, "turn/start", nextParams, {
      externalThreadId: route.externalId,
      physicalThreadId,
      displayModel: selected,
      displayProvider: NATIVE_PROVIDER,
      onResponse: (response) => {
        if (response.error) {
          clearActiveTurn(route.externalId);
          if (selectedProvider === GATEWAY_PROVIDER) failedProviderRoutes.add(route.externalId);
        } else if (selectedProvider === GATEWAY_PROVIDER) {
          failedProviderRoutes.delete(route.externalId);
        }
        const childDisplay = nativeDisplaySettingsForRoute(route, physicalThreadId);
        return decorateParentResponse(response, nativeTurnPending(
          parent,
          nextParams,
          route,
          selected,
          native,
          physicalThreadId,
          childDisplay?.effort,
          selectedProvider,
        ));
      },
    });
  }

  function handleNativeNotification(runtime: ProviderRuntime, message: JsonRecord): JsonRecord | null {
    const params = message.params && typeof message.params === "object" ? message.params as JsonRecord : {};
    const thread = params.thread && typeof params.thread === "object" ? params.thread as JsonRecord : {};
    const nativeId = threadIdFrom(params.threadId || thread.id);
    if (nativeId && isSuppressed(runtime, nativeId)) return null;
    if (nativeId && isRetiredNativeId(nativeId)) return null;
    const route = nativeId ? routeForNativeId(nativeId) : null;
    const childDisplay = nativeId
      ? nativeSubagentDisplaySettings.get(nativeId) || (route ? nativeDisplaySettingsForRoute(route, nativeId) : undefined)
      : undefined;
    if (!route && !childDisplay) return message;
    if (route) {
      const active = activeTurns.get(route.externalId);
      if (active && active.physicalThreadId === nativeId) {
        const method = cleanString(message.method);
        const item = params.item && typeof params.item === "object" ? params.item as JsonRecord : {};
        const itemType = cleanString(item.type).toLowerCase();
        const itemRole = cleanString(item.role).toLowerCase();
        const assistantItem = itemRole === "assistant"
          || itemType === "agentmessage"
          || itemType === "functioncall"
          || itemType === "computercall"
          || itemType === "computer_call"
          || itemType === "computer_call_output";
        if (method.startsWith("response/") || method.startsWith("rawResponseItem/") || assistantItem) {
          active.outputStarted = true;
        }
      }
      if (message.method === "turn/started") {
        const turnId = threadIdFrom(params.turnId || params.turn_id);
        if (active && turnId) active.parentTurnId = turnId;
        startSubagentEventPolling(route.externalId, turnId || undefined);
      }
      if (message.method === "thread/realtime/started" || message.method === "thread/realtime/resumed") {
        startSubagentEventPolling(route.externalId, threadIdFrom(params.turnId || params.turn_id) || undefined);
      }
      if (message.method === "thread/realtime/closed" || message.method === "thread/realtime/error") {
        drainSubagentEventPolling(route.externalId);
      }
    }
    const output = cloneValue(message);
    if (route) rewriteThreadIds(output, route.nativeId, route.externalId);
    const displayModel = childDisplay?.model || route?.selectedModel;
    const displayProvider = displayModel ? providerForModel(displayModel) : undefined;
    if (displayModel || childDisplay?.effort) {
      decorateThreadModel(output, displayModel, displayProvider, childDisplay?.effort);
    }
    if (["turn/completed", "turn/failed", "turn/interrupted", "turn/cancelled"].includes(message.method) && route) {
      drainSubagentEventPolling(route.externalId);
      clearActiveTurn(route.externalId);
    }
    return output;
  }

  function handleChildMessage(runtime: ProviderRuntime, message: JsonRecord, rawLine: string): void {
    if (runtime.stopping) return;
    if (typeof message.method === "string") {
      const output = handleNativeNotification(runtime, message);
      if (output) writeParent(registerServerRequest(runtime, message, output));
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = pendingRequests.get(requestKey(runtime, message.id));
      if (pending) {
        pendingRequests.delete(requestKey(runtime, message.id));
        if (pending.kind === "internal") {
          pending.onResponse(message);
          return;
        }
        try {
          const output = pending.onResponse ? pending.onResponse(message) : decorateParentResponse(message, pending);
          if (output) writeParent(output);
        } catch (error) {
          emitError(pending.id, error instanceof Error ? error.message : String(error));
        }
        return;
      }
    }
    if (message.id !== undefined && message.id !== null && ("result" in message || "error" in message)) {
      console.error(
        "[CodexSplit Provider Bridge] Ignoring unknown child JSON-RPC response: " + rawLine,
      );
      return;
    }
    // Child stdout is a strict JSONL protocol. Unknown JSON values must not
    // be forwarded verbatim because the desktop app would treat them as a
    // second protocol message and lose synchronization.
    console.error("[CodexSplit Provider Bridge] Ignoring unknown child JSON message: " + rawLine);
  }

  function ensureCanonical(
    externalId: string,
    params: JsonRecord,
    callback: (route: ThreadRoute | null, error?: string) => void,
    options: EnsureCanonicalOptions = {},
  ): void {
    const existing = routes.get(externalId);
    const requested = options.preserveRequestedModel ? "" : modelSlug(params.model);
    if (existing) {
      // `thread/read`, `thread/resume`, and several Desktop revisions of
      // other thread methods carry the currently selected picker model. That
      // value is request-scoped UI state, not a model change for the route
      // being opened. Mutating the durable route here makes opening one
      // conversation silently rebind it (and, after the next click, every
      // conversation) to a newly added provider model. Model changes are
      // committed only by the explicit settings/turn handlers below.
      if (requested || Object.keys(params).length > 0) {
        rememberSettings(existing, params);
        saveRoute(existing);
      }
      callback(existing);
      return;
    }
    const legacy = legacyThreads.get(externalId);
    const savedModel = requested || legacy?.model || "";
    const createDirectRoute = (): void => {
      const route = saveRoute({
        externalId,
        nativeId: externalId,
        nativePath: legacy?.path,
        selectedModel: savedModel || nativeDefaultModel(),
      });
      rememberSettings(route, params);
      callback(route);
    };
    // A fresh Desktop may resume a legacy third-party thread before it has
    // asked for thread/list, so there is no catalog hint yet. Read only the
    // local rollout metadata first; if it says third-party, bind the provider
    // selection to that same local thread instead of creating another one.
    if (!legacy && !requested) {
      const native = ensureRuntime(NATIVE_PROVIDER);
      sendInternal(native, "thread/read", { threadId: externalId, includeTurns: false }, (read) => {
        if (!read.error) {
          const result = read.result && typeof read.result === "object" ? read.result as JsonRecord : {};
          const source = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
          const discoveredModel = modelSlug(source.model);
          if (providerForModel(discoveredModel) === GATEWAY_PROVIDER) {
            const discovered = {
              id: externalId,
              model: discoveredModel,
              path: cleanString(source.path) || undefined,
            };
            legacyThreads.set(externalId, discovered);
            // The rollout already belongs to the local Codex store. Register
            // the provider selection against that same id/path; never create
            // a replacement native thread and never copy its history into a
            // second conversation.
            const route = saveRoute({
              externalId,
              nativeId: externalId,
              nativePath: discovered.path,
              selectedModel: discoveredModel,
            });
            rememberSettings(route, params);
            callback(route);
            return;
          }
        }
        createDirectRoute();
      });
      return;
    }
    createDirectRoute();
  }

  function handleThreadStart(message: JsonRecord, params: JsonRecord): void {
    const selected = selectedModel(params);
    const physicalModel = providerForModel(selected) === NATIVE_PROVIDER ? selected : nativeDefaultModel();
    const thirdParty = providerForModel(selected) === GATEWAY_PROVIDER;
    const native = ensureRuntime(NATIVE_PROVIDER);
    const nextParams = rewriteNativeTransportModel({
      ...stripRequestProvider(params),
      // Keep a provider-owned start durable in the native Codex store. The
      // selected provider is request routing metadata; it is not a second
      // app-server or a separate conversation record.
      ...(thirdParty ? { ephemeral: false } : {}),
      model: physicalModel,
      // Keep every logical thread on the local OpenAI-compatible Egress. It
      // routes official models to the native account and provider-owned models
      // to the selected third-party gateway without splitting the thread.
      modelProvider: NATIVE_EGRESS_PROVIDER,
    }, physicalModel, thirdParty);
    sendParent(native, message, "thread/start", nextParams, {
      displayModel: selected,
      displayProvider: providerForModel(selected),
      onResponse: (response) => {
        if (!response.error) {
          const result = response.result && typeof response.result === "object" ? response.result as JsonRecord : {};
          const thread = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
          const nativeId = threadIdFrom(thread.id);
          if (nativeId) {
            const route = saveRoute({
              externalId: nativeId,
              nativeId,
              nativePath: cleanString(thread.path) || undefined,
              selectedModel: selected,
              threadSource: threadSource(params) || undefined,
              threadOrigin: threadOrigin(params),
              parentThreadId: parentThreadId(params),
            });
            rememberSettings(route, params);
            // The first native thread/start response can arrive after the
            // child egress has already returned the gateway-selected effort.
            // Re-apply the cached value after rememberSettings so the native
            // low default cannot overwrite the visible Profile setting.
            applyDisplaySettingsToRoute(route, nativeDisplaySettingsForRoute(route, nativeId));
            saveRoute(route);
          }
        }
        const startedResult = response.result && typeof response.result === "object"
          ? response.result as JsonRecord
          : {};
        const startedThread = startedResult.thread && typeof startedResult.thread === "object"
          ? startedResult.thread as JsonRecord
          : {};
        const startedNativeId = threadIdFrom(startedThread.id);
        const childDisplay = startedNativeId
          ? nativeSubagentDisplaySettings.get(startedNativeId)
          : undefined;
        return decorateParentResponse(response, {
          kind: "parent",
          id: message.id,
          method: "thread/start",
          params: nextParams,
          runtime: native,
          displayModel: selected,
          displayProvider: providerForModel(selected),
          displayReasoning: childDisplay?.effort,
        });
      },
    });
  }

  function handleThreadResume(message: JsonRecord, params: JsonRecord): void {
    const externalId = threadIdFrom(params.threadId);
    if (!externalId) {
      emitError(message.id, "thread/resume requires a thread id", -32602);
      return;
    }
    ensureCanonical(externalId, params, (route, error) => {
      if (!route) {
        emitError(message.id, error || "Unable to resolve conversation");
        return;
      }
      // Resuming/opening a thread must preserve the model bound to that
      // thread. Desktop may include the current picker model here, but it is
      // not an explicit model switch; `thread/settings/update` is the model
      // selection boundary.
      const selected = route.selectedModel || nativeDefaultModel();
      route.threadSource = threadSource(params) || route.threadSource;
      route.threadOrigin = threadOrigin(params) || route.threadOrigin;
      route.parentThreadId = parentThreadId(params) || route.parentThreadId;
      rememberSettings(route, params);
      saveRoute(route);
      const native = nativeRuntimeForRoute(route);
      let archiveRepairAttempted = false;
      const decoratedResumeResponse = (response: JsonRecord, nextParams: JsonRecord): JsonRecord => {
        if (!response.error) {
          const result = response.result && typeof response.result === "object" ? response.result as JsonRecord : {};
          const thread = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
          updateRouteNativePath(route, thread);
          route.archived = false;
          saveRoute(route);
        }
        return decorateParentResponse(response, {
          kind: "parent",
          id: message.id,
          method: "thread/resume",
          params: nextParams,
          runtime: native,
          externalThreadId: externalId,
          physicalThreadId: route.nativeId,
          displayModel: selected,
          displayProvider: providerForModel(selected),
        });
      };
      const sendResume = (): void => {
        const nextParams: JsonRecord = {
          ...stripRequestProvider(params),
          ...(route.settings || {}),
          threadId: route.nativeId,
          model: nativeModel({}, route),
          modelProvider: NATIVE_EGRESS_PROVIDER,
        };
        delete nextParams.config;
        delete nextParams.path;
        if (route.nativePath) nextParams.path = route.nativePath;
        sendParent(native, message, "thread/resume", nextParams, {
          externalThreadId: externalId,
          physicalThreadId: route.nativeId,
          displayModel: selected,
          displayProvider: providerForModel(selected),
          onResponse: (response) => {
            if (response.error
              && !archiveRepairAttempted
              && shouldRepairArchivedRoute(route)
              && isArchivedThreadResponse(response)) {
              archiveRepairAttempted = true;
              restoreArchivedProviderRoute(route, native, (restored) => {
                if (restored) {
                  sendResume();
                  return;
                }
                writeParent(decoratedResumeResponse(response, nextParams));
              });
              return null;
            }
            return decoratedResumeResponse(response, nextParams);
          },
        });
      };
      if (route.nativePath && !fs.existsSync(route.nativePath)) {
        // A rollout can be moved to archived_sessions without changing its
        // thread id. Resolve the current native path before resuming instead
        // of sending a stale path that poisons the Desktop session.
        sendInternal(native, "thread/read", { threadId: route.nativeId, includeTurns: false }, (read) => {
          if (!read.error) {
            const result = read.result && typeof read.result === "object" ? read.result as JsonRecord : {};
            const thread = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
            updateRouteNativePath(route, thread);
          }
          sendResume();
        });
      } else {
        sendResume();
      }
    }, { preserveRequestedModel: true });
  }

  function handleThreadFork(message: JsonRecord, params: JsonRecord): void {
    const externalId = threadIdFrom(params.threadId);
    if (!externalId) {
      emitError(message.id, "thread/fork requires a thread id", -32602);
      return;
    }
    ensureCanonical(externalId, params, (route, error) => {
      if (!route) {
        emitError(message.id, error || "Unable to resolve conversation");
        return;
      }
      const selected = selectedModel(params, route);
      const native = nativeRuntimeForRoute(route);
      const nextParams = {
        ...stripRequestProvider(params),
        ...(route.settings || {}),
        threadId: route.nativeId,
        model: nativeModel(params, route),
        modelProvider: NATIVE_EGRESS_PROVIDER,
      };
      sendParent(native, message, "thread/fork", nextParams, {
        displayModel: selected,
        displayProvider: providerForModel(selected),
        onResponse: (response) => {
          if (!response.error) {
            const result = response.result && typeof response.result === "object" ? response.result as JsonRecord : {};
            const thread = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
            const nativeId = threadIdFrom(thread.id);
            if (nativeId) {
              saveRoute({
                externalId: nativeId,
                nativeId,
                nativePath: cleanString(thread.path) || undefined,
                selectedModel: selected,
                threadSource: threadSource(params) || route.threadSource,
                threadOrigin: threadOrigin(params) || route.threadOrigin,
                parentThreadId: parentThreadId(params) || route.parentThreadId,
              });
            }
          }
          return decorateParentResponse(response, {
            kind: "parent",
            id: message.id,
            method: "thread/fork",
            params: nextParams,
            runtime: native,
            displayModel: selected,
            displayProvider: providerForModel(selected),
          });
        },
      });
    });
  }

  function handleThreadList(message: JsonRecord, params: JsonRecord): void {
    const nextParams = normalizeThreadListParams(params);
    const runtimes = new Map<string, ProviderRuntime>();
    runtimes.set("default", ensureRuntime(NATIVE_PROVIDER));
    const hiddenLegacy = new Set<string>();
    for (const route of routes.values()) {
      if (route.legacySourceId && route.legacySourceId !== route.nativeId) hiddenLegacy.add(route.legacySourceId);
    }

    const project = (response: JsonRecord): JsonRecord => {
      const output = cloneValue(response);
      if (output.error) return output;
      const result = output.result && typeof output.result === "object" ? output.result as JsonRecord : {};
      const data = Array.isArray(result.data) ? result.data : [];
      const visible: JsonRecord[] = [];
      for (const rawEntry of data) {
        if (!rawEntry || typeof rawEntry !== "object") continue;
        const entry = cloneValue(rawEntry as JsonRecord);
        const id = threadIdFrom(entry.id);
        if (hiddenLegacy.has(id)) continue;
        const route = routeForNativeId(id);
        if (route) {
          entry.id = route.externalId;
          entry.model = route.selectedModel;
          entry.modelProvider = providerForModel(route.selectedModel);
        } else {
          const childDisplay = nativeSubagentDisplaySettings.get(id);
          if (childDisplay?.model) {
            entry.model = childDisplay.model;
            entry.modelProvider = providerForModel(childDisplay.model);
          }
          const model = modelSlug(entry.model);
          if (providerForModel(model) === GATEWAY_PROVIDER) {
            legacyThreads.set(id, { id, model, path: cleanString(entry.path) || undefined });
          }
        }
        // Codex Desktop consumes thread/list entries as conversation objects
        // and calls .turns.at(...) even when the list is not loaded. Keep the
        // contract stable for restored and native entries alike.
        if (!Array.isArray(entry.turns)) entry.turns = [];
        if (entry.id) visible.push(entry);
      }
      result.data = visible;
      output.result = result;
      return output;
    };

    const restoreMissingThirdPartyRoutes = (
      runtime: ProviderRuntime,
      seen: Set<string>,
      callback: (entries: JsonRecord[]) => void,
    ): void => {
      const candidates = Array.from(routes.values()).filter((route) =>
        providerForModel(route.selectedModel) === GATEWAY_PROVIDER
        && !seen.has(route.externalId)
        && !seen.has(route.nativeId)
        && !hiddenLegacy.has(route.nativeId),
      );
      if (!candidates.length) {
        callback([]);
        return;
      }

      const restored: JsonRecord[] = [];
      let remaining = candidates.length;
      const complete = (): void => {
        remaining -= 1;
        if (remaining === 0) callback(restored);
      };
      for (const route of candidates) {
        // A route can outlive the native app-server's in-memory list. Read
        // the same local native conversation directly before deciding that the
        // route is gone; this also avoids inventing sidebar entries for stale
        // map records whose physical conversation no longer exists.
        const readRoute = (allowArchiveRepair = true): void => sendInternal(
          runtime,
          "thread/read",
          { threadId: route.nativeId, includeTurns: false },
          (response) => {
          if (response.error
            && allowArchiveRepair
            && shouldRepairArchivedRoute(route)
            && isArchivedThreadResponse(response)) {
            restoreArchivedProviderRoute(route, runtime, (restoredRoute) => {
              if (restoredRoute) {
                readRoute(false);
                return;
              }
              complete();
            });
            return;
          }
          if (!response.error) {
            const result = response.result && typeof response.result === "object" ? response.result as JsonRecord : {};
            const thread = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
            const physicalId = threadIdFrom(thread.id);
            if (physicalId === route.nativeId || physicalId === route.externalId) {
              updateRouteNativePath(route, thread);
              const entry = cloneValue(thread);
              // A not-loaded thread still needs an empty turns array: Desktop
              // treats every list entry as a conversation object.
              entry.turns = [];
              entry.id = route.externalId;
              entry.model = route.selectedModel;
              entry.modelProvider = providerForModel(route.selectedModel);
              if (!entry.path && route.nativePath) entry.path = route.nativePath;
              if (!entry.cwd && route.settings?.cwd) entry.cwd = route.settings.cwd;
              restored.push(entry);
            }
          }
          complete();
          },
        );
        readRoute();
      }
    };

    const responses: JsonRecord[] = [];
    let remaining = runtimes.size;
    const finish = (): void => {
      if (remaining > 0) return;
      const projected = responses.map(project);
      const firstError = projected.find((response) => response.error);
      const successful = projected.filter((response) => !response.error);
      if (!successful.length) {
        const error = firstError?.error && typeof firstError.error === "object" ? firstError.error as JsonRecord : {};
        emitError(message.id, cleanString(error.message) || "Unable to list conversations");
        return;
      }
      const output = cloneValue(successful[0]);
      const result = output.result && typeof output.result === "object" ? output.result as JsonRecord : {};
      const seen = new Set<string>();
      const visible: JsonRecord[] = [];
      for (const response of successful) {
        const responseResult = response.result && typeof response.result === "object" ? response.result as JsonRecord : {};
        for (const entry of Array.isArray(responseResult.data) ? responseResult.data : []) {
          const id = threadIdFrom(entry?.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          visible.push(entry);
        }
      }
      const finishOutput = (restored: JsonRecord[] = []): void => {
        for (const entry of restored) {
          const id = threadIdFrom(entry.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          visible.push(entry);
        }
        result.data = visible;
        output.id = message.id;
        output.result = result;
        writeParent(output);
      };
      const native = runtimes.get("default");
      if (native) restoreMissingThirdPartyRoutes(native, seen, finishOutput);
      else finishOutput();
    };

    for (const runtime of runtimes.values()) {
      sendInternal(runtime, "thread/list", nextParams, (response) => {
        responses.push(response);
        remaining -= 1;
        finish();
      });
    }
  }

  function handleThreadRead(message: JsonRecord, params: JsonRecord): void {
    const externalId = threadIdFrom(params.threadId);
    if (!externalId) {
      emitError(message.id, "thread/read requires a thread id", -32602);
      return;
    }
    ensureCanonical(externalId, params, (route, error) => {
      if (!route) {
        emitError(message.id, error || "Unable to resolve conversation");
        return;
      }
      const selected = route.selectedModel || nativeDefaultModel();
      const native = nativeRuntimeForRoute(route);
      // Never forward the Desktop picker's provider-owned model or provider
      // name into this native read; model selection must not change the local
      // thread identity or make native thread/read reject the request.
      const nextParams = {
        ...stripRequestProvider(params),
        threadId: route.nativeId,
        model: nativeModel({}, route),
        modelProvider: NATIVE_PROVIDER,
        ...(params.includeTurns === undefined ? { includeTurns: true } : {}),
      };
      const childDisplay = nativeDisplaySettingsForRoute(route);
      let archiveRepairAttempted = false;
      const decoratedReadResponse = (response: JsonRecord): JsonRecord => {
        if (!response.error) {
          const result = response.result && typeof response.result === "object" ? response.result as JsonRecord : {};
          const thread = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
          updateRouteNativePath(route, thread);
          route.archived = false;
          saveRoute(route);
        }
        return decorateParentResponse(response, {
          kind: "parent",
          id: message.id,
          method: "thread/read",
          params: nextParams,
          runtime: native,
          externalThreadId: route.externalId,
          physicalThreadId: route.nativeId,
          displayModel: selected,
          displayProvider: providerForModel(selected),
          displayReasoning: childDisplay?.effort,
        });
      };
      const sendRead = (): void => {
        sendParent(native, message, "thread/read", nextParams, {
          externalThreadId: route.externalId,
          physicalThreadId: route.nativeId,
          displayModel: selected,
          displayProvider: providerForModel(selected),
          displayReasoning: childDisplay?.effort,
          onResponse: (response) => {
            if (response.error
              && !archiveRepairAttempted
              && shouldRepairArchivedRoute(route)
              && isArchivedThreadResponse(response)) {
              archiveRepairAttempted = true;
              restoreArchivedProviderRoute(route, native, (restored) => {
                if (restored) {
                  sendRead();
                  return;
                }
                writeParent(decoratedReadResponse(response));
              });
              return null;
            }
            return decoratedReadResponse(response);
          },
        });
      };
      sendRead();
    }, { preserveRequestedModel: true });
  }

  function handleSettings(message: JsonRecord, params: JsonRecord): void {
    const externalId = threadIdFrom(params.threadId);
    if (!externalId) {
      emitError(message.id, "thread/settings/update requires a thread id", -32602);
      return;
    }
    ensureCanonical(externalId, params, (route, error) => {
      if (!route) {
        emitError(message.id, error || "Unable to resolve conversation");
        return;
      }
      const selected = selectedModel(params, route);
      route.selectedModel = selected;
      failedProviderRoutes.delete(route.externalId);
      pendingSelectedModels.set(route.externalId, selected);
      rememberSettings(route, params);
      saveRoute(route);
      const isOfficialNativeModel = classifyRuntimeModel(selected) === NATIVE_PROVIDER;
      if (!isOfficialNativeModel || providerForModel(selected) === GATEWAY_PROVIDER) {
        writeParent({ id: message.id, result: {} });
        // Desktop can echo the native child default (low) immediately after
        // the gateway has selected the Profile's effort. Once the resolved
        // child value is known, it is authoritative for this routed thread.
        const childDisplay = isNativeSubagentThread(route)
          ? nativeDisplaySettingsForRoute(route)
          : undefined;
        const selectedEffort = childDisplay?.effort
          || cleanString(params.effort || params.reasoning_effort || params.reasoning?.effort);
        if (childDisplay?.effort) {
          applyDisplaySettingsToRoute(route, childDisplay);
          saveRoute(route);
        }
        emitSyntheticSettings(route.externalId, selected, selectedEffort || undefined);
        return;
      }
      const native = nativeRuntimeForRoute(route);
      const nextParams = { ...stripRequestProvider(params), threadId: route.nativeId, model: selected };
      sendParent(native, message, "thread/settings/update", nextParams, {
        externalThreadId: route.externalId,
        physicalThreadId: route.nativeId,
        displayModel: selected,
        displayProvider: NATIVE_PROVIDER,
      });
    });
  }

  function handleTurnStart(message: JsonRecord, params: JsonRecord): void {
    const externalId = threadIdFrom(params.threadId);
    if (!externalId) {
      emitError(message.id, "turn/start requires a thread id", -32602);
      return;
    }
    ensureCanonical(externalId, params, (route, error) => {
      if (!route) {
        emitError(message.id, error || "Unable to resolve conversation");
        return;
      }
      const selected = selectedTurnModel(params, route);
      const providerParams: JsonRecord = {
        ...params,
        input: normalizeLegacyTurnInput(params.input),
      };
      if (providerForModel(selected) === GATEWAY_PROVIDER) {
        // Codex Desktop may encode a screenshot as a legacy text marker in
        // turn/start. Normalize it before the native app-server forwards the
        // request through Native Egress; the gateway receives the same
        // semantic input_image that native GPT receives.
        const unsafeInputError = thirdPartyTurnInputError(providerParams);
        if (unsafeInputError) {
          // Only a genuinely oversized request is rejected. A normal image is
          // a first-class turn input and must not be treated as an error just
          // because it is represented by a data URL.
          emitError(message.id, unsafeInputError, -32602);
          return;
        }
      }
      route.selectedModel = selected;
      rememberSettings(route, params);
      saveRoute(route);
      if (providerForModel(selected) === GATEWAY_PROVIDER) {
        // Keep the native app-server as the sole owner of the local thread.
        // Native Egress reads the request-scoped model override and sends only
        // this turn to the HTTP gateway. The local app-server still owns the
        // same thread, history, archive state, and turn lifecycle.
        const native = nativeRuntimeForRoute(route);
        const childParams = isNativeSubagentThread(route)
          ? nativeSubagentTurnParams(providerParams, route, selected)
          : providerParams;
        sendNativeTurnAttempt(
          message,
          childParams,
          route,
          selected,
          native,
          route.nativeId,
          isNativeSubagentThread(route) ? nativeDefaultModel() : selected,
        );
        return;
      }
      const native = nativeRuntimeForRoute(route);
      sendNativeTurnAttempt(message, params, route, selected, native, route.nativeId);
    });
  }

  function handleActiveTurn(message: JsonRecord, method: string, params: JsonRecord): boolean {
    const externalId = threadIdFrom(params.threadId);
    const active = activeTurns.get(externalId);
    if (!externalId || !active) return false;
    const runtime = ensureRuntime(active.provider);
    const nextParams = { ...params, threadId: active.physicalThreadId };
    sendParent(runtime, message, method, nextParams, {
      externalThreadId: externalId,
      physicalThreadId: active.physicalThreadId,
    });
    if (method === "turn/interrupt") scheduleTurnInterruptWatchdog(externalId, active);
    return true;
  }

  function handleGenericThread(message: JsonRecord, method: string, params: JsonRecord): boolean {
    const externalId = threadIdFrom(params.threadId);
    if (!externalId) return false;
    ensureCanonical(externalId, params, (route, error) => {
      if (!route) {
        emitError(message.id, error || "Unable to resolve conversation");
        return;
      }
      const native = nativeRuntimeForRoute(route);
      const nextParams = { ...stripRequestProvider(params), threadId: route.nativeId };
      const archiveMutation = method === "thread/archive" || method === "thread/unarchive";
      sendParent(native, message, method, nextParams, {
        externalThreadId: route.externalId,
        physicalThreadId: route.nativeId,
        displayModel: route.selectedModel || nativeDefaultModel(),
        displayProvider: providerForModel(route.selectedModel || nativeDefaultModel()),
        onResponse: (response) => {
          if (!response.error && archiveMutation) {
            if (method === "thread/unarchive") {
              const result = response.result && typeof response.result === "object"
                ? response.result as JsonRecord
                : {};
              const thread = result.thread && typeof result.thread === "object"
                ? result.thread as JsonRecord
                : {};
              updateRouteNativePath(route, thread);
              route.archived = false;
            } else {
              route.archived = true;
            }
            saveRoute(route);
          }
          return decorateParentResponse(response, {
            kind: "parent",
            id: message.id,
            method,
            params: nextParams,
            runtime: native,
            externalThreadId: route.externalId,
            physicalThreadId: route.nativeId,
            displayModel: route.selectedModel || nativeDefaultModel(),
            displayProvider: providerForModel(route.selectedModel || nativeDefaultModel()),
          });
        },
      });
    }, { preserveRequestedModel: true });
    return true;
  }

  function rejectParentRequest(message: JsonRecord, error: unknown): void {
    const id = message.id;
    const reason = error instanceof Error ? error.message : String(error);
    if (id === undefined || id === null) return;
    const key = requestIdKey(id);
    // A synchronous route error must not leave a pending JSON-RPC entry behind
    // to answer a later turn. Remove only this parent request; other sessions
    // and their pending requests remain untouched.
    for (const [pendingKey, pending] of pendingRequests) {
      if (pending.kind === "parent" && requestIdKey(pending.id) === key) {
        pendingRequests.delete(pendingKey);
      }
    }
    emitError(id, reason || "Codex bridge request failed");
  }

  function handleParentMessage(message: JsonRecord): void {
    const method = cleanString(message.method);
    const params = message.params && typeof message.params === "object" ? message.params as JsonRecord : {};
    if (method === "initialize") {
      const native = ensureRuntime(NATIVE_PROVIDER);
      if (native.initialized) {
        writeParent({
          id: message.id,
          result: lastInitializeResult || {
            userAgent: "codex/1.0",
            codexHome: codexHomeDir(),
            platformFamily: process.platform === "win32" ? "windows" : "unix",
            platformOs: process.platform === "darwin" ? "macos" : process.platform,
          },
        });
      } else {
        pendingParentInitializations.push({ id: message.id });
      }
      return;
    }
    if (!method) {
      if (forwardParentServerResponse(message)) return;
      console.error(
        "[CodexSplit Provider Bridge] Ignoring unrouted parent JSON-RPC response: "
        + JSON.stringify(message),
      );
      return;
    }
    if (method === "thread/start") return handleThreadStart(message, params);
    if (method === "thread/resume") return handleThreadResume(message, params);
    if (method === "thread/fork") return handleThreadFork(message, params);
    if (method === "thread/list") return handleThreadList(message, params);
    if (method === "thread/read") return handleThreadRead(message, params);
    if (method === "thread/settings/update") return handleSettings(message, params);
    if (method === "turn/start") return handleTurnStart(message, params);
    if ((method === "turn/interrupt" || method === "turn/steer") && handleActiveTurn(message, method, params)) return;
    if (method.startsWith("thread/") && handleGenericThread(message, method, params)) return;
    if (method === "config/batchWrite") {
      // Desktop uses this startup write for feature snapshots. Forwarding it to
      // the child makes the native config loader re-merge ~/.codex/config.toml
      // and discard the per-process local Egress URL. The bridge owns that
      // process-scoped routing layer, so acknowledge the UI write here.
      writeParent({ id: message.id, result: {} });
      return;
    }
    const native = ensureRuntime(NATIVE_PROVIDER);
    sendParent(native, message, method, params);
  }

  ensureRuntime(NATIVE_PROVIDER);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    inputBuffer += chunk;
    const lines = inputBuffer.split(/\r?\n/);
    inputBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRecord;
      try {
        message = JSON.parse(line) as JsonRecord;
      } catch (error) {
        console.error("[CodexSplit Provider Bridge] Invalid parent message: " + (error instanceof Error ? error.message : String(error)));
        continue;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        console.error("[CodexSplit Provider Bridge] Invalid parent message: expected a JSON object");
        continue;
      }
      try {
        handleParentMessage(message);
      } catch (error) {
        console.error("[CodexSplit Provider Bridge] Parent request failed: " + (error instanceof Error ? error.message : String(error)));
        rejectParentRequest(message, error);
      }
    }
  });
  const stop = (): void => {
    bridgeStopping = true;
    for (const timer of runtimeRestartTimers.values()) clearTimeout(timer);
    runtimeRestartTimers.clear();
    runtimeRestartAttempts.clear();
    runtimeRecoveryQueues.clear();
    for (const [externalId, state] of subagentEventPollers) {
      if (state.timer) clearTimeout(state.timer);
      subagentEventPollers.delete(externalId);
    }
    for (const runtime of [...runtimes]) stopRuntime(runtime);
    nativeEgress.server.close();
    setImmediate(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  const entryArgs = process.argv.slice(2);
  const cliBridgeInvocation = entryArgs[0] === "--opencodex-cli";
  const run = cliBridgeInvocation
    ? runCliProviderBridge(entryArgs.slice(1))
    : runProviderBridge();
  void run.catch((error) => {
    console.error(`[CodexSplit Provider Bridge] Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
