/**
 * Native Google Gemini API Adapter for CodexBridge (OpenCodex V2)
 */

import { ProtocolAdapter } from "./base.js";
import { ChatMessage, ChatCompletionRequestBody } from "../core/types.js";

function sanitizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return { type: "STRING" };
  }

  const result: any = {};

  if (Array.isArray(schema.type)) {
    const firstType = schema.type.find((t: any) => typeof t === "string" && t !== "null") || "string";
    result.type = String(firstType).toUpperCase();
  } else if (typeof schema.type === "string") {
    result.type = schema.type.toUpperCase();
  } else if (schema.properties) {
    result.type = "OBJECT";
  } else if (schema.items) {
    result.type = "ARRAY";
  } else {
    result.type = "STRING";
  }

  if (["NULL", "UNDEFINED"].includes(result.type)) {
    result.type = "STRING";
  }

  if (typeof schema.description === "string") {
    result.description = schema.description;
  }

  if (Array.isArray(schema.enum)) {
    result.enum = schema.enum.map((e: any) => String(e));
  }

  if (schema.properties && typeof schema.properties === "object") {
    result.properties = {};
    for (const [key, propVal] of Object.entries(schema.properties)) {
      result.properties[key] = sanitizeGeminiSchema(propVal);
    }
  }

  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((r: any) => typeof r === "string");
  }

  if (schema.items) {
    result.items = sanitizeGeminiSchema(schema.items);
  }

  return result;
}

function appendGeminiContentParts(parts: any[], content: any): void {
  if (typeof content === "string") {
    if (content) parts.push({ text: content });
    return;
  }
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) parts.push({ text: JSON.stringify(content) });
    return;
  }
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      if (part.text) parts.push({ text: String(part.text) });
      continue;
    }
    const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const dataMatch = String(imageUrl || "").match(/^data:([^;]+);base64,(.+)$/);
    if (dataMatch) parts.push({ inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } });
  }
}

function toolCallThoughtSignature(toolCall: any): string {
  const value = toolCall?.thought_signature || toolCall?.thoughtSignature || toolCall?.signature;
  return typeof value === "string" ? value.trim() : "";
}

function appendLegacyToolImages(parts: any[], content: any): void {
  if (!Array.isArray(content)) return;
  // A signatureless historical function call cannot be sent back to Gemini
  // as a functionCall/functionResponse pair. Keep only the visual state from
  // its result; textual tool transcripts are internal protocol data and must
  // not become model-visible user text that can be echoed to Codex.
  appendGeminiContentParts(parts, content.filter((part: any) => {
    if (!part || typeof part !== "object") return false;
    return part.type === "image_url" || part.type === "input_image" || part.type === "output_image";
  }));
}

export class GoogleGeminiAdapter implements ProtocolAdapter {
  public name = "google";

