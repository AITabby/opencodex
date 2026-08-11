/**
 * Request Transformer for CodexBridge (OpenCodex V2)
 * Converts OpenAI Responses API input items into Chat Completions messages array.
 */

import {
  ResponsesRequestBody,
  ChatCompletionRequestBody,
  ChatMessage,
  ChatTool,
  ResponseTool,
} from "./types.js";
import { AdapterFactory } from "../adapters/factory.js";
import { buildNativeImageTool, NATIVE_IMAGE_TOOL_NAME, isImageGenerationTool } from "../services/native_image_bridge.js";
import {
  appendComputerUseInstructions,
  buildNativeComputerUseChatTool,
  canonicalNativeComputerUseExecutorName,
  hasComputerUseTool,
  isComputerUseDiscoveryToolName,
  isComputerUseTool,
  isNativeComputerUseExecutorName,
} from "../services/computer_use_native.js";

const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>/gi;

export function stripThinkTags(text: string): string {
  return text ? text.replace(THINK_TAG_REGEX, "") : "";
}

function contentToText(content: any): string {
  let raw = "";
  if (typeof content === "string") raw = content;
  else if (Array.isArray(content)) {
    raw = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null && "text" in part) {
          return String(part.text || "");
        }
        return "";
      })
      .join("");
  } else if (typeof content === "object" && content !== null && "text" in content) {
    raw = String(content.text || "");
  } else {
    raw = String(content || "");
  }
  return stripInternalCodexEnvelopes(raw);
}

function imageUrlFromContentPart(part: any): { url: string; detail?: string } | null {
  if (!part || typeof part !== "object") return null;

  const rawImageUrl = part.image_url;
  const url = typeof rawImageUrl === "string"
    ? rawImageUrl.trim()
    : typeof rawImageUrl?.url === "string"
      ? rawImageUrl.url.trim()
      : typeof part.url === "string"
        ? part.url.trim()
        : typeof part.screenshot === "string"
          ? part.screenshot.trim()
          : typeof part.data === "string" && typeof (part.mimeType || part.mime_type) === "string"
            ? `data:${part.mimeType || part.mime_type};base64,${part.data}`
          : "";
  if (!url) return null;

  const detail = typeof part.detail === "string"
    ? part.detail
    : typeof rawImageUrl?.detail === "string"
      ? rawImageUrl.detail
      : undefined;
  return detail ? { url, detail } : { url };
}

/**
 * Preserve Responses text and tool screenshots in the Chat multimodal shape.
 * A tool result may contain input_image blocks even though the Responses
 * function_call_output type is commonly represented as a string.
 */
function contentToChatContent(content: any): string | any[] {
  if (typeof content === "string") return contentToText(content);

  const sourceParts = Array.isArray(content) ? content : [content];
  const parts: any[] = [];
  for (const part of sourceParts) {
    if (typeof part === "string") {
      const text = stripInternalCodexEnvelopes(part);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (!part || typeof part !== "object") continue;

    if (typeof part.text === "string" && ["text", "input_text", "output_text"].includes(String(part.type || "text"))) {
      const text = stripInternalCodexEnvelopes(part.text);
      if (text) parts.push({ type: "text", text });
      continue;
    }

    const image = imageUrlFromContentPart(part);
    if (image) {
      parts.push({
        type: "image_url",
        image_url: {
          url: image.url,
          ...(image.detail ? { detail: image.detail } : {}),
        },
      });
    }
  }

  if (parts.length === 0) return contentToText(content);
  // Keep the legacy scalar shape for ordinary text-only messages. Only a
  // message that actually carries an image needs the multimodal array.
  return parts.some((part) => part?.type === "image_url")
    ? parts
    : contentToText(content);
}

function joinChatContent(left: any, right: any): string | any[] {
  if (!Array.isArray(left) && !Array.isArray(right)) {
    const leftText = contentToText(left);
    const rightText = contentToText(right);
    return leftText && rightText ? `${leftText}\n\n${rightText}` : leftText || rightText;
  }

  const parts: any[] = [];
  const append = (content: any): void => {
    if (Array.isArray(content)) {
      parts.push(...content);
    } else {
      const text = contentToText(content);
      if (text) parts.push({ type: "text", text });
    }
  };
  append(left);
  if (parts.length > 0 && (left || right)) parts.push({ type: "text", text: "\n\n" });
  append(right);
  return parts;
}

function stripInternalCodexEnvelopes(content: string): string {
  if (!content) return "";
  let clean = content;
  clean = clean.replace(/<app-context>[\s\S]*?<\/app-context>/gi, "");
  clean = clean.replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "");
  clean = clean.replace(/<apps_instructions>[\s\S]*?<\/apps_instructions>/gi, "");
  clean = clean.replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi, "");
  clean = clean.replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, "");
  clean = clean.replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "");
  clean = clean.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "");
  return clean.trim();
}

