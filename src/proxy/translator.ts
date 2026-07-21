/**
 * OpenCodex Protocol Translation & Vision Bridge Layer
 * Handles translation between Anthropic-style Responses API and OpenAI-style Chat Completions API.
 * Integrates macOS-native `sips` for screenshot resizing/compression.
 * Injects MiMo-v2.5 multimodal descriptions to allow text-only models (like DeepSeek) to run Computer Use.
 */

import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { ProxyAgent, fetch } from "undici";

// Auto-detect and configure outbound proxy support for translator requests
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;
const fetchDispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : undefined;

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;

export const customResponseIds = new Set<string>();
const SHIM_ENCRYPTED_CONTENT_PREFIX = "anthropic-thinking-v1:";
let CURRENT_ACTIVE_APP = "Google Chrome";

export function stripThink(text: string): string {
  return text ? text.replace(THINK_RE, "") : "";
}

export function patchToolCallArguments(fnName: string, argumentsStr: string): string {
  if (
    fnName.startsWith("mcp__computer_use__") ||
    ["click", "scroll", "press_key", "type_text", "perform_secondary_action", "select_text", "drag", "get_app_state", "set_value"].includes(fnName)
  ) {
    try {
      const args = argumentsStr ? JSON.parse(argumentsStr) : {};
      if (typeof args === "object" && args !== null && !args.app) {
        args.app = CURRENT_ACTIVE_APP;
        return JSON.stringify(args);
      }
    } catch {
      // ignore
    }
  }
  return argumentsStr;
}

function _encodeThinkingPayload(payload: any): string {
  const raw = JSON.stringify(payload);
  const b64 = Buffer.from(raw, "utf-8").toString("base64url");
  return SHIM_ENCRYPTED_CONTENT_PREFIX + b64;
}

function _decodeThinkingPayload(encoded: string): any | null {
  if (typeof encoded !== "string" || !encoded.startsWith(SHIM_ENCRYPTED_CONTENT_PREFIX)) {
    return null;
  }
  const blob = encoded.slice(SHIM_ENCRYPTED_CONTENT_PREFIX.length);
  try {
    const raw = Buffer.from(blob, "base64url").toString("utf-8");
    const data = JSON.parse(raw);
    return typeof data === "object" && data !== null ? data : null;
  } catch {
    return null;
  }
}

function responsesFunctionCallId(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^fc_[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }
  return `fc_${generateRandomHex(32)}_${fallback}`;
}

export function extractNamespaceMap(tools: any[] | undefined): Record<string, string> {
  if (!Array.isArray(tools)) return {};
  const nsMap: Record<string, string> = {};
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    if (tool.type === "namespace") {
      const namespaceName = tool.name || "";
      const funcs = tool.functions || tool.tools || [];
      for (const f of funcs) {
        if (typeof f !== "object" || f === null) continue;
        const fName = f.name || "";
        if (fName) {
          nsMap[fName] = namespaceName;
        }
      }
    }
  }
  return nsMap;
}

function _unflattenVariants(name: string): string[] {
  const variants: string[] = [];
  if (name.includes("__")) {
    const parts = name.split("__");
    if (parts.length >= 2 && parts[parts.length - 1]) {
      variants.push(parts[parts.length - 1]);
    }
    const firstParts = name.split("__", 2);
    if (firstParts.length === 2 && firstParts[1]) {
      variants.push(firstParts[1]);
    }
  }
  if (name.includes("_")) {
    const parts = name.split("_");
    variants.push(parts[parts.length - 1]);
  }
  return variants;
}

export function unflattenToolCall(name: string, namespaceMap?: Record<string, string>): [string, string | null] {
  // First, prioritize standard computer use actions so they always map to mcp__computer_use
  const actions = ["click", "scroll", "press_key", "type_text", "perform_secondary_action", "select_text", "drag", "get_app_state", "set_value", "list_apps", "wait_for_ui"];
  for (const action of actions) {
    if (name === action || name === `mcp__computer_use_${action}` || name === `mcp__computer_use__${action}` || (name.endsWith(`_${action}`) && name.includes("computer"))) {
      return [action, "mcp__computer_use"];
    }
  }

  // Fallback check of variants for computer use actions to avoid incorrect mapping by other namespace mappings
  for (const variant of _unflattenVariants(name)) {
    if (actions.includes(variant)) {
      return [variant, "mcp__computer_use"];
    }
  }

  if (namespaceMap) {
    if (name in namespaceMap) {
      return [name, namespaceMap[name]];
    }
    // Match namespace directly if we have it in the map (handles custom MCP, list_apps, etc.)
    for (const [fName, nsName] of Object.entries(namespaceMap)) {
      if (name === `${nsName}_${fName}`) {
        return [fName, nsName];
      }
      if (name === `${nsName}__${fName}`) {
        return [fName, nsName];
      }
    }
    for (const variant of _unflattenVariants(name)) {
      if (variant in namespaceMap) {
        return [variant, namespaceMap[variant]];
      }
    }
  }

  if (name.includes("computer_use") || name.includes("computer-use")) {
    for (const action of actions) {
      if (name.includes(action)) {
        return [action, "mcp__computer_use"];
      }
    }
  }

  if (name.includes("__")) {
    const parts = name.split("__");
    if (parts.length >= 2) {
      const fnName = parts[parts.length - 1];
      const namespace = parts.slice(0, -1).join("__");
      return [fnName, namespace];
    }
  }
  return [name, null];
}

function cleanUserPrompt(content: string, voiceSystemPrompt: string): string {
  if (!content || !voiceSystemPrompt) return content;
  const prefixUtf = voiceSystemPrompt + "\n\n用户说：";
  const prefixUtfClean = voiceSystemPrompt + "\n\n\u7528\u623f\u8bf4\uff1a"; // clean alternative
  if (content.startsWith(prefixUtf)) {
    return content.slice(prefixUtf.length);
  }
  if (content.startsWith(prefixUtfClean)) {
    return content.slice(prefixUtfClean.length);
  }
  return content;
}