  public sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages;
  }

  public transformPayload(chatBody: ChatCompletionRequestBody): {
    urlEndpoint: string;
    headers: Record<string, string>;
    body: any;
  } {
    const rawContents: any[] = [];
    let systemInstruction: any = undefined;
    const toolNames = new Map<string, string>();
    const signaturelessToolCallIds = new Set<string>();
    for (const message of chatBody.messages) {
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!toolCallThoughtSignature(toolCall) && toolCall?.id) {
          signaturelessToolCallIds.add(String(toolCall.id));
        }
      }
    }

    for (const msg of chatBody.messages) {
      if (msg.role === "system") {
        systemInstruction = {
          parts: [{ text: typeof msg.content === "string" ? msg.content : "" }]
        };
        continue;
      }

      const role = msg.role === "assistant" ? "model" : "user";
      const parts: any[] = [];

      if (msg.role !== "tool") appendGeminiContentParts(parts, msg.content);

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          const sig = toolCallThoughtSignature(tc);
          if (!sig) {
            // A previous native Responses rollout may not have persisted the
            // provider-owned signature. Never invent one: Gemini rejects a
            // signatureless functionCall. Omit the stale call from provider
            // history instead of turning internal tool data into plain text.
            if (tc.id && tc.function?.name) toolNames.set(String(tc.id), String(tc.function.name));
            continue;
          }
          const partObj: any = {
            functionCall: {
              name: tc.function.name,
              args,
            }
          };
          if (sig) {
            partObj.thoughtSignature = sig;
            partObj.thought_signature = sig;
          }
          if (tc.id && tc.function?.name) toolNames.set(String(tc.id), String(tc.function.name));
          parts.push(partObj);
        }
      }

      if (msg.role === "tool") {
        const responseName = String(msg.name || toolNames.get(String(msg.tool_call_id || "")) || "exec_command").trim();
        if (msg.tool_call_id && signaturelessToolCallIds.has(String(msg.tool_call_id))) {
          // The matching call was omitted above because its Gemini thought
          // signature is unrecoverable. A functionResponse without that call
          // is also invalid, so preserve only screenshots and omit the
          // textual result from the provider transcript.
          appendLegacyToolImages(parts, msg.content);
        } else {
          parts.push({
            functionResponse: {
              name: responseName,
              response: { output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "") }
            }
          });
        }
        // A local Computer Use result carries the screenshot beside the
        // function response so Gemini can inspect the updated desktop.
        if (Array.isArray(msg.content)) appendGeminiContentParts(parts, msg.content.filter((part: any) => part?.type !== "text"));
      }

      if (parts.length > 0) {
        rawContents.push({ role, parts });
      }
    }

    const mergedContents: any[] = [];
    for (const item of rawContents) {
      if (!item.parts || item.parts.length === 0) continue;
      if (mergedContents.length > 0 && mergedContents[mergedContents.length - 1].role === item.role) {
        mergedContents[mergedContents.length - 1].parts.push(...item.parts);
      } else {
        mergedContents.push({ role: item.role, parts: [...item.parts] });
      }
    }

    if (mergedContents.length > 0 && mergedContents[0].role === "model") {
      mergedContents.unshift({ role: "user", parts: [{ text: "Hello" }] });
    }

    // Gemini's native endpoint rejects a request whose final turn is `model`.
    // A trailing model turn here is an orphaned historical continuation: its
    // tool result was not present, so sending invented user text would make
    // the provider re-plan the same desktop action indefinitely. Drop only
    // trailing model turns and let the current user/tool turn drive the next
    // request.
    if (mergedContents.length > 0 && mergedContents[mergedContents.length - 1].role === "model") {
      while (mergedContents.length > 0 && mergedContents[mergedContents.length - 1].role === "model") {
        mergedContents.pop();
      }
    }

    const functionDeclarations = (chatBody.tools || []).map((t: any) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || "",
        parameters: sanitizeGeminiSchema(fn.parameters || { type: "object", properties: {} }),
      };
    });

    const geminiBody: any = {
      contents: mergedContents,
      generationConfig: {
        temperature: chatBody.temperature ?? 0.7,
        maxOutputTokens: chatBody.max_tokens ?? 4096,
      }
    };

    if (systemInstruction) geminiBody.systemInstruction = systemInstruction;
    if (functionDeclarations.length > 0) {
      geminiBody.tools = [{ functionDeclarations }];
    }

    return {
      urlEndpoint: `:streamGenerateContent?alt=sse`,
      headers: { "Content-Type": "application/json" },
      body: geminiBody,
    };
  }

  public processStreamChunk(eventData: any): any[] {
    if (!eventData || typeof eventData !== "object") return [];
    const chunks: any[] = [];
    const candidate = (eventData.response?.candidates || eventData.candidates || [])[0];
    if (!candidate || !candidate.content) return chunks;

    const parts = candidate.content.parts || [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.text) {
        chunks.push({
          choices: [{
            delta: { content: part.text }
          }]
        });
      }
      if (part.functionCall) {
        const sig = part.thoughtSignature || part.thought_signature || candidate.content?.thoughtSignature || candidate.content?.thought_signature;
        let argumentSize = 0;
        try {
          argumentSize = JSON.stringify(part.functionCall.args || {}).length;
        } catch {
          argumentSize = 0;
        }
        console.info(
          `[CodexSplit Gemini] functionCall name=${String(part.functionCall.name || "").trim() || "(empty)"} ` +
          `args_chars=${argumentSize} thought_signature=${Boolean(sig)}`,
        );
        const toolCallObj: any = {
          index: i,
          id: `call_gemini_${Date.now()}_${i}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        };
        if (sig) {
          toolCallObj.thought_signature = sig;
          toolCallObj.thoughtSignature = sig;
        }
        chunks.push({
          choices: [{
            delta: {
              tool_calls: [toolCallObj]
            }
          }]
        });
      }
    }
    return chunks;
  }
}
