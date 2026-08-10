import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ResponsesStreamEngine } from "../core/stream_engine.js";
import { buildGatewaySubagentResponseTool, isSubagentDispatchToolName, stripSubagentRuntimeTools, transformResponsesToChat } from "../core/transformer.js";
import { AdapterFactory } from "../adapters/factory.js";
import { GoogleGeminiAdapter } from "../adapters/google.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { getClaudeDesktopVersion, getCursorClientVersion, SubscriptionAuthService } from "../services/subscription_auth.js";
import { fetchUpstream, upstreamErrorDetails } from "../services/upstream_fetch.js";
import { extractImageGenerationContext, generateNativeCodexImage, parseImageGenerationArguments } from "../services/native_image_bridge.js";
import { analyzeWithNativeVision, assertNoNativeVisionImages, extractNativeVisionImages, extractNativeVisionImagesInCurrentTurn, hasNativeVisionImages, hasNativeVisionImagesInCurrentTurn, isProviderImageInputRejection, nativeVisionAuthorizationFingerprint, nativeVisionImageKey, NativeVisionBridgeError, normalizeTextOnlyProviderChatPayload, replaceImagesWithNativeVisionText, stripImageInspectionToolsForTextOnlyTurn, type NativeVisionErrorCode, type NativeVisionImageReference, type NativeVisionResult } from "../services/native_vision_bridge.js";
import { normalizeLegacyImageRequestBody } from "../services/image_input.js";
import { appendComputerUseInstructions, hasComputerUseTool, hasNativeComputerUseTool, normalizeComputerUseResponsesTools, normalizeNativeComputerUseResponsesPayload } from "../services/computer_use_native.js";
import {
  hasChatToolImages,
  isConsoleGoToolImageRejection,
  isXiaomiChatToolTextRejection,
  isXiaomiMimoProvider,
  normalizeXiaomiChatToolHistory,
  stripChatToolImages,
} from "../services/chat_tool_compat.js";
import { optimizeThirdPartyComputerUseImages } from "../services/computer_use_image_compat.js";
import { acquireCursorStreamReader, cursorAdvertisedToolNames, decodeCursorEndStreamError, decodeCursorStreamComplete, decodeCursorStreamText, decodeCursorToolCallCompleted, fetchCursorModelsCached, resolveCursorAgentModelSelector, streamCursorChat, type CursorExternalToolRequest, type CursorToolContinuation, type CursorToolEvent, type CursorToolResult } from "../services/cursor_protocol.js";
import { isNativeResponsesReasoningId } from "../core/responses_safety.js";
import { copySafeResponseHeaders, writeHttpResponseChunked, writeSseData } from "../services/http_stream.js";
import { CatalogSyncService, getProviderModelVisionCapability } from "../services/catalog_sync.js";
import { CredentialStore } from "../services/credential_store.js";
import { resolveSubscriptionTransport } from "../services/provider_transports.js";

export class ProviderCredentialError extends Error {
  public readonly statusCode: number;
  public readonly credentialId: string;

  constructor(message: string, statusCode: number, credentialId: string) {
    super(message);
    this.name = "ProviderCredentialError";
    this.statusCode = statusCode;
    this.credentialId = credentialId;
  }
}

function shouldRotateProviderCredential(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403 || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function configuredProviderVisionCapability(providerName: string, upstreamModel: string): boolean | undefined {
  const wanted = String(providerName || "").trim().toLowerCase();
  if (!wanted) return undefined;
  try {
    const provider = CredentialStore.loadProviders().find((item: any) =>
      String(item?.name || "").trim().toLowerCase() === wanted
      || String(item?.preset_id || "").trim().toLowerCase() === wanted,
    );
    return provider ? getProviderModelVisionCapability(provider, upstreamModel) : undefined;
  } catch {
    // Capability metadata is an optimization. A damaged catalog must not
    // make an otherwise routable provider unavailable.
    return undefined;
  }
}

/**
 * Every provider error is scoped to one Responses turn. A raw HTTP 4xx/5xx or
 * an SSE body that ends after `response.failed` leaves the native Codex client
 * waiting for the turn boundary and can make the next text/tool request look
 * stuck. Always close the local turn with the complete terminal sequence.
 */
export async function emitGatewayResponsesFailure(
  res: http.ServerResponse,
  error: { code?: string; message: string },
  requestBody: any,
  upstreamModel: string,
  responseModel = "",
): Promise<void> {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }
  const selectedResponseModel = String(responseModel || requestBody?.model || upstreamModel).trim() || upstreamModel;
  const write = async (payload: any) => {
    if (!res.writableEnded) await writeSseData(res, payload);
  };
  const engine = new ResponsesStreamEngine(
    upstreamModel,
    requestBody?.client_metadata?.turn_id,
    { responseModel: selectedResponseModel },
  );
  await engine.start(write);
  const now = Math.floor(Date.now() / 1000);
  const failedResponse = {
    id: engine.getResponseId(),
    object: "response",
    created_at: now,
    completed_at: now,
    status: "failed",
    model: selectedResponseModel,
    output: [],
    error: {
      code: error.code || "provider_request_failed",
      message: error.message,
    },
  };
  await write({ type: "response.failed", response: failedResponse });
  await write({ type: "response.completed", response: failedResponse });
  await write({ type: "response.done", response: failedResponse });
  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

async function emitNativeVisionBridgeFailure(
  res: http.ServerResponse,
  error: NativeVisionBridgeError,
  requestBody: any,
  upstreamModel: string,
  responseModel = "",
): Promise<void> {
  await emitGatewayResponsesFailure(res, error, requestBody, upstreamModel, responseModel);
}

const NATIVE_VISION_CACHE_SCHEMA_VERSION = 2;
const NATIVE_VISION_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_NATIVE_VISION_CACHE_ENTRIES = 64;
const nativeVisionCache = new Map<string, { result: NativeVisionResult; expiresAt: number }>();
type PersistedNativeVisionEntry = {
  status: "ready" | "failed";
  text?: string;
  model?: string;
  imageCount?: number;
  errorCode?: string;
  errorMessage?: string;
  statusCode?: number;
  authorizationFingerprint?: string;
  updatedAt: number;
};
const persistedNativeVisionCache = new Map<string, PersistedNativeVisionEntry>();
let persistedNativeVisionCacheLoaded = false;

function nativeVisionCachePath(): string {
  const dataDir = String(process.env.OPENCODEX_DATA_DIR || "").trim() || path.join(os.homedir(), ".opencodex");
  return path.join(dataDir, "native_vision_cache.json");
}

function loadPersistedNativeVisionCache(): void {
  if (persistedNativeVisionCacheLoaded) return;
  persistedNativeVisionCacheLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(nativeVisionCachePath(), "utf8"));
    if (raw?.schema_version !== NATIVE_VISION_CACHE_SCHEMA_VERSION) return;
    for (const [key, value] of Object.entries(raw?.entries || {})) {
      if (!key || !value || typeof value !== "object") continue;
      const entry = value as PersistedNativeVisionEntry;
      if ((entry.status !== "ready" && entry.status !== "failed") || !Number.isFinite(entry.updatedAt)) continue;
      persistedNativeVisionCache.set(key, entry);
    }
  } catch {
    // A missing or damaged cache must never affect routing or session recovery.
  }
}

function savePersistedNativeVisionCache(): void {
  try {
    const filePath = nativeVisionCachePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, JSON.stringify({ schema_version: NATIVE_VISION_CACHE_SCHEMA_VERSION, entries: Object.fromEntries(persistedNativeVisionCache) }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch {
    // The in-memory cache remains useful even when the optional disk cache is unavailable.
  }
}

function failedVisionFallback(entry: PersistedNativeVisionEntry, imageCount: number): NativeVisionResult {
  const safeError = String(entry.errorMessage || "视觉分析暂不可用")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, "[图片数据已隐藏]")
    .replace(/base64,[a-z0-9+/=_-]{16,}/gi, "base64,[图片数据已隐藏]")
    .replace(/\b(?:input_image|output_image|image_url)\b/gi, "图片字段")
    .slice(0, 800);
  const knownCodes: NativeVisionErrorCode[] = [
    "official_vision_auth_unavailable",
    "official_vision_quota_exhausted",
    "official_vision_invalid_request",
    "official_vision_request_failed",
    "official_vision_unreachable",
  ];
  const code = knownCodes.includes(entry.errorCode as NativeVisionErrorCode)
    ? entry.errorCode as NativeVisionErrorCode
    : "official_vision_request_failed";
  return {
    model: (entry.model || "gpt-5.6-luna") as NativeVisionResult["model"],
    imageCount: entry.imageCount || imageCount,
    text: `[图片视觉分析暂不可用：${safeError}]`,
    error: {
      code,
      message: safeError || "官方视觉模型没有返回图片分析文本。",
      ...(Number.isFinite(entry.statusCode) ? { statusCode: entry.statusCode } : {}),
    },
  };
}

function pruneNativeVisionCache(): void {
  const now = Date.now();
  for (const [key, entry] of nativeVisionCache) {
    if (entry.expiresAt <= now) nativeVisionCache.delete(key);
  }
  while (nativeVisionCache.size > MAX_NATIVE_VISION_CACHE_ENTRIES) {
    const oldest = nativeVisionCache.keys().next().value;
    if (oldest === undefined) break;
    nativeVisionCache.delete(oldest);
  }
}

async function analyzeNativeVisionOnce(
  requestBody: any,
  nativeHeaders: Record<string, string>,
  options: { providerApiKey?: string; signal?: AbortSignal; allowNetwork?: boolean } = {},
): Promise<NativeVisionResult> {
  pruneNativeVisionCache();
  loadPersistedNativeVisionCache();
  const images = extractNativeVisionImages(requestBody);
  if (images.length === 0) {
    return {
      model: "gpt-5.6-luna",
      imageCount: 0,
      text: "[图片视觉分析暂不可用：请求中没有可用的图片数据。]",
    };
  }
  const authFingerprint = nativeVisionAuthorizationFingerprint(nativeHeaders);
  const currentImageKeys = new Set(extractNativeVisionImagesInCurrentTurn(requestBody).map(nativeVisionImageKey));
  const textByImageKey = new Map<string, string>();
  const imageByKey = new Map<string, NativeVisionImageReference>();
  const pending: Array<{ key: string; image: NativeVisionImageReference }> = [];
  let currentTurnError: NativeVisionResult["error"];

  for (const image of images) {
    const key = nativeVisionImageKey(image);
    if (imageByKey.has(key)) continue;
    imageByKey.set(key, image);

    const cached = nativeVisionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      textByImageKey.set(key, cached.result.text);
      continue;
    }
    const persisted = persistedNativeVisionCache.get(key);
    if (persisted?.status === "ready" && persisted.text) {
      const result: NativeVisionResult = {
        model: (persisted.model || "gpt-5.6-luna") as NativeVisionResult["model"],
        text: persisted.text,
        imageCount: 1,
      };
      nativeVisionCache.set(key, { result, expiresAt: Date.now() + NATIVE_VISION_CACHE_TTL_MS });
      textByImageKey.set(key, result.text);
      continue;
    }
    if (persisted?.status === "failed" && persisted.authorizationFingerprint === authFingerprint) {
      const result = failedVisionFallback(persisted, 1);
      nativeVisionCache.set(key, { result, expiresAt: Date.now() + NATIVE_VISION_CACHE_TTL_MS });
      textByImageKey.set(key, result.text);
      if (currentImageKeys.has(key) && result.error) currentTurnError ||= result.error;
      continue;
    }
    if (options.allowNetwork === false || !currentImageKeys.has(key)) {
      textByImageKey.set(key, "[历史图片未在本地视觉缓存中，已跳过重复读取。]");
      continue;
    }
    pending.push({ key, image });
  }

  // Analyze only uncached images from the current turn. In particular, adding
  // a second image must never resend every image in the old transcript.
  for (const { key, image } of pending) {
    try {
      const result = await analyzeWithNativeVision(requestBody, nativeHeaders, {
        ...options,
        images: [image],
      });
      nativeVisionCache.set(key, { result, expiresAt: Date.now() + NATIVE_VISION_CACHE_TTL_MS });
      persistedNativeVisionCache.set(key, {
        status: "ready",
        text: result.text,
        model: result.model,
        imageCount: 1,
        updatedAt: Date.now(),
      });
      textByImageKey.set(key, result.text);
    } catch (error) {
      if (!(error instanceof NativeVisionBridgeError)) throw error;
      const failedEntry: PersistedNativeVisionEntry = {
        status: "failed",
        model: "gpt-5.6-luna",
        imageCount: 1,
        errorCode: error.code,
        errorMessage: error.message,
        statusCode: error.statusCode,
        authorizationFingerprint: authFingerprint,
        updatedAt: Date.now(),
      };
      persistedNativeVisionCache.set(key, failedEntry);
      const result = failedVisionFallback(failedEntry, 1);
      nativeVisionCache.set(key, { result, expiresAt: Date.now() + NATIVE_VISION_CACHE_TTL_MS });
      textByImageKey.set(key, result.text);
      if (currentImageKeys.has(key) && result.error) currentTurnError ||= result.error;
    }
  }
  if (pending.length > 0) savePersistedNativeVisionCache();
  pruneNativeVisionCache();

  const text = Array.from(imageByKey.keys())
    .map((key, index) => `图片${index + 1}：${textByImageKey.get(key) || "[图片说明不可用]"}`)
    .join("\n\n");
  return {
    model: "gpt-5.6-luna",
    imageCount: imageByKey.size,
    text,
    ...(currentTurnError ? { error: currentTurnError } : {}),
  };
}

