import http from "node:http";
import { ResponsesStreamEngine } from "../core/stream_engine.js";
import { buildGatewaySubagentResponseTool, isSubagentDispatchToolName, stripSubagentRuntimeTools, transformResponsesToChat } from "../core/transformer.js";
import { AdapterFactory } from "../adapters/factory.js";
import { GoogleGeminiAdapter } from "../adapters/google.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { getClaudeDesktopVersion, getCursorClientVersion, SubscriptionAuthService } from "../services/subscription_auth.js";
import { fetchUpstream, upstreamErrorDetails } from "../services/upstream_fetch.js";
import { extractImageGenerationContext, generateNativeCodexImage, parseImageGenerationArguments } from "../services/native_image_bridge.js";
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
import { CatalogSyncService } from "../services/catalog_sync.js";

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
}

export interface GatewaySubagentDispatchResult {
  call_id: string;
  task_id?: string;
  model?: string;
  reasoning_effort?: string;
  output: string;
  error?: string;
}

export type GatewaySubagentDispatcher = (
  calls: GatewaySubagentDispatchCall[],
  context: GatewaySubagentDispatchContext,
) => Promise<GatewaySubagentDispatchResult[]>;



const CURSOR_TEXT_IDLE_TIMEOUT_MS = 2000;
const CURSOR_TOOL_IDLE_TIMEOUT_MS = 8000;
const MAX_CURSOR_SESSION_MESSAGES = 40;
const MAX_CURSOR_SESSION_CACHE_ENTRIES = 100;
const cursorSessionHistory = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
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
  const upstreamBody = { ...(body || {}), model: upstreamModel };
  // `protocol` is a gateway catalog hint, not an upstream Responses field.
  delete upstreamBody.protocol;
  return upstreamBody;
}

function isResponsesUnsupported(status: number, body: string): boolean {
  if (status === 404 || status === 405) return true;
  if (status !== 415) return false;
  return /response|protocol|endpoint|unsupported|not supported|not found/i.test(body);
}

