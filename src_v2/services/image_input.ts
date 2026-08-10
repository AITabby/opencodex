import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Normalize the image form emitted by Codex Desktop's user-input protocol.
 *
 * Recent Desktop builds can represent a screenshot as a textual
 * `[Image: data:image/...;base64,...]` marker in `turn/start`, even though the
 * downstream Responses and Chat protocols expect a structured image part.
 * Keep the conversion at the gateway boundary so native GPT and every
 * third-party model receive the same semantic input.
 */

type ImageMode = "responses" | "turn" | "chat";

const IMAGE_PART_TYPES = new Set([
  "image",
  "localimage",
  "local_image",
  "input_image",
  "output_image",
  "image_url",
]);

const IMAGE_TOKEN = /\[\s*image\s*:\s*((?:data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+)|(?:https?:\/\/[^\]\s]+)|(?:file:\/\/[^\]\s]+)|(?:\/[^\]\s]+))\s*\]/gi;
const RAW_DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function imagePart(url: string, mode: ImageMode, detail?: unknown): Record<string, any> {
  const normalizedDetail = cleanString(detail);
  if (mode === "turn") {
    return {
      type: "image",
      url,
      ...(normalizedDetail ? { detail: normalizedDetail } : {}),
    };
  }
  if (mode === "chat") {
    return {
      type: "image_url",
      image_url: {
        url,
        ...(normalizedDetail ? { detail: normalizedDetail } : {}),
      },
    };
  }
  return {
    type: "input_image",
    image_url: url,
    ...(normalizedDetail ? { detail: normalizedDetail } : {}),
  };
}

function imageMimeType(filePath: string, explicitMimeType?: unknown): string {
  const explicit = cleanString(explicitMimeType).toLowerCase();
  if (explicit.startsWith("image/")) return explicit;
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".avif":
      return "image/avif";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".png":
    default:
      return "image/png";
  }
}

function localPathFromValue(value: unknown): string {
  const raw = cleanString(value);
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return "";
    }
  }
  return raw;
}