async function preprocessKnownTextOnlyImages(
  requestBody: any,
  upstreamModel: string,
  responseModel: string,
  apiKey: string,
  providerName: string,
  nativeHeaders: Record<string, string>,
  res: http.ServerResponse,
): Promise<{ requestBody: any; failed: boolean }> {
  requestBody = normalizeLegacyImageRequestBody(requestBody);
  const visionCapability = configuredProviderVisionCapability(providerName, upstreamModel);
  if (visionCapability !== false || !hasNativeVisionImages(requestBody)) {
    return { requestBody, failed: false };
  }

  const vision = await analyzeNativeVisionOnce(requestBody, nativeHeaders, {
    providerApiKey: apiKey,
    allowNetwork: hasNativeVisionImagesInCurrentTurn(requestBody),
  });
  if (vision.error) {
    await emitNativeVisionBridgeFailure(
      res,
      new NativeVisionBridgeError(vision.error.code, vision.error.message, vision.error.statusCode || 0),
      requestBody,
      upstreamModel,
      responseModel,
    );
    return { requestBody, failed: true };
  }

  console.info(
    `[CodexSplit Provider] preprocessed images through native vision `
    + `model=${vision.model} provider=${providerName || "provider"} `
    + `backend=${upstreamModel} images=${vision.imageCount}`,
  );
  const bridgedRequestBody = replaceImagesWithNativeVisionText(requestBody, vision.text);
  return {
    requestBody: stripImageInspectionToolsForTextOnlyTurn(bridgedRequestBody),
    failed: false,
  };
}

export interface GatewaySubagentDispatchCall {
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  thought_signature?: string;
}

export interface GatewaySubagentDispatchContext {
  parent_task_id?: string;
  parent_model?: string;
  provider?: string;
  backend_model?: string;
  parent_reasoning_effort?: string;
  source?: "gpt-live" | "main-agent" | "subagent";
}

export interface GatewaySubagentDispatchResult {
  call_id: string;
  task_id?: string;
  model?: string;
  reasoning_effort?: string;
  output: string;
  error?: string;
}

export interface GatewayResponsesResult {
  completed: boolean;
  output: string;
}

export type GatewaySubagentDispatcher = (
  calls: GatewaySubagentDispatchCall[],
  context: GatewaySubagentDispatchContext,
) => Promise<GatewaySubagentDispatchResult[]>;



const CURSOR_TEXT_IDLE_TIMEOUT_MS = 2000;
const CURSOR_TOOL_IDLE_TIMEOUT_MS = 8000;
// Some OpenAI-compatible gateways omit both finish_reason and [DONE] after a
// tool call. Do not leave the native client waiting until its next user
// message; once a tool call is visible, a bounded idle read closes this turn.
const PROVIDER_TOOL_IDLE_TIMEOUT_MS = 12_000;
const PROVIDER_TEXT_IDLE_TIMEOUT_MS = 30_000;
// An upstream that opens an empty SSE response must not keep the native
// Desktop turn pending until a later user message wakes the session up.
const PROVIDER_EMPTY_IDLE_TIMEOUT_MS = 45_000;
const MAX_CURSOR_SESSION_MESSAGES = 40;
const MAX_CURSOR_SESSION_CACHE_ENTRIES = 100;
const cursorSessionHistory = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
let cursorSessionHistoryLoadedPath = "";

function cursorSessionHistoryPath(): string {
  const dataDir = String(process.env.OPENCODEX_DATA_DIR || "").trim() || path.join(os.homedir(), ".opencodex");
  return path.join(dataDir, "cursor_session_history.json");
}

function loadCursorSessionHistory(): void {
  const filePath = cursorSessionHistoryPath();
  if (cursorSessionHistoryLoadedPath === filePath) return;
  cursorSessionHistoryLoadedPath = filePath;
  cursorSessionHistory.clear();
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const sessions = payload?.sessions && typeof payload.sessions === "object" ? payload.sessions : {};
    for (const [key, value] of Object.entries(sessions)) {
      if (!key || !Array.isArray(value)) continue;
      const messages = value
        .filter((message: any) => (message?.role === "user" || message?.role === "assistant") && typeof message?.content === "string")
        .map((message: any) => ({ role: message.role, content: message.content.slice(0, 120_000) }))
        .filter((message: any) => message.content.trim())
        .slice(-MAX_CURSOR_SESSION_MESSAGES);
      if (messages.length > 0) cursorSessionHistory.set(key, messages);
    }
    while (cursorSessionHistory.size > MAX_CURSOR_SESSION_CACHE_ENTRIES) {
      const oldest = cursorSessionHistory.keys().next().value;
      if (!oldest) break;
      cursorSessionHistory.delete(oldest);
    }
  } catch {}
}

function persistCursorSessionHistory(): void {
  const filePath = cursorSessionHistoryPath();
  const payload = { schema_version: 1, sessions: Object.fromEntries(cursorSessionHistory), updated_at: new Date().toISOString() };
  const dataDir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}
type CursorPendingToolCall = {
  key: string;
  callId: string;
  model: string;
  conversationId: string;
  messages: Array<{ role: string; content: string }>;
  continuation: CursorToolContinuation;
  /** The still-open native AgentService response body for this turn. */
  providerResponse?: Response;
  /** The single reader that owns providerResponse.body across continuations. */
  providerReader?: ReadableStreamDefaultReader<Uint8Array>;
  /** Sends the outer Codex result over that same native session. */
  respond?: (output: string, isError?: boolean) => Promise<void>;
  createdAt: number;
};
const cursorPendingToolCalls = new Map<string, CursorPendingToolCall>();
// The native AgentService stream outlives the individual Responses HTTP
// request. Its callback must therefore publish tool requests into a
// conversation-level queue; otherwise a tool emitted after resume is handled
// by the old request closure and silently discarded.
const cursorExternalToolQueues = new Map<string, CursorExternalToolRequest[]>();
const CURSOR_PENDING_TOOL_TTL_MS = 10 * 60 * 1000;

type PendingProviderReasoning = {
  content: string;
  providerName: string;
  providerUrl: string;
  upstreamModel: string;
  createdAt: number;
};

// Thinking-mode Chat providers require the exact reasoning_content from the
// assistant tool-call turn to be echoed when its tool result is continued.
// Keep that provider-private state keyed by the provider call id instead of
// putting it into the Responses stream that Codex Desktop persists.
const pendingProviderReasoning = new Map<string, PendingProviderReasoning>();
const PENDING_PROVIDER_REASONING_TTL_MS = 10 * 60 * 1000;

function providerReasoningKey(providerName: string, providerUrl: string, upstreamModel: string, callId: string): string {
  return [providerName.trim().toLowerCase(), providerUrl.trim().toLowerCase(), upstreamModel.trim(), callId.trim()].join("\u0000");
}

function prunePendingProviderReasoning(): void {
  const cutoff = Date.now() - PENDING_PROVIDER_REASONING_TTL_MS;
  for (const [key, entry] of pendingProviderReasoning) {
    if (entry.createdAt < cutoff) pendingProviderReasoning.delete(key);
  }
}

function rememberPendingProviderReasoning(
  callIds: string[],
  content: string,
  providerName: string,
  providerUrl: string,
  upstreamModel: string,
): void {
  const preservedContent = typeof content === "string" ? content : "";
  if (!preservedContent.trim() || callIds.length === 0) return;
  prunePendingProviderReasoning();
  const entry = { content: preservedContent, providerName, providerUrl, upstreamModel, createdAt: Date.now() };
  for (const rawCallId of callIds) {
    const callId = String(rawCallId || "").trim();
    if (!callId) continue;
    pendingProviderReasoning.set(providerReasoningKey(providerName, providerUrl, upstreamModel, callId), entry);
  }
}

function providerReasoningForRequest(
  input: unknown,
  providerName: string,
  providerUrl: string,
  upstreamModel: string,
): string {
  prunePendingProviderReasoning();
  if (!Array.isArray(input)) return "";
  const callIds = input
    .filter((item: any) => item && typeof item === "object" && [
      "function_call",
      "function_call_output",
      "mcp_call",
      "mcp_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
      "computer_call",
      "computer_call_output",
    ].includes(item.type))
    .map((item: any) => String(item.call_id || item.id || "").trim())
    .filter(Boolean)
    .reverse();
  for (const callId of callIds) {
    const entry = pendingProviderReasoning.get(providerReasoningKey(providerName, providerUrl, upstreamModel, callId));
    if (entry) return entry.content;
  }
  return "";
}

function responsesEndpointForProvider(providerUrl: string): string {
  const base = String(providerUrl || "").replace(/\/(?:chat\/completions|messages|responses)\/?$/i, "").replace(/\/$/, "");
  return `${base}/responses`;
}

function responsesCompactionEndpointForProvider(providerUrl: string): string {
  return `${responsesEndpointForProvider(providerUrl)}/compact`;
}

/**
 * A third-party provider that exposes /responses/compact receives the same
 * native compact request shape as GPT. Only the backend model name changes;
 * the provider must perform the compaction and return its native item.
 */
export function buildThirdPartyNativeCompactionBody(body: any, upstreamModel: string): any {
  return sanitizeThirdPartyResponsesRequest(body, upstreamModel);
}

/**
 * The Desktop request is also the gateway's routing envelope. Native OpenAI
 * accepts the envelope's client metadata, but an ordinary Responses upstream
 * must receive only provider-facing fields. Keep this boundary explicit so
 * internal routing state cannot turn a minimal model test into a 400 during a
 * real turn.
 */
export function sanitizeThirdPartyResponsesRequest(body: any, upstreamModel?: string, stripOptionalHints = false): any {
  const upstreamBody = { ...(body || {}) };
  if (upstreamModel) upstreamBody.model = upstreamModel;
  for (const field of [
    "protocol",
    "client_metadata",
    "session_id",
    "turn_id",
    "conversation_id",
    "request_kind",
    "agent_profile_id",
    "profile_id",
    "subagent_profile_id",
    "child_profile_id",
    "parent_task_id",
    "preserve_reasoning_effort",
    "stream_options",
  ]) delete upstreamBody[field];
  // Optional native-cache/reasoning transport hints are not needed for an
  // ordinary third-party turn. Keep them for provider-owned compaction, where
  // preserving the native cache key can be meaningful, but omit them from the
  // regular OpenCode-compatible request path.
  if (stripOptionalHints) {
    delete upstreamBody.include;
    delete upstreamBody.prompt_cache_key;
  }
  // Responses uses the nested reasoning object. The legacy field is useful
  // to the Chat transformer but is not part of the Responses request shape.
  if (!upstreamBody.reasoning && upstreamBody.reasoning_effort) {
    upstreamBody.reasoning = { effort: upstreamBody.reasoning_effort };
  }
  delete upstreamBody.reasoning_effort;
  return upstreamBody;
}

function isResponsesUnsupported(status: number, body: string): boolean {
  if (status === 404 || status === 405) return true;
  if (status !== 415) return false;
  return /response|protocol|endpoint|unsupported|not supported|not found/i.test(body);
}

function normalizeResponsesUsageShape(usage: any): any {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details
    : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details
      : {};
  const rawCached = Number(usage.cached_tokens ?? usage.cached_input_tokens ?? details.cached_tokens);
  return {
    ...usage,
    input_tokens_details: {
      ...details,
      cached_tokens: Number.isFinite(rawCached) ? rawCached : 0,
    },
  };
}

function normalizeResponsesUsagePayload(payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  let next = payload;
  if (payload.usage && typeof payload.usage === "object") {
    next = { ...next, usage: normalizeResponsesUsageShape(payload.usage) };
  }
  if (payload.response?.usage && typeof payload.response.usage === "object") {
    next = {
      ...next,
      response: {
        ...payload.response,
        usage: normalizeResponsesUsageShape(payload.response.usage),
      },
    };
  }
  return next;
}

function sanitizeThirdPartyResponsesPayload(
  payload: any,
  blockedReasoningIds: Set<string>,
  nativeComputerUseCallIds?: Set<string>,
): any | null {
  if (!payload || typeof payload !== "object") return payload;
  payload = normalizeResponsesUsagePayload(payload);

  const item = payload.item;
  if (item?.type === "reasoning") {
    const id = typeof item.id === "string" ? item.id : "";
    if (!isNativeResponsesReasoningId(id)) {
      if (id) blockedReasoningIds.add(id);
      return null;
    }
  }

  const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
  if (itemId && blockedReasoningIds.has(itemId)) return null;
  if (itemId && /reasoning/i.test(String(payload.type || "")) && !isNativeResponsesReasoningId(itemId)) {
    blockedReasoningIds.add(itemId);
    return null;
  }

  if (payload.response && Array.isArray(payload.response.output)) {
    const output = payload.response.output.filter((outputItem: any) => {
      if (outputItem?.type !== "reasoning") return true;
      const id = typeof outputItem.id === "string" ? outputItem.id : "";
      if (isNativeResponsesReasoningId(id)) return true;
      if (id) blockedReasoningIds.add(id);
      return false;
    });
    payload = { ...payload, response: { ...payload.response, output } };
  }

  return normalizeNativeComputerUseResponsesPayload(payload, nativeComputerUseCallIds);
}

function rewriteThirdPartyResponseModel(payload: any, responseModel: string): any {
  if (!payload || typeof payload !== "object" || !responseModel) return payload;
  let next = payload;
  if (payload.response && typeof payload.response === "object") {
    next = { ...next, response: { ...payload.response, model: responseModel } };
  }
  if (typeof payload.model === "string") {
    next = { ...next, model: responseModel };
  }
  return next;
}

function sanitizeThirdPartySseEvent(
  event: string,
  blockedReasoningIds: Set<string>,
  nativeComputerUseCallIds?: Set<string>,
  responseModel = "",
): string | null {
  const lines = event.split(/\r?\n/);
  const dataIndexes: number[] = [];
  const dataLines: string[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("data:")) {
      dataIndexes.push(index);
      dataLines.push(line.slice(5).trimStart());
    }
  });
  if (dataLines.length === 0) return `${event}\n\n`;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return `${event}\n\n`;

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return `${event}\n\n`; }
  const sanitized = rewriteThirdPartyResponseModel(
    sanitizeThirdPartyResponsesPayload(payload, blockedReasoningIds, nativeComputerUseCallIds),
    responseModel,
  );
  if (sanitized === null) return null;
  const output = JSON.stringify(sanitized);
  const rewritten = lines.map((line, index) => {
    if (!dataIndexes.includes(index)) return line;
    return `data: ${output}`;
  });
  return `${rewritten.join("\n")}\n\n`;
}

