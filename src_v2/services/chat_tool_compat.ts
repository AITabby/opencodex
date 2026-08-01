/**
 * Compatibility helpers for Chat providers that reject multimodal tool
 * results. The native Responses path must keep the original content intact;
 * these helpers are only used after a legacy Chat request is rejected.
 */

function partText(part: any): string {
  if (typeof part === "string") return part;
  if (part && typeof part === "object" && typeof part.text === "string") return part.text;
  return "";
}

function isImagePart(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  return part.type === "image_url"
    || part.type === "input_image"
    || part.type === "output_image"
    || part.image_url !== undefined
    || (typeof part.data === "string" && typeof part.mimeType === "string");
}

function toolMessageHasImage(message: any): boolean {
  return message?.role === "tool"
    && Array.isArray(message.content)
    && message.content.some((part: any) => isImagePart(part));
}

function hasTextPart(content: any): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return Boolean(content && typeof content.text === "string" && content.text.trim());
  return content.some((part: any) => {
    if (typeof part === "string") return part.trim().length > 0;
    return part && typeof part === "object" && typeof part.text === "string" && part.text.trim().length > 0;
  });
}

function hasChatToolCalls(payload: any): boolean {
  return Array.isArray(payload?.messages)
    && payload.messages.some((message: any) => message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
}

export function hasChatToolImages(payload: any): boolean {
  return Array.isArray(payload?.messages)
    && payload.messages.some((message: any) => toolMessageHasImage(message));
}

function toolContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join("\n");
  return partText(content) || (content == null ? "" : String(content));
}

/**
 * Convert only image-bearing tool messages to the plain string shape expected
 * by older Chat gateways. The input is shallow-cloned so the Responses
 * history and the original request remain untouched.
 */
export function stripChatToolImages(payload: any): any {
  if (!hasChatToolImages(payload)) return payload;

  return {
    ...payload,
    messages: payload.messages.map((message: any) => {
      if (!toolMessageHasImage(message)) return message;
      return {
        ...message,
        content: toolContentToText(message.content)
          || "Computer Use screenshot omitted because this Chat endpoint does not accept image tool results.",
      };
    }),
  };
}

/**
 * MiMo's OpenAI-compatible validator requires a non-empty text field on an
 * assistant tool-call message and on multimodal tool results. OpenAI accepts
 * an empty assistant content string here, so this normalization must remain
 * opt-in for the MiMo route instead of changing every Chat provider.
 */
export function normalizeXiaomiChatToolHistory(payload: any): any {
  if (!Array.isArray(payload?.messages)) return payload;

  return {
    ...payload,
    messages: payload.messages.map((message: any) => {
      if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const content = message.content;
        if (content === undefined || content === null || (typeof content === "string" && content.trim().length === 0)) {
          return { ...message, content: " " };
        }
        if (Array.isArray(content) && !hasTextPart(content)) {
          return { ...message, content: [{ type: "text", text: " " }, ...content] };
        }
      }

      if (message?.role === "tool" && Array.isArray(message.content) && !hasTextPart(message.content)) {
        return { ...message, content: [{ type: "text", text: " " }, ...message.content] };
      }

      return message;
    }),
  };
}

/**
 * Detect the provider-specific validation response seen when a MiMo Chat
 * continuation contains an empty tool-history text field. This is deliberately
 * based on the upstream error and payload shape, not a global MiniMax/tool
 * fallback.
 */
export function isXiaomiChatToolTextRejection(status: number, body: string, payload: any): boolean {
  return status === 400
    && /Xiaomi/i.test(body)
    && (/text\s*['`\"]?\s*is\s*not\s*set/i.test(body) || /Param Incorrect/i.test(body))
    && (hasChatToolImages(payload) || hasChatToolCalls(payload));
}

/** Identify the OpenCode/Xiaomi MiMo Chat route without affecting MiniMax. */
export function isXiaomiMimoProvider(providerName: string, providerUrl: string, model: string): boolean {
  const identity = `${providerName} ${providerUrl} ${model}`.toLowerCase();
  return /xiaomi|xiaomimimo|mimo\.mi|mimo-v\d|mimo_/.test(identity);
}

/**
 * Console Go currently surfaces this provider-side validation failure as a
 * generic 400. Retry once without tool images; do not mask unrelated 400s.
 */
export function isConsoleGoToolImageRejection(status: number, body: string, payload: any): boolean {
  return status === 400
    && /Console Go/i.test(body)
    && /Upstream request failed/i.test(body)
    && hasChatToolImages(payload);
}
