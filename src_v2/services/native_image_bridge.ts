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
export const NATIVE_CODEX_IMAGES_URL = "https://chatgpt.com/backend-api/codex/images/generations";
export const DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL = "gpt-image-2";
export const NATIVE_IMAGE_FALLBACK_MODEL = "gpt-image-1.5";

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

export function buildNativeCodexImageRequestBody(
  args: ImageGenerationToolArguments,
  context: ImageGenerationContext,
  model: string,
): any {
  // Third-party models only decide that an image is needed. The actual image
  // request uses the same native Codex Images API and image2 model as the
  // official Codex image-generation extension.
  return {
    model,
    prompt: args.prompt || context.text,
    background: "auto",
    quality: args.quality || "auto",
    size: args.size || "auto",
  };
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
  const authorization = Object.entries(nativeHeaders).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  const userAgent = Object.entries(nativeHeaders).find(([key]) => key.toLowerCase() === "user-agent")?.[1];
  const headers: Record<string, string> = {
    ...(authorization ? { Authorization: authorization } : {}),
    ...(userAgent ? { "User-Agent": userAgent } : {}),
    "Content-Type": "application/json",
  };
  // The native Images endpoint negotiates JSON with a generic accept header;
  // explicitly requesting `application/json` is rejected by this backend.
  headers.Accept = "*/*";

  const requestWithModel = async (requestedModel: string): Promise<NativeGeneratedImage[]> => {
    const body = buildNativeCodexImageRequestBody(args, context, requestedModel);
    const response = await fetchUpstream(NATIVE_CODEX_IMAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      maxAttempts: 1,
      timeoutMs: 600_000,
      operation: `native-image-generation:${requestedModel}`,
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`原生 Codex 生图失败（模型 ${requestedModel}，HTTP ${response.status}）：${parseNativeError(raw) || "上游没有返回错误详情"}`);
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`原生 Codex 生图失败（模型 ${requestedModel}）：响应不是有效的 JSON 图片结果`);
    }
    const images: NativeGeneratedImage[] = Array.isArray(payload?.data)
      ? payload.data
        .filter((item: any) => cleanString(item?.b64_json))
        .map((item: any) => ({
          data: cleanString(item.b64_json),
          ...(cleanString(item.revised_prompt) ? { revisedPrompt: cleanString(item.revised_prompt) } : {}),
        }))
      : [];
    if (images.length === 0) throw new Error(`原生 Codex 生图失败（模型 ${requestedModel}）：响应中没有 b64_json 图片结果`);
    return images;
  };

  try {
    return await requestWithModel(model);
  } catch (primaryError: any) {
    if (model === NATIVE_IMAGE_FALLBACK_MODEL) throw primaryError;
    console.warn(`[OpenCodex Image] image2 unavailable; falling back to ${NATIVE_IMAGE_FALLBACK_MODEL}`, {
      primary_model: model,
      error: primaryError?.message || String(primaryError),
    });
    try {
      return await requestWithModel(NATIVE_IMAGE_FALLBACK_MODEL);
    } catch (fallbackError: any) {
      throw new Error(`${primaryError?.message || primaryError}; fallback ${NATIVE_IMAGE_FALLBACK_MODEL} also failed: ${fallbackError?.message || fallbackError}`);
    }
  }
}