async function pipeFilteredThirdPartyResponses(
  body: AsyncIterable<Uint8Array>,
  res: http.ServerResponse,
  responseModel = "",
): Promise<void> {
  const decoder = new TextDecoder();
  const blockedReasoningIds = new Set<string>();
  const nativeComputerUseCallIds = new Set<string>();
  let buffer = "";
  const flush = async (final = false) => {
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (chunks.pop() || "");
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const sanitized = sanitizeThirdPartySseEvent(chunk, blockedReasoningIds, nativeComputerUseCallIds, responseModel);
      if (sanitized) await writeHttpResponseChunked(res, sanitized);
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    await flush();
  }
  buffer += decoder.decode();
  await flush(true);
}

type CollectedThirdPartyResponses = {
  events: string[];
  response?: any;
  calls: GatewaySubagentDispatchCall[];
  json?: any;
};

function thirdPartyResponsesHasTerminalEvent(events: string[]): boolean {
  for (const raw of events) {
    const dataLines = raw.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    for (const data of dataLines) {
      if (data.trim() === "[DONE]") return true;
      try {
        const payload = JSON.parse(data);
        if (payload?.type === "response.completed"
          || payload?.type === "response.failed"
          || payload?.type === "response.done") {
          return true;
        }
      } catch {
        // A malformed provider event is not a terminal event. The caller will
        // close this turn with a structured gateway failure instead.
      }
    }
  }
  return false;
}

function thirdPartyResponsesHasJsonPayload(collected: CollectedThirdPartyResponses): boolean {
  if (collected.json === undefined || collected.json === null) return false;
  if (typeof collected.json !== "object") return Boolean(String(collected.json).trim());
  const candidate = collected.json?.response ?? collected.json;
  if (!candidate || typeof candidate !== "object") return Boolean(String(candidate || "").trim());
  return Object.keys(candidate).length > 0;
}

function responseFunctionCallFromItem(item: any): GatewaySubagentDispatchCall | null {
  const name = String(item?.name || "").trim();
  if (!item || item.type !== "function_call" || !isSubagentDispatchToolName(name)) return null;
  const callId = String(item.call_id || item.id || "").trim();
  if (!callId) return null;
  return {
    id: String(item.id || callId),
    call_id: callId,
    name,
    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
    ...((item.thought_signature || item.thoughtSignature || item.signature)
      ? { thought_signature: String(item.thought_signature || item.thoughtSignature || item.signature) }
      : {}),
  };
}

function collectResponseFunctionCall(
  calls: Map<string, GatewaySubagentDispatchCall>,
  item: any,
): void {
  const call = responseFunctionCallFromItem(item);
  if (call) calls.set(call.call_id, call);
}

async function collectThirdPartyResponsesBody(response: Response): Promise<CollectedThirdPartyResponses> {
  const calls = new Map<string, GatewaySubagentDispatchCall>();
  const events: string[] = [];
  let responseObject: any;
  const contentType = response.headers.get("content-type") || "";

  const observe = (raw: string): void => {
    const dataLines = raw.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") return;
    let payload: any;
    try { payload = JSON.parse(data); } catch { return; }
    if (payload?.response && typeof payload.response === "object") {
      responseObject = payload.response;
    }
    if (payload?.type === "response.output_item.added" || payload?.type === "response.output_item.done") {
      collectResponseFunctionCall(calls, payload.item);
    }
    if (payload?.type === "response.function_call_arguments.delta") {
      const itemId = String(payload.item_id || "").trim();
      const existing = Array.from(calls.values()).find((call) => call.id === itemId);
      if (existing) existing.arguments += String(payload.delta || "");
    }
    if (payload?.type === "response.completed" && Array.isArray(payload.response?.output)) {
      for (const item of payload.response.output) collectResponseFunctionCall(calls, item);
    }
  };

  if (!response.body || !contentType.toLowerCase().includes("text/event-stream")) {
    const raw = await response.text();
    let json: any;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    const output = json?.response || json;
    if (output && typeof output === "object") {
      responseObject = output;
      for (const item of Array.isArray(output.output) ? output.output : []) collectResponseFunctionCall(calls, item);
    }
    return { events, response: responseObject, calls: Array.from(calls.values()), json };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  // @ts-ignore Node's fetch body is an async iterable at runtime.
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";
    for (const event of chunks) {
      if (!event.trim()) continue;
      events.push(event);
      observe(event);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    events.push(buffer);
    observe(buffer);
  }
  return { events, response: responseObject, calls: Array.from(calls.values()) };
}

function buildThirdPartyResponsesSubagentContinuation(
  body: any,
  calls: GatewaySubagentDispatchCall[],
  results: GatewaySubagentDispatchResult[],
): any {
  const originalInput = Array.isArray(body?.input)
    ? body.input
    : body?.input
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: String(body.input) }] }]
      : [];
  const resultByCallId = new Map(results.map((result) => [result.call_id, result]));
  return {
    ...body,
    stream: true,
    input: [
      ...originalInput,
      ...calls.map((call) => ({
        type: "function_call",
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
        ...(call.thought_signature ? { thought_signature: call.thought_signature, thoughtSignature: call.thought_signature } : {}),
      })),
      ...calls.map((call) => {
        const result = resultByCallId.get(call.call_id);
        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: result?.error ? `子代理执行失败：${result.error}` : result?.output || "子代理已完成，但没有返回文本。",
        };
      }),
    ],
  };
}

async function proxyThirdPartyResponses(
  reqBody: any,
  upstreamModel: string,
  responseModel: string,
  apiKey: string,
  providerUrl: string,
  res: http.ServerResponse,
  isSubagentRequest = false,
  subagentDispatcher: GatewaySubagentDispatcher | null = null,
  subagentContext: GatewaySubagentDispatchContext = {},
  providerName = "",
  allowCredentialFailover = true,
  credentialId = "",
  nativeImageHeaders: Record<string, string> = {},
): Promise<"handled" | "failed" | "fallback"> {
  // The native Desktop app-server may encode a user screenshot as
  // `[Image: data:image/...;base64,...]` inside an input_text item. Convert
  // that transport-only representation to the same structured image part
  // used by native GPT before the provider protocol is selected.
  reqBody = normalizeLegacyImageRequestBody(reqBody);
  const preprocessed = await preprocessKnownTextOnlyImages(
    reqBody,
    upstreamModel,
    responseModel,
    apiKey,
    providerName,
    nativeImageHeaders,
    res,
  );
  if (preprocessed.failed) return "failed";
  reqBody = preprocessed.requestBody;
  const targetUrl = responsesEndpointForProvider(providerUrl);
  const prepareUpstreamBody = async (sourceBody: any): Promise<{ body: any; optimized: any }> => {
    const optimized = await optimizeThirdPartyComputerUseImages(sourceBody);
    const sanitizedBody = sanitizeThirdPartyResponsesRequest(optimized.body, upstreamModel, true);
    const body = {
      ...sanitizedBody,
      ...(isSubagentRequest
        ? { tools: stripSubagentRuntimeTools(sanitizedBody?.tools) }
        : subagentDispatcher
          ? {
            tools: [
              ...(Array.isArray(sanitizedBody?.tools) ? sanitizedBody.tools : []),
              buildGatewaySubagentResponseTool(),
            ].filter((tool: any, index: number, list: any[]) => list.findIndex((candidate) => String(candidate?.name || candidate?.function?.name || "") === String(tool?.name || tool?.function?.name || "")) === index),
            ...(sanitizedBody?.parallel_tool_calls === undefined ? { parallel_tool_calls: true } : {}),
          }
          : {}),
    };
    return { body, optimized };
  };
  let prepared: { body: any; optimized: any };
  let upstreamBody: any;
  try {
    prepared = await prepareUpstreamBody(reqBody);
    upstreamBody = prepared.body;
    if (prepared.optimized.stats.optimized || prepared.optimized.stats.deduplicated) {
      console.info(
        `[OpenCodex Computer Use] optimized third-party Responses screenshots ` +
        `optimized=${prepared.optimized.stats.optimized} deduplicated=${prepared.optimized.stats.deduplicated} ` +
        `bytes=${prepared.optimized.stats.inputBytes}->${prepared.optimized.stats.outputBytes}`,
      );
    }
    let upstreamRes = await fetchUpstream(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      maxAttempts: 1,
      timeoutMs: 120_000,
      operation: "native-third-party-responses",
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      let errorText = await upstreamRes.text();
      if (isProviderImageInputRejection(upstreamRes.status, errorText, reqBody)) {
        // The provider gets the first chance to handle its own native image
        // input. Only an explicit image-shape validation failure enters this
        // bridge; ordinary provider auth/outage errors never do.
        const vision = await analyzeNativeVisionOnce(reqBody, nativeImageHeaders, {
          providerApiKey: apiKey,
          allowNetwork: hasNativeVisionImagesInCurrentTurn(reqBody),
        });
        if (vision.error) {
          await emitNativeVisionBridgeFailure(
            res,
            new NativeVisionBridgeError(vision.error.code, vision.error.message, vision.error.statusCode || 0),
            reqBody,
            upstreamModel,
            responseModel,
          );
          return "failed";
        }
        const bridgedBody = replaceImagesWithNativeVisionText(reqBody, vision.text);
        if (reqBody && typeof reqBody === "object" && bridgedBody && typeof bridgedBody === "object") {
          Object.assign(reqBody, bridgedBody);
        }
        prepared = await prepareUpstreamBody(bridgedBody);
        upstreamBody = prepared.body;
        console.warn(
          `[CodexSplit Provider] provider rejected image input; retrying through native vision ` +
          `model=${vision.model} provider=${providerName || "provider"} backend=${upstreamModel} images=${vision.imageCount}`,
        );
        upstreamRes = await fetchUpstream(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(upstreamBody),
          maxAttempts: 1,
          timeoutMs: 120_000,
          operation: "native-third-party-responses-vision-fallback",
        });
        if (!upstreamRes.ok || !upstreamRes.body) errorText = await upstreamRes.text();
      }
      if (!upstreamRes.ok || !upstreamRes.body) {
        if (upstreamRes.status === 400) {
          CatalogSyncService.learnReasoningLevelsFromProviderError(providerName, upstreamModel, errorText);
        }
        if (isResponsesUnsupported(upstreamRes.status, errorText)) {
          console.warn(`[CodexSplit Provider] Responses unsupported by ${targetUrl}; falling back to Chat conversion`);
          return "fallback";
        }
        if (allowCredentialFailover && credentialId && shouldRotateProviderCredential(upstreamRes.status)) {
          throw new ProviderCredentialError(
            `Provider API Key 请求失败（HTTP ${upstreamRes.status}）：${errorText.slice(0, 800)}`,
            upstreamRes.status,
            credentialId,
          );
        }
        let message = `Upstream API Error (${upstreamRes.status})`;
        try {
          const parsed = JSON.parse(errorText);
          message = String(parsed?.error?.message || parsed?.error || parsed?.message || errorText || message);
        } catch {
          message = errorText || message;
        }
        await emitGatewayResponsesFailure(
          res,
          { code: `provider_http_${upstreamRes.status}`, message },
          reqBody,
          upstreamModel,
          responseModel,
        );
        return "failed";
      }
    }

    let responseForHeaders = upstreamRes;
    let collected: CollectedThirdPartyResponses = await collectThirdPartyResponsesBody(upstreamRes);
    let continuationRound = 0;
    while (subagentDispatcher && !isSubagentRequest && collected.calls.length > 0) {
      continuationRound += 1;
      if (continuationRound > 8) throw new Error("第三方主模型连续调度子代理超过 8 轮，已停止继续递归");
      const results = await subagentDispatcher(collected.calls, subagentContext);
      if (results.length > 0 && results.every((result) => Boolean(result.error))) {
        const details = results.map((result) => result.error).filter(Boolean).join("；");
        throw new Error(`子代理调度失败，已停止主模型重试：${details || "没有可用的子代理结果"}`);
      }
      const continuationBody = buildThirdPartyResponsesSubagentContinuation(upstreamBody, collected.calls, results);
      const continuationResponse = await fetchUpstream(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(continuationBody),
        maxAttempts: 1,
        timeoutMs: 120_000,
        operation: "native-third-party-responses-subagent-continuation",
      });
      if (!continuationResponse.ok || !continuationResponse.body) {
        const errorText = await continuationResponse.text();
        if (continuationResponse.status === 400) {
          CatalogSyncService.learnReasoningLevelsFromProviderError(providerName, upstreamModel, errorText);
        }
        throw new Error(`第三方主模型子代理续答失败（HTTP ${continuationResponse.status}）：${errorText.slice(0, 800)}`);
      }
      responseForHeaders = continuationResponse;
      collected = await collectThirdPartyResponsesBody(continuationResponse);
    }

    // A fetch body existing is not the same as a completed Responses turn.
    // Empty SSE streams and streams that stop before response.done used to be
    // forwarded as HTTP 200, leaving Codex Desktop waiting forever and making
    // the next text/tool request appear broken.
    if ((collected.events.length === 0
      && (!collected.response || (typeof collected.response === "object" && Object.keys(collected.response).length === 0))
      && !thirdPartyResponsesHasJsonPayload(collected))
      || (collected.events.length > 0 && !thirdPartyResponsesHasTerminalEvent(collected.events))) {
      await emitGatewayResponsesFailure(
        res,
        {
          code: collected.events.length > 0 ? "incomplete_provider_response" : "empty_provider_response",
          message: collected.events.length > 0
            ? "第三方 Responses 上游在终止事件前结束，没有形成完整回复。"
            : "第三方 Responses 上游返回了空响应。",
        },
        reqBody,
        upstreamModel,
        responseModel,
      );
      return "failed";
    }

    const responseHeaders = copySafeResponseHeaders(responseForHeaders.headers);
    res.writeHead(responseForHeaders.status, responseHeaders);
    if (collected.events.length > 0) {
      const blockedReasoningIds = new Set<string>();
      const nativeComputerUseCallIds = new Set<string>();
      for (const event of collected.events) {
        const sanitized = sanitizeThirdPartySseEvent(event, blockedReasoningIds, nativeComputerUseCallIds, responseModel);
        if (sanitized) await writeHttpResponseChunked(res, sanitized);
      }
    } else {
      const blockedReasoningIds = new Set<string>();
      const payload = rewriteThirdPartyResponseModel(sanitizeThirdPartyResponsesPayload(
        collected.json,
        blockedReasoningIds,
        new Set<string>(),
      ), responseModel);
      await writeHttpResponseChunked(res, payload === null ? "{}" : JSON.stringify(payload));
    }
    res.end();
    return "handled";
  } catch (err: any) {
    if (err instanceof ProviderCredentialError) throw err;
    const details = upstreamErrorDetails(err);
    console.error(`[CodexBridge V2] Native third-party Responses proxy error:`, {
      ...details,
      attempts: err?.attempts,
    });
    if (err instanceof NativeVisionBridgeError) {
      await emitNativeVisionBridgeFailure(res, err, reqBody, upstreamModel, responseModel);
      return "failed";
    }
    await emitGatewayResponsesFailure(
      res,
      {
        code: "upstream_unreachable",
        message: err?.message || `无法连接第三方 Responses 上游${details.code ? ` [${details.code}]` : ""}`,
      },
      reqBody,
      upstreamModel,
      responseModel,
    );
    return "failed";
  }
}

