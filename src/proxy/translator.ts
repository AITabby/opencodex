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

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
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
  if (namespaceMap) {
    if (name in namespaceMap) {
      return [name, namespaceMap[name]];
    }
    for (const variant of _unflattenVariants(name)) {
      if (variant in namespaceMap) {
        return [variant, namespaceMap[variant]];
      }
    }
  }

  if (name.includes("computer_use") || name.includes("computer-use")) {
    const actions = ["click", "scroll", "press_key", "type_text", "perform_secondary_action", "select_text", "drag", "get_app_state", "set_value", "list_apps"];
    for (const action of actions) {
      if (name.includes(action)) {
        return [action, "mcp__computer_use__"];
      }
    }
  }

  if (name.includes("__")) {
    const parts = name.split("__");
    if (parts.length >= 2) {
      const fnName = parts[parts.length - 1];
      const namespace = parts.slice(0, -1).join("__") + "__";
      return [fnName, namespace];
    }
  }
  return [name, null];
}

export function responsesToChat(body: any, upstreamModel: string): any {
  const messages: any[] = [];
  const instructions = body.instructions;
  if (instructions) {
    messages.push({ role: "system", content: _contentToText(instructions) });
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
    messages.push(m);
  }

  const mergedMessages = _mergeConsecutiveMessages(_normalizeChatRoles(messages));
  const sanitizedMessages = _sanitizeChatMessages(mergedMessages);

  const chat: any = {
    model: upstreamModel,
    messages: sanitizedMessages.length > 0 ? sanitizedMessages : [{ role: "user", content: "" }],
    stream: !!body.stream,
  };

  _copyIfPresent(body, chat, "temperature");
  _copyIfPresent(body, chat, "top_p");
  if (body.max_output_tokens !== undefined) {
    chat.max_tokens = body.max_output_tokens;
  } else {
    _copyIfPresent(body, chat, "max_tokens");
  }
  _copyIfPresent(body, chat, "parallel_tool_calls");
  _copyIfPresent(body, chat, "reasoning_effort");

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
  for (const call of toolCalls) {
    const fn = call.function || {};
    const fnName = fn.name || "";
    const [unflattenedName, namespace] = unflattenToolCall(fnName, namespaceMap);

    const patchedArgs = patchToolCallArguments(unflattenedName, fn.arguments || "");

    const item: any = {
      id: call.id || "call_0",
      type: "function_call",
      status: "completed",
      call_id: call.id || "call_0",
      name: unflattenedName,
      arguments: patchedArgs,
    };
    if (namespace) {
      item.namespace = namespace;
    }
    output.push(item);
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
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: _contentToText(item.output || ""),
      });
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

export class ResponsesStreamState {
  private responseId: string;
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

  constructor(model: string, namespaceMap?: Record<string, string>) {
    this.responseId = `resp_${Date.now()}`;
    this.messageItemId = `msg_${Date.now()}`;
    this.model = model;
    this.namespaceMap = namespaceMap || {};
  }

  private _resolveNamespace(name: string): [string, string | null] {
    return unflattenToolCall(name, this.namespaceMap);
  }

  async start(writeSse: (payload: any) => Promise<void>): Promise<void> {
    await writeSse({ type: "response.created", response: this._response("in_progress") });
  }

  async finish(writeSse: (payload: any) => Promise<void>): Promise<void> {
    for (const key of Object.keys(this.reasoningBlocks)) {
      const rState = this.reasoningBlocks[key];
      if (!rState.closed) {
        await this._closeReasoning(writeSse, rState);
      }
    }
    if (this.messageOpened && !this.messageClosed) {
      await this._closeMessage(writeSse);
    }
    for (const key of Object.keys(this.toolCalls)) {
      const tState = this.toolCalls[Number(key)];
      if (!tState.added) {
        await this._ensureToolOpened(writeSse, tState);
      }
    }
    for (const key of Object.keys(this.toolCalls).map(Number).sort((a, b) => this.toolCalls[a].output_index - this.toolCalls[b].output_index)) {
      const tState = this.toolCalls[key];
      if (!tState.closed) {
        await this._closeTool(writeSse, tState);
      }
    }
    await writeSse({ type: "response.completed", response: this._response("completed", true) });
  }

  async writeChatDelta(writeSse: (payload: any) => Promise<void>, chunk: any): Promise<void> {
    const choice = (chunk.choices || [{}])[0];
    const delta = choice.delta || {};

    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) {
      await this._chatReasoningDelta(writeSse, reasoning);
    }

    const content = delta.content;
    if (content) {
      for (const key of Object.keys(this.reasoningBlocks)) {
        const rState = this.reasoningBlocks[key];
        if (!rState.closed) {
          await this._closeReasoning(writeSse, rState);
        }
      }
      await this._textDelta(writeSse, content);
    }

    const toolCalls = delta.tool_calls || [];
    for (const call of toolCalls) {
      await this._chatToolDelta(writeSse, call);
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
        id: callId,
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

    const argDelta = fn.arguments || "";
    if (argDelta) {
      await this._ensureToolOpened(writeSse, state);
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
      output_index: this.messageIndex,
      item: {
        id: this.messageItemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
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
      output_index: this.messageIndex,
      item: this._messageItem("completed"),
    });
  }

