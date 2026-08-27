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

function inlineImageDataUrl(record: Record<string, any>): string {
  const rawImageUrl = record.image_url;
  if (typeof rawImageUrl === "string") return rawImageUrl.trim();
  if (rawImageUrl && typeof rawImageUrl === "object" && typeof rawImageUrl.url === "string") {
    return rawImageUrl.url.trim();
  }
  if (typeof record.url === "string") return record.url.trim();
  const data = cleanString(record.data);
  const mimeType = cleanString(record.mimeType || record.mime_type);
  return data && mimeType.startsWith("image/") ? `data:${mimeType};base64,${data}` : "";
}

function decodedBase64(value: string): { mimeType: string; bytes: Buffer } | null {
  const match = value.match(/^data:(image\/[^;,\s]+);base64,([A-Za-z0-9+/=_-]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const encoded = match[2];
  const unpadded = encoded.replace(/=+$/, "");
  if (!unpadded || unpadded.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(unpadded)) return null;
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== unpadded) return null;
  return { mimeType, bytes };
}

function hasValidImageBytes(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 20
      && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      && bytes.subarray(-12).toString("hex") === "0000000049454e44ae426082";
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (mimeType === "image/gif") {
    return bytes.length >= 7
      && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")
      && bytes[bytes.length - 1] === 0x3b;
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "image/bmp") return bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM";
  if (mimeType === "image/svg+xml") return /<svg(?:\s|>)/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 4096)));
  if (["image/avif", "image/heic", "image/heif"].includes(mimeType)) {
    return bytes.length >= 12
      && bytes.subarray(4, 8).toString("ascii") === "ftyp"
      && /^(avif|avis|heic|heix|hevc|hevx|mif1)$/i.test(bytes.subarray(8, 12).toString("ascii"));
  }
  return true;
}

/**
 * Validate inline image bytes before a third-party provider sees them.
 *
 * The native desktop transcript can contain code snippets that look like
 * `data:image/png;base64,SCREENSHOT`, and a truncated screenshot can still
 * pass a loose Base64 parser. Keep those values as text instead of sending a
 * provider an invalid image and losing the whole continuation.
 */
export function isValidImageDataUrl(value: unknown): boolean {
  const raw = cleanString(value);
  if (!/^data:image\//i.test(raw)) return true;
  const decoded = decodedBase64(raw);
  return Boolean(decoded && hasValidImageBytes(decoded.mimeType, decoded.bytes));
}

const INVALID_IMAGE_TEXT = "[OpenCodex] Invalid image data omitted; continue from the surrounding text or accessibility state.";

function sanitizeInvalidImageValue(value: any, state: { removed: number }, depth = 0): any {
  if (depth > 24 || value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeInvalidImageValue(item, state, depth + 1));

  const record = value as Record<string, any>;
  const type = cleanString(record.type).toLowerCase();
  const isImage = IMAGE_PART_TYPES.has(type)
    || Object.prototype.hasOwnProperty.call(record, "image_url")
    || (typeof record.data === "string" && typeof (record.mimeType || record.mime_type) === "string");
  if (isImage) {
    const url = inlineImageDataUrl(record);
    if (/^data:image\//i.test(url) && !isValidImageDataUrl(url)) {
      state.removed++;
      return {
        type: type === "image_url" ? "text" : "input_text",
        text: INVALID_IMAGE_TEXT,
      };
    }
  }

  const next: Record<string, any> = { ...record };
  for (const [key, child] of Object.entries(record)) {
    next[key] = sanitizeInvalidImageValue(child, state, depth + 1);
  }
  return next;
}

/** Remove malformed inline images from provider-bound Responses/Chat bodies. */
export function sanitizeInvalidImageData(body: any): { body: any; removed: number } {
  if (!body || typeof body !== "object") return { body, removed: 0 };
  const state = { removed: 0 };
  const next = { ...body };
  if (Array.isArray(body.input)) next.input = sanitizeInvalidImageValue(body.input, state);
  if (Array.isArray(body.messages)) next.messages = sanitizeInvalidImageValue(body.messages, state);
  return { body: next, removed: state.removed };
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
