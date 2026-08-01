import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Third-party Computer Use screenshots are normally returned as inline image
 * data by the native executor. Keep enough pixels for the accessibility-tree
 * driven @oai/sky bridge, but avoid sending a full Retina desktop capture to
 * every Chat/Responses provider. Native OpenAI Responses bypasses this file.
 */
export const DEFAULT_COMPUTER_SCREENSHOT_MAX_EDGE = 1920;
export const DEFAULT_COMPUTER_SCREENSHOT_MAX_SOURCE_BYTES = 768 * 1024;
export const DEFAULT_COMPUTER_SCREENSHOT_JPEG_QUALITY = 82;

const TOOL_OUTPUT_ITEM_TYPES = new Set([
  "function_call_output",
  "mcp_call_output",
  "computer_call_output",
  "tool_result",
]);
const IMAGE_PART_TYPES = new Set(["input_image", "output_image", "image_url"]);
const DUPLICATE_SCREENSHOT_TEXT = "[OpenCodex] This Computer Use screenshot is identical to an earlier tool result in this request. Use the earlier image and the current accessibility state.";

export type ComputerUseImageOptimizationStats = {
  optimized: number;
  deduplicated: number;
  skippedOriginal: number;
  skippedRemote: number;
  failed: number;
  inputBytes: number;
  outputBytes: number;
};

export type ProcessComputerImage = (input: {
  buffer: Buffer;
  mimeType: string;
  maxEdge: number;
  jpegQuality: number;
}) => Promise<{ buffer: Buffer; mimeType: string } | null>;

export type ComputerUseImageOptimizationOptions = {
  maxEdge?: number;
  maxSourceBytes?: number;
  jpegQuality?: number;
  /** Test hook; production uses macOS sips when available. */
  processImage?: ProcessComputerImage;
};

type OptimizerState = {
  maxEdge: number;
  maxSourceBytes: number;
  jpegQuality: number;
  processImage: ProcessComputerImage;
  seen: Set<string>;
  stats: ComputerUseImageOptimizationStats;
};

function emptyStats(): ComputerUseImageOptimizationStats {
  return {
    optimized: 0,
    deduplicated: 0,
    skippedOriginal: 0,
    skippedRemote: 0,
    failed: 0,
    inputBytes: 0,
    outputBytes: 0,
  };
}