  private async _textDelta(writeSse: (payload: any) => Promise<void>, text: string): Promise<void> {
    if (!text) return;
    if (!this.messageOpened) {
      await this._openMessage(writeSse);
    }
    this.messageText += text;
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
      output_index: outputIndex,
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
      output_index: state.output_index,
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
      output_index: outputIndex,
      item: {
        id: itemId,
        type: "reasoning",
        status: "in_progress",
        summary: [],
        encrypted_content: null,
      },
    });
    return state;
  }

  private async _closeReasoning(writeSse: (payload: any) => Promise<void>, state: any): Promise<void> {
    state.closed = true;

    await writeSse({
      type: "response.reasoning_summary_text.done",
      item_id: state.id,
      output_index: state.output_index,
      summary_index: 0,
      text: state.text,
    });

    await writeSse({
      type: "response.output_item.done",
      output_index: state.output_index,
      item: this._reasoningItem(state, "completed"),
    });
  }

  private _reasoningItem(state: any, status: string): any {
    const payload = {
      type: "thinking",
      thinking: state.text || "",
      signature: state.signature || "",
    };
    const encrypted = _encodeThinkingPayload(payload);
    return {
      id: state.id,
      type: "reasoning",
      status,
      summary: state.text ? [{ type: "summary_text", text: state.text }] : [],
      encrypted_content: encrypted,
    };
  }

  private _messageItem(status: string): any {
    return {
      id: this.messageItemId,
      type: "message",
      status,
      role: "assistant",
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

  private _response(status: string, final = false): any {
    let output: any[] = [];
    if (final) {
      const collected: [number, any][] = [];
      for (const state of Object.values(this.reasoningBlocks)) {
        collected.push([state.output_index, this._reasoningItem(state, "completed")]);
      }
      if (this.messageOpened && this.messageText && this.messageIndex !== null) {
        collected.push([this.messageIndex, this._messageItem("completed")]);
      }
      for (const state of Object.values(this.toolCalls)) {
        collected.push([state.output_index, this._toolItem(state, "completed")]);
      }
      collected.sort((a, b) => a[0] - b[0]);
      output = collected.map((pair) => pair[1]);
    }
    return {
      id: this.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output,
    };
  }
}

// ══════════════════════════════════════════════
//  Universal Vision Fallback Implementation
// ══════════════════════════════════════════════

const DESCRIPTION_CACHE = new Map<string, { ts: number; desc: string }>();
const CACHE_TTL = 300 * 1000;

function _imageHash(b64Data: string): string {
  return crypto.createHash("sha256").update(b64Data).digest("hex").slice(0, 16);
}

function sipsCompressB64(b64Data: string): string {
  const tempDir = os.tmpdir();
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const tempInputPath = path.join(tempDir, `ocx_in_${uniqueId}.png`);
  const tempOutputPath = path.join(tempDir, `ocx_out_${uniqueId}.png`);
  try {
    fs.writeFileSync(tempInputPath, Buffer.from(b64Data, "base64"));
    execSync(`sips -Z 1200 "${tempInputPath}" --out "${tempOutputPath}" 2>/dev/null`);
    if (fs.existsSync(tempOutputPath)) {
      return fs.readFileSync(tempOutputPath).toString("base64");
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

    const response = await fetch(visionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[OpenCodex-VisionBridge] OpenCode MiMo API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const resBody: any = await response.json();
    const desc = resBody?.choices?.[0]?.message?.content || "";
    if (desc) {
      DESCRIPTION_CACHE.set(h, { ts: now, desc });
      return desc;
    }
    return null;
  } catch (err: any) {
    console.error(`[OpenCodex-VisionBridge] OpenCode MiMo vision request failed:`, err.message);
    return null;
  }
}

export async function processVisionBridge(body: any, config?: any): Promise<any> {
  const inputData = body.input;
  if (!Array.isArray(inputData)) return body;

  const images: { idx: number; b64: string; msgIdx: number }[] = [];

  for (let msgIdx = 0; msgIdx < inputData.length; msgIdx++) {
    const msg = inputData[msgIdx];
    if (typeof msg !== "object" || msg === null) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      if (typeof item !== "object" || item === null) continue;

      let b64 = "";
      if (item.type === "input_image") {
        const url = item.image_url?.url || "";
        if (url.startsWith("data:image/")) {
          b64 = url.includes(",") ? url.split(",")[1] : url;
        }
      } else if (item.type === "input_file" && item.file_data) {
        b64 = item.file_data;
      }
      if (!b64) continue;

      // Always compress with sips
      const compressed = sipsCompressB64(b64);
      if (compressed !== b64) {
        if (item.type === "input_image") {
          content[i] = { ...item, image_url: { url: `data:image/png;base64,${compressed}` } };
        } else {
          content[i] = { ...item, file_data: compressed };
        }
        console.error(`[OpenCodex] Compressed image ${(b64.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`);
      }

      images.push({ idx: i, b64: compressed, msgIdx });
    }
  }

  // Describe images for text-only models (vision bridge)
  if (images.length > 0 && config) {
    let described = 0;
    for (const { idx, b64, msgIdx } of images) {
      const desc = await describeImageB64(b64, config);
      if (desc) {
        inputData[msgIdx].content[idx] = {
          type: "input_text",
          text: `\n[截图描述: ${desc}]\n`,
        };
        described++;
      } else {
        inputData[msgIdx].content[idx] = {
          type: "input_text",
          text: `\n[截图描述: 无法识别的屏幕截图]\n`,
        };
        described++;
      }
    }
    if (described > 0) {
      console.error(`[OpenCodex-VisionBridge] Replaced ${described} screenshot(s) with descriptions.`);
    }
  }

  return body;
}
