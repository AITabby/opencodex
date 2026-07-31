/**
 * Native Codex image-generation bridge.
 *
 * Third-party chat providers only decide that an image should be generated
 * and provide the visual brief. The actual image request is sent to the same
 * ChatGPT/Codex Responses backend used by native GPT traffic. The gateway
 * does not select Gemini, Image API credentials, or a third-party image
 * provider here.
 */

import { ResponseTool } from "../core/types.js";
import { fetchUpstream } from "./upstream_fetch.js";

export const NATIVE_IMAGE_TOOL_NAME = "opencodex_generate_image";
export const NATIVE_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL = "gpt-5.6";

export interface ImageInputReference {
  url?: string;
  fileId?: string;
  detail?: string;
}

export interface ImageGenerationContext {
  text: string;
  images: ImageInputReference[];
}

export interface ImageGenerationToolArguments {
  prompt: string;
  size?: string;
  quality?: string;
}

export interface NativeGeneratedImage {
  data: string;
  revisedPrompt?: string;
  partialImages?: string[];
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" ? value as Record<string, any> : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isImageGenerationTool(tool: ResponseTool | any): boolean {
  return Boolean(tool && typeof tool === "object" && (
    tool.type === "image_generation"
    || tool.type === "image_generation_tool"
    || tool.name === "image_generation"
  ));
}

export function hasImageGenerationTool(tools?: ResponseTool[] | any[]): boolean {
  return Array.isArray(tools) && tools.some(isImageGenerationTool);
}

/**
 * This is only the provider-facing function contract. It is not emitted to
 * the Codex client as a normal function call; the stream engine consumes it
 * inside the gateway and calls the native image backend.
 */
export function buildNativeImageTool(): any {
  return {
    type: "function",
    function: {
      name: NATIVE_IMAGE_TOOL_NAME,
      description: "Generate or edit an image through the native Codex image-generation capability. Use this only when the user explicitly asks for an image or image edit. Put the complete visual brief in prompt.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Complete image prompt, including subject, composition, style, text, and edit instructions.",
          },
          size: {
            type: "string",
            description: "Optional native image size such as 1024x1024, 1536x1024, or 1024x1536.",
          },
          quality: {
            type: "string",
            description: "Optional quality preference when supported by the native image tool.",
          },
        },
        required: ["prompt"],
      },
    },
  };
}

function appendContextPart(context: ImageGenerationContext, part: any): void {
  if (Array.isArray(part)) {
    for (const nested of part) appendContextPart(context, nested);
    return;
  }
  if (typeof part === "string") {
    if (part.trim()) context.text = `${context.text}\n${part.trim()}`.trim();
    return;
  }
  const record = asRecord(part);
  if (!record) return;

  const type = cleanString(record.type).toLowerCase();
  if (type === "input_text" || type === "output_text" || type === "text") {
    const text = cleanString(record.text);
    if (text) context.text = `${context.text}\n${text}`.trim();
    return;
  }

  if (type === "input_image" || type === "output_image" || type === "image_url" || record.image_url || record.file_id) {
    const imageUrlValue = record.image_url;
    const url = typeof imageUrlValue === "string"
      ? imageUrlValue.trim()
      : cleanString(asRecord(imageUrlValue)?.url);
    const fileId = cleanString(record.file_id);
    if (url || fileId) context.images.push({
      ...(url ? { url } : {}),
      ...(fileId ? { fileId } : {}),
      ...(cleanString(record.detail) ? { detail: cleanString(record.detail) } : {}),
    });
  }
}

/** Extract the user's visual context without injecting a fixed prompt. */
export function extractImageGenerationContext(body: any): ImageGenerationContext {
  const context: ImageGenerationContext = { text: "", images: [] };
  const input = body?.input;
  if (typeof input === "string") appendContextPart(context, input);
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        appendContextPart(context, item);
        continue;
      }
      const record = asRecord(item);
      if (!record) continue;
      if (record.type === "message" || record.role || !record.type) appendContextPart(context, record.content);
    }
  }
  return context;
}

