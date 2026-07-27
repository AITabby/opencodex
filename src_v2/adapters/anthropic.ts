/**
 * Native Anthropic Claude Messages API Adapter for CodexBridge (OpenCodex V2)
 * Converts Responses API input into Claude /v1/messages format (supporting thinking blocks & tool_use).
 */

import { ProtocolAdapter } from "./base.js";
import { ChatMessage, ChatCompletionRequestBody } from "../core/types.js";

export class AnthropicAdapter implements ProtocolAdapter {
  public name = "anthropic";

  public sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages;
  }

  public transformPayload(chatBody: ChatCompletionRequestBody): {
    urlEndpoint: string;
    headers: Record<string, string>;
    body: any;
  } {
    let systemPrompt = "";
    const claudeMessages: any[] = [];

    for (const msg of chatBody.messages) {
      if (msg.role === "system") {
        systemPrompt = typeof msg.content === "string" ? msg.content : "";
        continue;
      }

      if (msg.role === "user") {
        claudeMessages.push({
          role: "user",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || ""),
        });
      } else if (msg.role === "assistant") {
        const contentParts: any[] = [];
        if (msg.content) {
          contentParts.push({ type: "text", text: String(msg.content) });
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
            contentParts.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: args,
            });
          }
        }
        claudeMessages.push({ role: "assistant", content: contentParts.length > 0 ? contentParts : "" });
      } else if (msg.role === "tool") {
        claudeMessages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || ""),
          }]
        });
      }
    }

    const tools: any[] = (chatBody.tools || []).map((t: any) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || "",
        input_schema: fn.parameters || { type: "object", properties: {} },
      };
    });

    const anthropicBody: any = {
      model: chatBody.model,
      messages: claudeMessages,
      max_tokens: chatBody.max_tokens || 4096,
      stream: chatBody.stream ?? true,
    };

    if (systemPrompt) anthropicBody.system = systemPrompt;
    if (tools.length > 0) anthropicBody.tools = tools;

    return {
      urlEndpoint: "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: anthropicBody,
    };
  }

  public processStreamChunk(eventData: any): any[] {
    if (!eventData || typeof eventData !== "object") return [];
    const chunks: any[] = [];
    const type = eventData.type;

    if (type === "content_block_start") {
      const block = eventData.content_block || {};
      if (block.type === "tool_use") {
        chunks.push({
          choices: [{
            delta: {
              tool_calls: [{
                index: eventData.index || 0,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" }
              }]
            }
          }]
        });
      } else if (block.type === "thinking") {
        chunks.push({
          choices: [{
            delta: { reasoning_content: block.thinking || "" }
          }]
        });
      }
    } else if (type === "content_block_delta") {
      const delta = eventData.delta || {};
      if (delta.type === "text_delta") {
        chunks.push({
          choices: [{
            delta: { content: delta.text || "" }
          }]
        });
      } else if (delta.type === "input_json_delta") {
        chunks.push({
          choices: [{
            delta: {
              tool_calls: [{
                index: eventData.index || 0,
                function: { arguments: delta.partial_json || "" }
              }]
            }
          }]
        });
      } else if (delta.type === "thinking_delta") {
        chunks.push({
          choices: [{
            delta: { reasoning_content: delta.thinking || "" }
          }]
        });
      }
    }
    return chunks;
  }
}