export function responsesToChat(body: any, upstreamModel: string, sessionId?: string): any {
  const messages: any[] = [];
  const instructions = body.instructions;
  
  // Try to load voice settings and inject voice system prompt if it's the active voice session
  let voiceSystemPrompt = "";
  try {
    const configPath = path.join(os.homedir(), ".opencodex", "voice_settings.json");
    if (fs.existsSync(configPath)) {
      const settings = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (settings.voice_system_prompt && (!sessionId || sessionId === settings.active_session_id)) {
        voiceSystemPrompt = settings.voice_system_prompt;
      }
    }
  } catch (err) {
    // ignore
  }

  let systemContent = _contentToText(instructions || "");
  if (voiceSystemPrompt) {
    systemContent = voiceSystemPrompt + "\n\n" + systemContent;
  }
  
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  let pendingReasoning: string | null = null;
  const inputMessages = _responsesInputToMessages(body.input);

  for (const m of inputMessages) {
    if (m._reasoning_only) {
      const summary = m.summary || [];
      const text = summary.map((item: any) => (typeof item === "object" ? item.text || "" : "")).join(" ");
      if (text) {
        pendingReasoning = text;
      }
      continue;
    }
    if (pendingReasoning && m.role === "assistant") {
      m.reasoning_content = pendingReasoning;
      pendingReasoning = null;
    }
    
    // Clean up any prepended voice prompt in user messages
    if (m.role === "user" && typeof m.content === "string" && voiceSystemPrompt) {
      m.content = cleanUserPrompt(m.content, voiceSystemPrompt);
    }
    
    messages.push(m);
  }

  const mergedMessages = _mergeConsecutiveMessages(_normalizeChatRoles(messages));
  const sanitizedMessages = _sanitizeChatMessages(mergedMessages);

  if (voiceSystemPrompt && sanitizedMessages.length > 0) {
    sanitizedMessages.push({
      role: "system",
      content: `[System Instruction reminder: Follow this personality style for the final response: ${voiceSystemPrompt}]`
    });
  }

  // Sanitize empty/null content fields for MiniMax model
  if (upstreamModel.toLowerCase().includes("minimax")) {
    for (const m of sanitizedMessages) {
      if (m.content === null || m.content === undefined || m.content === "") {
        m.content = " ";
      }
    }
  }

  const finalMessages = ensureToolCallIntegrity(sanitizedMessages);

  const chat: any = {
    model: upstreamModel,
    messages: finalMessages.length > 0 ? finalMessages : [{ role: "user", content: " " }],
    stream: body.stream ?? true,
  };

  _copyIfPresent(body, chat, "temperature");
  _copyIfPresent(body, chat, "top_p");
  if (body.max_output_tokens !== undefined) {
    chat.max_tokens = body.max_output_tokens;
  } else {
    _copyIfPresent(body, chat, "max_tokens");
  }
  _copyIfPresent(body, chat, "parallel_tool_calls");
  // Desktop Responses requests carry the selected intensity under
  // `reasoning.effort`; Chat-compatible upstreams expect `reasoning_effort`.
  // Preserve an explicit legacy field if a caller already supplied one.
  const reasoningEffort = body?.reasoning?.effort ?? body?.reasoning_effort;
  if (reasoningEffort) chat.reasoning_effort = reasoningEffort;

  const tools = _responsesToolsToChatTools(body.tools);
  if (tools && tools.length > 0) {
    chat.tools = tools;
    _copyIfPresent(body, chat, "tool_choice");
  }
  return chat;
}

export function chatCompletionToResponse(payload: any, requestedModel: string, namespaceMap?: Record<string, string>): any {
  const choice = (payload.choices || [{}])[0];
  const message = choice.message || {};
  const output: any[] = [];

  const reasoning = message.reasoning_content;
  if (reasoning) {
    output.push({
      id: "reasoning_0",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }

  const text = stripThink(message.content || "");
  if (text) {
    output.push({
      id: "msg_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  const toolCalls = message.tool_calls || [];
  for (const [index, call] of toolCalls.entries()) {
    const fn = call.function || {};
    const fnName = fn.name || "";
    const [unflattenedName, namespace] = unflattenToolCall(fnName, namespaceMap);

    const patchedArgs = patchToolCallArguments(unflattenedName, fn.arguments || "");
    const callId = call.id || `call_${index}`;

    const item: any = {
      id: responsesFunctionCallId(callId, String(index)),
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: unflattenedName,
      arguments: patchedArgs,
    };
    if (namespace) {
      item.namespace = namespace;
    }
    output.push(item);
  }

  if (output.length === 0) {
    output.push({
      id: "msg_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: " ", annotations: [] }],
    });
  }

  return {
    id: payload.id || "resp_chat",
    object: "response",
    created_at: payload.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage: payload.usage,
  };
}

function _copyIfPresent(src: any, dst: any, srcKey: string, dstKey?: string): void {
  if (src[srcKey] !== undefined && src[srcKey] !== null) {
    dst[dstKey || srcKey] = src[srcKey];
  }
}

function _contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (typeof part === "object" && part !== null) {
        if (["input_text", "output_text", "text"].includes(part.type)) {
          parts.push(String(part.text || ""));
        } else if ("content" in part) {
          parts.push(_contentToText(part.content));
        }
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  if (typeof content === "object" && content !== null) {
    if ("text" in content) return String(content.text || "");
    return JSON.stringify(content);
  }
  return String(content || "");
}

function _responsesInputToMessages(value: any): any[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [{ role: "user", content: value }];
  if (!Array.isArray(value)) return [{ role: "user", content: _contentToText(value) }];

  const messages: any[] = [];
  const pendingToolCalls: any[] = [];
  const deferredMessages: any[] = [];

  function flushPendingAssistantToolCalls() {
    if (pendingToolCalls.length > 0) {
      messages.push({ role: "assistant", content: null, tool_calls: [...pendingToolCalls] });
      pendingToolCalls.length = 0;
    }
  }

  function flushDeferred() {
    if (deferredMessages.length > 0) {
      messages.push(...deferredMessages);
      deferredMessages.length = 0;
    }
  }

  for (const item of value) {
    if (typeof item === "string") {
      flushPendingAssistantToolCalls();
      flushDeferred();
      messages.push({ role: "user", content: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;

    const itemType = item.type;
    if ((itemType === "message" || !itemType) && "role" in item) {
      if (pendingToolCalls.length > 0) {
        // Defer system/developer messages when tool calls are pending
        let role = item.role || "user";
        if (role === "developer") role = "system";
        deferredMessages.push({ role, content: _contentToText(item.content || "") });
      } else {
        flushPendingAssistantToolCalls();
        flushDeferred();
        let role = item.role || "user";
        if (role === "developer") role = "system";
        messages.push({ role, content: _contentToText(item.content || "") });
      }
    } else if (itemType === "input_text" || itemType === "text") {
      flushPendingAssistantToolCalls();
      flushDeferred();
      messages.push({ role: "user", content: _contentToText(item) });
    } else if (itemType === "function_call") {
      const callId = item.call_id || item.id || "call_0";
      const argsRaw = item.arguments || "";
      if (argsRaw) {
        try {
          const argsObj = JSON.parse(argsRaw);
          if (typeof argsObj === "object" && argsObj !== null && argsObj.app) {
            CURRENT_ACTIVE_APP = argsObj.app;
          }
        } catch {
          // ignore
        }
      }
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: item.name || "",
          arguments: item.arguments || "",
        },
      });
    } else if (itemType === "function_call_output") {
      flushPendingAssistantToolCalls();
      const outputText = _contentToText(item.output || "");

      // Parse get_app_state result to update CURRENT_ACTIVE_APP from actual app state,
      // not from what the model guessed in the function call arguments.
      const appMatch = outputText.match(/App=.*?\/([^\/]+\.app)\//);
      if (appMatch) {
        CURRENT_ACTIVE_APP = appMatch[1].replace(/\.app$/, "");
      }

      const outputCallId = item.call_id || item.id || "";
      if (outputCallId) {
        messages.push({
          role: "tool",
          tool_call_id: outputCallId,
          content: outputText,
        });
      } else {
        // No call id to pair with — strict OpenAI-compatible upstreams
        // reject tool messages with an empty tool_call_id, so deliver the
        // output as plain user context instead.
        messages.push({ role: "user", content: outputText || " " });
      }
      flushDeferred();
    } else if (itemType === "reasoning") {
      flushPendingAssistantToolCalls();
      messages.push({
        role: "assistant",
        _reasoning_only: true,
        encrypted_content: item.encrypted_content,
        summary: item.summary || [],
        content: null,
      });
    }
  }
  flushPendingAssistantToolCalls();
  flushDeferred();
  return messages;
}

function _responsesToolsToChatTools(tools: any[] | undefined): any[] {
  if (!Array.isArray(tools)) return [];
  const converted: any[] = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const toolName = tool.name || (tool.function || {}).name;
    if (toolName === "js") continue; // filter js tool



    const tType = tool.type;
    if (tType === "function") {
      if ("function" in tool) {
        converted.push(tool);
      } else if ("name" in tool) {
        converted.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.parameters || { type: "object", properties: {}, additionalProperties: true },
          },
        });
      }
    } else if (tType === "namespace") {
      const namespaceName = tool.name || "";
      const funcs = tool.functions || tool.tools || [];
      for (const f of funcs) {
        if (typeof f !== "object" || f === null) continue;
        const fName = f.name || "";
        const fullName = namespaceName.endsWith("__") ? namespaceName + fName : `${namespaceName}_${fName}`;
        const fFunc = f.function || f;
        const params = fFunc.parameters || fFunc.input_schema || { type: "object", properties: {}, additionalProperties: true };
        const desc = fFunc.description || "";
        converted.push({
          type: "function",
          function: {
            name: fullName,
            description: desc,
            parameters: params,
          },
        });
      }
    } else if ("name" in tool) {
      converted.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
        },
      });
    }
  }
  return converted;
}