function providerChunkSignalsCompletion(chunk: any): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  if (chunk.type === "message_stop" || chunk.type === "response.completed" || chunk.type === "response.done") return true;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  if (choices.some((choice: any) => choice && choice.finish_reason)) return true;
  const candidates = Array.isArray(chunk.candidates)
    ? chunk.candidates
    : Array.isArray(chunk.response?.candidates)
      ? chunk.response.candidates
      : [];
  return candidates.some((candidate: any) => Boolean(candidate?.finishReason || candidate?.finish_reason));
}

function cursorHistoryKey(body: any): string {
  return String(
    body?.client_metadata?.session_id ||
    body?.session_id ||
    body?.client_metadata?.conversation_id ||
    body?.conversation_id ||
    "",
  ).trim();
}

function cursorRequestStateKey(body: any): string {
  return cursorHistoryKey(body) || String(
    body?.client_metadata?.turn_id ||
    body?.turn_id ||
    body?.conversation_id ||
    "",
  ).trim();
}

function cursorFunctionCallOutput(body: any): { callId: string; output: string } | undefined {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type === "function_call_output" && item.call_id) {
      return {
        callId: String(item.call_id),
        output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      };
    }
  }
  return undefined;
}

function pruneCursorPendingToolCalls(): void {
  const cutoff = Date.now() - CURSOR_PENDING_TOOL_TTL_MS;
  for (const [key, pending] of cursorPendingToolCalls) {
    if (pending.createdAt < cutoff) {
      cursorPendingToolCalls.delete(key);
      cursorExternalToolQueues.delete(key);
      void pending.providerReader?.cancel().catch(() => {});
    }
  }
}

function takeCursorExternalToolRequest(key: string): CursorExternalToolRequest | undefined {
  const queue = cursorExternalToolQueues.get(key);
  if (!queue || queue.length === 0) return undefined;
  const request = queue.shift();
  if (queue.length === 0) cursorExternalToolQueues.delete(key);
  return request;
}

function cursorMessagesIncludeHistory(
  current: Array<{ role: string; content: string }>,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): boolean {
  if (history.length === 0 || current.length < history.length) return false;
  return history.every((message, index) => {
    const candidate = current[index];
    return candidate?.role === message.role && candidate.content === message.content;
  });
}

function cursorUserMessagesAfterToolResult(
  current: Array<{ role: string; content: string }>,
): Array<{ role: "user"; content: string }> {
  let lastToolIndex = -1;
  current.forEach((message, index) => {
    if (message.role === "tool") lastToolIndex = index;
  });
  if (lastToolIndex < 0) return [];
  return current
    .slice(lastToolIndex + 1)
    .filter((message): message is { role: "user"; content: string } => message.role === "user");
}

function rememberCursorSession(
  key: string,
  messages: Array<{ role: string; content: string }>,
  assistantText: string,
): void {
  loadCursorSessionHistory();
  if (!key || !assistantText.trim()) return;
  const conversation = messages
    .filter((message): message is { role: "user" | "assistant"; content: string } =>
      (message.role === "user" || message.role === "assistant") && Boolean(message.content.trim()))
    .concat({ role: "assistant", content: assistantText });
  cursorSessionHistory.delete(key);
  cursorSessionHistory.set(key, conversation.slice(-MAX_CURSOR_SESSION_MESSAGES));
  while (cursorSessionHistory.size > MAX_CURSOR_SESSION_CACHE_ENTRIES) {
    const oldest = cursorSessionHistory.keys().next().value;
    if (!oldest) break;
    cursorSessionHistory.delete(oldest);
  }
  persistCursorSessionHistory();
}

export class GatewayRouter {
  private subagentDispatcher: GatewaySubagentDispatcher | null = null;

  public setSubagentDispatcher(dispatcher: GatewaySubagentDispatcher | null): void {
    this.subagentDispatcher = dispatcher;
  }