function mcpCallToolName(item: any): string {
  const serverLabel = String(item?.server_label || "").trim();
  const name = String(item?.name || "").trim();
  if (serverLabel === "node_repl" && name === "js") return canonicalNativeComputerUseExecutorName("mcp__node_repl_js");
  if (!serverLabel) return name;
  return `mcp__${serverLabel}__${name}`;
}

function responseFunctionCallToolName(item: any): string {
  if (item?.type === "computer_call") return canonicalNativeComputerUseExecutorName("mcp__node_repl_js");
  const name = String(item?.name || "").trim();
  if (item?.type === "mcp_call") return mcpCallToolName(item);

  // Responses keeps MCP identity in two fields. Chat providers receive the
  // flattened spelling that was used when the tool list was translated.
  const namespace = String(item?.namespace || "").trim();
  if (!namespace || name === namespace || name.startsWith(`${namespace}_`) || name.startsWith(`${namespace}__`)) {
    return name;
  }
  return namespace.endsWith("__")
    ? `${namespace}${name}`
    : `${namespace}${namespace.startsWith("mcp__") ? "__" : "_"}${name}`;
}

function appendChatToolCall(messages: ChatMessage[], item: any): string {
  const callId = String(item?.call_id || item?.id || `call_${Date.now()}`).trim() || `call_${Date.now()}`;
  const rawArguments = item?.arguments ?? item?.input ?? item?.action;
  const argsStr = item?.type === "custom_tool_call" && item?.name === "apply_patch"
    ? JSON.stringify({ input: String(rawArguments ?? "") })
    : typeof rawArguments === "string"
      ? rawArguments
      : JSON.stringify(rawArguments || {});
  const thoughtSignature = String(item?.thought_signature || item?.thoughtSignature || item?.signature || "").trim();
  const toolCall = {
    id: callId,
    type: "function" as const,
    function: {
      name: responseFunctionCallToolName(item),
      arguments: argsStr,
    },
    ...(thoughtSignature ? { thought_signature: thoughtSignature, thoughtSignature } : {}),
  };

  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    if (!last.tool_calls) last.tool_calls = [];
    last.tool_calls.push(toolCall);
  } else {
    messages.push({ role: "assistant", content: "", tool_calls: [toolCall] });
  }
  return callId;
}

function appendChatToolOutput(messages: ChatMessage[], callId: unknown, output: unknown, name = ""): void {
  const normalizedCallId = String(callId || "").trim();
  if (!normalizedCallId) return;
  messages.push({
    role: "tool",
    tool_call_id: normalizedCallId,
    ...(name ? { name } : {}),
    content: contentToChatContent(output),
  });
}

export function responsesInputToChatMessages(input?: any[]): ChatMessage[] {
  if (!Array.isArray(input) || input.length === 0) return [];

  const messages: ChatMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;

    const itemType: string = (item as any).type;

    if (itemType === "compaction" || itemType === "context_compaction") {
      // Native compaction items are opaque provider state. A Chat provider
      // cannot consume them, so do not invent a gateway-side summary.
      continue;
    }

    if ((itemType === "message" || !itemType) && "role" in item) {
      let role = item.role || "user";
      if (role === "developer") role = "system";
      const content = contentToChatContent(item.content);
      const passthrough = item.internal_chat_message_metadata_passthrough;
      const reasoningContent = typeof item.reasoning_content === "string"
        ? item.reasoning_content
        : typeof item.reasoningContent === "string"
          ? item.reasoningContent
          : typeof passthrough?.reasoning_content === "string"
            ? passthrough.reasoning_content
            : "";

      const last = messages[messages.length - 1];
      if (last && last.role === role && role === "assistant" && !last.tool_calls) {
        last.content = joinChatContent(last.content, content);
        if (reasoningContent) last.reasoning_content = reasoningContent;
      } else {
        messages.push({
          role: role as any,
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        });
      }
    } else if (itemType === "function_call" || itemType === "mcp_call" || itemType === "custom_tool_call" || itemType === "computer_call") {
      const callId = appendChatToolCall(messages, item);
      const toolName = responseFunctionCallToolName(item);
      if (toolName) toolNames.set(callId, toolName);
      // A completed MCP item is commonly replayed with its output attached to
      // the same item. Preserve both halves for Chat providers.
      if ((itemType === "mcp_call" || itemType === "custom_tool_call") && item.output !== undefined) {
        appendChatToolOutput(messages, callId, item.output, toolName);
      }
    } else if (itemType === "function_call_output"
      || itemType === "mcp_call_output"
      || itemType === "custom_tool_call_output"
      || itemType === "computer_call_output") {
      const callId = item.call_id || item.id;
      appendChatToolOutput(messages, callId, item.output, toolNames.get(String(callId || "").trim()) || "");
    }
  }

  return messages;
}