function _sanitizeString(value: string): string {
  if (!value) return "";
  const clean = value.replace(/\x00/g, "");
  return [...clean].filter((char) => "\n\r\t".includes(char) || char.charCodeAt(0) >= 0x20).join("");
}

function _sanitizeChatMessages(messages: any[]): any[] {
  const cleaned: any[] = [];
  for (const message of messages) {
    const current = { ...message };
    delete current._reasoning_only;
    delete current.encrypted_content;
    delete current.summary;

    const role = current.role || "user";
    let content = current.content;
    if (role !== "assistant") {
      if (content === undefined || content === null) {
        current.content = "";
      } else if (typeof content !== "string") {
        current.content = _contentToText(content);
      }
      current.content = _sanitizeString(current.content);
    } else if (content !== undefined && content !== null) {
      if (typeof content !== "string") {
        content = _contentToText(content);
      }
      current.content = _sanitizeString(content);
    }

    if (typeof current.reasoning_content === "string") {
      current.reasoning_content = _sanitizeString(current.reasoning_content);
    }

    const toolCalls = current.tool_calls;
    if (toolCalls && Array.isArray(toolCalls)) {
      const copiedCalls: any[] = [];
      for (const call of toolCalls) {
        if (typeof call !== "object" || call === null) continue;
        const copiedCall = { ...call };
        if (typeof copiedCall.id === "string") {
          copiedCall.id = _sanitizeString(copiedCall.id);
        }
        let func = copiedCall.function;
        if (typeof func === "object" && func !== null) {
          func = { ...func };
          if (typeof func.arguments === "string") {
            func.arguments = _sanitizeString(func.arguments);
          }
          copiedCall.function = func;
        }
        copiedCalls.push(copiedCall);
      }
      current.tool_calls = copiedCalls;
    }

    if (typeof current.tool_call_id === "string") {
      current.tool_call_id = _sanitizeString(current.tool_call_id);
    }
    cleaned.push(current);
  }
  return cleaned;
}

/**
 * Reconcile tool messages with assistant tool_calls so the sequence is
 * always valid for strict OpenAI-compatible upstreams (e.g. Kimi), which
 * hard-fail the whole request when a tool_call_id is empty, unknown, or
 * left without a response.
 *
 * The desktop may rewrite call ids on its side, so pairing is done first
 * by exact id, then healed in call order. Tool outputs with no call at
 * all are downgraded to plain user context; assistant tool_calls that
 * end up without any response are removed from the request.
 */