function sanitizeThirdPartyResponsesPayload(
  payload: any,
  blockedReasoningIds: Set<string>,
  nativeComputerUseCallIds?: Set<string>,
): any | null {
  if (!payload || typeof payload !== "object") return payload;

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
): Promise<"handled" | "fallback"> {
  const targetUrl = responsesEndpointForProvider(providerUrl);
  const optimized = await optimizeThirdPartyComputerUseImages(reqBody);
  const upstreamBody = {
    ...optimized.body,
    model: upstreamModel,
    ...(isSubagentRequest
      ? { tools: stripSubagentRuntimeTools(optimized.body?.tools) }
      : subagentDispatcher
        ? {
          tools: [
            ...(Array.isArray(optimized.body?.tools) ? optimized.body.tools : []),
            buildGatewaySubagentResponseTool(),
          ].filter((tool: any, index: number, list: any[]) => list.findIndex((candidate) => String(candidate?.name || candidate?.function?.name || "") === String(tool?.name || tool?.function?.name || "")) === index),
          ...(optimized.body?.parallel_tool_calls === undefined ? { parallel_tool_calls: true } : {}),
        }
        : {}),
  };
  delete upstreamBody.protocol;
  if (optimized.stats.optimized || optimized.stats.deduplicated) {
    console.info(
      `[OpenCodex Computer Use] optimized third-party Responses screenshots ` +
      `optimized=${optimized.stats.optimized} deduplicated=${optimized.stats.deduplicated} ` +
      `bytes=${optimized.stats.inputBytes}->${optimized.stats.outputBytes}`,
    );
  }

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
      operation: "native-third-party-responses",
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      const errorText = await upstreamRes.text();
      if (upstreamRes.status === 400) {
        CatalogSyncService.learnReasoningLevelsFromProviderError(providerName, upstreamModel, errorText);
      }
      if (isResponsesUnsupported(upstreamRes.status, errorText)) {
        console.warn(`[OpenCodex Provider] Responses unsupported by ${targetUrl}; falling back to Chat conversion`);
        return "fallback";
      }
      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
      res.writeHead(upstreamRes.status, responseHeaders);
      res.end(errorText || JSON.stringify({ error: `Upstream API Error (${upstreamRes.status})` }));
      return "handled";
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
    const details = upstreamErrorDetails(err);
    console.error(`[CodexBridge V2] Native third-party Responses proxy error:`, {
      ...details,
      attempts: err?.attempts,
    });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: err.message,
      type: "upstream_unreachable",
      retryable: Boolean(err?.retryable),
      cause_code: details.code,
    }));
    return "handled";
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
): Promise<void> {
    const sessionId = reqBody?.client_metadata?.session_id || reqBody?.session_id;
    const selectedResponseModel = String(responseModel || reqBody?.model || upstreamModel).trim() || upstreamModel;
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
        },
        providerName,
      );
      if (nativeResult === "handled") return;
      // The configured Responses endpoint is unavailable; use the existing
      // Chat compatibility conversion for this request.
      reqBody = { ...reqBody, protocol: "chat" };
    }
    const imageGenerationContext = extractImageGenerationContext(reqBody);
    const chatBody = transformResponsesToChat(reqBody, upstreamModel, sessionId, !isSubagentRequest);
    const optimizedChat = await optimizeThirdPartyComputerUseImages(chatBody);
    const optimizedChatBody = optimizedChat.body;
    const isXiaomiMimoChat = isXiaomiMimoProvider(providerName, providerUrl, upstreamModel);
    // MiMo's Chat validator is stricter than the OpenAI schema for tool
    // history: an assistant tool-call turn and an image-only tool result must
    // still carry a text field. Keep this isolated to the Xiaomi/MiMo route;
    // MiniMax and all other providers retain the ordinary Chat payload.
    const providerChatBody = isXiaomiMimoChat
      ? normalizeXiaomiChatToolHistory(optimizedChatBody)
      : optimizedChatBody;
    providerChatBody.stream = true;
    if (optimizedChat.stats.optimized || optimizedChat.stats.deduplicated) {
      console.info(
        `[OpenCodex Computer Use] optimized third-party Chat screenshots ` +
        `optimized=${optimizedChat.stats.optimized} deduplicated=${optimizedChat.stats.deduplicated} ` +
        `bytes=${optimizedChat.stats.inputBytes}->${optimizedChat.stats.outputBytes}`,
      );
    }
    optimizedChatBody.stream = true;

    const adapter = AdapterFactory.getAdapter(reqBody?.protocol, providerUrl);
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
    const isAntigravityModel = (
      providerName.toLowerCase() === "antigravity" ||
      apiKey === "antigravity-cli-auto" ||
      providerUrl.includes("antigravity") ||
      providerUrl.includes("generativelanguage")
    ) && !apiKey.startsWith("AIzaSy");

    let finalTargetUrl = targetUrl;
    let finalHeaders = { ...headers };
    let finalPayloadBody = payloadBody;

    let activeAdapter = adapter;

    if (isAntigravityModel) {
      const oauthToken = await SubscriptionAuthService.getAntigravityAccessToken();

      console.log(`[OpenCodex V2] Antigravity token resolved: ${Boolean(oauthToken)}`);

      if (oauthToken) {
        finalTargetUrl = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
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
    const isGrokModel = (
      providerName.toLowerCase() === "grok" ||
      apiKey === "grok-cli-auto" ||
      providerUrl.includes("x.ai") ||
      providerUrl.includes("grok")
    ) && !apiKey.startsWith("xai-") && !isAntigravityModel;

    if (isGrokModel) {
      const grokToken = await SubscriptionAuthService.getGrokAccessToken();
      if (grokToken) {
        finalHeaders["Authorization"] = `Bearer ${grokToken}`;
        finalHeaders["User-Agent"] = "grok-cli/1.89.0";
        finalTargetUrl = "https://api.x.ai/v1/chat/completions";
      }
    }

    // Claude Subscription Routing
    const isClaudeModel = (
      providerName.toLowerCase() === "claude" ||
      apiKey === "claude-cli-auto" ||
      providerUrl.includes("anthropic") ||
      providerUrl.includes("claude")
    ) && !isAntigravityModel && !isGrokModel;

    if (isClaudeModel) {
      activeAdapter = new AnthropicAdapter();
      const payload = activeAdapter.transformPayload(optimizedChatBody);
      finalTargetUrl = "https://api.anthropic.com/v1/messages";
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
    const isCursorModel = (
      providerName.toLowerCase() === "cursor" ||
      apiKey === "cursor-cli-auto" ||
      providerUrl.includes("cursor")
    ) && !isAntigravityModel && !isGrokModel && !isClaudeModel;

    if (isCursorModel) {
      finalTargetUrl = "https://agent.api5.cursor.sh/agent.v1.AgentService/Run";
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

    console.info(
      `[OpenCodex Provider] request provider=${providerName || "provider"} model=${upstreamModel} ` +
      `messages=${Array.isArray(finalPayloadBody?.messages) ? finalPayloadBody.messages.length : 0} ` +
      `tools=${Array.isArray(finalPayloadBody?.tools) ? finalPayloadBody.tools.map((tool: any) => tool?.function?.name || tool?.name).filter(Boolean).join(",") || "(none)" : "(none)"} ` +
      `tool_images=${hasChatToolImages(finalPayloadBody)} ` +
      `continuation=${Boolean(reqBody?.input?.some?.((item: any) => item?.type === "function_call_output"))}`,
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
        ? cursorSessionHistory.get(cursorHistoryId) || []
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
        if (isConsoleGoToolImageRejection(response.status, initialErrorText, finalPayloadBody)) {
          const fallbackPayloadBody = stripChatToolImages(finalPayloadBody);
          console.warn(
            `[OpenCodex Provider] retrying Chat request without tool images provider=${providerName || "provider"} model=${upstreamModel}`,
          );
          const fallbackResponse = await fetchUpstream(finalTargetUrl, {
            method: "POST",
            headers: finalHeaders,
            body: JSON.stringify(fallbackPayloadBody),
            signal: controller.signal,
            maxAttempts: 1,
            timeoutMs: 120_000,
            operation: `responses:${providerName || "provider"}:chat-tool-image-fallback`,
          });
          response = fallbackResponse;
          if (response.ok && response.body) {
            finalPayloadBody = fallbackPayloadBody;
          } else {
            preReadErrorText = await response.text();
          }
        } else if (isXiaomiChatToolTextRejection(response.status, initialErrorText, finalPayloadBody)) {
          // The first MiMo request already has the strict text fields. If its
          // validator still rejects a screenshot-bearing tool result, retry
          // once with the textual accessibility result only. Do not apply this
          // fallback to MiniMax or to an unrelated Xiaomi 400.
          const normalizedPayload = normalizeXiaomiChatToolHistory(finalPayloadBody);
          const fallbackPayloadBody = stripChatToolImages(normalizedPayload);
          console.warn(
            `[OpenCodex Provider] retrying MiMo Chat continuation with text-only tool results provider=${providerName || "provider"} model=${upstreamModel}`,
          );
          const fallbackResponse = await fetchUpstream(finalTargetUrl, {
            method: "POST",
            headers: finalHeaders,
            body: JSON.stringify(fallbackPayloadBody),
            signal: controller.signal,
            maxAttempts: 1,
            timeoutMs: 120_000,
            operation: `responses:${providerName || "provider"}:mimo-chat-tool-fallback`,
          });
          response = fallbackResponse;
          if (response.ok && response.body) {
            finalPayloadBody = fallbackPayloadBody;
          } else {
            preReadErrorText = await response.text();
          }
        } else {
          preReadErrorText = initialErrorText;
        }
      }

      if (!response.ok || !response.body) {
        res.flushHeaders();
        const errText = firstAuthErrorText && (response.status === 401 || response.status === 403)
          ? firstAuthErrorText
          : preReadErrorText ?? await response.text();
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
          msg = "Grok 本机登录凭证已失效/撤销，请在终端运行 \"grok login\" 重新登录，或在 OpenCodex 控制面板保存 x.AI API Key。";
        }
        if (isClaudeModel && (response.status === 401 || response.status === 403 || errText.includes("invalid_api_key") || errText.includes("authentication_error"))) {
          const claudeFailure = SubscriptionAuthService.getClaudeAuthFailure();
          msg = claudeFailure.includes("requires a Pro or Max subscription")
            ? "已读取 Claude 登录态，但 Claude Code 订阅要求 Pro 或 Max 套餐。"
            : claudeFailure.startsWith("authorize_http_403")
              ? "已读取 Claude 登录态，但 Claude 上游拒绝了订阅授权；请确认账号套餐或配置 Anthropic API Key。"
              : "Claude API 凭证未找到或已失效。若使用的是 Console API 请在 OpenCodex 控制面板配置 Anthropic API Key，或运行 \"claude login\" 重新认证。";
        }
        if (isCursorModel && (response.status === 401 || response.status === 403 || response.status === 404)) {
          msg = "Cursor 本地凭证未生效或目标接口响应异常，请在 Cursor 软件中重新登录账户，或在 OpenCodex 中配置相关 API Key。";
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
        return;
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
          const readResult = await readWithTimeout(600000);
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

        if (!providerStreamCompleted) {
          // Some OpenAI-compatible gateways close a successful stream after
          // the last content/tool delta and omit both `[DONE]` and
          // `finish_reason`. The output already received from the provider is
          // sufficient to close the local Responses turn; do not fabricate a
          // response for an empty stream.
          if (providerDataObserved && engine.hasOutput()) {
            console.warn(
              `[OpenCodex Provider] upstream stream ended after valid output ` +
              `without a terminal event provider=${providerName || "provider"} model=${upstreamModel}`,
            );
            providerStreamCompleted = true;
          } else {
            throw new Error("上游流在完成事件前结束，且没有收到可收尾的模型输出");
          }
        }
      }

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
        const nextReadWithTimeout = (): Promise<ReadableStreamReadResult<Uint8Array>> => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("主模型子代理续答流读取超时（600s）")), 600000);
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
          if (activeAdapter.processStreamChunk) {
            engine.observeProviderChunk(chunk);
            for (const normalizedChunk of activeAdapter.processStreamChunk(chunk)) {
              await engine.processChatChunk(writeSse, normalizedChunk);
            }
          } else {
            await engine.processChatChunk(writeSse, chunk);
          }
        };

        while (!nextCompleted) {
          const readResult = await nextReadWithTimeout();
          if (readResult.done) {
            nextBuffer += nextDecoder.decode();
            if (nextBuffer.trim()) {
              for (const line of nextBuffer.split("\n")) await processContinuationLine(line);
            }
            nextBuffer = "";
            break;
          }
          nextBuffer += nextDecoder.decode(readResult.value, { stream: true });
          const lines = nextBuffer.split("\n");
          nextBuffer = lines.pop() || "";
          for (const line of lines) await processContinuationLine(line);
        }
        if (!nextCompleted && !nextDataObserved) {
          throw new Error("主模型子代理续答流在完成事件前结束");
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
    } catch (err: any) {
      clearTimeout(timeoutId);
      controller.abort();
      const upstreamDetails = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Stream error for ${finalTargetUrl}:`, {
        stack: err.stack,
        ...upstreamDetails,
        attempts: err?.attempts,
      });
      const attemptsText = Number.isFinite(err?.attempts) ? `（已尝试 ${err.attempts} 次）` : "";
      const causeText = upstreamDetails.code ? ` [${upstreamDetails.code}]` : "";
      const detailMsg = isCursorModel && /outdated|deprecated|upgrade/i.test(String(err.message || ""))
        ? "Cursor 上游已拒绝当前客户端协议：本机 Cursor 版本已被判定为过旧。请先从 Cursor 官网更新/重新下载 Cursor（设置会保留），再重试；这不是免费套餐限制。"
        : err.message === "fetch failed"
        ? `无法连接服务商接口${causeText}${attemptsText}：网络连接或 TLS 握手失败。请在 OpenCodex 控制面板检查该服务商 Endpoint / Base URL 是否填写正确。`
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
        await emitFailedResponse(detailMsg, "upstream_unreachable");
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  }
}
