/**
 * Provider-aware stdio bridge for the native Codex app-server.
 *
 * The native app-server has one provider configuration which it copies into
 * internally-created child agents. The bridge gives that runtime one local
 * provider multiplexer instead of a global gateway provider. The multiplexer
 * classifies every Responses request by its model: official models go
 * directly to ChatGPT, while namespaced/custom models go to the OpenCodex
 * gateway. The Desktop conversation and thread id stay shared.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copySafeResponseHeaders, writeHttpResponseChunked } from "./services/http_stream.js";
import { fetchUpstream, upstreamErrorDetails } from "./services/upstream_fetch.js";
import { copyNativeRequestHeaders } from "./server/webrtc_proxy.js";

export type CodexProvider = "openai" | "opencodex";

type JsonRecord = Record<string, any>;

type ProviderRuntime = {
  provider: CodexProvider;
  child: ChildProcessWithoutNullStreams;
  initialized: boolean;
  stopping: boolean;
  queue: Array<{ message: JsonRecord; pending?: PendingRequest }>;
};

type PendingParentRequest = {
  kind: "parent";
  id: unknown;
  method: string;
  params: JsonRecord;
  runtime: ProviderRuntime;
  externalThreadId?: string;
  physicalThreadId?: string;
  displayModel?: string;
  displayProvider?: CodexProvider;
  onResponse?: (message: JsonRecord) => JsonRecord | null;
};

type PendingInternalRequest = {
  kind: "internal";
  method: string;
  runtime: ProviderRuntime;
  suppressThreadId?: string;
  onResponse: (message: JsonRecord) => void;
};

type PendingRequest = PendingParentRequest | PendingInternalRequest;

type ThreadRoute = {
  externalId: string;
  nativeId: string;
  nativePath?: string;
  selectedModel: string;
  legacySourceId?: string;
  legacySourcePath?: string;
  legacyModel?: string;
  settings?: JsonRecord;
};

type LegacyThread = {
  id: string;
  model: string;
  path?: string;
};

type GatewayTurn = {
  externalThreadId: string;
  nativeThreadId: string;
  selectedModel: string;
  inputItems: JsonRecord[];
  assistantRawItems: JsonRecord[];
  assistantTextItems: JsonRecord[];
  physicalThreadId?: string;
  forwarding: boolean;
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
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
};

const NATIVE_PROVIDER: CodexProvider = "openai";
const GATEWAY_PROVIDER: CodexProvider = "opencodex";
// The native app-server has one provider field for the whole parent runtime
// and copies it into internally-created child configs. Keep that field on a
// local multiplexer so each HTTP request can be classified by its own model:
// official models go directly to ChatGPT, namespaced models go to 8765.
const NATIVE_RUNTIME_PROVIDER = "opencodex_native_router";
const MODEL_CATALOG_FILES = [
  path.join(os.homedir(), ".opencodex", "custom_model_catalog.json"),
  path.join(os.homedir(), ".codex", "models_cache.json"),
  path.join(os.homedir(), ".codex", "models_catalog.json"),
];

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
  const files = configured ? [configured, ...MODEL_CATALOG_FILES] : MODEL_CATALOG_FILES;
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
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
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

function requestIdKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function threadIdFrom(value: unknown): string {
  return cleanString(value);
}

function providerBridgeGatewayPort(): number {
  const configured = Number(process.env.OPENCODEX_GATEWAY_PORT || process.env.OPENCODEX_PORT || 8765);
  return Number.isFinite(configured) && configured > 0 && configured < 65536 ? Math.floor(configured) : 8765;
}

function providerBridgeAdminToken(): string {
  const configured = cleanString(process.env.OPENCODEX_ADMIN_TOKEN);
  if (configured) return configured;
  const configuredPath = cleanString(process.env.OPENCODEX_ADMIN_TOKEN_PATH);
  const candidates = [configuredPath, path.join(os.homedir(), ".opencodex", "admin_token")].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const token = cleanString(fs.readFileSync(candidate, "utf8"));
      if (token) return token;
    } catch {}
  }
  return "";
}

function providerBridgeExecutablePath(): string {
  const configured = cleanString(process.env.OPENCODEX_PROVIDER_BRIDGE_PATH)
    || cleanString(process.env.CODEX_CLI_PATH);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    path.join(moduleDir, "codex-provider-bridge"),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || "";
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

export function normalizeThreadListParams(params: JsonRecord = {}): JsonRecord {
  const nextParams = { ...params };
  nextParams.modelProviders = [];
  return nextParams;
}

function nativeCodexPath(): string {
  return cleanString(process.env.OPENCODEX_NATIVE_CODEX_PATH)
    || "/Applications/ChatGPT.app/Contents/Resources/codex";
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


async function runProviderBridge(): Promise<void> {
  const args = process.argv.slice(2);
  if (!isAppServerInvocation(args)) {
    passthroughNative(args);
    return;
  }

  const runtimeByProvider = new Map<CodexProvider, ProviderRuntime>();
  const runtimes = new Set<ProviderRuntime>();
  const pendingRequests = new Map<string, PendingRequest>();
  const outputBuffers = new Map<ProviderRuntime, string>();
  const legacyThreads = new Map<string, LegacyThread>();
  const pendingMigrations = new Map<string, Array<(route: ThreadRoute | null, error?: string) => void>>();
  const gatewayTurns = new Map<string, GatewayTurn>();
  const activeTurns = new Map<string, { provider: CodexProvider; physicalThreadId: string; parentTurnId?: string }>();
  const subagentEventPollers = new Map<string, SubagentEventPoller>();
  const gatewayPort = providerBridgeGatewayPort();
  const gatewayAdminToken = providerBridgeAdminToken();
  const pendingSelectedModels = new Map<string, string>();
  const suppressedNotifications = new Map<string, number>();
  const routes = loadThreadRoutes();
  const pendingParentInitializations: Array<{ id: unknown }> = [];
  let internalRequestCounter = 0;
  let inputBuffer = "";
  let bridgeStopping = false;
  let lastInitializeParams: JsonRecord | null = null;
  let lastInitializeResult: JsonRecord | null = null;

  const nativeRouter = http.createServer();
  let nativeRouterPort = 0;

  async function readNativeRouterBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += value.length;
      if (length > 64 * 1024 * 1024) throw new Error("native provider request body is too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async function forwardNativeRouterResponse(upstream: Response, response: http.ServerResponse): Promise<void> {
    response.writeHead(upstream.status, copySafeResponseHeaders(upstream.headers));
    if (upstream.body) {
      // @ts-ignore Node's fetch body is an async iterable at runtime.
      for await (const chunk of upstream.body) {
        await writeHttpResponseChunked(response, chunk);
      }
    }
    response.end();
  }

  async function handleNativeRouterRequest(req: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      response.writeHead(405, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "native provider router only accepts POST" }));
      return;
    }

    const rawBody = await readNativeRouterBody(req);
    let body: JsonRecord = {};
    try {
      const parsed = JSON.parse(rawBody.toString("utf8"));
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "native provider router received invalid JSON" }));
      return;
    }

    const model = modelSlug(body.model) || nativeDefaultModel();
    const provider = classifyRuntimeModel(model) || NATIVE_PROVIDER;
    const requestPath = String(req.url || "/v1/responses").split("?", 1)[0];
    const isCompaction = /responses\/compact$/i.test(requestPath);
    const officialTargetBase = cleanString(process.env.OPENCODEX_NATIVE_ROUTER_OPENAI_URL)
      || "https://chatgpt.com/backend-api/codex/responses";
    const nativeTarget = isCompaction
      ? `${officialTargetBase.replace(/\/$/, "")}/compact`
      : officialTargetBase;
    const gatewayTarget = `http://127.0.0.1:${gatewayPort}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`;
    const target = provider === NATIVE_PROVIDER ? nativeTarget : gatewayTarget;
    const headers = provider === NATIVE_PROVIDER
      ? copyNativeRequestHeaders(req, { localAdminToken: gatewayAdminToken }, true)
      : copyNativeRequestHeaders(req, { localAdminToken: gatewayAdminToken }, false);
    if (provider === GATEWAY_PROVIDER && gatewayAdminToken) {
      headers.authorization = `Bearer ${gatewayAdminToken}`;
    }

    console.log(
      `[OpenCodex Native Router] model=${model} route=`
      + (provider === NATIVE_PROVIDER ? "openai-direct" : `gateway:${gatewayPort}`),
    );
    try {
      const upstream = await fetchUpstream(target, {
        method: "POST",
        headers,
        body: rawBody as any,
        maxAttempts: 1,
        timeoutMs: 600_000,
        operation: provider === NATIVE_PROVIDER ? "native-router-openai" : "native-router-gateway",
      });
      await forwardNativeRouterResponse(upstream, response);
    } catch (error: any) {
      const details = upstreamErrorDetails(error);
      console.error(`[OpenCodex Native Router] upstream failed route=${provider === NATIVE_PROVIDER ? "openai-direct" : "gateway"}`, {
        ...details,
        attempts: error?.attempts,
      });
      if (!response.headersSent) {
        response.writeHead(provider === NATIVE_PROVIDER ? 502 : 503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          error: details.message,
          type: "native_provider_router_upstream_unreachable",
          route: provider === NATIVE_PROVIDER ? "openai-direct" : "gateway",
        }));
      }
    }
  }

  nativeRouter.on("request", (req, response) => {
    void handleNativeRouterRequest(req, response).catch((error: any) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error?.message || error || "native provider router failed") }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    nativeRouter.once("error", reject);
    nativeRouter.listen(0, "127.0.0.1", () => {
      nativeRouter.off("error", reject);
      const address = nativeRouter.address();
      nativeRouterPort = address && typeof address === "object" ? address.port : 0;
      if (!nativeRouterPort) reject(new Error("native provider router did not receive a port"));
      else resolve();
    });
  });
  console.log(`[OpenCodex Native Router] listening on http://127.0.0.1:${nativeRouterPort}/v1`);

  function statePath(): string {
    const configured = cleanString(process.env.OPENCODEX_PROVIDER_SESSION_MAP_PATH);
    if (configured) return configured;
    const dataDir = cleanString(process.env.OPENCODEX_DATA_DIR);
    return path.join(dataDir || path.join(os.homedir(), ".opencodex"), "provider-session-routes.json");
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
        const nativeId = cleanString(value.nativeId);
        if (!externalId || !nativeId) continue;
        result.set(externalId, {
          externalId,
          nativeId,
          nativePath: cleanString(value.nativePath) || undefined,
          selectedModel: cleanString(value.selectedModel) || nativeDefaultModel(),
          legacySourceId: cleanString(value.legacySourceId) || undefined,
          legacySourcePath: cleanString(value.legacySourcePath) || undefined,
          legacyModel: cleanString(value.legacyModel) || undefined,
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
          selectedModel: route.selectedModel,
          legacySourceId: route.legacySourceId,
          legacySourcePath: route.legacySourcePath,
          legacyModel: route.legacyModel,
        };
      }
      const tempFile = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tempFile, JSON.stringify({ version: 1, threads }, null, 2), { mode: 0o600 });
      fs.renameSync(tempFile, file);
    } catch (error) {
      console.warn("[OpenCodex Provider Bridge] Could not persist session routes: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  function saveRoute(route: ThreadRoute): ThreadRoute {
    routes.set(route.externalId, route);
    persistRoutes();
    return route;
  }

  function requestKey(runtime: ProviderRuntime, id: unknown): string {
    return runtime.provider + "\u0000" + requestIdKey(id);
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

  function selectedModel(params: JsonRecord, route?: ThreadRoute): string {
    return modelSlug(params.model) || route?.selectedModel || nativeDefaultModel();
  }

  function selectedTurnModel(params: JsonRecord, route: ThreadRoute): string {
    const explicit = modelSlug(params.model);
    // Some Desktop revisions report only an OpenAI provider after the user
    // changes away from a failed third-party turn. Treat that as native
    // selection, never as a reason to reuse the dead third-party route.
    if (!explicit && normalizeProvider(params.modelProvider) === NATIVE_PROVIDER) {
      return nativeModel(params, route);
    }
    const pending = pendingSelectedModels.get(route.externalId);
    if (pending) return pending;
    if (explicit) return explicit;
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
    const message = cleanString(task.error) || (isCancelled ? "子代理取消请求已记录" : "");
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
        if (Number.isFinite(createdAt) && createdAt < state.startedAt) continue;
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

  function decorateThreadModel(value: any, model?: string, provider?: CodexProvider): void {
    if (!value || typeof value !== "object" || !model) return;
    if (Array.isArray(value)) {
      for (const entry of value) decorateThreadModel(entry, model, provider);
      return;
    }
    const record = value as JsonRecord;
    const modelProvider = provider || providerForModel(model);
    if (record.thread && typeof record.thread === "object") {
      const thread = record.thread as JsonRecord;
      thread.model = model;
      thread.modelProvider = modelProvider;
    }
    if (record.threadSettings && typeof record.threadSettings === "object") {
      const settings = record.threadSettings as JsonRecord;
      settings.model = model;
      settings.modelProvider = modelProvider;
    }
    if (
      typeof record.id === "string"
      && ("model" in record || "modelProvider" in record || "path" in record || "turns" in record || "cwd" in record)
    ) {
      record.model = model;
      record.modelProvider = modelProvider;
    }
    for (const child of Object.values(record)) decorateThreadModel(child, model, provider);
  }

  function decorateParentResponse(message: JsonRecord, pending: PendingParentRequest): JsonRecord {
    const output = cloneValue(message);
    if (pending.externalThreadId && pending.physicalThreadId) {
      rewriteThreadIds(output, pending.physicalThreadId, pending.externalThreadId);
    }
    if (pending.displayModel) decorateThreadModel(output, pending.displayModel, pending.displayProvider);
    return output;
  }

  function toUserResponseItems(input: unknown): JsonRecord[] {
    if (!Array.isArray(input)) return [];
    const content: JsonRecord[] = [];
    for (const part of input) {
      if (!part || typeof part !== "object") continue;
      const value = part as JsonRecord;
      const type = cleanString(value.type);
      if (type === "text" && cleanString(value.text)) {
        content.push({ type: "input_text", text: cleanString(value.text) });
      } else if (type === "image" && cleanString(value.url)) {
        content.push({ type: "input_text", text: "[Image: " + cleanString(value.url) + "]" });
      } else if (type === "localImage" && cleanString(value.path)) {
        content.push({ type: "input_text", text: "[Local image: " + cleanString(value.path) + "]" });
      } else if ((type === "skill" || type === "mention") && (cleanString(value.name) || cleanString(value.path))) {
        content.push({ type: "input_text", text: "[" + type + ": " + (cleanString(value.name) || cleanString(value.path)) + "]" });
      }
    }
    return content.length ? [{ type: "message", role: "user", content }] : [];
  }

  function historyToResponseItems(thread: unknown): JsonRecord[] {
    if (!thread || typeof thread !== "object") return [];
    const items: JsonRecord[] = [];
    const turns = Array.isArray((thread as JsonRecord).turns) ? (thread as JsonRecord).turns : [];
    for (const turn of turns) {
      const turnItems = turn && typeof turn === "object" && Array.isArray((turn as JsonRecord).items)
        ? (turn as JsonRecord).items
        : [];
      for (const entry of turnItems) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as JsonRecord;
        if (item.type === "userMessage") {
          items.push(...toUserResponseItems(item.content));
        } else if (item.type === "agentMessage" && cleanString(item.text)) {
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: cleanString(item.text) }],
          });
        }
      }
    }
    return items;
  }

  function emitSyntheticSettings(threadId: string, model: string): void {
    writeParent({
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: {
          model,
          modelProvider: providerForModel(model),
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
    if (pending && message.id !== undefined && message.id !== null) {
      pendingRequests.set(requestKey(runtime, message.id), pending);
    }
    runtime.child.stdin.write(JSON.stringify(message) + "\n");
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

  function failRuntime(runtime: ProviderRuntime, reason: string): void {
    const matched = [...pendingRequests.entries()].filter(([, entry]) => entry.runtime === runtime);
    for (const [key, entry] of matched) {
      pendingRequests.delete(key);
      const error = responseError(entry.kind === "parent" ? entry.id : undefined, reason);
      if (entry.kind === "internal") entry.onResponse(error);
      else emitError(entry.id, reason);
    }
    for (const queued of runtime.queue.splice(0)) {
      if (!queued.pending) continue;
      const error = responseError(queued.message.id, reason);
      if (queued.pending.kind === "internal") queued.pending.onResponse(error);
      else emitError(queued.pending.id, reason);
    }
    if (runtime.provider === NATIVE_PROVIDER) {
      while (pendingParentInitializations.length > 0) {
        const parent = pendingParentInitializations.shift();
        if (parent) emitError(parent.id, reason);
      }
    }
  }

  function stopRuntime(runtime: ProviderRuntime): void {
    if (runtime.stopping) return;
    runtime.stopping = true;
    failRuntime(runtime, "Codex " + runtime.provider + " app-server stopped");
    if (!runtime.child.killed) runtime.child.kill("SIGTERM");
    runtimes.delete(runtime);
    if (runtimeByProvider.get(runtime.provider) === runtime) runtimeByProvider.delete(runtime.provider);
  }

  function nativeRuntimeArgs(): string[] {
    const routerConfig = [
      "-c", `model_provider=${NATIVE_RUNTIME_PROVIDER}`,
      "-c", `model_providers.${NATIVE_RUNTIME_PROVIDER}.name=OpenCodexNativeRouter`,
      "-c", `model_providers.${NATIVE_RUNTIME_PROVIDER}.base_url=http://127.0.0.1:${nativeRouterPort}/v1`,
      "-c", `model_providers.${NATIVE_RUNTIME_PROVIDER}.wire_api=responses`,
      "-c", `model_providers.${NATIVE_RUNTIME_PROVIDER}.requires_openai_auth=false`,
    ];
    const appServerIndex = args.indexOf("app-server");
    if (appServerIndex < 0) return [...routerConfig, ...args];
    return [
      ...args.slice(0, appServerIndex),
      ...routerConfig,
      ...args.slice(appServerIndex),
    ];
  }

  function consumeOutput(runtime: ProviderRuntime, chunk: Buffer | string): void {
    const previous = outputBuffers.get(runtime) || "";
    const lines = (previous + chunk.toString()).split(/\r?\n/);
    outputBuffers.set(runtime, lines.pop() || "");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleChildMessage(runtime, JSON.parse(line) as JsonRecord, line);
      } catch {
        process.stdout.write(line + "\n");
      }
    }
  }

  function spawnRuntime(provider: CodexProvider): ProviderRuntime {
    const bridge = providerBridgeExecutablePath();
    const childArgs = provider === NATIVE_PROVIDER ? nativeRuntimeArgs() : args;
    const child = spawn(nativeCodexPath(), childArgs, {
      env: {
        ...process.env,
        // Native Codex owns the child-agent lifecycle. Keep its child
        // launcher on this bridge so each child can be classified by its own
        // model: official GPT stays native, namespaced models enter the
        // gateway. Do not route every child based on the parent runtime.
        ...(bridge ? {
          CODEX_CLI_PATH: bridge,
          OPENCODEX_PROVIDER_BRIDGE_PATH: bridge,
        } : {}),
        OPENCODEX_PROVIDER_BRIDGE_RUNTIME: provider,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const runtime: ProviderRuntime = { provider, child, initialized: false, stopping: false, queue: [] };
    runtimes.add(runtime);
    runtimeByProvider.set(provider, runtime);
    outputBuffers.set(runtime, "");
    child.stdout.on("data", (chunk) => consumeOutput(runtime, chunk));
    child.stderr.pipe(process.stderr);
    child.once("error", (error) => {
      if (!runtime.stopping) {
        console.error("[OpenCodex Provider Bridge] " + provider + " app-server failed: " + error.message);
        failRuntime(runtime, "Codex " + provider + " app-server failed: " + error.message);
      }
    });
    child.once("exit", (code, signal) => {
      outputBuffers.delete(runtime);
      runtimes.delete(runtime);
      if (runtimeByProvider.get(provider) === runtime) runtimeByProvider.delete(provider);
      if (!runtime.stopping && !bridgeStopping) {
        failRuntime(runtime, "Codex " + provider + " app-server exited (" + (signal || code || "unknown") + ")");
      }
    });
    const initializeId = "opencodex-provider-initialize-" + (++internalRequestCounter);
    const initializeParams = lastInitializeParams || {
      clientInfo: { name: "OpenCodex Provider Bridge", version: "1.1.5" },
      capabilities: { experimentalApi: true, requestAttestation: true },
    };
    pendingRequests.set(requestKey(runtime, initializeId), {
      kind: "internal",
      method: "initialize",
      runtime,
      onResponse: (message) => {
        if (message.error) {
          failRuntime(runtime, "Codex " + provider + " initialization failed: " + (cleanString(message.error.message) || "unknown error"));
          return;
        }
        if (message.result && typeof message.result === "object") lastInitializeResult = message.result as JsonRecord;
        runtime.initialized = true;
        if (provider === NATIVE_PROVIDER) {
          while (pendingParentInitializations.length > 0) {
            const parent = pendingParentInitializations.shift();
            if (!parent) continue;
            writeParent({
              id: parent.id,
              result: lastInitializeResult || {
                userAgent: "codex/1.0",
                codexHome: path.join(os.homedir(), ".codex"),
                platformFamily: process.platform === "win32" ? "windows" : "unix",
                platformOs: process.platform === "darwin" ? "macos" : process.platform,
              },
            });
          }
        }
        flushQueue(runtime);
      },
    });
    child.stdin.write(JSON.stringify({ id: initializeId, method: "initialize", params: initializeParams }) + "\n");
    return runtime;
  }

  function ensureRuntime(provider: CodexProvider): ProviderRuntime {
    const existing = runtimeByProvider.get(provider);
    return existing && !existing.stopping ? existing : spawnRuntime(provider);
  }

  function finishGatewayTurn(turn: GatewayTurn, completed: JsonRecord): void {
    const finish = () => {
      if (turn.physicalThreadId) gatewayTurns.delete(turn.physicalThreadId);
      activeTurns.delete(turn.externalThreadId);
      drainSubagentEventPolling(turn.externalThreadId);
      const output = cloneValue(completed);
      if (turn.physicalThreadId) rewriteThreadIds(output, turn.physicalThreadId, turn.externalThreadId);
      writeParent(output);
    };
    const items = turn.assistantRawItems.length ? turn.assistantRawItems : turn.assistantTextItems;
    if (!items.length) {
      finish();
      return;
    }
    const native = ensureRuntime(NATIVE_PROVIDER);
    sendInternal(native, "thread/inject_items", { threadId: turn.nativeThreadId, items }, (response) => {
      if (response.error) {
        console.warn("[OpenCodex Provider Bridge] Could not mirror third-party reply: " + cleanString(response.error.message));
      }
      finish();
    }, turn.nativeThreadId);
  }

  function handleGatewayNotification(runtime: ProviderRuntime, message: JsonRecord): JsonRecord | null {
    const params = message.params && typeof message.params === "object" ? message.params as JsonRecord : {};
    const thread = params.thread && typeof params.thread === "object" ? params.thread as JsonRecord : {};
    const physicalId = threadIdFrom(params.threadId || thread.id);
    const turn = gatewayTurns.get(physicalId);
    if (!turn || !turn.forwarding) return null;
    if (message.method === "rawResponseItem/completed") {
      const raw = params.item && typeof params.item === "object" ? params.item as JsonRecord : {};
      if (raw.type === "message" && cleanString(raw.role).toLowerCase() === "assistant") {
        turn.assistantRawItems.push(raw);
      }
    } else if (message.method === "item/completed") {
      const item = params.item && typeof params.item === "object" ? params.item as JsonRecord : {};
      if (item.type === "agentMessage" && cleanString(item.text)) {
        turn.assistantTextItems.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: cleanString(item.text) }],
        });
      }
    } else if (message.method === "turn/completed") {
      turn.forwarding = false;
      drainSubagentEventPolling(turn.externalThreadId);
      finishGatewayTurn(turn, message);
      return null;
    }
    const output = cloneValue(message);
    rewriteThreadIds(output, physicalId, turn.externalThreadId);
    return output;
  }

  function handleNativeNotification(runtime: ProviderRuntime, message: JsonRecord): JsonRecord | null {
    const params = message.params && typeof message.params === "object" ? message.params as JsonRecord : {};
    const thread = params.thread && typeof params.thread === "object" ? params.thread as JsonRecord : {};
    const nativeId = threadIdFrom(params.threadId || thread.id);
    if (nativeId && isSuppressed(runtime, nativeId)) return null;
    const route = nativeId ? routeForNativeId(nativeId) : null;
    if (!route) return message;
    const output = cloneValue(message);
    rewriteThreadIds(output, route.nativeId, route.externalId);
    decorateThreadModel(output, route.selectedModel, providerForModel(route.selectedModel));
    if (message.method === "turn/started") {
      const active = activeTurns.get(route.externalId);
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
    if (message.method === "turn/completed") {
      drainSubagentEventPolling(route.externalId);
      activeTurns.delete(route.externalId);
    }
    return output;
  }

  function handleChildMessage(runtime: ProviderRuntime, message: JsonRecord, rawLine: string): void {
    if (runtime.stopping) return;
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
    if (typeof message.method === "string") {
      const output = runtime.provider === GATEWAY_PROVIDER
        ? handleGatewayNotification(runtime, message)
        : handleNativeNotification(runtime, message);
      if (output) writeParent(output);
      return;
    }
    process.stdout.write(rawLine + "\n");
  }

  function finishMigration(externalId: string, route: ThreadRoute | null, error?: string): void {
    const callbacks = pendingMigrations.get(externalId) || [];
    pendingMigrations.delete(externalId);
    for (const callback of callbacks) callback(route, error);
  }

  function migrateLegacy(
    externalId: string,
    params: JsonRecord,
    legacy: LegacyThread,
    callback: (route: ThreadRoute | null, error?: string) => void,
  ): void {
    const queued = pendingMigrations.get(externalId);
    if (queued) {
      queued.push(callback);
      return;
    }
    pendingMigrations.set(externalId, [callback]);
    const useRead = (read: JsonRecord, allowGatewayFallback: boolean): void => {
      if (read.error) {
        if (allowGatewayFallback) {
          const gateway = ensureRuntime(GATEWAY_PROVIDER);
          sendInternal(gateway, "thread/read", { threadId: externalId, includeTurns: true }, (fallback) => {
            useRead(fallback, false);
          });
          return;
        }
        finishMigration(externalId, null, "Unable to read existing conversation: " + (cleanString(read.error.message) || "thread not found"));
        return;
      }
      const result = read.result && typeof read.result === "object" ? read.result as JsonRecord : {};
      const sourceThread = result.thread && typeof result.thread === "object" ? result.thread as JsonRecord : {};
      const native = ensureRuntime(NATIVE_PROVIDER);
      const startParams: JsonRecord = {
        ...(params.cwd ? { cwd: params.cwd } : sourceThread.cwd ? { cwd: sourceThread.cwd } : {}),
        model: nativeDefaultModel(),
        modelProvider: NATIVE_RUNTIME_PROVIDER,
        threadSource: "user",
      };
      sendInternal(native, "thread/start", startParams, (started) => {
        if (started.error) {
          finishMigration(externalId, null, "Unable to create native conversation: " + cleanString(started.error.message));
          return;
        }
        const startedResult = started.result && typeof started.result === "object" ? started.result as JsonRecord : {};
        const thread = startedResult.thread && typeof startedResult.thread === "object" ? startedResult.thread as JsonRecord : {};
        const nativeId = threadIdFrom(thread.id);
        if (!nativeId) {
          finishMigration(externalId, null, "Unable to create native conversation: no thread id returned");
          return;
        }
        const route = saveRoute({
          externalId,
          nativeId,
          nativePath: cleanString(thread.path) || undefined,
          selectedModel: modelSlug(params.model) || legacy.model || nativeDefaultModel(),
          legacySourceId: externalId,
          legacySourcePath: legacy.path,
          legacyModel: legacy.model,
        });
        rememberSettings(route, params);
        const history = historyToResponseItems(sourceThread);
        const done = () => {
          const name = cleanString(sourceThread.name);
          if (!name) {
            finishMigration(externalId, route);
            return;
          }
          sendInternal(native, "thread/name/set", { threadId: nativeId, name }, () => {
            finishMigration(externalId, route);
          }, nativeId);
        };
        if (!history.length) {
          done();
          return;
        }
        sendInternal(native, "thread/inject_items", { threadId: nativeId, items: history }, (injected) => {
          if (injected.error) {
            finishMigration(externalId, null, "Unable to copy existing conversation history: " + cleanString(injected.error.message));
            return;
          }
          done();
        }, nativeId);
      });
    };
    const native = ensureRuntime(NATIVE_PROVIDER);
    sendInternal(native, "thread/read", { threadId: externalId, includeTurns: true }, (read) => {
      useRead(read, true);
    });
  }

  function ensureCanonical(
    externalId: string,
    params: JsonRecord,
    callback: (route: ThreadRoute | null, error?: string) => void,
  ): void {
    const existing = routes.get(externalId);
    const requested = modelSlug(params.model);
    if (existing) {
      if (requested) {
        existing.selectedModel = requested;
        rememberSettings(existing, params);
        saveRoute(existing);
      }
      callback(existing);
      return;
    }
    const legacy = legacyThreads.get(externalId);
    const savedModel = requested || legacy?.model || "";
    if (providerForModel(savedModel) === GATEWAY_PROVIDER) {
      migrateLegacy(externalId, params, legacy || { id: externalId, model: savedModel }, callback);
      return;
    }
    const createDirectRoute = (): void => {
      const route = saveRoute({
        externalId,
        nativeId: externalId,
        selectedModel: savedModel || nativeDefaultModel(),
      });
      rememberSettings(route, params);
      callback(route);
    };
    // A fresh Desktop may resume a legacy third-party thread before it has
    // asked for thread/list, so there is no catalog hint yet. Read only the
    // local rollout metadata first; if it says third-party, migrate it into a
    // native canonical thread instead of ever resuming it as OpenAI.
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
            migrateLegacy(externalId, params, discovered, callback);
            return;
          }
        }
        createDirectRoute();
      });
      return;
    }
    createDirectRoute();
  }

  function beginGatewayTurn(parent: JsonRecord, params: JsonRecord, route: ThreadRoute, model: string): void {
    const native = ensureRuntime(NATIVE_PROVIDER);
    const turn: GatewayTurn = {
      externalThreadId: route.externalId,
      nativeThreadId: route.nativeId,
      selectedModel: model,
      inputItems: toUserResponseItems(params.input),
      assistantRawItems: [],
      assistantTextItems: [],
      forwarding: false,
    };
    sendInternal(native, "thread/read", { threadId: route.nativeId, includeTurns: true }, (historyRead) => {
      if (historyRead.error) {
        emitError(parent.id, "Unable to read shared conversation history: " + cleanString(historyRead.error.message));
        return;
      }
      const historyResult = historyRead.result && typeof historyRead.result === "object" ? historyRead.result as JsonRecord : {};
      const history = historyToResponseItems(historyResult.thread);
      const gateway = ensureRuntime(GATEWAY_PROVIDER);
      const startParams: JsonRecord = {
        ...(route.settings || {}),
        model,
        modelProvider: GATEWAY_PROVIDER,
        ephemeral: true,
        experimentalRawEvents: true,
        threadSource: "user",
      };
      sendInternal(gateway, "thread/start", startParams, (started) => {
        if (started.error) {
          emitError(parent.id, "Unable to activate third-party model " + model + ": " + cleanString(started.error.message));
          return;
        }
        const startedResult = started.result && typeof started.result === "object" ? started.result as JsonRecord : {};
        const thread = startedResult.thread && typeof startedResult.thread === "object" ? startedResult.thread as JsonRecord : {};
        const gatewayId = threadIdFrom(thread.id);
        if (!gatewayId) {
          emitError(parent.id, "Unable to activate third-party model " + model + ": no thread id returned");
          return;
        }
        turn.physicalThreadId = gatewayId;
        const runTurn = (): void => {
          turn.forwarding = true;
          gatewayTurns.set(gatewayId, turn);
          activeTurns.set(route.externalId, { provider: GATEWAY_PROVIDER, physicalThreadId: gatewayId });
          startSubagentEventPolling(route.externalId);
          const turnParams = stripRequestProvider({ ...params, threadId: gatewayId, model });
          sendParent(gateway, parent, "turn/start", turnParams, {
            externalThreadId: route.externalId,
            physicalThreadId: gatewayId,
            displayModel: model,
            displayProvider: GATEWAY_PROVIDER,
            onResponse: (response) => {
              if (response.error) {
                gatewayTurns.delete(gatewayId);
                activeTurns.delete(route.externalId);
                drainSubagentEventPolling(route.externalId);
              }
              return decorateParentResponse(response, {
                kind: "parent",
                id: parent.id,
                method: "turn/start",
                params: turnParams,
                runtime: gateway,
                externalThreadId: route.externalId,
                physicalThreadId: gatewayId,
                displayModel: model,
                displayProvider: GATEWAY_PROVIDER,
              });
            },
          });
        };
        const mirrorUser = (): void => {
          if (!turn.inputItems.length) {
            runTurn();
            return;
          }
          sendInternal(native, "thread/inject_items", { threadId: route.nativeId, items: turn.inputItems }, (injected) => {
            if (injected.error) {
              emitError(parent.id, "Unable to update shared conversation history: " + cleanString(injected.error.message));
              return;
            }
            runTurn();
          }, route.nativeId);
        };
        if (!history.length) {
          mirrorUser();
          return;
        }
        sendInternal(gateway, "thread/inject_items", { threadId: gatewayId, items: history }, (injected) => {
          if (injected.error) {
            emitError(parent.id, "Unable to prepare third-party conversation: " + cleanString(injected.error.message));
            return;
          }
          mirrorUser();
        }, gatewayId);
      });
    });
  }

  function handleThreadStart(message: JsonRecord, params: JsonRecord): void {
    const selected = selectedModel(params);
    const physicalModel = providerForModel(selected) === NATIVE_PROVIDER ? selected : nativeDefaultModel();
    const native = ensureRuntime(NATIVE_PROVIDER);
    const nextParams = { ...stripRequestProvider(params), model: physicalModel, modelProvider: NATIVE_RUNTIME_PROVIDER };
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
            });
            rememberSettings(route, params);
          }
        }
        return decorateParentResponse(response, {
          kind: "parent",
          id: message.id,
          method: "thread/start",
          params: nextParams,
          runtime: native,
          displayModel: selected,
          displayProvider: providerForModel(selected),
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
      const selected = selectedModel(params, route);
      route.selectedModel = selected;
      rememberSettings(route, params);
      saveRoute(route);
      const native = ensureRuntime(NATIVE_PROVIDER);
      const nextParams: JsonRecord = {
        ...stripRequestProvider(params),
        ...(route.settings || {}),
        threadId: route.nativeId,
        model: nativeModel(params, route),
        modelProvider: NATIVE_RUNTIME_PROVIDER,
      };
      delete nextParams.path;
      if (route.nativePath) nextParams.path = route.nativePath;
      sendParent(native, message, "thread/resume", nextParams, {
        externalThreadId: externalId,
        physicalThreadId: route.nativeId,
        displayModel: selected,
        displayProvider: providerForModel(selected),
      });
    });
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
      const native = ensureRuntime(NATIVE_PROVIDER);
      const nextParams = {
        ...stripRequestProvider(params),
        ...(route.settings || {}),
        threadId: route.nativeId,
        model: nativeModel(params, route),
        modelProvider: NATIVE_RUNTIME_PROVIDER,
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
    const native = ensureRuntime(NATIVE_PROVIDER);
    const nextParams = normalizeThreadListParams(params);
    sendParent(native, message, "thread/list", nextParams, {
      onResponse: (response) => {
        if (response.error) return response;
        const output = cloneValue(response);
        const result = output.result && typeof output.result === "object" ? output.result as JsonRecord : {};
        const data = Array.isArray(result.data) ? result.data : [];
        const hiddenLegacy = new Set<string>();
        for (const route of routes.values()) {
          if (route.legacySourceId && route.legacySourceId !== route.nativeId) hiddenLegacy.add(route.legacySourceId);
        }
        const visible: JsonRecord[] = [];
        const seen = new Set<string>();
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
            const model = modelSlug(entry.model);
            if (providerForModel(model) === GATEWAY_PROVIDER) {
              legacyThreads.set(id, { id, model, path: cleanString(entry.path) || undefined });
            }
          }
          if (!entry.id || seen.has(entry.id)) continue;
          seen.add(entry.id);
          visible.push(entry);
        }
        result.data = visible;
        output.result = result;
        return output;
      },
    });
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
      const native = ensureRuntime(NATIVE_PROVIDER);
      const nextParams = { ...params, threadId: route.nativeId };
      sendParent(native, message, "thread/read", nextParams, {
        externalThreadId: route.externalId,
        physicalThreadId: route.nativeId,
        displayModel: route.selectedModel,
        displayProvider: providerForModel(route.selectedModel),
      });
    });
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
      pendingSelectedModels.set(route.externalId, selected);
      rememberSettings(route, params);
      saveRoute(route);
      if (providerForModel(selected) === GATEWAY_PROVIDER) {
        writeParent({ id: message.id, result: {} });
        emitSyntheticSettings(route.externalId, selected);
        return;
      }
      const native = ensureRuntime(NATIVE_PROVIDER);
      const nextParams = {
        ...stripRequestProvider(params),
        threadId: route.nativeId,
        model: selected,
        modelProvider: NATIVE_RUNTIME_PROVIDER,
      };
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
      route.selectedModel = selected;
      rememberSettings(route, params);
      saveRoute(route);
      if (providerForModel(selected) === GATEWAY_PROVIDER) {
        beginGatewayTurn(message, params, route, selected);
        return;
      }
      const native = ensureRuntime(NATIVE_PROVIDER);
      const nextParams = {
        ...stripRequestProvider({ ...params, threadId: route.nativeId, model: selected }),
        modelProvider: NATIVE_RUNTIME_PROVIDER,
      };
      activeTurns.set(route.externalId, { provider: NATIVE_PROVIDER, physicalThreadId: route.nativeId });
      startSubagentEventPolling(route.externalId);
      sendParent(native, message, "turn/start", nextParams, {
        externalThreadId: route.externalId,
        physicalThreadId: route.nativeId,
        displayModel: selected,
        displayProvider: NATIVE_PROVIDER,
        onResponse: (response) => {
          if (response.error) {
            activeTurns.delete(route.externalId);
            drainSubagentEventPolling(route.externalId);
          }
          return decorateParentResponse(response, {
            kind: "parent",
            id: message.id,
            method: "turn/start",
            params: nextParams,
            runtime: native,
            externalThreadId: route.externalId,
            physicalThreadId: route.nativeId,
            displayModel: selected,
            displayProvider: NATIVE_PROVIDER,
          });
        },
      });
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
      const native = ensureRuntime(NATIVE_PROVIDER);
      const nextParams = { ...stripRequestProvider(params), threadId: route.nativeId };
      const realtimeMethod = method.toLowerCase();
      if (realtimeMethod.includes("realtime") && /(start|resume|connect)/.test(realtimeMethod)) {
        startSubagentEventPolling(route.externalId, threadIdFrom(params.turnId || params.turn_id) || undefined);
      }
      if (realtimeMethod.includes("realtime") && /(close|stop|disconnect)/.test(realtimeMethod)) {
        drainSubagentEventPolling(route.externalId);
      }
      sendParent(native, message, method, nextParams, {
        externalThreadId: route.externalId,
        physicalThreadId: route.nativeId,
        displayModel: route.selectedModel,
        displayProvider: providerForModel(route.selectedModel),
      });
    });
    return true;
  }

  function handleParentMessage(message: JsonRecord): void {
    const method = cleanString(message.method);
    const params = message.params && typeof message.params === "object" ? message.params as JsonRecord : {};
    if (method === "initialize") {
      const parentCapabilities = params.capabilities && typeof params.capabilities === "object" ? params.capabilities : {};
      lastInitializeParams = {
        ...params,
        capabilities: {
          experimentalApi: true,
          requestAttestation: true,
          ...parentCapabilities,
        },
      };
      const native = ensureRuntime(NATIVE_PROVIDER);
      if (native.initialized) {
        writeParent({
          id: message.id,
          result: lastInitializeResult || {
            userAgent: "codex/1.0",
            codexHome: path.join(os.homedir(), ".codex"),
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
      const native = ensureRuntime(NATIVE_PROVIDER);
      sendParent(native, message, "", params);
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
      try {
        handleParentMessage(JSON.parse(line) as JsonRecord);
      } catch (error) {
        console.error("[OpenCodex Provider Bridge] Invalid parent message: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  });
  const stop = (): void => {
    bridgeStopping = true;
    for (const [externalId, state] of subagentEventPollers) {
      if (state.timer) clearTimeout(state.timer);
      subagentEventPollers.delete(externalId);
    }
    for (const runtime of [...runtimes]) stopRuntime(runtime);
    nativeRouter.close(() => setImmediate(() => process.exit(0)));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) runProviderBridge();