function localImageDataUrl(filePathValue: unknown, explicitMimeType?: unknown): string {
  const filePath = localPathFromValue(filePathValue);
  if (!filePath || !path.isAbsolute(filePath)) return "";
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length === 0) return "";
    return `data:${imageMimeType(filePath, explicitMimeType)};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

function turnImageUrl(record: Record<string, any>): string {
  const type = cleanString(record.type).toLowerCase();
  const rawImageUrl = record.image_url;
  const directUrl = typeof rawImageUrl === "string"
    ? rawImageUrl.trim()
    : cleanString(rawImageUrl?.url || record.url);
  if (directUrl.startsWith("file://") || path.isAbsolute(directUrl)) {
    return localImageDataUrl(directUrl, record.mimeType || record.mime_type);
  }
  if (directUrl) return directUrl;
  if (["localimage", "local_image", "image"].includes(type) || record.path || record.file_path || record.filePath) {
    return localImageDataUrl(
      record.path || record.file_path || record.filePath,
      record.mimeType || record.mime_type,
    );
  }
  const data = cleanString(record.data);
  const mimeType = cleanString(record.mimeType || record.mime_type);
  if (data && mimeType.startsWith("image/")) return `data:${mimeType};base64,${data}`;
  return "";
}

/**
 * Desktop can keep a dragged attachment as a local path in a normal
 * Responses/Chat request. That path is meaningful only inside this Mac; the
 * native GPT endpoint needs the original image bytes as a data URL. Convert
 * only local image references here, without resizing or recompressing them.
 */
function normalizeLocalImageReferences(value: unknown, depth = 0): any {
  if (depth > 20 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeLocalImageReferences(item, depth + 1));
  if (typeof value !== "object") return value;

  const record = value as Record<string, any>;
  const type = cleanString(record.type).toLowerCase();
  const isImage = IMAGE_PART_TYPES.has(type) || Object.prototype.hasOwnProperty.call(record, "image_url");
  if (isImage) {
    const url = turnImageUrl(record);
    if (url) {
      const next = { ...record };
      if (Object.prototype.hasOwnProperty.call(record, "image_url")) {
        next.image_url = record.image_url && typeof record.image_url === "object"
          ? { ...record.image_url, url }
          : url;
      } else if (Object.prototype.hasOwnProperty.call(record, "url")) {
        next.url = url;
      } else {
        next.url = url;
      }
      delete next.path;
      delete next.file_path;
      delete next.filePath;
      return next;
    }
  }

  const next: Record<string, any> = { ...record };
  for (const [key, child] of Object.entries(record)) {
    next[key] = normalizeLocalImageReferences(child, depth + 1);
  }
  return next;
}

function textPart(text: string, mode: ImageMode, original?: Record<string, any>): Record<string, any> {
  if (mode === "turn") {
    return {
      ...(original || {}),
      type: "text",
      text,
    };
  }
  return {
    ...(original || {}),
    type: mode === "chat" ? "text" : "input_text",
    text,
  };
}

function appendText(parts: Record<string, any>[], text: string, mode: ImageMode, original?: Record<string, any>): void {
  if (!text) return;
  parts.push(textPart(text, mode, original));
}

/**
 * Split a Desktop image marker into ordinary text and one or more structured
 * image parts. Returns null when the value contains no legacy image marker.
 */
export function splitLegacyImageText(value: string, mode: ImageMode, original?: Record<string, any>): Record<string, any>[] | null {
  const text = String(value || "");
  const matches: Array<{ start: number; end: number; url: string }> = [];
  IMAGE_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(IMAGE_TOKEN)) {
    const url = cleanString(match[1]);
    if (url && match.index !== undefined) matches.push({ start: match.index, end: match.index + match[0].length, url });
  }
  IMAGE_TOKEN.lastIndex = 0;

  // A few Desktop builds omit the surrounding `[Image: ...]` label when the
  // screenshot is the only attachment. Recognize the raw data URL too, but
  // never rewrite arbitrary ordinary text that does not contain image bytes.
  if (matches.length === 0) {
    RAW_DATA_URL.lastIndex = 0;
    for (const match of text.matchAll(RAW_DATA_URL)) {
      if (match.index !== undefined) matches.push({ start: match.index, end: match.index + match[0].length, url: match[0] });
    }
    RAW_DATA_URL.lastIndex = 0;
  }
  if (matches.length === 0) return null;

  const parts: Record<string, any>[] = [];
  let cursor = 0;
  for (const match of matches) {
    appendText(parts, text.slice(cursor, match.start), mode, original);
    parts.push(imagePart(match.url, mode));
    cursor = match.end;
  }
  appendText(parts, text.slice(cursor), mode, original);
  return parts;
}

function normalizeResponseContent(value: unknown): unknown {
  if (typeof value === "string") {
    const parts = splitLegacyImageText(value, "responses");
    return parts || value;
  }
  if (!Array.isArray(value)) {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, any>;
    const type = cleanString(record.type).toLowerCase();
    if (["input_text", "output_text", "text"].includes(type) && typeof record.text === "string") {
      const parts = splitLegacyImageText(record.text, "responses", record);
      return parts || record;
    }
    return record;
  }

  const output: any[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      const parts = splitLegacyImageText(part, "responses");
      if (parts) output.push(...parts);
      else output.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const record = part as Record<string, any>;
      const type = cleanString(record.type).toLowerCase();
      if (["input_text", "output_text", "text"].includes(type) && typeof record.text === "string") {
        const parts = splitLegacyImageText(record.text, "responses", record);
        if (parts) output.push(...parts);
        else output.push(record);
        continue;
      }
    }
    output.push(part);
  }
  return output;
}

function normalizeResponseItem(item: unknown): unknown {
  if (typeof item === "string") {
    const parts = splitLegacyImageText(item, "responses");
    return parts ? { type: "message", role: "user", content: parts } : item;
  }
  if (!item || typeof item !== "object") return item;
  const record = item as Record<string, any>;
  const type = cleanString(record.type).toLowerCase();
  if (type === "message" || record.role) {
    return { ...record, content: normalizeResponseContent(record.content) };
  }
  if (type === "function_call_output"
    || type === "mcp_call_output"
    || type === "custom_tool_call_output"
    || type === "computer_call_output") {
    return { ...record, output: normalizeResponseContent(record.output) };
  }
  if (type === "mcp_call" || type === "custom_tool_call" || type === "computer_call") {
    return record.output === undefined
      ? record
      : { ...record, output: normalizeResponseContent(record.output) };
  }
  return record;
}

/** Normalize legacy image markers in a Responses/Chat request body. */
export function normalizeLegacyImageRequestBody(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  if (Array.isArray(body.input)) next.input = normalizeLocalImageReferences(body.input.map(normalizeResponseItem));
  else if (typeof body.input === "string") {
    const parts = splitLegacyImageText(body.input, "responses");
    if (parts) next.input = normalizeLocalImageReferences([{ type: "message", role: "user", content: parts }]);
  }
  if (Array.isArray(body.messages)) {
    next.messages = normalizeLocalImageReferences(body.messages.map((message: any) => {
      if (!message || typeof message !== "object") return message;
      return { ...message, content: normalizeChatContent(message.content) };
    }));
  }
  return next;
}

function normalizeChatContent(value: unknown): unknown {
  if (typeof value === "string") {
    const parts = splitLegacyImageText(value, "chat");
    return parts || value;
  }
  if (!Array.isArray(value)) return value;
  const output: any[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      const parts = splitLegacyImageText(part, "chat");
      if (parts) output.push(...parts);
      else output.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const record = part as Record<string, any>;
      const type = cleanString(record.type).toLowerCase();
      if (["text", "input_text", "output_text"].includes(type) && typeof record.text === "string") {
        const parts = splitLegacyImageText(record.text, "chat", record);
        if (parts) output.push(...parts);
        else output.push(record);
        continue;
      }
    }
    output.push(part);
  }
  return output;
}

/** Normalize the native app-server `turn/start` input item shape. */
export function normalizeLegacyTurnInput(input: unknown): any[] {
  if (!Array.isArray(input)) return [];
  const output: any[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      const parts = splitLegacyImageText(item, "turn");
      if (parts) output.push(...parts);
      else if (item) output.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, any>;
    const type = cleanString(record.type).toLowerCase();
    if (["text", "input_text"].includes(type) && typeof record.text === "string") {
      const parts = splitLegacyImageText(record.text, "turn", record);
      if (parts) output.push(...parts);
      else output.push({ ...record, type: "text" });
      continue;
    }
    if (["image", "localimage", "local_image", "input_image", "image_url"].includes(type) || record.image_url !== undefined) {
      const url = turnImageUrl(record);
      if (url) {
        output.push({
          type: "image",
          url,
          ...(cleanString(record.detail) ? { detail: cleanString(record.detail) } : {}),
        });
        continue;
      }
    }
    output.push(record);
  }
  return output;
}