export function parseImageGenerationArguments(rawArguments: string, fallbackPrompt = ""): ImageGenerationToolArguments {
  let parsed: any = {};
  try {
    parsed = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    parsed = { prompt: rawArguments };
  }
  const prompt = cleanString(parsed?.prompt) || cleanString(parsed?.description) || cleanString(fallbackPrompt);
  if (!prompt) throw new Error("第三方模型调用了生图工具，但没有提供 prompt");
  return {
    prompt,
    ...(cleanString(parsed?.size || parsed?.image_size) ? { size: cleanString(parsed?.size || parsed?.image_size) } : {}),
    ...(cleanString(parsed?.quality) ? { quality: cleanString(parsed.quality) } : {}),
  };
}

function nativeInputContent(prompt: string, images: ImageInputReference[]): any[] {
  const content: any[] = [{ type: "input_text", text: prompt }];
  for (const image of images) {
    if (image.url) {
      content.push({
        type: "input_image",
        image_url: image.url,
        ...(image.detail ? { detail: image.detail } : {}),
      });
    } else if (image.fileId) {
      content.push({
        type: "input_image",
        file_id: image.fileId,
        ...(image.detail ? { detail: image.detail } : {}),
      });
    }
  }
  return content;
}

export function buildNativeCodexImageRequestBody(
  args: ImageGenerationToolArguments,
  context: ImageGenerationContext,
  model: string,
): any {
  // Let the native Responses image tool choose between a new image and an
  // edit when reference images are present; the third-party model's prompt
  // remains the source of truth for the visual operation.
  const tool: any = { type: "image_generation", action: "auto", partial_images: 0 };
  // These are hints for the native tool. Unsupported hints are intentionally
  // omitted rather than translated into a provider-specific image API.
  if (args.quality) tool.quality = args.quality;
  if (args.size) tool.size = args.size;

  return {
    model,
    input: [{ role: "user", content: nativeInputContent(args.prompt || context.text, context.images) }],
    tools: [tool],
    stream: true,
  };
}

function appendNativeImageFromItem(images: NativeGeneratedImage[], item: any): void {
  if (!item || item.type !== "image_generation_call" || !cleanString(item.result)) return;
  images.push({
    data: cleanString(item.result),
    ...(cleanString(item.revised_prompt || item.revisedPrompt) ? { revisedPrompt: cleanString(item.revised_prompt || item.revisedPrompt) } : {}),
  });
}

function parseNativeJsonEvent(images: NativeGeneratedImage[], event: any): void {
  if (!event || typeof event !== "object") return;
  if (event.type === "response.output_item.done") appendNativeImageFromItem(images, event.item);
  if (event.type === "response.completed" || event.type === "response.done") {
    const output = Array.isArray(event.response?.output) ? event.response.output : [];
    for (const item of output) appendNativeImageFromItem(images, item);
  }
}

async function readNativeImageStream(response: Response): Promise<NativeGeneratedImage[]> {
  const images: NativeGeneratedImage[] = [];
  if (!response.body) return images;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") return;
    try { parseNativeJsonEvent(images, JSON.parse(data)); } catch {}
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) for (const line of buffer.split("\n")) consumeLine(line);
  return images;
}

function parseNativeError(raw: string): string {
  try {
    const payload = JSON.parse(raw) as any;
    return cleanString(payload?.error?.message) || cleanString(payload?.message) || raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

export async function generateNativeCodexImage(
  args: ImageGenerationToolArguments,
  context: ImageGenerationContext,
  nativeHeaders: Record<string, string>,
  options: { model?: string } = {},
): Promise<NativeGeneratedImage[]> {
  const model = cleanString(options.model)
    || cleanString(process.env.OPENCODEX_NATIVE_IMAGE_MAINLINE_MODEL)
    || DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL;
  const body = buildNativeCodexImageRequestBody(args, context, model);
  const headers: Record<string, string> = { ...nativeHeaders };
  for (const key of ["host", "content-length", "transfer-encoding", "connection", "accept-encoding", "content-encoding"]) {
    delete headers[key];
    delete headers[key.toLowerCase()];
  }
  headers.host = "chatgpt.com";
  headers["Content-Type"] = "application/json";
  headers.Accept = "text/event-stream";

  const response = await fetchUpstream(NATIVE_CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    maxAttempts: 1,
    timeoutMs: 600_000,
    operation: "native-image-generation",
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`原生 Codex 生图失败（HTTP ${response.status}）：${parseNativeError(raw) || "上游没有返回错误详情"}`);
  }
  const images = await readNativeImageStream(response);
  if (images.length === 0) throw new Error("原生 Codex 生图完成，但响应中没有 image_generation_call 结果");
  return images;
}
