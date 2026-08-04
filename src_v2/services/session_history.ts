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
      if (part) parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    const rawImageUrl = part.image_url;
    const imageUrl = typeof rawImageUrl === "string"
      ? rawImageUrl
      : typeof rawImageUrl?.url === "string"
        ? rawImageUrl.url
        : typeof part.data === "string" && typeof part.mimeType === "string"
          ? `data:${part.mimeType};base64,${part.data}`
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
  if (parts.length === 0) return JSON.stringify(content || "");
  return parts.some((part) => part?.type === "image_url")
    ? parts
    : parts.map((part) => String(part.text || "")).join("");
}

export class SessionHistoryService {
  private static sessionsDir = path.join(os.homedir(), ".codex", "sessions");

  /**
   * Find session JSON file by sessionId or client_metadata
   */
  private static findSessionFilePath(sessionId?: string): string | null {
    if (!sessionId) return null;
    try {
      if (!fs.existsSync(SessionHistoryService.sessionsDir)) return null;

      // Direct file match
      const directPath = path.join(SessionHistoryService.sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(directPath)) return directPath;

      // Subdirectory recursive search
      const files = fs.readdirSync(SessionHistoryService.sessionsDir, { recursive: true });
      for (const f of files) {
        if (typeof f === "string" && f.endsWith(".json") && f.includes(sessionId)) {
          const fullPath = path.join(SessionHistoryService.sessionsDir, f);
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
      const data = JSON.parse(raw);
      const items = data.items || data.messages || data.input || [];
      if (!Array.isArray(items)) return [];

      const reconstructed: ChatMessage[] = [];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        if (item.type === "message" || item.role) {
          let role = item.role || "user";
          if (role === "developer") role = "system";
          const content = responseContentToChatContent(item.content);
          if (typeof content === "string" ? content.trim() : content.length > 0) {
            reconstructed.push({ role: role as any, content });
          }
        } else if (item.type === "function_call" || item.type === "mcp_call") {
          const callId = String(item.call_id || item.id || `call_repair_${reconstructed.length}`).trim();
          const argsStr = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
          reconstructed.push({
            role: "assistant",
            content: "",
            tool_calls: [{
              id: callId || `call_repair_${reconstructed.length}`,
              type: "function",
              function: { name: flattenResponseFunctionCallName(item), arguments: argsStr }
            }]
          });
          if (item.type === "mcp_call" && item.output !== undefined) {
            reconstructed.push({
              role: "tool",
              tool_call_id: callId || `call_repair_${reconstructed.length}`,
              content: responseContentToChatContent(item.output),
            });
          }
        } else if (item.type === "function_call_output") {
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
    let combined = currentMessages;

    if (pastMessages.length > 0) {
      const firstCurrentUserMsg = currentMessages.find(m => m.role === "user");
      if (!firstCurrentUserMsg) {
        combined = [...pastMessages, ...currentMessages];
      } else {
        const hasOverlap = pastMessages.some(m => m.role === "user" && m.content === firstCurrentUserMsg.content);
        if (!hasOverlap) {
          combined = [...pastMessages, ...currentMessages];
        }
      }
    }

    // Repair tool_calls & tool role alignment for upstream providers (Claude, Gemini, etc.)
    const repaired: ChatMessage[] = [];
    const activeToolCallIds = new Set<string>();

    let generatedToolId = 0;
    for (const msg of combined) {
      if (msg.role === "assistant" && msg.tool_calls) {
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
        repaired.push(msg);
      }
    }

    // If assistant ended with unfulfilled tool_calls, inject dummy tool responses to prevent 400 error
    for (const id of activeToolCallIds) {
      repaired.push({
        role: "tool",
        tool_call_id: id,
        content: "Tool execution completed.",
      });
    }

    return repaired;
  }
}