export function ensureToolCallIntegrity(messages: any[]): any[] {
  const result = messages.map((m) => ({ ...m }));
  const pending: { msgIndex: number; callIndex: number; id: string }[] = [];

  for (let i = 0; i < result.length; i++) {
    const m = result[i];
    if (!m) continue;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      m.tool_calls.forEach((tc: any, callIndex: number) => {
        if (!tc || typeof tc !== "object") return;
        if (typeof tc.id !== "string" || !tc.id) {
          tc.id = `call_auto_${i}_${callIndex}`;
        }
        pending.push({ msgIndex: i, callIndex, id: tc.id });
      });
    } else if (m.role === "tool") {
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      let hitIndex = id ? pending.findIndex((p) => p.id === id) : -1;
      if (hitIndex >= 0) {
        pending.splice(hitIndex, 1);
        continue;
      }
      // Heal by call order: the desktop executes calls in order and lists
      // outputs in the same order, so pair with the oldest unanswered call.
      const next = pending.shift();
      if (next) {
        m.tool_call_id = next.id;
      } else {
        // No outstanding call — strict upstreams reject this message, so
        // deliver the output as plain user context instead.
        const content = typeof m.content === "string" ? m.content : _contentToText(m.content);
        result[i] = { role: "user", content: content || " " };
      }
    }
  }

  // Any assistant tool_call still without a response must not reach the
  // upstream; drop it (and the tool_calls array if it becomes empty).
  for (const p of pending) {
    const m = result[p.msgIndex];
    if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
      m.tool_calls = m.tool_calls.filter((tc: any) => tc && tc.id !== p.id);
      if (m.tool_calls.length === 0) {
        delete m.tool_calls;
        if (m.content === null || m.content === undefined) m.content = " ";
      }
    }
  }
  return result;
}

function _normalizeChatRoles(messages: any[]): any[] {
  return messages.map((m) => {
    const current = { ...m };
    if (current.role === "developer") {
      current.role = "system";
    }
    return current;
  });
}

function _mergeConsecutiveMessages(messages: any[]): any[] {
  const merged: any[] = [];
  for (const message of messages) {
    const current = { ...message };
    const role = current.role;
    if (merged.length > 0 && role === merged[merged.length - 1].role && ["system", "user", "assistant"].includes(role)) {
      const previous = merged[merged.length - 1];
      const prevContent = previous.content || "";
      const currContent = current.content || "";
      if (prevContent && currContent) {
        previous.content = `${prevContent}\n\n${currContent}`;
      } else if (currContent) {
        previous.content = currContent;
      }
      if (role === "assistant") {
        if (current.reasoning_content && !previous.reasoning_content) {
          previous.reasoning_content = current.reasoning_content;
        }
        const toolCalls = [...(previous.tool_calls || []), ...(current.tool_calls || [])];
        if (toolCalls.length > 0) {
          previous.tool_calls = toolCalls;
        }
      }
      continue;
    }
    merged.push(current);
  }
  return merged;
}

class ThinkTagFilter {
  private isThinking = false;
  private buffer = "";

  filter(chunk: string): string {
    this.buffer += chunk;
    let output = "";

    while (this.buffer.length > 0) {
      if (!this.isThinking) {
        const thinkIndex = this.buffer.indexOf("<think>");
        if (thinkIndex !== -1) {
          output += this.buffer.slice(0, thinkIndex);
          this.isThinking = true;
          this.buffer = this.buffer.slice(thinkIndex + 7);
        } else {
          let foundPartial = false;
          for (let i = 1; i < 7; i++) {
            if (this.buffer.endsWith("<think>".slice(0, i))) {
              output += this.buffer.slice(0, -i);
              this.buffer = this.buffer.slice(-i);
              foundPartial = true;
              break;
            }
          }
          if (!foundPartial) {
            output += this.buffer;
            this.buffer = "";
          } else {
            break;
          }
        }
      } else {
        const endThinkIndex = this.buffer.indexOf("</think>");
        if (endThinkIndex !== -1) {
          this.isThinking = false;
          this.buffer = this.buffer.slice(endThinkIndex + 8);
        } else {
          let foundPartial = false;
          for (let i = 1; i < 8; i++) {
            if (this.buffer.endsWith("</think>".slice(0, i))) {
              this.buffer = this.buffer.slice(-i);
              foundPartial = true;
              break;
            }
          }
          if (!foundPartial) {
            this.buffer = "";
          } else {
            break;
          }
        }
      }
    }
    return output;
  }
}




