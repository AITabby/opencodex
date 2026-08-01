/**
 * Native Anthropic Claude Messages API Adapter for CodexBridge (OpenCodex V2)
 * Converts Responses API input into Claude /v1/messages format (supporting thinking blocks & tool_use).
 */

import { ProtocolAdapter } from "./base.js";
import { ChatMessage, ChatCompletionRequestBody } from "../core/types.js";

function anthropicToolResultContent(content: any): any {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content || "");
  const blocks: any[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      if (part.text) blocks.push({ type: "text", text: String(part.text) });
      continue;
    }
    const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (imageUrl) {
      const dataMatch = String(imageUrl).match(/^data:([^;]+);base64,(.+)$/);
      blocks.push(dataMatch
        ? { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } }
        : { type: "image", source: { type: "url", url: imageUrl } });
    }
  }
  return blocks.length > 0 ? blocks : JSON.stringify(content);
}

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
          for (let index = 0; index < msg.tool_calls.length; index += 1) {
            const tc = msg.tool_calls[index];
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
            contentParts.push({
              type: "tool_use",
              // Anthropic rejects the entire request when one historical
              // tool_use has no id. Session repair normally supplies this;
              // keep a deterministic boundary fallback here as a final guard.
              id: String(tc.id || `toolu_opencodex_${index}`).trim() || `toolu_opencodex_${index}`,
              name: tc.function.name,
              input: args,
            });
          }
        }
        claudeMessages.push({ role: "assistant", content: contentParts.length > 0 ? contentParts : "" });
      } else if (msg.role === "tool") {
        const toolUseId = String(msg.tool_call_id || "").trim();
        if (!toolUseId) continue;
        claudeMessages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseId,
            content: anthropicToolResultContent(msg.content),
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