const DEFAULT_WORKSPACE_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Dispatch one real Codex subagent task asynchronously. Before acting, decide whether the task needs no child, one child, or multiple independent children. Call spawn_agent once for each child you decide to create; multiple calls may be issued in the same turn or in subsequent turns. Do not call wait_agent or list_agents, and do not fall back to doing delegated work yourself. When the user explicitly assigns a model or saved Agent Profile to a child, pass exactly one of model, profile_id, or profile_name; that explicit binding overrides capability auto-routing. If the user names multiple Profiles, issue one spawn_agent call per named child so each has an independent lifecycle. When no target is named, omit all target fields and let the gateway route from the user's saved model capability directory. Use fork_turns only when conversation context is required, and use reasoning_effort only when deliberately overriding the selected target's saved default. Do not claim a child finished; only report that it was dispatched after each tool call succeeds.",
      parameters: {
        type: "object",
        properties: {
          task_name: { type: "string", description: "Short stable name for the subagent, for example game-builder" },
          message: { type: "string", description: "Complete task instructions and expected deliverable for the subagent" },
          model: { type: "string", description: "Optional exact model slug from the gateway catalog; use only when the user explicitly assigns this child to a model" },
          profile_id: { type: "string", description: "Optional saved Agent Profile id; use only when the user explicitly assigns this child to a Profile" },
          profile_name: { type: "string", description: "Optional exact saved Agent Profile name; use only when the user explicitly names this child Profile" },
          fork_turns: { type: "string", enum: ["none", "all"], description: "Whether to include the current conversation context; use none unless context is required" },
          reasoning_effort: { type: "string", description: "Optional per-child reasoning override; use one of the reasoning levels advertised by the selected model's catalog entry" }
        },
        required: ["task_name", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "exec_command",
      description: "Execute a shell command on the local Mac.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "The shell command to run" },
          workdir: { type: "string", description: "Optional working directory; omit to use the current project directory" },
          sandbox_permissions: {
            type: "string",
            enum: ["use_default", "require_escalated"],
            description: "Permission mode for this command"
          },
          justification: {
            type: "string",
            description: "Reason associated with an elevated permission request"
          }
        },
        required: ["cmd"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "view_file",
      description: "View content of a file in the workspace",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to view" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files in a workspace directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" }
        },
        required: ["path"]
      }
    }
  }
];

const CODEX_SUBAGENT_TOOLS = DEFAULT_WORKSPACE_TOOLS.slice(0, 1);

/**
 * Responses providers use the flat function-tool shape, while Chat
 * providers use the nested `function` shape above. Keep one description and
 * parameter contract for both protocol paths so a third-party main model
 * cannot lose the real gateway-owned dispatcher merely by switching
 * protocols.
 */
export function buildGatewaySubagentResponseTool(): any {
  const tool = DEFAULT_WORKSPACE_TOOLS[0]?.function;
  return {
    type: "function",
    name: tool?.name || "spawn_agent",
    description: tool?.description || "Dispatch a real Codex subagent task.",
    parameters: tool?.parameters || { type: "object", properties: {}, required: [] },
    strict: false,
  };
}

/**
 * Subagents are workers, not another orchestration layer. The native Codex
 * executor currently owns the real multi-agent controls, while the gateway's
 * generic spawn_agent function is only a main-agent control. Never advertise
 * either form to a child turn.
 */
