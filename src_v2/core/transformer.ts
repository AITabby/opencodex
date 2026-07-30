/**
 * Request Transformer for CodexBridge (OpenCodex V2)
 * Converts OpenAI Responses API input items into Chat Completions messages array.
 */

import {
  ResponsesRequestBody,
  ChatCompletionRequestBody,
  ChatMessage,
  ChatTool,
  ResponseInputItem,
  ResponseTool,
} from "./types.js";
import { AdapterFactory } from "../adapters/factory.js";

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

export function responsesInputToChatMessages(input?: ResponseInputItem[]): ChatMessage[] {
  if (!Array.isArray(input) || input.length === 0) return [];

  const messages: ChatMessage[] = [];

  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;

    const itemType = item.type;

    if ((itemType === "message" || !itemType) && "role" in item) {
      let role = item.role || "user";
      if (role === "developer") role = "system";
      const content = contentToText(item.content);

      const last = messages[messages.length - 1];
      if (last && last.role === role && role === "assistant" && !last.tool_calls) {
        const existingText = typeof last.content === "string" ? last.content : "";
        last.content = existingText && content ? `${existingText}\n${content}` : existingText || content;
      } else {
        messages.push({
          role: role as any,
          content,
        });
      }
    } else if (itemType === "function_call") {
      const callId = item.call_id || item.id || `call_${Date.now()}`;
      const argsStr = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
      const toolCall = {
        id: callId,
        type: "function" as const,
        function: {
          name: item.name || "",
          arguments: argsStr,
        },
      };

      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        if (!last.tool_calls) last.tool_calls = [];
        last.tool_calls.push(toolCall);
      } else {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [toolCall],
        });
      }
    } else if (itemType === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: contentToText(item.output),
      });
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

export function convertToolsToChatTools(tools?: ResponseTool[]): ChatTool[] {
  if (!Array.isArray(tools) || tools.length === 0) return DEFAULT_WORKSPACE_TOOLS;
  const result: ChatTool[] = [];

  for (const rawTool of tools) {
    if (typeof rawTool !== "object" || rawTool === null) continue;
    const tool = rawTool as any;

    if (tool.type === "function" && tool.function) {
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

  if (result.length === 0) return DEFAULT_WORKSPACE_TOOLS;

  // Codex Desktop may send its own workspace tool list on every continuation.
  // Keep that list, but never drop the gateway's real subagent controls merely
  // because the client supplied an explicit tools array.
  const existingNames = new Set(result.map((tool) => tool.function?.name).filter(Boolean));
  for (const tool of CODEX_SUBAGENT_TOOLS) {
    const name = tool.function?.name;
    if (name && !existingNames.has(name)) result.unshift(tool);
  }

  return result;
}

export function mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const merged: ChatMessage[] = [];

  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && !prev.tool_calls && !msg.tool_calls && prev.role !== "tool") {
      const prevText = contentToText(prev.content);
      const msgText = contentToText(msg.content);
      prev.content = prevText && msgText ? `${prevText}\n\n${msgText}` : prevText || msgText;
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
  const tools = convertToolsToChatTools(body.tools);

  let systemPrompt = body.instructions ? stripInternalCodexEnvelopes(body.instructions) : "";

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

  return chatBody;
}
