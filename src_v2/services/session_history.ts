/**
 * Session History Reconstruction & Repair Service for CodexBridge (OpenCodex V2)
 * Reads past turns from ~/.codex/sessions to repair multi-turn tool call history
 * when Codex Desktop omits previous_response_id or sends incremental turns.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ChatMessage } from "../core/types.js";

function flattenResponseFunctionCallName(item: any): string {
  if (item?.type === "computer_call") return "mcp__node_repl_js";
  if (item?.type === "mcp_call") {
    const serverLabel = String(item?.server_label || "").trim();
    const toolName = String(item?.name || "").trim();
    if (serverLabel === "node_repl" && toolName === "js") return "mcp__node_repl_js";
    if (serverLabel && toolName) return `mcp__${serverLabel}__${toolName}`;
  }
  const name = String(item?.name || "").trim();
  const namespace = String(item?.namespace || "").trim();
  if (!namespace || name === namespace || name.startsWith(`${namespace}_`) || name.startsWith(`${namespace}__`)) {
    return name;
  }
  return namespace.endsWith("__") ? `${namespace}${name}` : `${namespace}_${name}`;
}

function responseContentToChatContent(content: any): string | any[] {
  if (typeof content === "string") return content;
  const sourceParts = Array.isArray(content) ? content : [content];
  const parts: any[] = [];
  for (const part of sourceParts) {
    if (typeof part === "string") {
      if (part.trim()) parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      if (part.text.trim()) parts.push({ type: "text", text: part.text });
      continue;
    }
    const rawImageUrl = part.image_url;
    const imageUrl = typeof rawImageUrl === "string"
      ? rawImageUrl
      : typeof rawImageUrl?.url === "string"
        ? rawImageUrl.url
        : typeof part.data === "string" && typeof part.mimeType === "string"
          ? `data:${part.mimeType};base64,${part.data}`
          : typeof part.url === "string"
            ? part.url
            : typeof part.screenshot === "string"
              ? part.screenshot
              : typeof part.data === "string" && typeof part.mime_type === "string"
                ? `data:${part.mime_type};base64,${part.data}`
          : "";
    if (imageUrl) {
      const detail = typeof part.detail === "string"
        ? part.detail
        : typeof rawImageUrl?.detail === "string"
          ? rawImageUrl.detail
          : undefined;
      parts.push({ type: "image_url", image_url: { url: imageUrl, ...(detail ? { detail } : {}) } });
    }
  }
  if (parts.length === 0) {
    // An empty Responses content array is not a user message. Serializing it
    // to "[]" used to create a fake visible turn and made the next provider
    // request look as if its previous message were empty.
    if (content === null || content === undefined || Array.isArray(content)) return "";
    if (typeof content === "object") {
      const serialized = JSON.stringify(content);
      return serialized === "{}" ? "" : serialized;
    }
    return String(content || "");
  }
  return parts.some((part) => part?.type === "image_url")
    ? parts
    : parts.map((part) => String(part.text || "")).join("");
}

function hasUsableChatContent(content: any): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return Boolean(content);
  return content.some((part) => {
    if (typeof part === "string") return part.trim().length > 0;
    if (!part || typeof part !== "object") return false;
    if (typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "image_url"
      || part.type === "input_image"
      || part.type === "output_image"
      || part.image_url !== undefined
      || part.file_id !== undefined;
  });
}

function reasoningContentFromItem(item: any): string {
  const passthrough = item?.internal_chat_message_metadata_passthrough;
  return typeof item?.reasoning_content === "string"
    ? item.reasoning_content
    : typeof item?.reasoningContent === "string"
      ? item.reasoningContent
      : typeof passthrough?.reasoning_content === "string"
        ? passthrough.reasoning_content
        : typeof passthrough?.reasoningContent === "string"
          ? passthrough.reasoningContent
          : "";
}

function sessionItemsFromFile(raw: string, sessionFile: string): any[] {
  if (sessionFile.toLowerCase().endsWith(".jsonl")) {
    const items: any[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type !== "response_item") continue;
        const item = record?.payload?.item || record?.item || record?.payload;
        if (item && typeof item === "object") items.push(item);
      } catch {
        // Codex appends JSONL records while a turn is running. Ignore only
        // the incomplete line; the complete records before it remain valid.
      }
    }
    return items;
  }

  try {
    const data = JSON.parse(raw);
    const items = data?.items || data?.messages || data?.input || data;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function messageFingerprint(message: ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content ?? "",
    tool_call_id: message.tool_call_id || "",
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      }))
      : [],
  });
}

function messagesMatch(left: ChatMessage, right: ChatMessage): boolean {
  return messageFingerprint(left) === messageFingerprint(right);
}

function mergePastAndCurrentMessages(pastMessages: ChatMessage[], currentMessages: ChatMessage[]): ChatMessage[] {
  if (pastMessages.length === 0) return currentMessages;
  if (currentMessages.length === 0) return pastMessages;

  // A native app-server revision may send either the full transcript or only
  // the newest delta. Keep the fuller side when one sequence is a prefix of
  // the other, then use the largest suffix/prefix overlap for continuations.
  if (pastMessages.length <= currentMessages.length
    && pastMessages.every((message, index) => messagesMatch(message, currentMessages[index]))) {
    return currentMessages;
  }
  if (currentMessages.length <= pastMessages.length
    && currentMessages.every((message, index) => messagesMatch(message, pastMessages[index]))) {
    return pastMessages;
  }

  const maxOverlap = Math.min(pastMessages.length, currentMessages.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const pastStart = pastMessages.length - overlap;
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (!messagesMatch(pastMessages[pastStart + index], currentMessages[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return [...pastMessages, ...currentMessages.slice(overlap)];
  }

  return [...pastMessages, ...currentMessages];
}

export class SessionHistoryService {
  private static get codexHome(): string {
    return String(process.env.OPENCODEX_CODEX_HOME || process.env.CODEX_HOME || "").trim()
      || path.join(os.homedir(), ".codex");
  }

  private static get sessionsDir(): string {
    return path.join(SessionHistoryService.codexHome, "sessions");
  }

  /**
   * Find session JSON file by sessionId or client_metadata
   */
  private static findSessionFilePath(sessionId?: string): string | null {
    if (!sessionId) return null;
    try {
      const roots = [
        SessionHistoryService.sessionsDir,
        path.join(SessionHistoryService.codexHome, "archived_sessions"),
      ];
      for (const root of roots) {
        if (!fs.existsSync(root)) continue;

        // Direct file match, including the actual Codex JSONL naming scheme.
        for (const extension of [".jsonl", ".json"]) {
          const directPath = path.join(root, `${sessionId}${extension}`);
          if (fs.existsSync(directPath)) return directPath;
        }

        // Native rollouts are normally nested as YYYY/MM/DD/rollout-*.jsonl.
        const files = fs.readdirSync(root, { recursive: true });
        for (const f of files) {
          if (typeof f !== "string" || !/(?:\.jsonl|\.json)$/i.test(f) || !f.includes(sessionId)) continue;
          const fullPath = path.join(root, f);
          if (fs.existsSync(fullPath)) return fullPath;
        }
      }
    } catch {
      // Ignore disk errors
    }
    return null;
  }

  /**
   * Reconstruct past messages array from disk session history
   */
  public static reconstructPastMessages(sessionId?: string): ChatMessage[] {
    const sessionFile = SessionHistoryService.findSessionFilePath(sessionId);
    if (!sessionFile) return [];

    try {
      const raw = fs.readFileSync(sessionFile, "utf-8");
      const items = sessionItemsFromFile(raw, sessionFile);

      const reconstructed: ChatMessage[] = [];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        if (item.type === "message" || item.role) {
          let role = item.role || "user";
          if (role === "developer") role = "system";
          const content = responseContentToChatContent(item.content);
          const reasoningContent = reasoningContentFromItem(item);
          if (hasUsableChatContent(content) || (Array.isArray(item.tool_calls) && item.tool_calls.length > 0)) {
            reconstructed.push({
              role: role as any,
              content,
              ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            });
          }
        } else if (item.type === "function_call" || item.type === "mcp_call" || item.type === "custom_tool_call" || item.type === "computer_call") {
          const callId = String(item.call_id || item.id || `call_repair_${reconstructed.length}`).trim();
          const rawArguments = item.arguments ?? item.input ?? item.action;
          const argsStr = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments || {});
          reconstructed.push({
            role: "assistant",
            content: "",
            tool_calls: [{
              id: callId || `call_repair_${reconstructed.length}`,
              type: "function",
              function: { name: flattenResponseFunctionCallName(item), arguments: argsStr }
            }]
          });
          if ((item.type === "mcp_call" || item.type === "custom_tool_call" || item.type === "computer_call") && item.output !== undefined) {
            reconstructed.push({
              role: "tool",
              tool_call_id: callId || `call_repair_${reconstructed.length}`,
              content: responseContentToChatContent(item.output),
            });
          }
        } else if (item.type === "function_call_output"
          || item.type === "custom_tool_call_output"
          || item.type === "computer_call_output") {
          reconstructed.push({
            role: "tool",
            tool_call_id: typeof item.call_id === "string" ? item.call_id.trim() : item.call_id,
            content: responseContentToChatContent(item.output),
          });
        } else if (item.type === "mcp_call_output") {
          reconstructed.push({
            role: "tool",
            tool_call_id: typeof item.call_id === "string" ? item.call_id.trim() : item.call_id,
            content: responseContentToChatContent(item.output),
          });
        }
      }

      return reconstructed;
    } catch {
      return [];
    }
  }

  /**
   * Repair orphan tool calls and merge session history
   */
  public static repairAndMergeHistory(currentMessages: ChatMessage[], sessionId?: string): ChatMessage[] {
    const pastMessages = SessionHistoryService.reconstructPastMessages(sessionId);
    const combined = mergePastAndCurrentMessages(pastMessages, currentMessages);

    // Repair tool_calls & tool role alignment for upstream providers (Claude, Gemini, etc.)
    const repaired: ChatMessage[] = [];
    const activeToolCallIds = new Set<string>();

    let generatedToolId = 0;
    const flushOrphanToolCalls = (): void => {
      // Chat providers require every assistant tool call to be followed
      // immediately by a tool message. A failed desktop/vision turn can leave
      // the next user message in the local transcript without that result;
      // appending the repair at the end is too late and causes the provider
      // to reject every later ordinary text message.
      for (const id of activeToolCallIds) {
        repaired.push({
          role: "tool",
          tool_call_id: id,
          content: "Tool execution failed or was cancelled; continue without this tool result.",
        });
      }
      activeToolCallIds.clear();
    };

    for (const msg of combined) {
      if (msg.role === "assistant" && msg.tool_calls) {
        if (activeToolCallIds.size > 0) flushOrphanToolCalls();
        const toolCalls = msg.tool_calls.map((tc) => {
          const existingId = typeof tc.id === "string" ? tc.id.trim() : "";
          const id = existingId || `call_repair_${generatedToolId++}`;
          if (id) activeToolCallIds.add(id);
          return { ...tc, id };
        });
        repaired.push({ ...msg, tool_calls: toolCalls });
      } else if (msg.role === "tool") {
        const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id.trim() : "";
        if (toolCallId && activeToolCallIds.has(toolCallId)) {
          repaired.push({ ...msg, tool_call_id: toolCallId });
          activeToolCallIds.delete(toolCallId);
        } else {
          if (activeToolCallIds.size > 0) flushOrphanToolCalls();
          // Codex may send only function_call_output on a continuation when
          // the previous response is referenced by id. If the local session
          // cache has not persisted the preceding function_call yet, dropping
          // this result leaves the provider with no new task and the second
          // round appears to hang. Preserve it as a user-visible continuation
          // message instead of inventing a fake tool name/id pair.
          const content = typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content ?? "");
          if (content.trim()) {
            repaired.push({
              role: "user",
              content: `上一轮工具执行结果（${toolCallId || "未知工具"}）：\n${content}`,
            });
          }
        }
      } else {
        if (activeToolCallIds.size > 0) flushOrphanToolCalls();
        repaired.push(msg);
      }
    }

    // If the transcript ended with unfulfilled tool_calls, repair them in
    // place (at the end is correct only when the assistant call is last).
    flushOrphanToolCalls();

    return repaired;
  }
}