export function isSubagentDispatchToolName(value: unknown): boolean {
  const name = String(value || "").trim().toLowerCase();
  return name === "spawn_agent" ||
    name === "collaboration" ||
    name.startsWith("collaboration_") ||
    name === "multi_agent_v2" ||
    name.startsWith("multi_agent_v2_") ||
    name.startsWith("multi_agent_v1_");
}

function rawToolName(tool: any): string {
  return String(tool?.function?.name || tool?.name || "").trim();
}

/** Remove nested-agent controls before a Responses-native provider sees them. */
export function stripSubagentDispatchTools(tools?: ResponseTool[]): ResponseTool[] | undefined {
  if (!Array.isArray(tools)) return tools;
  const result: ResponseTool[] = [];
  for (const rawTool of tools as any[]) {
    if (!rawTool || typeof rawTool !== "object") continue;
    if (rawTool.type === "namespace") {
      const namespace = String(rawTool.name || "").trim();
      const collectionKey = Array.isArray(rawTool.functions) ? "functions" : Array.isArray(rawTool.tools) ? "tools" : "";
      if (!collectionKey) {
        if (!isSubagentDispatchToolName(namespace)) result.push(rawTool);
        continue;
      }
      const kept = rawTool[collectionKey].filter((entry: any) => {
        const fullName = namespace.endsWith("__")
          ? `${namespace}${String(entry?.name || "")}`
          : `${namespace}_${String(entry?.name || "")}`;
        return !isSubagentDispatchToolName(entry?.name) && !isSubagentDispatchToolName(fullName);
      });
      if (kept.length > 0) result.push({ ...rawTool, [collectionKey]: kept });
      continue;
    }
    if (!isSubagentDispatchToolName(rawToolName(rawTool))) result.push(rawTool);
  }
  return result;
}

const SUBAGENT_ORCHESTRATION_TOOL_NAMES = new Set([
  "get_goal",
  "create_goal",
  "update_goal",
  "update_plan",
  "request_user_input",
]);

function isSubagentOrchestrationToolName(value: unknown): boolean {
  const name = String(value || "").trim().toLowerCase();
  return SUBAGENT_ORCHESTRATION_TOOL_NAMES.has(name) ||
    name.startsWith("codex_app_") ||
    name.startsWith("mcp__openaideveloperdocs_");
}

/** Keep worker tools, but omit host-side orchestration and documentation tools. */
export function stripSubagentRuntimeTools(tools?: ResponseTool[]): ResponseTool[] | undefined {
  const dispatchStripped = stripSubagentDispatchTools(tools);
  if (!Array.isArray(dispatchStripped)) return dispatchStripped;
  const result: ResponseTool[] = [];
  for (const rawTool of dispatchStripped as any[]) {
    if (!rawTool || typeof rawTool !== "object") continue;
    if (rawTool.type === "namespace") {
      const namespace = String(rawTool.name || "").trim();
      const collectionKey = Array.isArray(rawTool.functions) ? "functions" : Array.isArray(rawTool.tools) ? "tools" : "";
      if (!collectionKey) {
        if (!isSubagentOrchestrationToolName(namespace)) result.push(rawTool);
        continue;
      }
      const kept = rawTool[collectionKey].filter((entry: any) => {
        const fullName = namespace.endsWith("__")
          ? `${namespace}${String(entry?.name || "")}`
          : `${namespace}_${String(entry?.name || "")}`;
        return !isSubagentOrchestrationToolName(entry?.name) && !isSubagentOrchestrationToolName(fullName);
      });
      if (kept.length > 0) result.push({ ...rawTool, [collectionKey]: kept });
      continue;
    }
    if (!isSubagentOrchestrationToolName(rawToolName(rawTool))) result.push(rawTool);
  }
  return result;
}

const nativeComputerUseSessions = new Map<string, number>();
const NATIVE_COMPUTER_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_NATIVE_COMPUTER_SESSIONS = 256;