  /**
   * Use a provider's native Codex compaction endpoint when it actually
   * implements it. The client-facing contract stays identical to native GPT:
   * the gateway only rewrites the backend model name and response model label.
   * A 404/405/unsupported response is returned to the client; there is no
   * gateway-generated summary fallback.
   */
  public async proxyNativeThirdPartyCompaction(
    reqBody: any,
    upstreamModel: string,
    responseModel: string,
    apiKey: string,
    providerUrl: string,
    res: http.ServerResponse,
  ): Promise<"handled" | "unsupported"> {
    // Keep the native compact request shape identical to the native GPT lane.
    // Only the provider backend model name is translated; the provider owns
    // compaction and must return its native compact response.
    const upstreamBody = buildThirdPartyNativeCompactionBody(reqBody, upstreamModel);
    const targetUrl = responsesCompactionEndpointForProvider(providerUrl);

    try {
      const upstreamRes = await fetchUpstream(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(upstreamBody),
        maxAttempts: 1,
        timeoutMs: 120_000,
        operation: "native-third-party-responses-compact",
      });

      if (!upstreamRes.ok || !upstreamRes.body) {
        const errorText = await upstreamRes.text();
        if (isResponsesUnsupported(upstreamRes.status, errorText)) {
          console.info(`[OpenCodex Compaction] Native endpoint unsupported by ${targetUrl}`);
          return "unsupported";
        }
        res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
        res.end(errorText || JSON.stringify({ error: `Upstream API Error (${upstreamRes.status})` }));
        return "handled";
      }

      const responseHeaders = copySafeResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.status, responseHeaders);
      const contentType = upstreamRes.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("text/event-stream")) {
        // @ts-ignore Node's fetch body is an async iterable at runtime.
        await pipeFilteredThirdPartyResponses(upstreamRes.body, res, responseModel);
      } else {
        const raw = await upstreamRes.text();
        try {
          const payload = rewriteThirdPartyResponseModel(JSON.parse(raw), responseModel);
          await writeHttpResponseChunked(res, JSON.stringify(payload));
        } catch {
          await writeHttpResponseChunked(res, raw);
        }
      }
      res.end();
      console.info(`[OpenCodex Compaction] Native third-party compaction passthrough provider=${targetUrl}`);
      return "handled";
    } catch (err: any) {
      const details = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Native third-party compaction proxy error:`, {
        ...details,
        attempts: err?.attempts,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err.message,
          type: "upstream_unreachable",
          retryable: Boolean(err?.retryable),
          cause_code: details.code,
        }));
      }
      return "handled";
    }
  }

  private async emitProviderCredentialFailure(
    reqBody: any,
    upstreamModel: string,
    responseModel: string,
    res: http.ServerResponse,
    message: string,
  ): Promise<void> {
    if (res.writableEnded) return;
    const selectedResponseModel = String(responseModel || reqBody?.model || upstreamModel).trim() || upstreamModel;
    const write = async (payload: any) => {
      if (!res.writableEnded) await writeSseData(res, payload);
    };
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }
    const engine = new ResponsesStreamEngine(upstreamModel, reqBody?.client_metadata?.turn_id, { responseModel: selectedResponseModel });
    await engine.start(write);
    const now = Math.floor(Date.now() / 1000);
    const failedResponse = {
      id: engine.getResponseId(),
      object: "response",
      created_at: now,
      completed_at: now,
      status: "failed",
      model: selectedResponseModel,
      output: [],
      error: { code: "provider_credential_unavailable", message },
    };
    await write({ type: "response.failed", response: failedResponse });
    // Keep the failed status, but also emit the same terminal event shape as
    // a normal Responses turn. Codex Desktop otherwise treats an HTTP 200 SSE
    // stream that ends after response.failed as an incomplete transport and
    // replays the same user turn several times.
    await write({ type: "response.completed", response: failedResponse });
    await write({ type: "response.done", response: failedResponse });
    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }

  public async handleResponses(
    reqBody: any,
    upstreamModel: string,
    apiKey: string,
    providerUrl: string,
    res: http.ServerResponse,
    providerName = "",
    nativeImageHeaders: Record<string, string> = {},
    responseModel = "",
    isSubagentRequest = false,
  credentialId = "",
  adapterName = "",
  subagentSource: GatewaySubagentDispatchContext["source"] = "main-agent",
): Promise<GatewayResponsesResult> {
    let selectedApiKey = String(apiKey || "");
    let selectedCredentialId = String(credentialId || "");
    if (providerName && !selectedApiKey) {
      const provider = CredentialStore.loadProviders().find((item: any) =>
        String(item?.name || "").trim().toLowerCase() === String(providerName).trim().toLowerCase()
        || String(item?.preset_id || "").trim().toLowerCase() === String(providerName).trim().toLowerCase(),
      ) as any;
      if (provider) {
        const resolved = CredentialStore.resolveApiKeyWithCredential(provider);
        selectedApiKey = resolved.apiKey;
        selectedCredentialId = resolved.id || selectedCredentialId;
        if (!selectedApiKey && !selectedCredentialId) {
          const credentials = CredentialStore.getProviderCredentialsPublic(provider);
          selectedCredentialId = credentials.find((credential: any) => credential.active)?.id || credentials[0]?.id || "";
        }
      }
    }

    try {
      if (!selectedApiKey && selectedCredentialId) {
        throw new ProviderCredentialError("没有可用的 API Key；当前凭证可能已失效或已从 Keychain 移除", 401, selectedCredentialId);
      }
      const completed = await this.handleResponsesOnce(
        reqBody,
        upstreamModel,
        selectedApiKey,
        providerUrl,
        res,
        providerName,
        nativeImageHeaders,
        responseModel,
        isSubagentRequest,
        selectedCredentialId,
        true,
        adapterName,
        subagentSource,
      );
      if (completed.completed && selectedCredentialId) CredentialStore.markProviderCredentialSuccess(providerName, selectedCredentialId);
      return completed;
    } catch (error: any) {
      if (error instanceof ProviderCredentialError && selectedCredentialId && !res.headersSent && !res.writableEnded) {
        CredentialStore.markProviderCredentialFailure(providerName, selectedCredentialId, error.statusCode, error.message);
        const next = CredentialStore.selectNextApiKeyCredential(providerName, selectedCredentialId);
        if (next && next.id !== selectedCredentialId) {
          console.warn(`[CodexSplit Provider] credential failover provider=${providerName} failed=${selectedCredentialId} next=${next.id}`);
          return this.handleResponses(
            reqBody,
            upstreamModel,
            next.apiKey,
            providerUrl,
            res,
            providerName,
            nativeImageHeaders,
            responseModel,
            isSubagentRequest,
            next.id,
            adapterName,
            subagentSource,
          );
        }
        await this.emitProviderCredentialFailure(
          reqBody,
          upstreamModel,
          responseModel,
          res,
          `${error.message}；没有其他可用 API Key，请在 Provider 设置中检测或移除失效凭证。`,
        );
        return { completed: false, output: "" };
      }

      // Keep unexpected failures on the same per-turn Responses contract.
      // The outer HTTP handler must not turn an image/tool failure into a raw
      // JSON 400 that leaves the native app-server waiting for turn/done.
      if (!res.writableEnded) {
        const message = error instanceof Error ? error.message : String(error || "第三方请求失败");
        console.error(`[CodexBridge V2] Responses request failed before a terminal response: ${message}`);
        await emitGatewayResponsesFailure(
          res,
          { code: error?.code || "provider_request_failed", message },
          reqBody,
          upstreamModel,
          responseModel,
        );
        return { completed: false, output: "" };
      }
      throw error;
    }
  }

  private async handleResponsesOnce(
    reqBody: any,
    upstreamModel: string,
    apiKey: string,
    providerUrl: string,
    res: http.ServerResponse,
    providerName = "",
  nativeImageHeaders: Record<string, string> = {},
  responseModel = "",
  isSubagentRequest = false,
  credentialId = "",
  allowCredentialFailover = true,
  adapterName = "",
  subagentSource: GatewaySubagentDispatchContext["source"] = "main-agent",
  ): Promise<GatewayResponsesResult> {
    reqBody = normalizeLegacyImageRequestBody(reqBody);
    const selectedResponseModel = String(responseModel || reqBody?.model || upstreamModel).trim() || upstreamModel;
    const textOnlyProvider = configuredProviderVisionCapability(providerName, upstreamModel) === false;
    const preprocessed = await preprocessKnownTextOnlyImages(
      reqBody,
      upstreamModel,
      selectedResponseModel,
      apiKey,
      providerName,
      nativeImageHeaders,
      res,
    );
    if (preprocessed.failed) return { completed: false, output: "" };
    reqBody = preprocessed.requestBody;
    const sessionId = reqBody?.client_metadata?.session_id || reqBody?.session_id;
    const cursorHistoryId = cursorHistoryKey(reqBody);
    const cursorStateKey = cursorRequestStateKey(reqBody);
    const requestUsesComputerUse = hasComputerUseTool(reqBody?.tools);
    if (requestUsesComputerUse) {
      // Native third-party Responses providers do not pass through the Chat
      // transformer, so give both protocol paths the same direct-use rule.
      reqBody = {
        ...reqBody,
        tools: normalizeComputerUseResponsesTools(reqBody.tools),
        instructions: appendComputerUseInstructions(reqBody.instructions, reqBody.tools),
      };
    }
    if (String(reqBody?.protocol || "").toLowerCase() === "responses") {
      // Responses-capable third-party providers receive the request as-is.
      // Computer Use is still a client-owned native tool call; the gateway
      // must never execute desktop actions or synthesize a second bridge.
      const nativeResult = await proxyThirdPartyResponses(
        reqBody,
        upstreamModel,
        selectedResponseModel,
        apiKey,
        providerUrl,
        res,
        isSubagentRequest,
        this.subagentDispatcher,
        {
          parent_task_id: sessionId,
          parent_model: selectedResponseModel,
          backend_model: upstreamModel,
          parent_reasoning_effort: String(reqBody?.reasoning?.effort || reqBody?.reasoning_effort || "").trim() || undefined,
          source: subagentSource,
        },
        providerName,
        allowCredentialFailover,
        credentialId,
        nativeImageHeaders,
      );
      if (nativeResult === "handled") return { completed: true, output: "" };
      if (nativeResult === "failed") return { completed: false, output: "" };
      // The configured Responses endpoint is unavailable; use the existing
      // Chat compatibility conversion for this request.
      reqBody = { ...reqBody, protocol: "chat" };
    }
    const imageGenerationContext = extractImageGenerationContext(reqBody);
    const providerReasoningContent = providerReasoningForRequest(
      reqBody?.input,
      providerName,
      providerUrl,
      upstreamModel,
    );
    let chatBody = transformResponsesToChat(
      reqBody,
      upstreamModel,
      sessionId,
      !isSubagentRequest,
      adapterName,
      providerReasoningContent,
    );
    // SessionHistoryService may rehydrate screenshots from the native rollout
    // after the request-level preprocessing above has already run. Apply the
    // same native vision boundary to the reconstructed Chat transcript before
    // it reaches a text-only provider; otherwise the old image reappears in
    // `messages[*].content` and the provider rejects the whole continuation.
    const preprocessedChat = await preprocessKnownTextOnlyImages(
      chatBody,
      upstreamModel,
      selectedResponseModel,
      apiKey,
      providerName,
      nativeImageHeaders,
      res,
    );
    if (preprocessedChat.failed) return { completed: false, output: "" };
    chatBody = preprocessedChat.requestBody;
    if (textOnlyProvider) {
      chatBody = normalizeTextOnlyProviderChatPayload(chatBody);
      assertNoNativeVisionImages(chatBody);
    }
    if (providerReasoningContent) {
      console.info(
        `[CodexSplit Provider] restored provider reasoning_content for continuation `
        + `provider=${providerName || "provider"} model=${upstreamModel}`,
      );
    }
    const optimizedChat = await optimizeThirdPartyComputerUseImages(chatBody);
    let optimizedChatBody = optimizedChat.body;
    const isXiaomiMimoChat = isXiaomiMimoProvider(providerName, providerUrl, upstreamModel);
    // MiMo's Chat validator is stricter than the OpenAI schema for tool
    // history: an assistant tool-call turn and an image-only tool result must
    // still carry a text field. Keep this isolated to the Xiaomi/MiMo route;
    // MiniMax and all other providers retain the ordinary Chat payload.
    let providerChatBody = isXiaomiMimoChat
      ? normalizeXiaomiChatToolHistory(optimizedChatBody)
      : optimizedChatBody;
    if (textOnlyProvider) providerChatBody = normalizeTextOnlyProviderChatPayload(providerChatBody);
    if (optimizedChat.stats.optimized || optimizedChat.stats.deduplicated) {
      console.info(
        `[OpenCodex Computer Use] optimized third-party Chat screenshots ` +
        `optimized=${optimizedChat.stats.optimized} deduplicated=${optimizedChat.stats.deduplicated} ` +
        `bytes=${optimizedChat.stats.inputBytes}->${optimizedChat.stats.outputBytes}`,
      );
    }
    const adapter = AdapterFactory.getAdapter(reqBody?.protocol, providerUrl, adapterName);
    const { urlEndpoint, headers: adapterHeaders, body: payloadBody } = adapter.transformPayload(providerChatBody);

    // Callers may provide either a provider base URL or an already selected
    // OpenAI endpoint. Normalize both forms before an adapter chooses its
    // protocol-specific path; otherwise Anthropic-compatible models can end
    // up at `/chat/completions/v1/messages`.
    const providerBaseUrl = providerUrl.replace(/\/(?:chat\/completions|messages)\/?$/i, "");
    const adapterPath = /\/v1$/i.test(providerBaseUrl) && /^\/v1\//i.test(urlEndpoint)
      ? urlEndpoint.slice("/v1".length)
      : urlEndpoint;
    const targetUrl = adapterPath
      ? `${providerBaseUrl.replace(/\/$/, "")}${adapterPath}`
      : /\/chat\/completions\/?$/i.test(providerUrl)
        ? providerUrl
        : `${providerBaseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...adapterHeaders,
    };
    // OpenCode Go's Anthropic Messages-compatible models validate the API key
    // through x-api-key. Keep Authorization as well for providers that accept
    // the OpenAI-compatible bearer convention.
    if (adapter.name === "anthropic" && apiKey) {
      headers["x-api-key"] = apiKey;
    }

    // Clean V2 Antigravity Subscription Routing
    const subscriptionTransport = resolveSubscriptionTransport(providerName, apiKey);
    const isAntigravityModel = subscriptionTransport?.id === "antigravity";

    let finalTargetUrl = targetUrl;
    let finalHeaders = { ...headers };
    let finalPayloadBody = textOnlyProvider
      ? normalizeTextOnlyProviderChatPayload(payloadBody)
      : payloadBody;

    let activeAdapter = adapter;

    if (isAntigravityModel) {
      const oauthToken = await SubscriptionAuthService.getAntigravityAccessToken();

      console.log(`[OpenCodex V2] Antigravity token resolved: ${Boolean(oauthToken)}`);

      if (oauthToken) {
        finalTargetUrl = subscriptionTransport!.endpoint;
        finalHeaders["Authorization"] = `Bearer ${oauthToken}`;
        finalHeaders["User-Agent"] = "antigravity/hub/2.2.1 darwin/arm64";

        activeAdapter = new GoogleGeminiAdapter();
        const geminiPayload = activeAdapter.transformPayload(optimizedChatBody).body;

        finalPayloadBody = {
          project: "default-cli-project",
          model: upstreamModel,
          request: geminiPayload
        };
      }
    }

    // Grok Subscription Routing
    const isGrokModel = subscriptionTransport?.id === "grok" && !isAntigravityModel;

    if (isGrokModel) {
      const grokToken = await SubscriptionAuthService.getGrokAccessToken();
      if (grokToken) {
        finalHeaders["Authorization"] = `Bearer ${grokToken}`;
        finalHeaders["User-Agent"] = "grok-cli/1.89.0";
        finalTargetUrl = subscriptionTransport!.endpoint;
      }
    }

    // Claude Subscription Routing
    const isClaudeModel = subscriptionTransport?.id === "claude" && !isAntigravityModel && !isGrokModel;

    if (isClaudeModel) {
      activeAdapter = new AnthropicAdapter();
      const payload = activeAdapter.transformPayload(optimizedChatBody);
      finalTargetUrl = subscriptionTransport!.endpoint;
      finalPayloadBody = payload.body;

      const claudeKey = await SubscriptionAuthService.getClaudeAccessToken();
      if (claudeKey) {
        finalHeaders["Authorization"] = `Bearer ${claudeKey}`;
        if (claudeKey.startsWith("sk-ant-")) {
          finalHeaders["x-api-key"] = claudeKey;
        } else {
          finalHeaders["anthropic-beta"] = "oauth-2025-04-20";
          finalHeaders["anthropic-client-platform"] = "DESKTOP_APP";
          finalHeaders["anthropic-client-version"] = getClaudeDesktopVersion();
        }
        finalHeaders["anthropic-version"] = "2023-06-01";
      }
    }

    // Cursor Subscription Routing
    const isCursorModel = subscriptionTransport?.id === "cursor"
      && !isAntigravityModel && !isGrokModel && !isClaudeModel;

    if (isCursorModel) {
      finalTargetUrl = subscriptionTransport!.endpoint;
    }

    // Ask OpenAI-compatible Chat endpoints for their actual stream usage when
    // supported. This is optional metadata; providers that omit it still work
    // and the Responses engine will simply leave usage absent.
    if (activeAdapter.name === "openai" && finalPayloadBody && typeof finalPayloadBody === "object") {
      finalPayloadBody = {
        ...finalPayloadBody,
        stream_options: {
          ...(finalPayloadBody.stream_options || {}),
          include_usage: true,
        },
      };
    }
    if (textOnlyProvider) {
      finalPayloadBody = normalizeTextOnlyProviderChatPayload(finalPayloadBody);
      assertNoNativeVisionImages(finalPayloadBody);
    }

    const rebuildProviderPayloadAfterVision = async (nextReqBody: any, sourceChatBody?: any): Promise<void> => {
      const nextChatBody = sourceChatBody || transformResponsesToChat(
        nextReqBody,
        upstreamModel,
        sessionId,
        !isSubagentRequest,
        adapterName,
        providerReasoningContent,
      );
      const nextOptimized = await optimizeThirdPartyComputerUseImages(nextChatBody);
      optimizedChatBody = nextOptimized.body;
      const nextProviderChatBody = isXiaomiMimoChat
        ? normalizeXiaomiChatToolHistory(optimizedChatBody)
        : optimizedChatBody;
      const transformed = activeAdapter.transformPayload(nextProviderChatBody);
      let nextPayloadBody = transformed.body;
      if (isAntigravityModel) {
        nextPayloadBody = {
          project: "default-cli-project",
          model: upstreamModel,
          request: nextPayloadBody,
        };
      }
      if (activeAdapter.name === "openai" && nextPayloadBody && typeof nextPayloadBody === "object") {
        nextPayloadBody = {
          ...nextPayloadBody,
          stream_options: {
            ...(nextPayloadBody.stream_options || {}),
            include_usage: true,
          },
        };
      }
      finalPayloadBody = textOnlyProvider
        ? normalizeTextOnlyProviderChatPayload(nextPayloadBody)
        : nextPayloadBody;
      if (textOnlyProvider) assertNoNativeVisionImages(finalPayloadBody);
      if (nextOptimized.stats.optimized || nextOptimized.stats.deduplicated) {
        console.info(
          `[OpenCodex Computer Use] optimized third-party Chat vision fallback ` +
          `optimized=${nextOptimized.stats.optimized} deduplicated=${nextOptimized.stats.deduplicated} ` +
          `bytes=${nextOptimized.stats.inputBytes}->${nextOptimized.stats.outputBytes}`,
        );
      }
    };

    const retryChatImagesThroughNativeVision = async (
      imageRequestBody: any,
      operation: string,
    ): Promise<Response> => {
      const visionRequestBody = hasNativeVisionImages(imageRequestBody) ? imageRequestBody : reqBody;
      const vision = await analyzeNativeVisionOnce(visionRequestBody, nativeImageHeaders, {
        providerApiKey: apiKey,
        signal: controller.signal,
        allowNetwork: hasNativeVisionImagesInCurrentTurn(visionRequestBody),
      });
      if (vision.error) {
        throw new NativeVisionBridgeError(
          vision.error.code,
          vision.error.message,
          vision.error.statusCode || 0,
        );
      }

      const bridgedRequestBody = stripImageInspectionToolsForTextOnlyTurn(
        replaceImagesWithNativeVisionText(
          hasNativeVisionImages(reqBody) ? reqBody : imageRequestBody,
          vision.text,
        ),
      );
      const chatSource = hasNativeVisionImages(optimizedChatBody)
        ? optimizedChatBody
        : hasNativeVisionImages(imageRequestBody)
          ? imageRequestBody
          : optimizedChatBody;
      const bridgedChatBody = stripImageInspectionToolsForTextOnlyTurn(
        normalizeTextOnlyProviderChatPayload(
          replaceImagesWithNativeVisionText(chatSource, vision.text),
        ),
      );
      assertNoNativeVisionImages(bridgedChatBody);
      reqBody = bridgedRequestBody;
      await rebuildProviderPayloadAfterVision(bridgedRequestBody, bridgedChatBody);
      console.warn(
        `[CodexSplit Provider] provider rejected tool/image input; retrying through native vision `
        + `model=${vision.model} provider=${providerName || "provider"} backend=${upstreamModel} images=${vision.imageCount}`,
      );
      return fetchUpstream(finalTargetUrl, {
        method: "POST",
        headers: finalHeaders,
        body: JSON.stringify(finalPayloadBody),
        signal: controller.signal,
        maxAttempts: 1,
        timeoutMs: 120_000,
        operation,
      });
    };

    console.info(
      `[CodexSplit Provider] request provider=${providerName || "provider"} model=${upstreamModel} ` +
      `messages=${Array.isArray(finalPayloadBody?.messages) ? finalPayloadBody.messages.length : 0} ` +
      `tools=${Array.isArray(finalPayloadBody?.tools) ? finalPayloadBody.tools.map((tool: any) => tool?.function?.name || tool?.name).filter(Boolean).join(",") || "(none)" : "(none)"} ` +
      `tool_images=${hasChatToolImages(finalPayloadBody)} ` +
      `continuation=${Boolean(reqBody?.input?.some?.((item: any) => [
        "function_call_output",
        "mcp_call_output",
        "custom_tool_call_output",
        "computer_call_output",
      ].includes(item?.type)))}`,
    );

    pruneCursorPendingToolCalls();
    const requestedCursorToolOutput = isCursorModel ? cursorFunctionCallOutput(reqBody) : undefined;
    const pendingCursorTool = isCursorModel && cursorStateKey
      ? cursorPendingToolCalls.get(cursorStateKey)
      : undefined;
    const matchedPendingCursorTool = pendingCursorTool && requestedCursorToolOutput?.callId === pendingCursorTool.callId
      ? pendingCursorTool
      : undefined;




    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.socket?.setNoDelay(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);

    const writeSse = async (payload: any) => {
      if (!res.writableEnded) {
        await writeSseData(res, payload);
      }
    };

    // Native Computer Use often starts a turn with explanatory text and only
    // emits the node-repl call a few chunks later. Keep that message in the
    // commentary phase from its first event; otherwise Codex Desktop may
    // treat the early text as a replaceable final answer and clear it when
    // the first desktop action arrives.
    const nativeComputerUseTurn = requestUsesComputerUse || hasNativeComputerUseTool(optimizedChatBody?.tools);
    const engine = new ResponsesStreamEngine(
      upstreamModel,
      reqBody?.client_metadata?.turn_id,
      {
        forceCommentary: nativeComputerUseTurn,
        responseModel: selectedResponseModel,
        // A third-party main model must be handled by the gateway itself.
        // Child turns are intentionally excluded so delegation cannot recurse.
        internalToolNames: !isSubagentRequest && !isCursorModel && this.subagentDispatcher
          ? ["spawn_agent", "multi_agent_v1_spawn_agent"]
          : [],
      },
    );
    let engineStarted = false;
    const emitFailedResponse = async (message: string, code = "provider_request_failed"): Promise<void> => {
      if (!engineStarted) {
        await engine.start(writeSse);
        engineStarted = true;
      }
      const now = Math.floor(Date.now() / 1000);
      const failedResponse = {
        id: engine.getResponseId(),
        object: "response",
        created_at: now,
        completed_at: now,
        status: "failed",
        model: selectedResponseModel,
        output: [],
        error: { code, message },
      };
      await writeSse({ type: "response.failed", response: failedResponse });
      // A failed provider turn still needs a protocol-level terminal event;
      // without it the native client retries the already-failed turn.
      await writeSse({ type: "response.completed", response: failedResponse });
      await writeSse({ type: "response.done", response: failedResponse });
    };
    let cursorToolResult: CursorToolResult | undefined;
    let pendingCursorToolRequest: CursorExternalToolRequest | undefined;
    const onCursorToolEvent = (event: CursorToolEvent): void => {
      const args = event.arguments ? ` args=${event.arguments.replace(/\s+/g, " ").slice(0, 500)}` : "";
      console.log(`[OpenCodex Cursor] tool-${event.phase} transport=${event.transport} name=${event.name} id=${event.id}${event.execId ? ` exec_id=${event.execId}` : ""}${event.exitCode !== undefined ? ` exit=${event.exitCode}` : ""}${args}`);
    };
    const onExternalCursorToolRequest = (request: CursorExternalToolRequest): void => {
      if (cursorStateKey) {
        const queue = cursorExternalToolQueues.get(cursorStateKey) || [];
        queue.push(request);
        cursorExternalToolQueues.set(cursorStateKey, queue);
      } else if (!pendingCursorToolRequest) {
        pendingCursorToolRequest = request;
      }
      console.log(`[OpenCodex Cursor] external-tool-pending transport=${request.transport} name=${request.name} id=${request.id}${request.execId ? ` exec_id=${request.execId}` : ""} args=${request.arguments.replace(/\s+/g, " ").slice(0, 500)}`);
    };

    try {
      const requestCursorMessages = isCursorModel
        ? optimizedChatBody.messages.map((message: any) => ({
          role: String(message.role || "user"),
          content: typeof message.content === "string" ? message.content : JSON.stringify(message.content || ""),
        }))
        : [];
      const currentCursorMessages = requestCursorMessages.filter((message) => message.role !== "system");
      const cursorSystemMessages = requestCursorMessages.filter((message) => message.role === "system");
      const cursorFollowupUserMessages = matchedPendingCursorTool && requestedCursorToolOutput
        ? cursorUserMessagesAfterToolResult(currentCursorMessages)
        : [];
      const rememberedCursorMessages = isCursorModel && cursorHistoryId
        ? (loadCursorSessionHistory(), cursorSessionHistory.get(cursorHistoryId) || [])
        : [];
      const resumedCursorMessages = matchedPendingCursorTool && requestedCursorToolOutput
        ? [
          ...matchedPendingCursorTool.messages,
          { role: "tool", content: requestedCursorToolOutput.output },
          ...(cursorFollowupUserMessages.length > 0
            ? cursorFollowupUserMessages
            : [{ role: "user" as const, content: "Continue the original task using the tool result above." }]),
        ]
        : undefined;
      const cursorMessages = resumedCursorMessages || (isCursorModel && rememberedCursorMessages.length > 0 && !cursorMessagesIncludeHistory(currentCursorMessages, rememberedCursorMessages)
        ? [...cursorSystemMessages, ...rememberedCursorMessages, ...currentCursorMessages]
        : requestCursorMessages);
      const cursorModelForRequest = matchedPendingCursorTool?.model || upstreamModel;
      // AgentService model IDs are provider metadata, not the same thing as
      // the imported picker slug. Resolve them once at the Cursor boundary so
      // the selected reasoning effort is preserved without touching native
      // GPT or ordinary third-party requests.
      let cursorAgentModelForRequest = cursorModelForRequest;
      const cursorContinuation = matchedPendingCursorTool && requestedCursorToolOutput
        ? {
          ...matchedPendingCursorTool.continuation,
          output: requestedCursorToolOutput.output,
          isError: false,
        }
        : undefined;
      let response: Response;
      const nativeCursorContinuation = isCursorModel && matchedPendingCursorTool && requestedCursorToolOutput
        && matchedPendingCursorTool.providerResponse?.body
        && matchedPendingCursorTool.providerReader
        && matchedPendingCursorTool.respond;
      if (nativeCursorContinuation) {
        console.log(`[OpenCodex Cursor] native-session-resume call_id=${matchedPendingCursorTool.callId}`);
        await matchedPendingCursorTool.respond!(requestedCursorToolOutput!.output, false);
        response = matchedPendingCursorTool.providerResponse!;
      } else if (isCursorModel) {
        response = await (async () => {
          const cursorToken = await SubscriptionAuthService.getCursorAccessToken();
          if (!cursorToken) throw new Error("未找到有效的 Cursor 本机登录凭证");
          const cursorModels = await fetchCursorModelsCached(
            cursorToken,
            getCursorClientVersion(),
            AbortSignal.timeout(15000),
          );
          cursorAgentModelForRequest = resolveCursorAgentModelSelector(
            cursorModelForRequest,
            String(reqBody?.reasoning?.effort || reqBody?.reasoning_effort || "").trim() || undefined,
            cursorModels,
          );
          const inputToolNames = (optimizedChatBody.tools || []).map((tool: any) => String(tool?.function?.name || tool?.name || "")).filter(Boolean);
          const advertisedToolNames = cursorAdvertisedToolNames(optimizedChatBody.tools as any);
          console.log(`[OpenCodex Cursor] AgentRun model=${cursorAgentModelForRequest} source_model=${cursorModelForRequest} input_tools=${inputToolNames.length ? inputToolNames.join(",") : "(none)"} advertised_mcp_tools=${advertisedToolNames.length ? advertisedToolNames.join(",") : "(none)"} tool_choice=${String(reqBody?.tool_choice || "auto")} mode=AGENT${matchedPendingCursorTool ? " continuation=true" : ""}`);
          return streamCursorChat(
            cursorToken,
            cursorMessages,
            cursorAgentModelForRequest,
            String(reqBody?.client_metadata?.turn_id || `opencodex-${Date.now()}`),
            String(matchedPendingCursorTool?.conversationId || sessionId || `opencodex-${Date.now()}`),
            getCursorClientVersion(),
            controller.signal,
            {
              workspaceRoot: process.cwd(),
              tools: optimizedChatBody.tools as any,
              onServerMessage: (message) => {
                if (message.message.case === "execServerMessage") {
                  console.log(`[OpenCodex Cursor] execServerMessage=${message.message.value.message.case || "unknown"}`);
                } else if (message.message.case === "interactionQuery") {
                  console.log(`[OpenCodex Cursor] interactionQuery=${message.message.value.query.case || "unknown"}`);
                }
              },
              onToolResult: (result) => { cursorToolResult = result; },
              onToolEvent: onCursorToolEvent,
              // Codex owns the tool loop. Cursor only emits tool intent over
              // AgentService; the request is surfaced as a Codex function_call
              // and the next function_call_output resumes this same task.
              manualExternalTools: true,
              onExternalToolRequest: onExternalCursorToolRequest,
              continuation: cursorContinuation,
            },
          );
        })();
      } else {
        response = await fetchUpstream(finalTargetUrl, {
          method: "POST",
          headers: finalHeaders,
          body: JSON.stringify(finalPayloadBody),
          signal: controller.signal,
          // A streaming POST may have been accepted by the provider before
          // its headers arrive. Retrying it can create a second execution of
          // the same Live task, so the caller must decide whether to retry.
          maxAttempts: 1,
          timeoutMs: 120_000,
          operation: `responses:${providerName || "provider"}`,
        });
      }

      // A provider can rotate/revoke a token before its advertised expiry.
      // Refresh once and retry the same request; never route to another
      // provider as an implicit fallback.
      let firstAuthErrorText: string | undefined;
      if ((isGrokModel || isAntigravityModel || isCursorModel || isClaudeModel) && (response.status === 401 || response.status === 403)) {
        firstAuthErrorText = await response.text();
        const refreshedToken = isGrokModel
          ? await SubscriptionAuthService.getGrokAccessToken(true)
          : isAntigravityModel
            ? await SubscriptionAuthService.getAntigravityAccessToken(true)
            : isCursorModel
              ? await SubscriptionAuthService.getCursorAccessToken(true)
              : await SubscriptionAuthService.getClaudeAccessToken(true);
        if (refreshedToken) {
          if (isCursorModel) {
            response = await streamCursorChat(
              refreshedToken,
              cursorMessages,
              cursorAgentModelForRequest,
              String(reqBody?.client_metadata?.turn_id || `opencodex-${Date.now()}`),
              String(matchedPendingCursorTool?.conversationId || sessionId || `opencodex-${Date.now()}`),
              getCursorClientVersion(),
              controller.signal,
            {
              workspaceRoot: process.cwd(),
              tools: optimizedChatBody.tools as any,
              onServerMessage: (message) => {
                if (message.message.case === "execServerMessage") {
                  console.log(`[OpenCodex Cursor] execServerMessage=${message.message.value.message.case || "unknown"}`);
                } else if (message.message.case === "interactionQuery") {
                  console.log(`[OpenCodex Cursor] interactionQuery=${message.message.value.query.case || "unknown"}`);
                }
              },
              onToolResult: (result) => { cursorToolResult = result; },
              onToolEvent: onCursorToolEvent,
              manualExternalTools: true,
              onExternalToolRequest: onExternalCursorToolRequest,
              continuation: cursorContinuation,
            },
            );
          } else {
            finalHeaders["Authorization"] = `Bearer ${refreshedToken}`;
            if (isClaudeModel && !refreshedToken.startsWith("sk-ant-")) {
              finalHeaders["anthropic-beta"] = "oauth-2025-04-20";
              finalHeaders["anthropic-client-platform"] = "DESKTOP_APP";
              finalHeaders["anthropic-client-version"] = getClaudeDesktopVersion();
            }
            response = await fetchUpstream(finalTargetUrl, {
              method: "POST",
              headers: finalHeaders,
              body: JSON.stringify(finalPayloadBody),
              signal: controller.signal,
              maxAttempts: 1,
              timeoutMs: 120_000,
              operation: `responses:${providerName || "provider"}:auth-refresh`,
            });
          }
        }
      }

      clearTimeout(timeoutId);

      // Some legacy Chat gateways accept ordinary tool text but reject a
      // multimodal tool result with a generic Console Go 400. A screenshot
      // result is optional for Computer Use because the accessibility tree is
      // still present in the text result, so retry this exact case once with
      // the image removed. Native Responses providers never enter this path.
      let preReadErrorText: string | undefined;
      if (!response.ok || !response.body) {
        const initialErrorText = await response.text();
        // The Chat transformer can add screenshots rehydrated from the native
        // rollout. Use the actual provider payload as the image signal when
        // it contains one; checking only the current Responses delta misses
        // those historical tool-result images.
        const imageRequestBody = hasNativeVisionImages(finalPayloadBody) ? finalPayloadBody : reqBody;
        if (isProviderImageInputRejection(response.status, initialErrorText, imageRequestBody)) {
          response = await retryChatImagesThroughNativeVision(
            imageRequestBody,
            `responses:${providerName || "provider"}:vision-fallback`,
          );
          if (!response.ok || !response.body) {
            preReadErrorText = await response.text();
          }
        } else if (isConsoleGoToolImageRejection(response.status, initialErrorText, finalPayloadBody)) {
          // Console Go's generic wrapper used to trigger a silent screenshot
          // deletion here. That made a text-only third-party model appear to
          // understand the request while actually losing the user's image.
          // Route the same native Computer Use screenshot through official
          // Codex vision first; a vision failure is surfaced as a failed turn.
          response = await retryChatImagesThroughNativeVision(
            imageRequestBody,
            `responses:${providerName || "provider"}:chat-tool-image-vision-fallback`,
          );
          if (!response.ok || !response.body) {
            preReadErrorText = await response.text();
          }
        } else if (isXiaomiChatToolTextRejection(response.status, initialErrorText, finalPayloadBody)) {
          // The first MiMo request already has the strict text fields. If its
          // validator still rejects a screenshot-bearing tool result, retry
          // once with the textual accessibility result only. Do not apply this
          // fallback to MiniMax or to an unrelated Xiaomi 400.
          const normalizedPayload = normalizeXiaomiChatToolHistory(finalPayloadBody);
          const fallbackPayloadBody = hasNativeVisionImages(imageRequestBody)
            ? undefined
            : stripChatToolImages(normalizedPayload);
          console.warn(
            `[CodexSplit Provider] retrying MiMo Chat continuation `
            + `${fallbackPayloadBody ? "with text-only tool results" : "through native vision"} `
            + `provider=${providerName || "provider"} model=${upstreamModel}`,
          );
          const fallbackResponse = fallbackPayloadBody
            ? await fetchUpstream(finalTargetUrl, {
              method: "POST",
              headers: finalHeaders,
              body: JSON.stringify(fallbackPayloadBody),
              signal: controller.signal,
              maxAttempts: 1,
              timeoutMs: 120_000,
              operation: `responses:${providerName || "provider"}:mimo-chat-tool-fallback`,
            })
            : await retryChatImagesThroughNativeVision(
              imageRequestBody,
              `responses:${providerName || "provider"}:mimo-chat-tool-vision-fallback`,
            );
          response = fallbackResponse;
          if (response.ok && response.body) {
            if (fallbackPayloadBody) finalPayloadBody = fallbackPayloadBody;
          } else {
            preReadErrorText = await response.text();
          }
        } else {
          preReadErrorText = initialErrorText;
        }
      }

      if (!response.ok || !response.body) {
        const errText = firstAuthErrorText && (response.status === 401 || response.status === 403)
          ? firstAuthErrorText
          : preReadErrorText ?? await response.text();
        if (allowCredentialFailover && credentialId && shouldRotateProviderCredential(response.status)) {
          throw new ProviderCredentialError(
            `Provider API Key 请求失败（HTTP ${response.status}）：${errText.slice(0, 800)}`,
            response.status,
            credentialId,
          );
        }
        res.flushHeaders();
        if (response.status === 400) {
          // A provider validation enum is authoritative capability metadata.
          // Record it for the next model-picker refresh, but never silently
          // replace the user's selected effort on this request.
          CatalogSyncService.learnReasoningLevelsFromProviderError(providerName, upstreamModel, errText);
        }
        console.error(`[CodexBridge V2] Upstream error (${response.status}) for ${finalTargetUrl}: ${errText}`);
        let msg = `Upstream API Error (${response.status})`;
        try {
          const parsed = JSON.parse(errText);
          msg = parsed.error?.message || parsed.error || parsed.message || errText || msg;
        } catch {
          msg = errText || msg;
        }

        if (isGrokModel && (response.status === 401 || response.status === 403 || errText.includes("Incorrect API key") || errText.includes("bad-credentials"))) {
          msg = "Grok 本机登录凭证已失效/撤销，请在终端运行 \"grok login\" 重新登录，或在 CodexSplit 控制面板保存 x.AI API Key。";
        }
        if (isClaudeModel && (response.status === 401 || response.status === 403 || errText.includes("invalid_api_key") || errText.includes("authentication_error"))) {
          const claudeFailure = SubscriptionAuthService.getClaudeAuthFailure();
          msg = claudeFailure.includes("requires a Pro or Max subscription")
            ? "已读取 Claude 登录态，但 Claude Code 订阅要求 Pro 或 Max 套餐。"
            : claudeFailure.startsWith("authorize_http_403")
              ? "已读取 Claude 登录态，但 Claude 上游拒绝了订阅授权；请确认账号套餐或配置 Anthropic API Key。"
              : "Claude API 凭证未找到或已失效。若使用的是 Console API 请在 CodexSplit 控制面板配置 Anthropic API Key，或运行 \"claude login\" 重新认证。";
        }
        if (isCursorModel && (response.status === 401 || response.status === 403 || response.status === 404)) {
          msg = "Cursor 本地凭证未生效或目标接口响应异常，请在 Cursor 软件中重新登录账户，或在 CodexSplit 中配置相关 API Key。";
        }
        if (isCursorModel && response.status === 415) {
          msg = "Cursor 上游拒绝了协议格式（415）。请确认网关使用的是原始 protobuf 请求和 Connect 流式响应，而不是把请求再次封装成流式帧。";
        }
        if (isCursorModel && /outdated|deprecated|ERROR_OUTDATED_CLIENT/i.test(errText)) {
          msg = "Cursor 上游已拒绝当前客户端协议：本机 Cursor 版本已被判定为过旧。请先从 Cursor 官网更新/重新下载 Cursor（设置会保留），再重试；这不是免费套餐限制。";
        }


        // Do not turn an upstream/provider failure into a completed assistant
        // message. Codex and GPT-Live interpret response.completed as a
        // successful turn and may announce that a task was dispatched even
        // though no model response or tool call ever arrived.
        await emitFailedResponse(msg);
        res.end();
        return { completed: false, output: "" };
      }

      res.flushHeaders();
      await engine.start(writeSse);
      engineStarted = true;

      const reader = acquireCursorStreamReader(response, matchedPendingCursorTool?.providerReader);
      const decoder = new TextDecoder();
      let buffer = "";

      const readWithTimeout = (timeoutMs = 600000): Promise<ReadableStreamReadResult<Uint8Array>> => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Stream read timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
          reader.read().then((result) => {
            clearTimeout(timer);
            resolve(result);
          }, (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      };

      let providerStreamCompleted = false;
      let providerDataObserved = false;
      let parentTextLength = 0;
      const providerWantsStream = isAntigravityModel
        ? finalPayloadBody?.request?.stream !== false
        : finalPayloadBody?.stream !== false;

      if (isCursorModel) {
        let binaryBuffer = new Uint8Array(0);
        let cursorStreamComplete = false;
        let cursorHasVisibleText = false;
        let cursorLastVisibleTextAt = 0;
        let cursorHasPostToolText = false;
        let cursorLastPostToolTextAt = 0;
        let cursorToolResultObserved = false;
        let cursorToolCompleted = false;
        let cursorFallbackSent = false;
        const writeCursorToolFallback = async () => {
          if (cursorFallbackSent || cursorHasPostToolText || !cursorToolResult) return;
          cursorFallbackSent = true;
          const result = cursorToolResult;
          const output = result.stdout.trim();
          const error = result.stderr.trim();
          const text = result.exitCode === 0
            ? `已执行命令「${result.command}」。\n${output || "命令执行完成，没有标准输出。"}${error ? `\n错误输出：${error}` : ""}`
            : `命令「${result.command}」执行失败（退出码 ${result.exitCode}）。${error ? `\n${error}` : ""}`;
          await engine.processChatChunk(writeSse, { choices: [{ delta: { content: text } }] });
        };
        while (true) {
          if (cursorToolResult && !cursorToolResultObserved) {
            // Text emitted before a shell request is usually only a plan. It
            // must not start the short final-text idle timer for the resumed
            // turn after the tool result arrives.
            cursorToolResultObserved = true;
            cursorHasPostToolText = false;
            cursorLastPostToolTextAt = 0;
          }
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            // Text before a tool call is planning output. After the tool
            // result, wait for a resumed answer before applying the short
            // final-text idle boundary.
            readResult = await readWithTimeout(
              cursorToolResultObserved
                ? (cursorHasPostToolText ? CURSOR_TEXT_IDLE_TIMEOUT_MS : CURSOR_TOOL_IDLE_TIMEOUT_MS)
                : cursorToolCompleted
                  ? CURSOR_TOOL_IDLE_TIMEOUT_MS
                  : cursorHasVisibleText
                    ? CURSOR_TEXT_IDLE_TIMEOUT_MS
                    : 600000,
            );
          } catch (readErr: any) {
            if (cursorToolResult && !cursorHasPostToolText) {
              await writeCursorToolFallback();
              controller.abort();
              break;
            }
            if (cursorHasVisibleText && /Stream read timeout/.test(String(readErr?.message || ""))) {
              console.warn("[CodexBridge V2] Cursor turn idle after text; closing the bidi stream cleanly.");
              controller.abort();
              break;
            }
            throw readErr;
          }
          if (readResult.done) {
            if (cursorToolResult && !cursorHasPostToolText) await writeCursorToolFallback();
            break;
          }
          const incoming = readResult.value || new Uint8Array(0);
          const merged = new Uint8Array(binaryBuffer.byteLength + incoming.byteLength);
          merged.set(binaryBuffer);
          merged.set(incoming, binaryBuffer.byteLength);
          binaryBuffer = merged;

          let offset = 0;
          while (binaryBuffer.byteLength - offset >= 5) {
            const flags = binaryBuffer[offset];
            const length = new DataView(binaryBuffer.buffer, binaryBuffer.byteOffset + offset + 1, 4).getUint32(0, false);
            if (binaryBuffer.byteLength - offset - 5 < length) break;
            const payload = binaryBuffer.slice(offset + 5, offset + 5 + length);
            offset += 5 + length;
            if ((flags & 0x01) !== 0) throw new Error("Cursor 返回了压缩响应，当前网关无法解码");
            if ((flags & 0x02) !== 0) {
              const streamError = decodeCursorEndStreamError(payload);
              if (streamError) throw new Error(`Cursor 流结束错误：${streamError}`);
              continue;
            }
            const text = decodeCursorStreamText(payload);
            if (text) {
              if (cursorToolResultObserved) {
                cursorHasPostToolText = true;
                cursorLastPostToolTextAt = Date.now();
              } else {
                cursorHasVisibleText = true;
                cursorLastVisibleTextAt = Date.now();
              }
              await engine.processChatChunk(writeSse, { choices: [{ delta: { content: text } }] });
            }
            if (decodeCursorToolCallCompleted(payload)) cursorToolCompleted = true;
            if (decodeCursorStreamComplete(payload)) {
              cursorStreamComplete = true;
              break;
            }
            const lastTextAt = cursorToolResultObserved ? cursorLastPostToolTextAt : cursorLastVisibleTextAt;
            const hasTextForIdleBoundary = cursorToolResultObserved ? cursorHasPostToolText : cursorHasVisibleText;
            if (hasTextForIdleBoundary && lastTextAt > 0 && Date.now() - lastTextAt >= CURSOR_TEXT_IDLE_TIMEOUT_MS) {
              cursorStreamComplete = true;
              break;
            }
          }
          binaryBuffer = binaryBuffer.slice(offset);
          if (!pendingCursorToolRequest && cursorStateKey) {
            pendingCursorToolRequest = takeCursorExternalToolRequest(cursorStateKey);
          }
          if (pendingCursorToolRequest && cursorStateKey) {
            const callId = `cursor_${pendingCursorToolRequest.transport}_${pendingCursorToolRequest.execId || pendingCursorToolRequest.id}`;
            const continuation: CursorToolContinuation = {
              transport: pendingCursorToolRequest.transport,
              callId,
              execId: pendingCursorToolRequest.execId,
              providerCallId: pendingCursorToolRequest.providerCallId,
              name: pendingCursorToolRequest.name,
              arguments: pendingCursorToolRequest.arguments,
              output: "",
              isError: false,
            };
            cursorPendingToolCalls.set(cursorStateKey, {
              key: cursorStateKey,
              callId,
              model: cursorAgentModelForRequest,
              conversationId: String(matchedPendingCursorTool?.conversationId || sessionId || `opencodex-${Date.now()}`),
              messages: cursorMessages,
              continuation,
              providerResponse: response,
              providerReader: reader,
              respond: pendingCursorToolRequest.respond,
              createdAt: Date.now(),
            });
            await engine.processChatChunk(writeSse, {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: callId,
                    type: "function",
                    function: {
                      name: pendingCursorToolRequest.name,
                      arguments: pendingCursorToolRequest.arguments,
                    },
                  }],
                },
              }],
            });
            // Do not abort or reopen the provider request here. Cursor's
            // AgentService is a bidi state machine: it is now paused waiting
            // for the Codex function_call_output. The next HTTP request will
            // write the native ExecClientMessage onto this same response
            // body/session.
            if (!pendingCursorToolRequest.respond || !response.body) {
              controller.abort();
            }
            break;
          }
          if (cursorStreamComplete) {
            if (cursorToolResult && !cursorHasPostToolText) await writeCursorToolFallback();
            // AgentService is a bidi stream and intentionally stays open after
            // turn_ended for follow-up context/tool messages. Close the
            // provider side now that this response turn is complete.
            controller.abort();
            break;
          }
        }
        if (matchedPendingCursorTool && !pendingCursorToolRequest) {
          cursorPendingToolCalls.delete(cursorStateKey);
          cursorExternalToolQueues.delete(cursorStateKey);
          try { matchedPendingCursorTool.providerReader?.releaseLock(); } catch {}
        }
        if (!pendingCursorToolRequest) rememberCursorSession(cursorHistoryId, cursorMessages, engine.getMessageText());
      } else if (!providerWantsStream) {
        let raw = "";
        while (true) {
          const readResult = await readWithTimeout(120_000);
          if (readResult.done) {
            raw += decoder.decode();
            break;
          }
          raw += decoder.decode(readResult.value, { stream: true });
        }
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new Error("上游返回了不可解析的非流式响应");
        }
        providerDataObserved = true;
        engine.observeProviderChunk(payload);
        const choice = payload?.choices?.[0];
        if (choice?.message && typeof choice.message === "object") {
          const message = choice.message;
          const delta: any = {};
          if (typeof message.role === "string") delta.role = message.role;
          if (message.content !== undefined) delta.content = message.content;
          const reasoningContent = typeof message.reasoning_content === "string"
            ? message.reasoning_content
            : typeof message.reasoning === "string"
              ? message.reasoning
              : "";
          if (reasoningContent) delta.reasoning_content = reasoningContent;
          if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls;
          if (Object.keys(delta).length > 0) {
            await engine.processChatChunk(writeSse, {
              choices: [{ delta, finish_reason: choice.finish_reason }],
              ...(payload.usage ? { usage: payload.usage } : {}),
            });
          }
        } else if (typeof payload?.output_text === "string" && payload.output_text) {
          await engine.processChatChunk(writeSse, { choices: [{ delta: { content: payload.output_text } }] });
        } else if (Array.isArray(payload?.content)) {
          const text = payload.content
            .filter((item: any) => item?.type === "text" && typeof item.text === "string")
            .map((item: any) => item.text)
            .join("");
          if (text) await engine.processChatChunk(writeSse, { choices: [{ delta: { content: text } }] });
        }
        if (!engine.hasOutput()) throw new Error("上游非流式响应没有可用的模型输出");
        providerStreamCompleted = true;
      } else {
        const processSseLine = async (line: string): Promise<void> => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const dataStr = trimmed.slice("data:".length).trim();
          if (!dataStr) return;
          if (dataStr === "[DONE]") {
            providerStreamCompleted = true;
            return;
          }

          providerDataObserved = true;

          let chunk: any;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            // SSE comments and provider keep-alives are harmless, but a
            // stream without a terminal event is not allowed to become a
            // synthetic response.completed.
            return;
          }
          if (providerChunkSignalsCompletion(chunk)) providerStreamCompleted = true;
          if (activeAdapter.processStreamChunk) {
            engine.observeProviderChunk(chunk);
            const normalizedChunks = activeAdapter.processStreamChunk(chunk);
            for (const nc of normalizedChunks) {
              await engine.processChatChunk(writeSse, nc);
            }
          } else {
            await engine.processChatChunk(writeSse, chunk);
          }
        };

        while (!providerStreamCompleted) {
          const providerReadTimeout = engine.getToolCallIds().length > 0
            ? PROVIDER_TOOL_IDLE_TIMEOUT_MS
            : engine.getMessageText().trim()
              ? PROVIDER_TEXT_IDLE_TIMEOUT_MS
              : PROVIDER_EMPTY_IDLE_TIMEOUT_MS;
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await readWithTimeout(providerReadTimeout);
          } catch (readErr: any) {
            if (engine.hasOutput() && /Stream read timeout/.test(String(readErr?.message || ""))) {
              console.warn(
                `[CodexSplit Provider] closing provider turn after idle output `
                + `provider=${providerName || "provider"} model=${upstreamModel} `
                + `tool_calls=${engine.getToolCallIds().length}`,
              );
              providerStreamCompleted = true;
              break;
            }
            throw readErr;
          }
          const { done, value } = readResult;
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              const finalLines = buffer.split("\n");
              buffer = "";
              for (const line of finalLines) await processSseLine(line);
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) await processSseLine(line);
        }

        if (providerStreamCompleted && !engine.hasOutput()) {
          throw new Error("上游流已结束，但没有收到可显示的模型输出或工具调用");
        }

        if (!providerStreamCompleted) {
          // Some OpenAI-compatible gateways close a successful stream after
          // the last content/tool delta and omit both `[DONE]` and
          // `finish_reason`. The output already received from the provider is
          // sufficient to close the local Responses turn; do not fabricate a
          // response for an empty stream.
          if (providerDataObserved && engine.hasOutput()) {
            console.warn(
              `[CodexSplit Provider] upstream stream ended after valid output ` +
              `without a terminal event provider=${providerName || "provider"} model=${upstreamModel}`,
            );
            providerStreamCompleted = true;
          } else {
            throw new Error("上游流在完成事件前结束，且没有收到可收尾的模型输出");
          }
        }
      }

      rememberPendingProviderReasoning(
        engine.getToolCallIds(),
        engine.getReasoningContent(),
        providerName,
        providerUrl,
        upstreamModel,
      );

      // Third-party main models cannot hand `spawn_agent` back to Codex
      // Desktop: the desktop only knows its native private tool executor.
      // Consume the gateway-owned calls here, run the selected child models,
      // append their outputs to the provider conversation, and let the same
      // parent model continue. This supports multiple independent children in
      // one turn and keeps the custom tool completely out of the client stream.
      const readAdditionalStandardProviderResponse = async (nextResponse: Response): Promise<void> => {
        if (!nextResponse.ok || !nextResponse.body) {
          const errorText = await nextResponse.text();
          throw new Error(`子代理调度后的主模型续答失败（HTTP ${nextResponse.status}）：${errorText.slice(0, 800)}`);
        }

        const nextReader = acquireCursorStreamReader(nextResponse);
        const nextDecoder = new TextDecoder();
        let nextBuffer = "";
        let nextCompleted = false;
        let nextDataObserved = false;
        let nextOutputObserved = false;
        const previousMessageText = engine.getMessageText();
        const previousToolCallIds = new Set(engine.getToolCallIds());
        const nextReadWithTimeout = (timeoutMs: number): Promise<ReadableStreamReadResult<Uint8Array>> => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`主模型子代理续答流读取超时（${Math.ceil(timeoutMs / 1000)}s）`)), timeoutMs);
          nextReader.read().then((result) => {
            clearTimeout(timer);
            resolve(result);
          }, (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        const processContinuationLine = async (line: string): Promise<void> => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const dataStr = trimmed.slice("data:".length).trim();
          if (!dataStr) return;
          if (dataStr === "[DONE]") {
            nextCompleted = true;
            return;
          }
          nextDataObserved = true;
          let chunk: any;
          try { chunk = JSON.parse(dataStr); } catch { return; }
          if (providerChunkSignalsCompletion(chunk)) nextCompleted = true;
          const choice = chunk?.choices?.[0];
          const delta = choice?.delta;
          const message = choice?.message;
          if (
            (typeof delta?.content === "string" && delta.content.length > 0)
            || (typeof delta?.text === "string" && delta.text.length > 0)
            || (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0)
            || (typeof delta?.reasoning === "string" && delta.reasoning.length > 0)
            || (typeof message?.content === "string" && message.content.length > 0)
            || (typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0)
            || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
            || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
          ) {
            nextOutputObserved = true;
          }
          if (activeAdapter.processStreamChunk) {
            engine.observeProviderChunk(chunk);
            for (const normalizedChunk of activeAdapter.processStreamChunk(chunk)) {
              await engine.processChatChunk(writeSse, normalizedChunk);
            }
          } else {
            await engine.processChatChunk(writeSse, chunk);
          }
          if (engine.getMessageText() !== previousMessageText) nextOutputObserved = true;
          if (engine.getToolCallIds().some((callId) => !previousToolCallIds.has(callId))) nextOutputObserved = true;
        };

        while (!nextCompleted) {
          const nextReadTimeout = engine.getToolCallIds().length > 0
            ? PROVIDER_TOOL_IDLE_TIMEOUT_MS
            : engine.getMessageText().trim()
              ? PROVIDER_TEXT_IDLE_TIMEOUT_MS
              : PROVIDER_EMPTY_IDLE_TIMEOUT_MS;
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await nextReadWithTimeout(nextReadTimeout);
          } catch (readErr: any) {
            if (nextOutputObserved && /续答流读取超时/.test(String(readErr?.message || ""))) {
              console.warn(
                `[CodexSplit Provider] closing subagent continuation after idle output `
                + `provider=${providerName || "provider"} model=${upstreamModel} `
                + `tool_calls=${engine.getToolCallIds().length}`,
              );
              nextCompleted = true;
              break;
            }
            throw readErr;
          }
          if (readResult.done) {
            nextBuffer += nextDecoder.decode();
            if (nextBuffer.trim()) {
              for (const line of nextBuffer.split("\n")) await processContinuationLine(line);
            }
            nextBuffer = "";
            if (!nextCompleted && nextOutputObserved) nextCompleted = true;
            break;
          }
          nextBuffer += nextDecoder.decode(readResult.value, { stream: true });
          const lines = nextBuffer.split("\n");
          nextBuffer = lines.pop() || "";
          for (const line of lines) await processContinuationLine(line);
        }
        if (!nextOutputObserved) {
          throw new Error(
            nextDataObserved
              ? "主模型子代理续答流只返回了非输出事件，已拒绝空回复"
              : "主模型子代理续答流在完成事件前结束，且没有收到可收尾的模型输出",
          );
        }
      };

      const rebuildProviderPayloadForContinuation = (): void => {
        const continuationChatBody = isXiaomiMimoChat
          ? normalizeXiaomiChatToolHistory(optimizedChatBody)
          : optimizedChatBody;
        const transformed = activeAdapter.transformPayload(continuationChatBody);
        finalPayloadBody = transformed.body;
        if (isAntigravityModel) {
          finalPayloadBody = {
            project: "default-cli-project",
            model: upstreamModel,
            request: transformed.body,
          };
        }
        if (activeAdapter.name === "openai" && finalPayloadBody && typeof finalPayloadBody === "object") {
          finalPayloadBody = {
            ...finalPayloadBody,
            stream_options: {
              ...(finalPayloadBody.stream_options || {}),
              include_usage: true,
            },
          };
        }
        if (textOnlyProvider) {
          finalPayloadBody = normalizeTextOnlyProviderChatPayload(finalPayloadBody);
          assertNoNativeVisionImages(finalPayloadBody);
        }
      };

      let subagentRound = 0;
      while (this.subagentDispatcher && !isSubagentRequest && !isCursorModel) {
        const internalCalls = engine.takeInternalToolCalls();
        if (internalCalls.length === 0) break;
        subagentRound += 1;
        if (subagentRound > 8) throw new Error("主模型连续调度子代理超过 8 轮，已停止继续递归");

        const results = await this.subagentDispatcher(internalCalls, {
          parent_task_id: sessionId,
          parent_model: selectedResponseModel,
          provider: providerName,
          backend_model: upstreamModel,
          parent_reasoning_effort: String(reqBody?.reasoning?.effort || reqBody?.reasoning_effort || "").trim() || undefined,
          source: subagentSource,
        });
        if (results.length > 0 && results.every((result) => Boolean(result.error))) {
          const details = results.map((result) => result.error).filter(Boolean).join("；");
          throw new Error(`子代理调度失败，已停止主模型重试：${details || "没有可用的子代理结果"}`);
        }
        const resultByCallId = new Map(results.map((result) => [result.call_id, result]));
        const currentText = engine.getMessageText();
        const assistantText = currentText.slice(parentTextLength);
        parentTextLength = currentText.length;
          optimizedChatBody.messages.push({
          role: "assistant",
          content: assistantText,
          tool_calls: internalCalls.map((call) => ({
            id: call.call_id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
            ...(call.thought_signature ? { thought_signature: call.thought_signature, thoughtSignature: call.thought_signature } : {}),
          })),
        });
        for (const call of internalCalls) {
          const result = resultByCallId.get(call.call_id);
          const output = result?.error
            ? `子代理执行失败：${result.error}`
            : result?.output || "子代理已完成，但没有返回文本。";
          optimizedChatBody.messages.push({
            role: "tool",
            tool_call_id: call.call_id,
            name: call.name,
            content: output,
          });
        }
        rebuildProviderPayloadForContinuation();
        console.info(
          `[OpenCodex Subagent] third-party parent continuation round=${subagentRound} ` +
          `children=${internalCalls.length} ` +
          `models=${results.map((result) => result.model || "unresolved").join(",")}`,
        );
        const continuationResponse = await fetchUpstream(finalTargetUrl, {
          method: "POST",
          headers: finalHeaders,
          body: JSON.stringify(finalPayloadBody),
          signal: controller.signal,
          maxAttempts: 1,
          timeoutMs: 120_000,
          operation: `responses:${providerName || "provider"}:subagent-continuation`,
        });
        await readAdditionalStandardProviderResponse(continuationResponse);
      }

      const internalImageCalls = engine.getInternalImageToolCalls();
      for (const call of internalImageCalls) {
        const imageArgs = parseImageGenerationArguments(call.arguments, imageGenerationContext.text);
        const images = await generateNativeCodexImage(imageArgs, imageGenerationContext, nativeImageHeaders);
        for (const image of images) {
          await engine.emitImageGeneration(writeSse, {
            result: image.data,
            revised_prompt: image.revisedPrompt,
            partial_images: image.partialImages,
          });
        }
      }

      await engine.finish(writeSse);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return { completed: true, output: engine.getMessageText().trim() };
    } catch (err: any) {
      if (err instanceof ProviderCredentialError) throw err;
      clearTimeout(timeoutId);
      controller.abort();
      const upstreamDetails = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Stream error for ${finalTargetUrl}:`, {
        stack: err.stack,
        ...upstreamDetails,
        attempts: err?.attempts,
      });
      if (err instanceof NativeVisionBridgeError) {
        if (!res.headersSent) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
        }
        await emitFailedResponse(err.message, err.code);
        if (!res.writableEnded) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
        return { completed: false, output: "" };
      }
      const attemptsText = Number.isFinite(err?.attempts) ? `（已尝试 ${err.attempts} 次）` : "";
      const causeText = upstreamDetails.code ? ` [${upstreamDetails.code}]` : "";
      const detailMsg = isCursorModel && /outdated|deprecated|upgrade/i.test(String(err.message || ""))
        ? "Cursor 上游已拒绝当前客户端协议：本机 Cursor 版本已被判定为过旧。请先从 Cursor 官网更新/重新下载 Cursor（设置会保留），再重试；这不是免费套餐限制。"
        : err.message === "fetch failed"
        ? `无法连接服务商接口${causeText}${attemptsText}：网络连接或 TLS 握手失败。请在 CodexSplit 控制面板检查该服务商 Endpoint / Base URL 是否填写正确。`
        : err.message;
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
      }
      if (!res.writableEnded) {
        // A transport failure is also a failed Responses turn, regardless of
        // whether the provider failed before headers or during its stream.
        // Never synthesize assistant text or response.completed here.
        await emitFailedResponse(
          detailMsg,
          err instanceof NativeVisionBridgeError ? err.code : "upstream_unreachable",
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return { completed: false, output: "" };
    }
  }
}