function parseDataUrl(value: string): { mimeType: string; buffer: Buffer } | null {
  const match = String(value || "").match(/^data:([^;,\s]+)(;base64)?,([\s\S]*)$/i);
  if (!match || !/^image\//i.test(match[1])) return null;
  try {
    const buffer = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return buffer.length > 0 ? { mimeType: match[1].toLowerCase(), buffer } : null;
  } catch {
    return null;
  }
}

function toDataUrl(mimeType: string, buffer: Buffer): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function imageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png" && buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (!/^image\/jpe?g$/i.test(mimeType) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xc3
      || marker >= 0xc5 && marker <= 0xc7
      || marker >= 0xc9 && marker <= 0xcb
      || marker >= 0xcd && marker <= 0xcf;
    if (isStartOfFrame && segmentLength >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function imageUrlFromPart(part: any): string {
  if (!part || typeof part !== "object") return "";
  const rawImageUrl = part.image_url;
  if (typeof rawImageUrl === "string") return rawImageUrl.trim();
  if (typeof rawImageUrl?.url === "string") return rawImageUrl.url.trim();
  if (typeof part.data === "string" && typeof part.mimeType === "string") {
    return toDataUrl(part.mimeType, Buffer.from(part.data, "base64"));
  }
  if (typeof part.url === "string") return part.url.trim();
  return "";
}

function isImagePart(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  return IMAGE_PART_TYPES.has(String(value.type || "").toLowerCase())
    || value.image_url !== undefined
    || (typeof value.data === "string" && typeof value.mimeType === "string");
}

function isToolMessage(value: any): boolean {
  return value?.role === "tool";
}

function isToolOutputItem(value: any): boolean {
  return TOOL_OUTPUT_ITEM_TYPES.has(String(value?.type || "").toLowerCase())
    || isToolMessage(value);
}

function imageKey(url: string, detail?: unknown): string {
  const parsed = parseDataUrl(url);
  const source = parsed
    ? parsed.buffer
    : Buffer.from(url, "utf8");
  return crypto.createHash("sha256")
    .update(source)
    .update(`|detail:${String(detail || "")}`)
    .digest("hex");
}

function duplicateTextPart(part: any): any {
  const type = String(part?.type || "").toLowerCase();
  return {
    type: type === "image_url" ? "text" : "input_text",
    text: DUPLICATE_SCREENSHOT_TEXT,
  };
}

function rewriteImagePart(part: any, dataUrl: string, mimeType: string): any {
  const next = { ...part };
  const parsed = parseDataUrl(dataUrl);
  const base64 = parsed?.buffer.toString("base64") || "";

  if (typeof part.image_url === "string") {
    next.image_url = dataUrl;
  } else if (part.image_url && typeof part.image_url === "object") {
    next.image_url = { ...part.image_url, url: dataUrl };
  } else if (typeof part.data === "string" && typeof part.mimeType === "string") {
    next.data = base64;
    next.mimeType = mimeType;
  } else if (typeof part.url === "string") {
    next.url = dataUrl;
  } else {
    next.image_url = dataUrl;
  }
  return next;
}

async function processWithSips(input: {
  buffer: Buffer;
  mimeType: string;
  maxEdge: number;
  jpegQuality: number;
}): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (process.platform !== "darwin") return null;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-cu-image-"));
  const inputPath = path.join(tempDir, "input");
  const outputMimeType = input.mimeType === "image/png" ? "image/png" : "image/jpeg";
  const outputPath = path.join(tempDir, outputMimeType === "image/png" ? "output.png" : "output.jpg");
  try {
    await fs.writeFile(inputPath, input.buffer);
    const args = ["-Z", String(input.maxEdge), "-s", "format", outputMimeType === "image/png" ? "png" : "jpeg"];
    if (outputMimeType !== "image/png") args.push("-s", "formatOptions", String(input.jpegQuality));
    args.push(inputPath, "--out", outputPath);
    await execFileAsync("/usr/bin/sips", args, { timeout: 15_000, maxBuffer: 256 * 1024 });
    const buffer = await fs.readFile(outputPath);
    return buffer.length > 0 ? { buffer, mimeType: outputMimeType } : null;
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function optimizeImagePart(part: any, state: OptimizerState, textMode: boolean): Promise<any> {
  const url = imageUrlFromPart(part);
  if (!url) return part;

  const detail = part?.detail || part?.image_url?.detail;
  const key = imageKey(url, detail);
  if (state.seen.has(key)) {
    state.stats.deduplicated++;
    return duplicateTextPart(textMode ? { type: "image_url" } : part);
  }
  state.seen.add(key);

  const parsed = parseDataUrl(url);
  if (!parsed) {
    state.stats.skippedRemote++;
    return part;
  }
  state.stats.inputBytes += parsed.buffer.length;

  // Respect an explicit original-detail request. It is normally used for
  // coordinate-sensitive visual work; the native route is never sent here.
  if (String(detail || "").toLowerCase() === "original") {
    state.stats.skippedOriginal++;
    state.stats.outputBytes += parsed.buffer.length;
    return part;
  }

  const dimensions = imageDimensions(parsed.buffer, parsed.mimeType);
  const oversized = dimensions
    ? Math.max(dimensions.width, dimensions.height) > state.maxEdge
    : parsed.buffer.length > state.maxSourceBytes;
  if (!oversized && parsed.buffer.length <= state.maxSourceBytes) {
    state.stats.outputBytes += parsed.buffer.length;
    return part;
  }

  try {
    const processed = await state.processImage({
      buffer: parsed.buffer,
      mimeType: parsed.mimeType,
      maxEdge: state.maxEdge,
      jpegQuality: state.jpegQuality,
    });
    // Keep a resized image even if compression makes the byte payload slightly
    // larger: fewer pixels are the important saving for model context. If the
    // source was already within the dimension limit, only keep a byte-saving
    // re-encode.
    if (!processed || (!oversized && processed.buffer.length >= parsed.buffer.length)) {
      state.stats.outputBytes += parsed.buffer.length;
      return part;
    }
    state.stats.optimized++;
    state.stats.outputBytes += processed.buffer.length;
    return rewriteImagePart(part, toDataUrl(processed.mimeType, processed.buffer), processed.mimeType);
  } catch {
    state.stats.failed++;
    state.stats.outputBytes += parsed.buffer.length;
    return part;
  }
}

async function optimizeToolValue(value: any, state: OptimizerState, textMode: boolean): Promise<any> {
  if (Array.isArray(value)) {
    const next: any[] = [];
    for (const part of value) {
      next.push(isImagePart(part) ? await optimizeImagePart(part, state, textMode) : await optimizeToolValue(part, state, textMode));
    }
    return next;
  }
  if (!value || typeof value !== "object") return value;

  const next = { ...value };
  for (const key of ["content", "output", "result", "parts"]) {
    if (key in next) next[key] = await optimizeToolValue(next[key], state, textMode);
  }
  return next;
}

function createState(options: ComputerUseImageOptimizationOptions): OptimizerState {
  return {
    maxEdge: Math.max(512, Math.floor(options.maxEdge || DEFAULT_COMPUTER_SCREENSHOT_MAX_EDGE)),
    maxSourceBytes: Math.max(0, Math.floor(options.maxSourceBytes ?? DEFAULT_COMPUTER_SCREENSHOT_MAX_SOURCE_BYTES)),
    jpegQuality: Math.min(95, Math.max(50, Math.floor(options.jpegQuality || DEFAULT_COMPUTER_SCREENSHOT_JPEG_QUALITY))),
    processImage: options.processImage || processWithSips,
    seen: new Set<string>(),
    stats: emptyStats(),
  };
}

/**
 * Optimize only tool-result images on a third-party request. User-provided
 * images and native OpenAI Responses requests are intentionally outside this
 * helper's scope.
 */
export async function optimizeThirdPartyComputerUseImages(
  body: any,
  options: ComputerUseImageOptimizationOptions = {},
): Promise<{ body: any; stats: ComputerUseImageOptimizationStats }> {
  const state = createState(options);
  if (!body || typeof body !== "object") return { body, stats: state.stats };

  const next = { ...body };
  if (Array.isArray(body.input)) {
    next.input = [];
    for (const item of body.input) {
      if (!isToolOutputItem(item)) {
        next.input.push(item);
        continue;
      }
      const optimizedItem = { ...item };
      for (const key of ["content", "output", "result", "parts"]) {
        if (key in optimizedItem) optimizedItem[key] = await optimizeToolValue(optimizedItem[key], state, false);
      }
      next.input.push(optimizedItem);
    }
  }

  if (Array.isArray(body.messages)) {
    next.messages = [];
    for (const message of body.messages) {
      if (!isToolMessage(message)) {
        next.messages.push(message);
        continue;
      }
      next.messages.push({
        ...message,
        content: await optimizeToolValue(message.content, state, true),
      });
    }
  }

  return { body: next, stats: state.stats };
}