function generateRandomHex(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export class ResponsesStreamState {
  private static sessionResponseIds = new Map<string, string>();
  public responseId: string;
  private thinkFilter = new ThinkTagFilter();
  private messageItemId: string;
  private model: string;
  private namespaceMap: Record<string, string>;
  private messageIndex: number | null = null;
  private messageText = "";
  private messageOpened = false;
  private messageClosed = false;
  private toolCalls: Record<number, any> = {};
  private reasoningBlocks: Record<string, any> = {};
  private nextOutputIndex = 0;
  private hasStartedReasoningText = false;
  private hasEndedReasoningText = false;
  private onTextChunk?: (text: string) => void;
  private onTextDone?: (text: string) => void;
  private metadata?: any;
  private sequenceNumber = 1;
  private isBackground = false;
  private sequenceNumberCallbacks?: { get: () => number, set: (seq: number) => void };

  constructor(model: string, namespaceMap?: Record<string, string>, sessionId?: string, onTextChunk?: (text: string) => void, onTextDone?: (text: string) => void, metadata?: any, isBackground?: boolean, sequenceNumberCallbacks?: { get: () => number, set: (seq: number) => void }) {
    this.responseId = `resp_${generateRandomHex(48)}`;
    customResponseIds.add(this.responseId);
    this.messageItemId = `msg_${generateRandomHex(48)}`;
    this.model = model;
    this.namespaceMap = namespaceMap || {};
    this.onTextChunk = onTextChunk;
    this.onTextDone = onTextDone;
    this.metadata = metadata;
    this.isBackground = !!isBackground;
    this.sequenceNumberCallbacks = sequenceNumberCallbacks;
    if (sequenceNumberCallbacks) {
      this.sequenceNumber = sequenceNumberCallbacks.get();
    }
  }

  private _wrap(writeSse: (payload: any) => Promise<void>): (payload: any) => Promise<void> {
    return async (payload: any) => {
      payload.sequence_number = this.sequenceNumber;
      this.sequenceNumber += 1;
      if (this.sequenceNumberCallbacks) {
        this.sequenceNumberCallbacks.set(this.sequenceNumber);
      }
      await writeSse(payload);
    };
  }

  getAssistantMessage(): any {
    const content = this.messageText;
    const toolCalls: any[] = [];
    for (const key of Object.keys(this.toolCalls).map(Number).sort((a, b) => a - b)) {
      const tc = this.toolCalls[key];
      toolCalls.push({
        // History is replayed to the upstream chat API, where the id must
        // be the call id that later tool messages reference, not the
        // responses-protocol item id (fc_...).
        id: tc.call_id || tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments
        }
      });
    }
    return {
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined
    };
  }

  private _resolveNamespace(name: string): [string, string | null] {
    return unflattenToolCall(name, this.namespaceMap);
  }

  async start(writeSse: (payload: any) => Promise<void>): Promise<void> {
    const wrapped = this._wrap(writeSse);
    await wrapped({ type: "response.created", response: this._response("in_progress") });
    await wrapped({ type: "response.in_progress", response: this._response("in_progress") });
  }

  async finish(writeSse: (payload: any) => Promise<void>, usage?: { input_tokens: number, output_tokens: number, total_tokens: number }): Promise<void> {
    const wrapped = this._wrap(writeSse);
    for (const key of Object.keys(this.reasoningBlocks)) {
      const rState = this.reasoningBlocks[key];
      if (!rState.closed) {
        await this._closeReasoning(wrapped, rState);
      }
    }
    if (!this.messageOpened) {
      await this._openMessage(wrapped);
    }
    if (this.messageOpened && !this.messageClosed) {
      await this._closeMessage(wrapped);
    }
    for (const key of Object.keys(this.toolCalls)) {
      const tState = this.toolCalls[Number(key)];
      if (!tState.added) {
        await this._ensureToolOpened(wrapped, tState);
      }
    }
    for (const key of Object.keys(this.toolCalls).map(Number).sort((a, b) => this.toolCalls[a].output_index - this.toolCalls[b].output_index)) {
      const tState = this.toolCalls[key];
      if (!tState.closed) {
        await this._closeTool(wrapped, tState);
      }
    }
    if (this.onTextDone) {
      try { this.onTextDone(this.messageText); } catch {}
    }
    const finalResp = this._response("completed", true, usage);
    await wrapped({ type: "response.completed", response: finalResp });
    await wrapped({ type: "response.done", response: finalResp });

    if (usage) {
      await wrapped({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: usage.input_tokens,
              cached_input_tokens: 0,
              output_tokens: usage.output_tokens,
              reasoning_output_tokens: 0,
              total_tokens: usage.total_tokens
            },
            last_token_usage: {
              input_tokens: usage.input_tokens,
              cached_input_tokens: 0,
              output_tokens: usage.output_tokens,
              reasoning_output_tokens: 0,
              total_tokens: usage.total_tokens
            },
            model_context_window: finalResp.usage?.model_context_window || 200000
          }
        }
      });
    }
  }

  async writeChatDelta(writeSse: (payload: any) => Promise<void>, chunk: any): Promise<void> {
    const wrapped = this._wrap(writeSse);
    const choice = (chunk.choices && chunk.choices.length > 0) ? chunk.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta || {};

    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) {
      await this._chatReasoningDelta(wrapped, reasoning);
    }

    const content = delta.content;
    if (content) {
      for (const key of Object.keys(this.reasoningBlocks)) {
        const rState = this.reasoningBlocks[key];
        if (!rState.closed) {
          await this._closeReasoning(wrapped, rState);
        }
      }

      const filtered = this.thinkFilter.filter(content);
      if (filtered) {
        if (!this.messageOpened) {
          await this._openMessage(wrapped);
        }
        await this._textDelta(wrapped, filtered);
      }
    }

    const toolCalls = delta.tool_calls || [];
    for (const call of toolCalls) {
      await this._chatToolDelta(wrapped, call);
    }
  }

  private async _chatReasoningDelta(writeSse: (payload: any) => Promise<void>, text: string): Promise<void> {
    const key = "chat_reasoning";
    let state = this.reasoningBlocks[key];
    if (!state) {
      state = await this._openReasoning(writeSse, key);
    }
    state.text += text;
    await writeSse({
      type: "response.reasoning_text.delta",
      item_id: state.id,
      output_index: state.output_index,
      content_index: 0,
      delta: text,
    });
    await writeSse({
      type: "response.reasoning_summary_text.delta",
      item_id: state.id,
      output_index: state.output_index,
      summary_index: 0,
      delta: text,
    });
  }

  private async _chatToolDelta(writeSse: (payload: any) => Promise<void>, call: any): Promise<void> {
    const index = Number(call.index || 0);
    const fn = call.function || {};
    let state = this.toolCalls[index];

    if (!state) {
      const callId = call.id || `call_${index}`;
      state = {
        id: responsesFunctionCallId(callId, String(index)),
        call_id: callId,
        name: fn.name || "",
        arguments: "",
        added: false,
        closed: false,
      };
      this.toolCalls[index] = state;
    } else {
      if (fn.name) {
        state.name += fn.name;
      }
    }

    // Defer ensureToolOpened until we have the complete name (which is when arguments start streaming or the tool closes)
    const argDelta = fn.arguments || "";
    if (argDelta) {
      if (!state.added) {
        await this._ensureToolOpened(writeSse, state);
      }
      state.arguments += argDelta;
      await writeSse({
        type: "response.function_call_arguments.delta",
        item_id: state.id,
        output_index: state.output_index,
        delta: argDelta,
      });
    }
  }

  private async _openMessage(writeSse: (payload: any) => Promise<void>): Promise<void> {
    this.messageIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    this.messageOpened = true;

    await writeSse({
      type: "response.output_item.added",
      item: {
        id: this.messageItemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        phase: "final_answer",
        content: [],
      },
    });

    await writeSse({
      type: "response.content_part.added",
      item_id: this.messageItemId,
      output_index: this.messageIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private async _closeMessage(writeSse: (payload: any) => Promise<void>): Promise<void> {
    if (!this.messageOpened || this.messageClosed || this.messageIndex === null) return;
    this.messageClosed = true;

    await writeSse({
      type: "response.output_text.done",
      item_id: this.messageItemId,
      output_index: this.messageIndex,
      content_index: 0,
      text: this.messageText,
    });

    await writeSse({
      type: "response.content_part.done",
      item_id: this.messageItemId,
      output_index: this.messageIndex,
      content_index: 0,
      part: { type: "output_text", text: this.messageText, annotations: [] },
    });

    await writeSse({
      type: "response.output_item.done",
      item: this._messageItem("completed"),
    });
  }

  private async _textDelta(writeSse: (payload: any) => Promise<void>, text: string): Promise<void> {
    if (!text) return;
    if (!this.messageOpened) {
      await this._openMessage(writeSse);
    }
    this.messageText += text;
    if (this.onTextChunk) {
      try { this.onTextChunk(text); } catch {}
    }
    await writeSse({
      type: "response.output_text.delta",
      item_id: this.messageItemId,
      output_index: this.messageIndex!,
      content_index: 0,
      delta: text,
    });
  }

  private async _ensureToolOpened(writeSse: (payload: any) => Promise<void>, state: any): Promise<void> {
    if (state.added) return;
    state.added = true;

    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    state.output_index = outputIndex;

    if (this.messageOpened && !this.messageClosed) {
      await this._closeMessage(writeSse);
    }

    const [unflattenedName, namespace] = this._resolveNamespace(state.name);

    const itemData: any = {
      id: state.id,
      type: "function_call",
      status: "in_progress",
      call_id: state.call_id,
      name: unflattenedName,
      arguments: "",
    };
    if (namespace) {
      itemData.namespace = namespace;
    }

    await writeSse({
      type: "response.output_item.added",
      item: itemData,
    });
  }

  private async _closeTool(writeSse: (payload: any) => Promise<void>, state: any): Promise<void> {
    await this._ensureToolOpened(writeSse, state);
    state.closed = true;

    const patchedArgs = patchToolCallArguments(state.name, state.arguments);
    state.arguments = patchedArgs;

    await writeSse({
      type: "response.function_call_arguments.done",
      item_id: state.id,
      output_index: state.output_index,
      arguments: state.arguments,
    });

    await writeSse({
      type: "response.output_item.done",
      item: this._toolItem(state, "completed"),
    });
  }

  private async _openReasoning(writeSse: (payload: any) => Promise<void>, key: string): Promise<any> {
    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId = `rs_${Date.now()}_${outputIndex}`;

    const state = {
      id: itemId,
      output_index: outputIndex,
      text: "",
      signature: "",
      closed: false,
    };
    this.reasoningBlocks[key] = state;

    await writeSse({
      type: "response.output_item.added",
      item: {
        id: itemId,
        type: "reasoning",
        status: "in_progress",
        summary: [],
        content: [],
        encrypted_content: null,
      },
    });

    await writeSse({
      type: "response.content_part.added",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
    });

    return state;
  }

  private async _closeReasoning(writeSse: (payload: any) => Promise<void>, state: any): Promise<void> {
    state.closed = true;

    await writeSse({
      type: "response.reasoning_text.done",
      item_id: state.id,
      output_index: state.output_index,
      content_index: 0,
      text: state.text,
    });

    await writeSse({
      type: "response.reasoning_summary_text.done",
      item_id: state.id,
      output_index: state.output_index,
      summary_index: 0,
      text: state.text,
    });

    await writeSse({
      type: "response.output_item.done",
      item: this._reasoningItem(state, "completed"),
    });
  }

  private _reasoningItem(state: any, status: string): any {
    return {
      id: state.id,
      type: "reasoning",
      summary: state.text ? [{ type: "summary_text", text: state.text }] : [],
      content: [],
      encrypted_content: null,
    };
  }

  private _messageItem(status: string): any {
    return {
      id: this.messageItemId,
      type: "message",
      status,
      role: "assistant",
      phase: "final_answer",
      content: this.messageText ? [{ type: "output_text", text: this.messageText, annotations: [] }] : [],
    };
  }

  private _toolItem(state: any, status: string): any {
    const [unflattenedName, namespace] = this._resolveNamespace(state.name);
    const item: any = {
      id: state.id,
      type: "function_call",
      status,
      call_id: state.call_id,
      name: unflattenedName,
      arguments: state.arguments,
    };
    if (namespace) {
      item.namespace = namespace;
    }
    return item;
  }

  private _response(status: string, final = false, usage?: { input_tokens: number, output_tokens: number, total_tokens: number }): any {
    let output: any[] = [];
    const now = Math.floor(Date.now() / 1000);
    if (final) {
      const collected: [number, any][] = [];
      for (const state of Object.values(this.reasoningBlocks)) {
        collected.push([state.output_index, this._reasoningItem(state, "completed")]);
      }
      if (this.messageOpened && this.messageIndex !== null) {
        collected.push([this.messageIndex, this._messageItem("completed")]);
      }
      for (const state of Object.values(this.toolCalls)) {
        collected.push([state.output_index, this._toolItem(state, "completed")]);
      }
      collected.sort((a, b) => a[0] - b[0]);
      output = collected.map((pair) => pair[1]);

      if (output.length === 0) {
        output.push({
          id: this.messageItemId,
          type: "message",
          status: "completed",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: " ", annotations: [] }],
        });
      }
    }
    return {
      id: this.responseId,
      object: "response",
      created_at: now,
      completed_at: final ? now : null,
      status,
      model: this.model,
      output,
      metadata: this.metadata,
      usage: usage ? {
        total_tokens: usage.total_tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens
      } : {
        total_tokens: 100,
        input_tokens: 50,
        output_tokens: 50
      }
    };
  }
}