function rememberNativeComputerUseSession(sessionId: string | undefined, enabled: boolean): boolean {
  const key = String(sessionId || "").trim();
  if (!key) return false;
  const now = Date.now();
  for (const [storedKey, timestamp] of nativeComputerUseSessions) {
    if (now - timestamp > NATIVE_COMPUTER_SESSION_TTL_MS) nativeComputerUseSessions.delete(storedKey);
  }
  if (enabled) {
    nativeComputerUseSessions.delete(key);
    nativeComputerUseSessions.set(key, now);
  }
  return nativeComputerUseSessions.has(key);
}

function appendNativeComputerUseTool(tools: ChatTool[]): ChatTool[] {
  if (tools.some((tool) => isNativeComputerUseExecutorName(tool.function?.name))) return tools;
  const next = [...tools, buildNativeComputerUseChatTool()];
  while (nativeComputerUseSessions.size > MAX_NATIVE_COMPUTER_SESSIONS) {
    const oldest = nativeComputerUseSessions.keys().next().value;
    if (!oldest) break;
    nativeComputerUseSessions.delete(oldest);
  }
  return next;
}

export function convertToolsToChatTools(tools?: ResponseTool[], sessionId?: string, allowSubagentDispatch = true): ChatTool[] {
  const requestUsesComputerUse = hasComputerUseTool(tools);
  const rememberedComputerUse = rememberNativeComputerUseSession(sessionId, requestUsesComputerUse);
  if (!Array.isArray(tools) || tools.length === 0) {
    const defaults = allowSubagentDispatch ? [...DEFAULT_WORKSPACE_TOOLS] : DEFAULT_WORKSPACE_TOOLS.slice(1);
    return rememberedComputerUse ? appendNativeComputerUseTool(defaults) : defaults;
  }
  const result: ChatTool[] = [];

  for (const rawTool of tools) {
    if (typeof rawTool !== "object" || rawTool === null) continue;
    const tool = rawTool as any;

    if (isComputerUseTool(tool)) {
      if (!result.some((candidate) => isNativeComputerUseExecutorName(candidate.function?.name))) {
        result.push(buildNativeComputerUseChatTool(tool));
      }
    } else if (isImageGenerationTool(tool)) {
      result.push(buildNativeImageTool());
    } else if (tool.type === "custom" && tool.name === "apply_patch") {
      result.push({
        type: "function",
        function: {
          name: "edit",
          description: "Edit one file by replacing an exact existing text block. Use this instead of writing patch syntax.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path." },
              old_text: { type: "string", description: "Exact existing text to replace." },
              new_text: { type: "string", description: "Replacement text." },
            },
            required: ["path", "old_text", "new_text"],
            additionalProperties: false,
          },
        },
      }, {
        type: "function",
        function: {
          name: "apply_patch",
          description: "For edits that cannot use exact replacement, pass a complete raw patch whose first line is exactly *** Begin Patch and last line is exactly *** End Patch.",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "The complete raw apply_patch patch text." },
            },
            required: ["input"],
            additionalProperties: false,
          },
        },
      });
    } else if (tool.type === "function" && tool.function) {
      result.push({
        type: "function",
        function: tool.function,
      });
    } else if (tool.type === "namespace") {
      const nsName = tool.name || "";
      const funcs = tool.functions || tool.tools || [];
      for (const f of funcs) {
        if (typeof f !== "object" || f === null) continue;
        const fnName = f.name || "";
        const fullName = nsName.endsWith("__")
          ? `${nsName}${fnName}`
          : `${nsName}${nsName.startsWith("mcp__") ? "__" : "_"}${fnName}`;
        result.push({
          type: "function",
          function: {
            name: fullName,
            description: f.description || "",
            parameters: f.parameters || { type: "object", properties: {} },
          },
        });
      }
    } else if ("name" in tool && typeof tool.name === "string") {
      result.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || { type: "object", properties: {} },
        },
      });
    }
  }

  const normalizedResult = result.map((tool) =>
    isNativeComputerUseExecutorName(tool.function?.name)
      ? buildNativeComputerUseChatTool(tool)
      : tool,
  );
  const filteredResult = normalizedResult.filter((tool) =>
    !isComputerUseDiscoveryToolName(tool.function?.name) &&
    (allowSubagentDispatch || !isSubagentDispatchToolName(tool.function?.name)),
  );
  if (filteredResult.length === 0) {
    filteredResult.push(...(allowSubagentDispatch ? DEFAULT_WORKSPACE_TOOLS : DEFAULT_WORKSPACE_TOOLS.slice(1)));
  }

  if (rememberedComputerUse && !filteredResult.some((tool) => isNativeComputerUseExecutorName(tool.function?.name))) {
    filteredResult.push(buildNativeComputerUseChatTool());
  }

  // Codex Desktop may send its own workspace tool list on every continuation.
  // Keep that list, but never drop the gateway's real subagent controls merely
  // because the client supplied an explicit tools array.
  if (allowSubagentDispatch) {
    const existingNames = new Set(filteredResult.map((tool) => tool.function?.name).filter(Boolean));
    for (const tool of CODEX_SUBAGENT_TOOLS) {
      const name = tool.function?.name;
      if (name && !existingNames.has(name)) filteredResult.unshift(tool);
    }
  }

  return filteredResult;
}

