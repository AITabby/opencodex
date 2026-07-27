/**
 * Session History Reconstruction & Repair Service for CodexBridge (OpenCodex V2)
 * Reads past turns from ~/.codex/sessions to repair multi-turn tool call history
 * when Codex Desktop omits previous_response_id or sends incremental turns.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ChatMessage } from "../core/types.js";

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
          const text = typeof item.content === "string"
            ? item.content
            : Array.isArray(item.content)
              ? item.content.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("")
              : "";
          if (text.trim()) {
            reconstructed.push({ role: role as any, content: text });
          }
        } else if (item.type === "function_call") {
          const callId = item.call_id || item.id || `call_${Date.now()}`;
          const argsStr = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
          reconstructed.push({
            role: "assistant",
            content: "",
            tool_calls: [{
              id: callId,
              type: "function",
              function: { name: item.name || "", arguments: argsStr }
            }]
          });
        } else if (item.type === "function_call_output") {
          reconstructed.push({
            role: "tool",
            tool_call_id: item.call_id,
            content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || "")
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

    for (const msg of combined) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) activeToolCallIds.add(tc.id);
        }
        repaired.push(msg);
      } else if (msg.role === "tool") {
        if (msg.tool_call_id && activeToolCallIds.has(msg.tool_call_id)) {
          repaired.push(msg);
          activeToolCallIds.delete(msg.tool_call_id);
        } else {
          // Drop orphan tool output without matching assistant tool_call
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