// ══════════════════════════════════════════════
//  Universal Vision Fallback Implementation
// ══════════════════════════════════════════════

const CACHE_DIR = path.join(os.homedir(), ".opencodex");
const PERSISTENT_CACHE_PATH = path.join(CACHE_DIR, "vision_cache.json");

let DESCRIPTION_CACHE = new Map<string, { ts: number; desc: string }>();
const CACHE_TTL = 86400 * 1000; // 24 hours

try {
  if (fs.existsSync(PERSISTENT_CACHE_PATH)) {
    const raw = fs.readFileSync(PERSISTENT_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === "object" && (v as any).desc) {
          DESCRIPTION_CACHE.set(k, v as any);
        }
      }
      console.error(`[OpenCodex-VisionBridge] Loaded ${DESCRIPTION_CACHE.size} persistent descriptions from ${PERSISTENT_CACHE_PATH}`);
    }
  }
} catch (err: any) {
  console.error(`[OpenCodex-VisionBridge] Failed to load persistent cache: ${err.message}`);
}

function savePersistentCache() {
  try {
    const obj: Record<string, any> = {};
    for (const [k, v] of DESCRIPTION_CACHE.entries()) {
      obj[k] = v;
    }
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(PERSISTENT_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err: any) {
    console.error(`[OpenCodex-VisionBridge] Failed to save persistent cache: ${err.message}`);
  }
}

function _imageHash(b64Data: string): string {
  return crypto.createHash("sha256").update(b64Data).digest("hex").slice(0, 16);
}

const COMPRESSED_CACHE = new Map<string, string>();

function sipsCompressB64(b64Data: string): string {
  if (!b64Data) return "";
  const h = _imageHash(b64Data);
  const cached = COMPRESSED_CACHE.get(h);
  if (cached) {
    return cached;
  }

  const tempDir = os.tmpdir();
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempInputPath = path.join(tempDir, `ocx_in_${uniqueId}.png`);
  const tempOutputPath = path.join(tempDir, `ocx_out_${uniqueId}.jpg`);
  try {
    fs.writeFileSync(tempInputPath, Buffer.from(b64Data, "base64"));
    // Convert to highly compressed JPEG (quality=40) and scale to max 800px width/height
    execSync(`sips -s format jpeg -s formatOptions 40 -Z 800 "${tempInputPath}" --out "${tempOutputPath}" 2>/dev/null`);
    if (fs.existsSync(tempOutputPath)) {
      const compressed = fs.readFileSync(tempOutputPath).toString("base64");
      COMPRESSED_CACHE.set(h, compressed);
      const compHash = _imageHash(compressed);
      COMPRESSED_CACHE.set(compHash, compressed);
      return compressed;
    }
  } catch {
    // fallback to original
  } finally {
    try { if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath); } catch {}
    try { if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); } catch {}
  }
  return b64Data;
}

