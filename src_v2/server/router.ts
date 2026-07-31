import http from "node:http";
import { ResponsesStreamEngine } from "../core/stream_engine.js";
import { transformResponsesToChat } from "../core/transformer.js";
import { AdapterFactory } from "../adapters/factory.js";
import { GoogleGeminiAdapter } from "../adapters/google.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { getClaudeDesktopVersion, getCursorClientVersion, SubscriptionAuthService } from "../services/subscription_auth.js";
import { fetchUpstream, upstreamErrorDetails } from "../services/upstream_fetch.js";
import { cursorAdvertisedToolNames, decodeCursorEndStreamError, decodeCursorStreamComplete, decodeCursorStreamText, decodeCursorToolCallCompleted, streamCursorChat, type CursorExternalToolRequest, type CursorToolContinuation, type CursorToolEvent, type CursorToolResult } from "../services/cursor_protocol.js";
import { redactSensitiveText, safeDiagnosticTarget, safeErrorMessage } from "./privacy.js";
import { proxyNativeResponses } from "./native_responses.js";



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
  constructor(
    private readonly nativeResponsesProxy: typeof proxyNativeResponses = proxyNativeResponses,
  ) {}

  public async handleResponses(
    reqBody: any,
    upstreamModel: string,
    apiKey: string,
    providerUrl: string,
    res: http.ServerResponse,
    providerName = ""
  ): Promise<void> {
    if (String(reqBody?.protocol || "").toLowerCase() === "responses") {
      await this.nativeResponsesProxy({
        reqBody,
        upstreamModel,
        apiKey,
        providerUrl,
        providerName,
        res,
      });
      return;
    }

    const sessionId = reqBody?.client_metadata?.session_id || reqBody?.session_id;
    const cursorHistoryId = cursorHistoryKey(reqBody);
    const cursorStateKey = cursorRequestStateKey(reqBody);
    const chatBody = transformResponsesToChat(reqBody, upstreamModel, sessionId);
    chatBody.stream = true;

    const adapter = AdapterFactory.getAdapter(reqBody?.protocol, providerUrl);
    const { urlEndpoint, headers: adapterHeaders, body: payloadBody } = adapter.transformPayload(chatBody);

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
        const geminiPayload = activeAdapter.transformPayload(chatBody).body;

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
      const payload = activeAdapter.transformPayload(chatBody);
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

    console.info(
      `[OpenCodex Provider] request provider=${providerName || "provider"} model=${upstreamModel} ` +
      `messages=${Array.isArray(finalPayloadBody?.messages) ? finalPayloadBody.messages.length : 0} ` +
      `tools=${Array.isArray(finalPayloadBody?.tools) ? finalPayloadBody.tools.map((tool: any) => tool?.function?.name || tool?.name).filter(Boolean).join(",") || "(none)" : "(none)"} ` +
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
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    const engine = new ResponsesStreamEngine(upstreamModel, reqBody?.client_metadata?.turn_id);
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
        model: upstreamModel,
        output: [],
        error: { code, message },
      };
      await writeSse({ type: "response.failed", response: failedResponse });
      await writeSse({ type: "response.done", response: failedResponse });
    };
    let cursorToolResult: CursorToolResult | undefined;
    let pendingCursorToolRequest: CursorExternalToolRequest | undefined;
    const onCursorToolEvent = (event: CursorToolEvent): void => {
      const argumentBytes = event.arguments ? Buffer.byteLength(event.arguments) : 0;
      console.log(`[OpenCodex Cursor] tool-${event.phase} transport=${event.transport} name=${event.name} id=${event.id}${event.execId ? ` exec_id=${event.execId}` : ""}${event.exitCode !== undefined ? ` exit=${event.exitCode}` : ""} argument_bytes=${argumentBytes}`);
    };
    const onExternalCursorToolRequest = (request: CursorExternalToolRequest): void => {
      if (cursorStateKey) {
        const queue = cursorExternalToolQueues.get(cursorStateKey) || [];
        queue.push(request);
        cursorExternalToolQueues.set(cursorStateKey, queue);
      } else if (!pendingCursorToolRequest) {
        pendingCursorToolRequest = request;
      }
      console.log(`[OpenCodex Cursor] external-tool-pending transport=${request.transport} name=${request.name} id=${request.id}${request.execId ? ` exec_id=${request.execId}` : ""} argument_bytes=${Buffer.byteLength(request.arguments)}`);
    };

    try {
      const requestCursorMessages = isCursorModel
        ? chatBody.messages.map((message: any) => ({
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
        && matchedPendingCursorTool.respond;
      if (nativeCursorContinuation) {
        console.log(`[OpenCodex Cursor] native-session-resume call_id=${matchedPendingCursorTool.callId}`);
        await matchedPendingCursorTool.respond!(requestedCursorToolOutput!.output, false);
        response = matchedPendingCursorTool.providerResponse!;
      } else if (isCursorModel) {
        response = await (async () => {
          const cursorToken = await SubscriptionAuthService.getCursorAccessToken();
          if (!cursorToken) throw new Error("未找到有效的 Cursor 本机登录凭证");
          const inputToolNames = (chatBody.tools || []).map((tool: any) => String(tool?.function?.name || tool?.name || "")).filter(Boolean);
          const advertisedToolNames = cursorAdvertisedToolNames(chatBody.tools as any);
          console.log(`[OpenCodex Cursor] AgentRun model=${cursorModelForRequest} input_tools=${inputToolNames.length ? inputToolNames.join(",") : "(none)"} advertised_mcp_tools=${advertisedToolNames.length ? advertisedToolNames.join(",") : "(none)"} tool_choice=${String(reqBody?.tool_choice || "auto")} mode=AGENT${matchedPendingCursorTool ? " continuation=true" : ""}`);
          return streamCursorChat(
            cursorToken,
            cursorMessages,
            cursorModelForRequest,
            String(reqBody?.client_metadata?.turn_id || `opencodex-${Date.now()}`),
            String(matchedPendingCursorTool?.conversationId || sessionId || `opencodex-${Date.now()}`),
            getCursorClientVersion(),
            controller.signal,
            {
              workspaceRoot: process.cwd(),
              tools: chatBody.tools as any,
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
              cursorModelForRequest,
              String(reqBody?.client_metadata?.turn_id || `opencodex-${Date.now()}`),
              String(matchedPendingCursorTool?.conversationId || sessionId || `opencodex-${Date.now()}`),
              getCursorClientVersion(),
              controller.signal,
            {
              workspaceRoot: process.cwd(),
              tools: chatBody.tools as any,
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

      if (!response.ok || !response.body) {
        res.flushHeaders();
        const errText = firstAuthErrorText && (response.status === 401 || response.status === 403)
          ? firstAuthErrorText
          : await response.text();
        console.error(`[CodexBridge V2] Upstream error status=${response.status} target=${safeDiagnosticTarget(finalTargetUrl)} body_bytes=${Buffer.byteLength(errText)}`);
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

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readWithTimeout = (timeoutMs = 600000): Promise<ReadableStreamReadResult<Uint8Array>> => {
        return Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Stream read timeout (600s)")), timeoutMs)
          ),
        ]);
      };

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
              model: cursorModelForRequest,
              conversationId: String(matchedPendingCursorTool?.conversationId || sessionId || `opencodex-${Date.now()}`),
              messages: cursorMessages,
              continuation,
              providerResponse: response,
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
            if (pendingCursorToolRequest.respond && response.body) {
              reader.releaseLock();
            } else {
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
        }
        if (!pendingCursorToolRequest) rememberCursorSession(cursorHistoryId, cursorMessages, engine.getMessageText());
      } else while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await readWithTimeout(600000);
        } catch (readErr: any) {
          console.warn(`[CodexBridge V2] ${safeErrorMessage(readErr)}; closing stream cleanly.`);
          break;
        }

        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;
            try {
              const chunk = JSON.parse(dataStr);
              if (activeAdapter.processStreamChunk) {
                const normalizedChunks = activeAdapter.processStreamChunk(chunk);
                for (const nc of normalizedChunks) {
                  await engine.processChatChunk(writeSse, nc);
                }
              } else {
                await engine.processChatChunk(writeSse, chunk);
              }
            } catch {
              // Ignore parse errors on individual chunk lines
            }
          }
        }
      }

      await engine.finish(writeSse);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      const upstreamDetails = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Stream error target=${safeDiagnosticTarget(finalTargetUrl)}`, {
        message: safeErrorMessage(err),
        code: upstreamDetails.code,
        syscall: upstreamDetails.syscall,
        hostname: upstreamDetails.hostname,
        attempts: err?.attempts,
      });
      const attemptsText = Number.isFinite(err?.attempts) ? `（已尝试 ${err.attempts} 次）` : "";
      const causeText = upstreamDetails.code ? ` [${upstreamDetails.code}]` : "";
      const detailMsg = isCursorModel && /outdated|deprecated|upgrade/i.test(String(err.message || ""))
        ? "Cursor 上游已拒绝当前客户端协议：本机 Cursor 版本已被判定为过旧。请先从 Cursor 官网更新/重新下载 Cursor（设置会保留），再重试；这不是免费套餐限制。"
        : err.message === "fetch failed"
        ? `无法连接服务商接口${causeText}${attemptsText}：网络连接或 TLS 握手失败。请在 OpenCodex 控制面板检查该服务商 Endpoint / Base URL 是否填写正确。`
        : redactSensitiveText(err.message, 500);
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
