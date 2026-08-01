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
import { decodeGatewayCompaction, formatGatewayCompactionContext } from "../services/compaction_compat.js";

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
        : typeof part.data === "string" && typeof part.mimeType === "string"
          ? `data:${part.mimeType};base64,${part.data}`
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
  const name = String(item?.name || "").trim();
  if (item?.type === "mcp_call") return mcpCallToolName(item);

  // Responses keeps MCP identity in two fields. Chat providers receive the
  // flattened spelling that was used when the tool list was translated.
  const namespace = String(item?.namespace || "").trim();
  if (!namespace || name === namespace || name.startsWith(`${namespace}_`) || name.startsWith(`${namespace}__`)) {
    return name;
  }
  return namespace.endsWith("__") ? `${namespace}${name}` : `${namespace}_${name}`;
}

function appendChatToolCall(messages: ChatMessage[], item: any): string {
  const callId = String(item?.call_id || item?.id || `call_${Date.now()}`).trim() || `call_${Date.now()}`;
  const argsStr = typeof item?.arguments === "string"
    ? item.arguments
    : JSON.stringify(item?.arguments || {});
  const toolCall = {
    id: callId,
    type: "function" as const,
    function: {
      name: responseFunctionCallToolName(item),
      arguments: argsStr,
    },
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

function appendChatToolOutput(messages: ChatMessage[], callId: unknown, output: unknown): void {
  const normalizedCallId = String(callId || "").trim();
  if (!normalizedCallId) return;
  messages.push({
    role: "tool",
    tool_call_id: normalizedCallId,
    content: contentToChatContent(output),
  });
}

export function responsesInputToChatMessages(input?: any[]): ChatMessage[] {
  if (!Array.isArray(input) || input.length === 0) return [];

  const messages: ChatMessage[] = [];

  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;

    const itemType: string = (item as any).type;

    if (itemType === "compaction" || itemType === "context_compaction") {
      const state = decodeGatewayCompaction(item.encrypted_content);
      // Native OpenAI compaction payloads are opaque to this gateway. Only
      // expand our own envelope; an unknown encrypted item must not be sent
      // to a Chat provider as fabricated text.
      if (state) {
        messages.push({
          role: "system",
          content: formatGatewayCompactionContext(state),
        });
      }
      continue;
    }

    if ((itemType === "message" || !itemType) && "role" in item) {
      let role = item.role || "user";
      if (role === "developer") role = "system";
      const content = contentToChatContent(item.content);

      const last = messages[messages.length - 1];
      if (last && last.role === role && role === "assistant" && !last.tool_calls) {
        last.content = joinChatContent(last.content, content);
      } else {
        messages.push({
          role: role as any,
          content,
        });
      }
    } else if (itemType === "function_call" || itemType === "mcp_call") {
      const callId = appendChatToolCall(messages, item);
      // A completed MCP item is commonly replayed with its output attached to
      // the same item. Preserve both halves for Chat providers.
      if (itemType === "mcp_call" && item.output !== undefined) {
        appendChatToolOutput(messages, callId, item.output);
      }
    } else if (itemType === "function_call_output") {
      appendChatToolOutput(messages, item.call_id, item.output);
    } else if (itemType === "mcp_call_output") {
      appendChatToolOutput(messages, item.call_id || item.id, item.output);
    }
  }

  return messages;
}

const DEFAULT_WORKSPACE_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Dispatch one real Codex subagent task asynchronously. This desktop integration supports one fire-and-forget dispatch per Live task: after this tool succeeds, do not call wait_agent, list_agents, or spawn_agent again, and do not fall back to doing the delegated work yourself. Use the legacy fields task_name, message, and optional fork_turns exactly as defined here. Do not claim the subagent finished; only report that it was dispatched after this tool succeeds.",
      parameters: {
        type: "object",
        properties: {
          task_name: { type: "string", description: "Short stable name for the subagent, for example game-builder" },
          message: { type: "string", description: "Complete task instructions and expected deliverable for the subagent" },
          fork_turns: { type: "string", enum: ["none", "all"], description: "Whether to include the current conversation context; use none unless context is required" }
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

export function convertToolsToChatTools(tools?: ResponseTool[], sessionId?: string): ChatTool[] {
  const requestUsesComputerUse = hasComputerUseTool(tools);
  const rememberedComputerUse = rememberNativeComputerUseSession(sessionId, requestUsesComputerUse);
  if (!Array.isArray(tools) || tools.length === 0) {
    const defaults = [...DEFAULT_WORKSPACE_TOOLS];
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
        const fullName = nsName.endsWith("__") ? `${nsName}${fnName}` : `${nsName}_${fnName}`;
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
  const filteredResult = normalizedResult.filter((tool) => !isComputerUseDiscoveryToolName(tool.function?.name));
  if (filteredResult.length === 0) filteredResult.push(...DEFAULT_WORKSPACE_TOOLS);

  if (rememberedComputerUse && !filteredResult.some((tool) => isNativeComputerUseExecutorName(tool.function?.name))) {
    filteredResult.push(buildNativeComputerUseChatTool());
  }

  // Codex Desktop may send its own workspace tool list on every continuation.
  // Keep that list, but never drop the gateway's real subagent controls merely
  // because the client supplied an explicit tools array.
  const existingNames = new Set(filteredResult.map((tool) => tool.function?.name).filter(Boolean));
  for (const tool of CODEX_SUBAGENT_TOOLS) {
    const name = tool.function?.name;
    if (name && !existingNames.has(name)) filteredResult.unshift(tool);
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
  sessionId?: string
): ChatCompletionRequestBody {
  const messages: ChatMessage[] = [];
  const tools = convertToolsToChatTools(body.tools, sessionId);

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
  const adapter = AdapterFactory.getAdapter(undefined, undefined);
  const sanitizedMessages = adapter.sanitizeMessages(messages);
  const mergedMessages = mergeConsecutiveMessages(sanitizedMessages);

  const chatBody: ChatCompletionRequestBody = {
    model: upstreamModel,
    messages: mergedMessages.length > 0 ? mergedMessages : [{ role: "user", content: " " }],
    stream: body.stream ?? true,
  };

  if (tools.length > 0) {
    chatBody.tools = tools;
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