export async function describeImageB64(b64Data: string, config?: any): Promise<string | null> {
  const h = _imageHash(b64Data);
  const now = Date.now();
  
  const cached = DESCRIPTION_CACHE.get(h);
  if (cached && now - cached.ts < CACHE_TTL) {
    console.error(`[OpenCodex-VisionBridge] Cache hit for image hash=${h}: ${cached.desc.slice(0, 80)}...`);
    return cached.desc;
  }

  console.error(`[OpenCodex-VisionBridge] Processing image base64, len=${b64Data?.length}. Compressing with sips...`);

  const optimizedB64 = sipsCompressB64(b64Data);

  // 2. Fetch API key and endpoint for vision fallback provider
  const opencodeProvider = config?.providers?.find((p: any) => p.name === "opencode");

  let apiKey = opencodeProvider ? opencodeProvider.api_key : "";
  let baseUrl = opencodeProvider ? opencodeProvider.base_url : "https://opencode.ai/zen/go/v1";

  if (apiKey.startsWith("$")) {
    apiKey = process.env[apiKey.slice(1)] || "";
  }

  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  if (!apiKey && !isLocal) {
    console.error(`[OpenCodex-VisionBridge] No API key configured for vision fallback. Skipping.`);
    return null;
  }

  const visionUrl = `${baseUrl}/chat/completions`;
  const visionModel = opencodeProvider?.vision_model || "mimo-v2.5";

  console.error(`[OpenCodex-VisionBridge] Calling ${visionModel} at ${visionUrl}`);

  try {
    const payload = {
      model: visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "请详细描述此屏幕截图的内容，如果包含文字请提取。只输出描述，不要额外对话。" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${optimizedB64}` } },
          ],
        },
      ],
      stream: false,
      max_tokens: 1024,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(visionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      dispatcher: fetchDispatcher
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[OpenCodex-VisionBridge] OpenCode MiMo API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const resBody: any = await response.json();
    const desc = resBody?.choices?.[0]?.message?.content || "";
    if (desc) {
      DESCRIPTION_CACHE.set(h, { ts: now, desc });
      savePersistentCache();
      return desc;
    }
    return null;
  } catch (err: any) {
    console.error(`[OpenCodex-VisionBridge] OpenCode MiMo vision request failed:`, err.message);
    return null;
  }
}

export async function replaceScreenshotPlaceholders(body: any, config?: any): Promise<void> {
  const inputData = body.input;
  if (!Array.isArray(inputData)) return;

  for (let msgIdx = 0; msgIdx < inputData.length; msgIdx++) {
    const msg = inputData[msgIdx];
    if (typeof msg !== "object" || msg === null) continue;

    const processValue = async (val: any): Promise<any> => {
      if (val === undefined || val === null) return val;
      if (typeof val === "string") {
        const match = val.match(/\[OpenCodexScreenshotCached:\s*([^\]]+)\]/);
        if (match) {
          const cachePath = match[1].trim();
          if (fs.existsSync(cachePath)) {
            try {
              console.error(`[OpenCodex-Bypass] Found screenshot placeholder at path: ${cachePath}`);
              const pngData = fs.readFileSync(cachePath);
              const b64 = pngData.toString("base64");
              
              const origHash = _imageHash(b64);
              const cachedVal = DESCRIPTION_CACHE.get(origHash);
              if (cachedVal && Date.now() - cachedVal.ts < CACHE_TTL) {
                console.error(`[OpenCodex-Bypass] Fast-path: cached placeholder description hit`);
                val = val.replace(match[0], `[截图描述: ${cachedVal.desc}]`);
                return val;
              }

              const compressed = sipsCompressB64(b64);
              let desc = "";
              if (config) {
                const fetchedDesc = await describeImageB64(compressed, config);
                if (fetchedDesc) {
                  desc = fetchedDesc;
                  DESCRIPTION_CACHE.set(origHash, { ts: Date.now(), desc });
                  savePersistentCache();
                }
              }
              if (!desc) {
                desc = "屏幕截图（已离线缓存且由于未配置视觉模型无法生成文本描述）";
              }
              
              const replacement = `[截图描述: ${desc}]`;
              val = val.replace(match[0], replacement);
            } catch (err: any) {
              console.error(`[OpenCodex-Bypass] Error processing screenshot cache:`, err.message);
            }
          } else {
            console.error(`[OpenCodex-Bypass] Cached screenshot file not found: ${cachePath}`);
          }
        }

        // Intercept drag-dropped image files in notch client prompt (only if not already processed in history)
        if (!val.includes("[拖入图片描述:") && !val.includes("[截图描述:")) {
          const dragMatch = val.match(/保存在本地路径：([^\s\(\)]+\.(?:png|jpg|jpeg|gif|webp))/);
          if (dragMatch) {
            const dragPath = dragMatch[1].trim();
            if (fs.existsSync(dragPath)) {
              try {
                console.error(`[OpenCodex-Bypass] Found drag-dropped image at path: ${dragPath}`);
                const imgData = fs.readFileSync(dragPath);
                const b64 = imgData.toString("base64");

                const origHash = _imageHash(b64);
                const cachedVal = DESCRIPTION_CACHE.get(origHash);
                if (cachedVal && Date.now() - cachedVal.ts < CACHE_TTL) {
                  console.error(`[OpenCodex-Bypass] Fast-path: cached drag image description hit`);
                  val = val.replace(dragMatch[0], `保存在本地路径：${dragPath} [拖入图片描述: ${cachedVal.desc}]`);
                  return val;
                }

                const compressed = sipsCompressB64(b64);
                let desc = "";
                if (config) {
                  const fetchedDesc = await describeImageB64(compressed, config);
                  if (fetchedDesc) {
                    desc = fetchedDesc;
                    DESCRIPTION_CACHE.set(origHash, { ts: Date.now(), desc });
                    savePersistentCache();
                  }
                }
                if (!desc) {
                  desc = "拖入图片（已在本地准备就绪，由于未配置视觉模型无法生成文本描述）";
                }
                
                const replacement = `保存在本地路径：${dragPath} [拖入图片描述: ${desc}]`;
                val = val.replace(dragMatch[0], replacement);
              } catch (err: any) {
                console.error(`[OpenCodex-Bypass] Error processing drag image:`, err.message);
              }
            } else {
              console.error(`[OpenCodex-Bypass] Drag-dropped file not found on disk: ${dragPath}`);
            }
          }
        }
      } else if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          val[i] = await processValue(val[i]);
        }
      } else if (typeof val === "object") {
        for (const key of Object.keys(val)) {
          val[key] = await processValue(val[key]);
        }
      }
      return val;
    };

    inputData[msgIdx] = await processValue(msg);
  }
}

export async function processVisionBridge(body: any, config?: any): Promise<any> {
  await replaceScreenshotPlaceholders(body, config);

  const inputData = body.input;
  if (!Array.isArray(inputData)) return body;

  const images: { idx: number; b64: string; msgIdx: number; isOutput: boolean; origHash: string }[] = [];
  const now = Date.now();

  for (let msgIdx = 0; msgIdx < inputData.length; msgIdx++) {
    const msg = inputData[msgIdx];
    if (typeof msg !== "object" || msg === null) continue;
    
    // Only translate images/screenshots in user messages (e.g. dragged/dropped images).
    // Skip assistant, system, and tool output messages (no computer use screenshots should be processed).
    if (msg.role !== "user") continue;

    // Handle function_call_output items that carry MCP tool results with embedded images
    if (msg.type === "function_call_output" && Array.isArray(msg.output)) {
      for (let i = 0; i < msg.output.length; i++) {
        const item = msg.output[i];
        if (typeof item !== "object" || item === null) continue;

        let b64 = "";
        if (item.type === "image") {
          if (item.source?.data) {
            b64 = item.source.data;
          } else if (item.data) {
            b64 = item.data;
          }
        } else if (item.type === "input_image") {
          let url = "";
          if (typeof item.image_url === "string") url = item.image_url;
          else if (item.image_url?.url) url = item.image_url.url;
          if (url.startsWith("data:image/")) {
            b64 = url.includes(",") ? url.split(",")[1] : url;
          }
        }
        if (!b64) continue;

        const origHash = _imageHash(b64);
        const cached = DESCRIPTION_CACHE.get(origHash);
        if (cached && now - cached.ts < CACHE_TTL) {
          console.error(`[OpenCodex-VisionBridge] Fast-path: original image cache hit for output image hash=${origHash}`);
          msg.output[i] = {
            type: "input_text",
            text: `\n[截图描述: ${cached.desc}]\n`,
          };
          continue;
        }

        const compressed = sipsCompressB64(b64);
        images.push({ idx: i, b64: compressed, msgIdx, isOutput: true, origHash });
      }
      continue;
    }

    // Skip function_call_output items with plain string output (no images)
    if (msg.type === "function_call_output") continue;

    const content = msg.content || (Array.isArray(msg.output) ? msg.output : null);
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      if (typeof item !== "object" || item === null) continue;

      let b64 = "";
      if (item.type === "input_image") {
        let url = "";
        if (typeof item.image_url === "string") {
          url = item.image_url;
        } else if (typeof item.image_url === "object" && item.image_url !== null) {
          url = item.image_url.url || "";
        }
        if (url.startsWith("data:image/")) {
          b64 = url.includes(",") ? url.split(",")[1] : url;
        }
      } else if (item.type === "image") {
        // MCP/Anthropic-style image inside message content array
        if (item.source?.data) {
          b64 = item.source.data;
        } else if (item.data) {
          b64 = item.data;
        }
      } else if (item.type === "input_file" && item.file_data) {
        b64 = item.file_data;
      }
      if (!b64) continue;

      const origHash = _imageHash(b64);
      const cached = DESCRIPTION_CACHE.get(origHash);
      if (cached && now - cached.ts < CACHE_TTL) {
        console.error(`[OpenCodex-VisionBridge] Fast-path: original image cache hit for input image hash=${origHash}`);
        content[i] = {
          type: "input_text",
          text: `\n[截图描述: ${cached.desc}]\n`,
        };
        continue;
      }

      // Always compress with sips
      const compressed = sipsCompressB64(b64);
      if (compressed !== b64) {
        if (item.type === "input_image") {
          if (typeof item.image_url === "string") {
            content[i].image_url = `data:image/png;base64,${compressed}`;
          } else {
            content[i] = { ...item, image_url: { url: `data:image/png;base64,${compressed}` } };
          }
        } else {
          content[i] = { ...item, file_data: compressed };
        }
      }

      images.push({ idx: i, b64: compressed, msgIdx, isOutput: false, origHash });
    }
  }

  // Describe images for text-only models (vision bridge)
  if (images.length > 0 && config) {
    const promises = images.map(async ({ idx, b64, msgIdx, isOutput, origHash }) => {
      const desc = await describeImageB64(b64, config);
      const targetArray = isOutput ? inputData[msgIdx].output : inputData[msgIdx].content;
      if (desc) {
        // Cache under the original uncompressed image hash
        DESCRIPTION_CACHE.set(origHash, { ts: Date.now(), desc });
        savePersistentCache();

        targetArray[idx] = {
          type: "input_text",
          text: `\n[截图描述: ${desc}]\n`,
        };
      } else {
        targetArray[idx] = {
          type: "input_text",
          text: `\n[截图描述: 无法识别 of 屏幕截图]\n`,
        };
      }
    });
    await Promise.all(promises);
    console.error(`[OpenCodex-VisionBridge] Replaced ${images.length} screenshot(s) with descriptions in parallel.`);
  }

  return body;
}