export function mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const merged: ChatMessage[] = [];

  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && !prev.tool_calls && !msg.tool_calls && prev.role !== "tool") {
      prev.content = joinChatContent(prev.content, msg.content);
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

import { SessionHistoryService } from "../services/session_history.js";

export function transformResponsesToChat(
  body: ResponsesRequestBody,
  upstreamModel: string,
  sessionId?: string,
  allowSubagentDispatch = true,
  adapterName?: string,
  providerReasoningContent = "",
): ChatCompletionRequestBody {
  const messages: ChatMessage[] = [];
  const sourceTools = allowSubagentDispatch ? body.tools : stripSubagentRuntimeTools(body.tools);
  const tools = convertToolsToChatTools(sourceTools, sessionId, allowSubagentDispatch);

  const systemPrompt = appendComputerUseInstructions(
    body.instructions ? stripInternalCodexEnvelopes(body.instructions) : "",
    tools,
  );

  if (systemPrompt.trim()) {
    messages.push({
      role: "system",
      content: systemPrompt.trim(),
    });
  }

  // Responses API also permits input to be a plain string. Keep it as a
  // user message instead of treating the non-array string as an empty input;
  // otherwise the synthetic tool directive above can become the provider's
  // only user-visible prompt.
  const rawInput = typeof (body as any).input === "string"
    ? [(body as any).input]
    : (Array.isArray(body.input) && body.input.length > 0)
      ? body.input
      : ((body as any).messages || []);
  const inputMessages = responsesInputToChatMessages(rawInput);
  const repairedMessages = SessionHistoryService.repairAndMergeHistory(inputMessages, sessionId);
  messages.push(...repairedMessages);

  // Apply model-specific adapter (DeepSeek, MiniMax, Anthropic, Google)
  const adapter = AdapterFactory.getAdapter(undefined, undefined, adapterName);
  const sanitizedMessages = adapter.sanitizeMessages(messages);
  const mergedMessages = mergeConsecutiveMessages(sanitizedMessages);
  if (providerReasoningContent) {
    const assistantWithToolCall = [...mergedMessages].reverse().find((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
    );
    if (assistantWithToolCall) assistantWithToolCall.reasoning_content = providerReasoningContent;
  }

  const chatBody: ChatCompletionRequestBody = {
    model: upstreamModel,
    messages: mergedMessages.length > 0 ? mergedMessages : [{ role: "user", content: " " }],
    stream: body.stream ?? true,
  };

  if (tools.length > 0) {
    chatBody.tools = tools;
  }

  // A complex main-agent turn may emit more than one spawn_agent call. Keep
  // the caller's explicit choice when present; otherwise enable parallel tool
  // calls whenever the gateway has exposed its real subagent control.
  const hasSpawnAgentTool = tools.some((tool) => tool.function?.name === "spawn_agent");
  if (body.parallel_tool_calls !== undefined) {
    chatBody.parallel_tool_calls = body.parallel_tool_calls;
  } else if (hasSpawnAgentTool) {
    chatBody.parallel_tool_calls = true;
  }

  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chatBody.max_tokens = body.max_output_tokens;
  const reasoningEffort = body.reasoning?.effort ?? body.reasoning_effort;
  if (reasoningEffort !== undefined) chatBody.reasoning_effort = reasoningEffort;
  const requestedToolChoice = (body as any).tool_choice;
  if (requestedToolChoice === "image_generation" || requestedToolChoice?.type === "image_generation") {
    chatBody.tool_choice = {
      type: "function",
      function: { name: NATIVE_IMAGE_TOOL_NAME },
    };
  }

  return chatBody;
}
