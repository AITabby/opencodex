/**
 * Native Google Gemini API Adapter for CodexBridge (OpenCodex V2)
 */

import { ProtocolAdapter } from "./base.js";
import { ChatMessage, ChatCompletionRequestBody } from "../core/types.js";

const DEFAULT_THOUGHT_SIGNATURE = "EocDCoQDARFNMg/wQatFS7RFDS/KgCjQ6PF5Ftu7blOIEB1GIMFDxWS15lf54PftREjCt22MZCJUvG8TJlo7t2Zxd7PI6ZaJUykSf/mgzo++cO8oirHVi7QETe5HrdvR9Y7aH09xNADrqwtADWS/Jr/JRKNWGEFlbBf0hRhp/U/WzJQsek8Dg/wHPeWV7VEESUz9SRVTVkN4NuPAmhtQvW5ekCQjrcQagIaYhd/dFIrz5We5WZYXlLefPT4FHI/5AP7dwWhv8ZK8uYwdJ1twAzsjF7HgVc5mJhtlTjY2blQb7jkfnw5oAKX7Stl6JuZNMQ0yiB3RrpLCcIxb377FjKpeKxob37SHwzfr1qFQsaVJe1m2SySbQqmoYzDRx956QPT0dgoztsSPrrqSFutXGOcGkEc9xj198GPhn5R2JfiGBb6rjGVgFjGlr9dhzZOWSrNzwlkpKJTSA5OcXDmsJMRfWRMhovJMaYTITR2UwEzNc75nKHL/Xh/Rsh4/+IRQSagYbV1luM8yYA==";

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
          const partObj: any = {
            functionCall: {
              name: tc.function.name,
              args,
            }
          };
          const sig = (tc as any).thought_signature || (tc as any).thoughtSignature || (tc as any).signature || DEFAULT_THOUGHT_SIGNATURE;
          partObj.thoughtSignature = sig;
          partObj.thought_signature = sig;
          parts.push(partObj);
        }
      }

      if (msg.role === "tool") {
        parts.push({
          functionResponse: {
            name: msg.name || "exec_command",
            response: { output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "") }
          }
        });
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
