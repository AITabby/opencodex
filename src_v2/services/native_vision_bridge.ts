/**
 * Native vision bridge for third-party models.
 *
 * A text-only provider can enter this bridge before its request is sent, or
 * after it rejects a screenshot-shaped tool result. The image is sent through
 * the native ChatGPT/Codex subscription lane and its textual description is
 * substituted into the third-party request.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fetchUpstream, type UpstreamFetchOptions } from "./upstream_fetch.js";
import { createHash } from "node:crypto";
import { ChatGptAccountPool } from "./chatgpt_account_pool.js";

export const NATIVE_VISION_MODEL = "gpt-5.6-luna";
export const NATIVE_CODEX_VISION_URL = "https://chatgpt.com/backend-api/codex/responses";
// A vision sidecar is a bounded preprocessing step. A dead native auth lane
// must not hold the user's third-party turn for the provider's ten-minute
// stream timeout or trigger a retry storm in Codex Desktop.
export const NATIVE_VISION_TIMEOUT_MS = 30_000;

export type NativeVisionErrorCode =
  | "official_vision_auth_unavailable"
  | "official_vision_quota_exhausted"
  | "official_vision_invalid_request"
  | "official_vision_request_failed"
  | "official_vision_unreachable";

export class NativeVisionBridgeError extends Error {
  public readonly code: NativeVisionErrorCode;
  public readonly statusCode: number;

  constructor(code: NativeVisionErrorCode, message: string, statusCode = 0, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeVisionBridgeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface NativeVisionImageReference {
  url?: string;
  fileId?: string;
  detail?: string;
}

export interface NativeVisionResult {
  model: typeof NATIVE_VISION_MODEL;
  text: string;
  imageCount: number;
  /** Present only when the sidecar could not produce a usable description. */
  error?: {
    code: NativeVisionErrorCode;
    message: string;
    statusCode?: number;
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function redactVisionError(value: unknown): string {
  return cleanString(value)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, "[图片数据已隐藏]")
    .replace(/base64,[a-z0-9+/=_-]{16,}/gi, "base64,[图片数据已隐藏]")
    .replace(/\b(?:input_image|output_image|image_url)\b/gi, "图片字段")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" ? value as Record<string, any> : null;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return cleanString(value);
  }
  return "";
}

function codexAuthPath(): string {
  const codexHome = cleanString(process.env.OPENCODEX_CODEX_HOME || process.env.CODEX_HOME)
    || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "auth.json");
}

function copyHeadersWithOfficialCredential(
  nativeHeaders: Record<string, string>,
  token: string,
  upstreamId = "",
): Record<string, string> | null {
  const normalizedToken = cleanString(token);
  if (!normalizedToken || /dummy|opencodex-local/i.test(normalizedToken)) return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(nativeHeaders || {})) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "chatgpt-account-id") continue;
    headers[key] = value;
  }
  headers.Authorization = `Bearer ${normalizedToken}`;
  if (cleanString(upstreamId)) headers["chatgpt-account-id"] = cleanString(upstreamId);
  return headers;
}

function readOfficialCredential(filePath: string): { token: string; upstreamId: string } | null {
  try {
    const auth = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const token = cleanString(auth?.tokens?.access_token || auth?.access_token);
    if (!token) return null;
    return {
      token,
      upstreamId: cleanString(auth?.tokens?.account_id || auth?.account_id),
    };
  } catch {
    return null;
  }
}

function isRealBearer(headers: Record<string, string>): boolean {
  const authorization = headerValue(headers, "authorization");
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  return /^bearer\s+\S+/i.test(authorization) && Boolean(token) && !/dummy|opencodex-local/i.test(token);
}

/**
 * The native Desktop request and the third-party vision sidecar enter the
 * gateway through different paths. When official account rotation is
 * enabled, the sidecar must use the same selected profile as native official
 * egress instead of falling back to the global ~/.codex/auth.json token.
 * This is resolved lazily so ordinary text-only provider turns never touch
 * the account-pool scheduler.
 */
function headersFromOfficialAccountPool(nativeHeaders: Record<string, string>): Record<string, string> {
  try {
    const pool = new ChatGptAccountPool();
    const settings = pool.getSettings();
    if (settings.rotation_enabled) {
      // The vision sidecar is an official request in its own right. When the
      // account pool is enabled, do not silently reuse a stale Authorization
      // header from the Desktop process; select the same explicit pool
      // account when available, otherwise use the pool's configured default.
      const accountId = process.env.OPENCODEX_CHATGPT_ACCOUNT_ID
        || headerValue(nativeHeaders, "chatgpt-account-id");
      const account = pool.selectForInvocation(accountId);
      if (account) {
        const credential = readOfficialCredential(path.join(account.profile_dir, "auth.json"));
        const headers = credential
          ? copyHeadersWithOfficialCredential(nativeHeaders, credential.token, credential.upstreamId)
          : null;
        if (headers) return headers;
      }
    }
  } catch {
    // A missing/partial pool profile must not break the ordinary native-header
    // path.
  }
  return nativeHeaders;
}

/**
 * Return the credential lanes in the order in which native official egress
 * should try them. The selected pool account remains first, but a stale
 * profile must not make a third-party image turn unrecoverable when the
 * currently signed-in native account is still valid. Tokens are kept in
 * memory only and are never included in diagnostics.
 */
function nativeVisionHeaderCandidates(nativeHeaders: Record<string, string>): Record<string, string>[] {
  const candidates: Record<string, string>[] = [];
  const seen = new Set<string>();
  const add = (headers: Record<string, string> | null | undefined): void => {
    if (!headers || !isRealBearer(headers)) return;
    const authorization = headerValue(headers, "authorization");
    const accountId = headerValue(headers, "chatgpt-account-id");
    const key = `${authorization}\n${accountId}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(headers);
  };

  add(headersFromOfficialAccountPool(nativeHeaders));
  add(nativeHeaders);

  const globalCredential = readOfficialCredential(codexAuthPath());
  if (globalCredential) {
    add(copyHeadersWithOfficialCredential(nativeHeaders, globalCredential.token, globalCredential.upstreamId));
  }

  try {
    const pool = new ChatGptAccountPool();
    for (const account of pool.listAccounts().filter((candidate) => candidate.enabled)) {
      const credential = readOfficialCredential(path.join(account.profile_dir, "auth.json"));
      if (credential) {
        add(copyHeadersWithOfficialCredential(nativeHeaders, credential.token, credential.upstreamId));
      }
    }
  } catch {
    // The selected/incoming/global lanes above are sufficient when the pool
    // is missing or partially unreadable.
  }

  return candidates;
}

/**
 * Fingerprint the credential lane without persisting any token. A re-login
 * changes the profile file metadata, so a previously failed image can retry
 * with the refreshed account instead of remaining suppressed forever.
 */
export function nativeVisionAuthorizationFingerprint(nativeHeaders: Record<string, string>): string {
  const incomingAuthorization = headerValue(nativeHeaders, "authorization");
  let material = incomingAuthorization;
  try {
    const pool = new ChatGptAccountPool();
    const settings = pool.getSettings();
    if (settings.rotation_enabled) {
      const profiles = pool.listAccounts()
        .filter((account) => account.enabled)
        .map((account) => {
          try {
            const stat = fs.statSync(path.join(account.profile_dir, "auth.json"));
            return [account.id, stat.mtimeMs, stat.size];
          } catch {
            return [account.id, 0, 0];
          }
        });
      let globalAuth = [0, 0];
      try {
        const stat = fs.statSync(codexAuthPath());
        globalAuth = [stat.mtimeMs, stat.size];
      } catch {
        // The pool may be usable even when the global native auth file is absent.
      }
      material = JSON.stringify({ settings, profiles, globalAuth });
    }
  } catch {
    // Fall back to the request-level token fingerprint when the pool is absent.
  }
  return material ? createHash("sha256").update(material).digest("hex") : "";
}

const IMAGE_PART_TYPES = new Set([
  "input_image",
  "output_image",
  "image",
  "localimage",
  "local_image",
  "image_url",
  // Native Computer Use returns a screenshot as a tool-output part rather
  // than as `input_image`. It is still an image at the gateway boundary.
  "computer_screenshot",
  "computer_image",
  "screenshot",
]);

function imageUrlCandidate(value: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (typeof value === "string") {
    const candidate = value.trim();
    return /^(?:data:image\/|https?:\/\/|file:\/\/|\/)/i.test(candidate) ? candidate : "";
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["url", "image_url", "src", "screenshot", "image"]) {
    const candidate = imageUrlCandidate(record[key], depth + 1);
    if (candidate) return candidate;
  }
  return "";
}

function isImagePart(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const type = cleanString(record.type).toLowerCase();
  const data = cleanString(record.data);
  const mimeType = cleanString(record.mimeType || record.mime_type);
  const hasImageField = ["image_url", "src", "screenshot", "image"].some((key) => record[key] !== undefined);
  const directUrl = cleanString(record.url);
  return IMAGE_PART_TYPES.has(type)
    || record.image_url !== undefined
    || record.file_id !== undefined
    || record.fileId !== undefined
    || hasImageField
    || Boolean(directUrl && /^data:image\//i.test(directUrl))
    || Boolean(data && mimeType.startsWith("image/"));
}

function imageReference(value: unknown): NativeVisionImageReference | null {
  const record = asRecord(value);
  if (!record || !isImagePart(record)) return null;
  const url = imageUrlCandidate(record);
  const fileId = cleanString(record.file_id || record.fileId);
  const data = cleanString(record.data);
  const mimeType = cleanString(record.mimeType || record.mime_type);
  const dataUrl = !url && data && mimeType.startsWith("image/") ? `data:${mimeType};base64,${data}` : "";
  if (!url && !fileId && !dataUrl) return null;
  return {
    ...(url || dataUrl ? { url: url || dataUrl } : {}),
    ...(fileId ? { fileId } : {}),
    ...(cleanString(record.detail) ? { detail: cleanString(record.detail) } : {}),
  };
}

function collectImages(value: unknown, output: NativeVisionImageReference[], depth = 0): void {
  if (depth > 16 || value === null || value === undefined) return;
  const image = imageReference(value);
  if (image) {
    output.push(image);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, output, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const child of Object.values(record)) collectImages(child, output, depth + 1);
}

function collectText(value: unknown, output: string[], depth = 0): void {
  if (depth > 16 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.trim()) output.push(value.trim());
    return;
  }
  if (isImagePart(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const type = cleanString(record.type).toLowerCase();
  if (type === "input_text" || type === "output_text" || type === "text") {
    const text = cleanString(record.text);
    if (text) output.push(text);
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "arguments" || key === "id" || key === "call_id") continue;
    collectText(child, output, depth + 1);
  }
}

/** Find image parts in a Responses or Chat-shaped request without touching tools. */
export function extractNativeVisionImages(body: any): NativeVisionImageReference[] {
  const images: NativeVisionImageReference[] = [];
  collectImages(body?.input, images);
  collectImages(body?.messages, images);
  collectImages(body?.attachments, images);
  collectImages(body?.content, images);
  // Antigravity and a few OpenAI-compatible wrappers place the Chat payload
  // under `request`. Keep this explicit rather than scanning tool schemas,
  // which may legitimately contain an example image field.
  collectImages(body?.request?.input, images);
  collectImages(body?.request?.messages, images);
  collectImages(body?.request?.attachments, images);
  collectImages(body?.request?.content, images);
  return images;
}

export function hasNativeVisionImages(body: any): boolean {
  return extractNativeVisionImages(body).length > 0;
}

/**
 * Only images attached to the latest user/tool turn are new candidates for a
 * vision request. Native Codex may reconstruct older rollout items into the
 * provider payload; those historical images must not trigger a fresh native
 * vision call during an ordinary text-only follow-up.
 */
export function hasNativeVisionImagesInCurrentTurn(body: any): boolean {
  return extractNativeVisionImagesInCurrentTurn(body).length > 0;
}

/** Return only image references attached to the latest user/tool turn. */
export function extractNativeVisionImagesInCurrentTurn(body: any): NativeVisionImageReference[] {
  const roots = [body?.input, body?.messages, body?.request?.input, body?.request?.messages];
  const images: NativeVisionImageReference[] = [];
  for (const root of roots) {
    if (!Array.isArray(root) || root.length === 0) continue;
    let latestUserIndex = -1;
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const item = asRecord(root[index]);
      const role = cleanString(item?.role).toLowerCase();
      const type = cleanString(item?.type).toLowerCase();
      if (role === "user" || (type === "message" && role !== "assistant")) {
        latestUserIndex = index;
        break;
      }
    }
    const start = latestUserIndex >= 0 ? latestUserIndex : root.length - 1;
    images.push(...extractNativeVisionImages({ input: root.slice(start) }));
  }
  collectImages(body?.attachments, images);
  collectImages(body?.request?.attachments, images);
  return images;
}

/** Stable cache key for one image, independent of the surrounding transcript. */
export function nativeVisionImageKey(image: NativeVisionImageReference): string {
  return createHash("sha256").update(JSON.stringify(image)).digest("hex");
}

/** Stable in-memory cache key for the same native image set across turns. */
export function nativeVisionCacheKey(body: any): string {
  const images = extractNativeVisionImages(body);
  if (images.length === 0) return "";
  return createHash("sha256").update(JSON.stringify(images)).digest("hex");
}

/**
 * This is deliberately narrow: a normal provider outage or auth failure must
 * not silently turn into an official-model request. It only matches a
 * validation response that mentions an image/multimodal shape, or the
 * string-only schema error that text-only providers return for an image
 * content array.
 */
export function isProviderImageInputRejection(status: number, body: string, requestBody: any): boolean {
  if (![400, 415, 422].includes(Number(status)) || !hasNativeVisionImages(requestBody)) return false;
  const text = String(body || "");
  // Text-only providers often collapse an image content array into their
  // string-only schema and return only `Input should be a valid string`.
  // That message does not mention images, so the image presence in the
  // request is the required second signal here. Keep the status guard above
  // so an unrelated provider validation error cannot invoke the official
  // vision sidecar.
  const mentionsImageShape = /(image_url|input_image|output_image|multimodal|vision|image)/i.test(text);
  const genericStringContentError = /(?:input|content|message(?:s|\b))\s+(?:should|must)\s+be\s+(?:a\s+)?valid\s+string|(?:expected|expects)\s+(?:a\s+)?string/i.test(text);
  if (!mentionsImageShape && !genericStringContentError) return false;
  return /unknown variant|deserialize|deserializ|unsupported|not supported|does not support|invalid[_ -]?request|expected\s+[`'\"]?text|content\s+type|cannot process|valid\s+string/i.test(text);
}

function responseText(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();

  const output = Array.isArray(payload.output) ? payload.output : [];
  const outputText = output.flatMap((item: any) => {
    if (!item || typeof item !== "object") return [];
    if (typeof item.text === "string") return [item.text];
    const content = Array.isArray(item.content) ? item.content : [];
    return content.flatMap((part: any) => typeof part?.text === "string" ? [part.text] : []);
  }).filter((text: any) => typeof text === "string" && text.trim()).join("\n").trim();
  if (outputText) return outputText;

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choiceText = choices.map((choice: any) => {
    const message = choice?.message;
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) return message.content.map((part: any) => part?.text || "").join("");
    return "";
  }).filter((text: string) => text.trim()).join("\n").trim();
  return choiceText;
}

function responseTextFromBody(raw: string, contentType = ""): string {
  try {
    return responseText(JSON.parse(raw));
  } catch {
    // The native Codex Responses lane normally streams SSE even when the
    // request is used as an internal sidecar. Collect text deltas if that is
    // what the backend returned.
    let deltaText = "";
    let completedPayload: any;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim().startsWith("data:")) continue;
      const data = line.slice(line.indexOf(":") + 1).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        if (event?.type === "response.output_text.delta") deltaText += cleanString(event.delta);
        if (event?.type === "response.completed") completedPayload = event.response;
      } catch {
        // Ignore SSE comments/keep-alives; the terminal result below decides
        // whether the sidecar actually produced usable text.
      }
    }
    return deltaText.trim() || (completedPayload ? responseText(completedPayload) : "");
  }
}

async function readResponseBody(response: Response, timeoutMs: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = Math.max(1, deadline - Date.now());
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const id = setTimeout(() => reject(new Error("official vision response body timeout")), remaining);
          id.unref?.();
          reader.read().then((value) => {
            clearTimeout(id);
            resolve(value);
          }, (error) => {
            clearTimeout(id);
            reject(error);
          });
        });
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      if (result.done) {
        output += decoder.decode();
        return output;
      }
      output += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function nativeVisionFailure(status: number, body: string, cause?: unknown): NativeVisionBridgeError {
  const detail = (() => {
    try {
      const parsed = JSON.parse(body);
      return cleanString(parsed?.error?.message)
        || cleanString(parsed?.message)
        || cleanString(parsed?.error)
        || body;
    } catch {
      return body;
    }
  })();
  const safeDetail = redactVisionError(detail);
  const lower = safeDetail.toLowerCase();
  if (status === 401 || status === 403 || /unauthori[sz]ed|authentication|login|token|credential/.test(lower)) {
    return new NativeVisionBridgeError(
      "official_vision_auth_unavailable",
      `官方视觉模型 ${NATIVE_VISION_MODEL} 的原生订阅凭证不可用${safeDetail ? `：${safeDetail}` : ""}`,
      status,
      cause,
    );
  }
  if (status === 402 || status === 429 || /quota|usage limit|rate limit|credits?|capacity|too many requests|上限|额度/.test(lower)) {
    return new NativeVisionBridgeError(
      "official_vision_quota_exhausted",
      `官方视觉模型 ${NATIVE_VISION_MODEL} 当前没有可用额度${safeDetail ? `：${safeDetail}` : ""}`,
      status,
      cause,
    );
  }
  if (status === 400 || status === 404 || status === 415 || status === 422) {
    return new NativeVisionBridgeError(
      "official_vision_invalid_request",
      `官方视觉模型 ${NATIVE_VISION_MODEL} 拒绝了图片请求${safeDetail ? `：${safeDetail}` : ""}`,
      status,
      cause,
    );
  }
  return new NativeVisionBridgeError(
    "official_vision_request_failed",
    `官方视觉模型 ${NATIVE_VISION_MODEL} 请求失败（HTTP ${status || "未知"}）${safeDetail ? `：${safeDetail}` : ""}`,
    status,
    cause,
  );
}

function nativeHeadersForVision(
  nativeHeaders: Record<string, string>,
  providerApiKey = "",
  selectedHeadersOverride?: Record<string, string>,
): Record<string, string> {
  const selectedHeaders = selectedHeadersOverride || headersFromOfficialAccountPool(nativeHeaders);
  const authorization = headerValue(selectedHeaders, "authorization");
  const accountId = headerValue(selectedHeaders, "chatgpt-account-id");
  const providerAuthorization = providerApiKey ? `bearer ${providerApiKey}`.toLowerCase() : "";
  if (!authorization || !/^bearer\s+\S+/i.test(authorization) || authorization.toLowerCase() === providerAuthorization) {
    throw new NativeVisionBridgeError(
      "official_vision_auth_unavailable",
      `无法调用官方视觉模型 ${NATIVE_VISION_MODEL}：没有可用的原生 ChatGPT 订阅凭证。`,
    );
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(selectedHeaders || {})) {
    const lower = key.toLowerCase();
    if ([
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "content-encoding",
      // The Desktop request can contain lowercase variants of these headers.
      // Do not copy them and then add canonical names below: undici's Headers
      // combines case-insensitive duplicates into values such as
      // `application/json, application/json`, which the official backend
      // rejects as an unsupported content type.
      "authorization",
      "chatgpt-account-id",
      "content-type",
      "accept",
      "accept-encoding",
      // Never carry a third-party provider credential into the official lane.
      "x-api-key",
      "api-key",
      "x-goog-api-key",
      "x-gemini-api-key",
    ].includes(lower)) continue;
    if (lower.startsWith("sec-websocket-")) continue;
    if (typeof value === "string" && value.trim()) headers[key] = value;
  }
  headers.Authorization = authorization;
  if (accountId) headers["chatgpt-account-id"] = accountId;
  headers["Content-Type"] = "application/json";
  headers.Accept = "*/*";
  headers["Accept-Encoding"] = "identity";
  return headers;
}

function buildNativeVisionRequestBody(images: NativeVisionImageReference[], requestBody: any): any {
  const textParts: string[] = [];
  collectText(requestBody?.input, textParts);
  collectText(requestBody?.messages, textParts);
  const userContext = textParts.join("\n").replace(/\s+/g, " ").trim().slice(-30_000);
  const content: any[] = [{
    type: "input_text",
    text: [
      "请分析下面的图片，给另一个只能处理文本的模型提供可直接使用的事实描述。",
      "请包含可见文字（OCR）、界面状态、关键对象、错误信息和不确定之处；不要执行任何操作，也不要编造看不见的内容。",
      userContext ? `原始请求上下文：${userContext}` : "",
    ].filter(Boolean).join("\n"),
  }];
  for (const image of images) {
    content.push({
      type: "input_image",
      ...(image.url ? { image_url: image.url } : {}),
      ...(image.fileId ? { file_id: image.fileId } : {}),
      ...(image.detail ? { detail: image.detail } : {}),
    });
  }
  return {
    model: NATIVE_VISION_MODEL,
    input: [{ type: "message", role: "user", content }],
    // ChatGPT's Codex Responses endpoint only accepts non-persisted sidecar
    // calls. Omitting this field is rejected before the model sees the image.
    store: false,
    stream: true,
  };
}

export async function analyzeWithNativeVision(
  requestBody: any,
  nativeHeaders: Record<string, string>,
  options: { providerApiKey?: string; signal?: AbortSignal; fetchImpl?: UpstreamFetchOptions["fetchImpl"]; images?: NativeVisionImageReference[] } = {},
): Promise<NativeVisionResult> {
  const images = Array.isArray(options.images) && options.images.length > 0
    ? options.images
    : extractNativeVisionImages(requestBody);
  if (images.length === 0) {
    throw new NativeVisionBridgeError(
      "official_vision_invalid_request",
      `无法调用官方视觉模型 ${NATIVE_VISION_MODEL}：原始请求中没有可用的图片数据。`,
    );
  }
  const candidates = nativeVisionHeaderCandidates(nativeHeaders);
  let lastError: NativeVisionBridgeError | undefined;
  for (let candidateIndex = 0; candidateIndex < Math.max(1, candidates.length); candidateIndex += 1) {
    let headers: Record<string, string>;
    try {
      headers = nativeHeadersForVision(
        nativeHeaders,
        options.providerApiKey || "",
        candidates[candidateIndex],
      );
    } catch (error: any) {
      lastError = error instanceof NativeVisionBridgeError
        ? error
        : new NativeVisionBridgeError(
          "official_vision_auth_unavailable",
          `无法调用官方视觉模型 ${NATIVE_VISION_MODEL}：没有可用的原生 ChatGPT 订阅凭证。`,
          0,
          error,
        );
      continue;
    }

    let response: Response;
    try {
      response = await fetchUpstream(NATIVE_CODEX_VISION_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(buildNativeVisionRequestBody(images, requestBody)),
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        maxAttempts: 1,
        timeoutMs: NATIVE_VISION_TIMEOUT_MS,
        operation: `native-vision:${NATIVE_VISION_MODEL}`,
        transport: "node_https",
      });
    } catch (error: any) {
      throw new NativeVisionBridgeError(
        "official_vision_unreachable",
        `无法连接官方视觉模型 ${NATIVE_VISION_MODEL}：${error?.message || "原生订阅接口不可达"}`,
        0,
        error,
      );
    }

    let raw: string;
    try {
      raw = await readResponseBody(response, NATIVE_VISION_TIMEOUT_MS);
    } catch (error: any) {
      throw new NativeVisionBridgeError(
        "official_vision_unreachable",
        `官方视觉模型 ${NATIVE_VISION_MODEL} 响应超时：${error?.message || "没有收到完成结果"}`,
        response.status,
        error,
      );
    }
    if (!response.ok) {
      const failure = nativeVisionFailure(response.status, raw);
      lastError = failure;
      // Account-pool profiles can be older than the currently signed-in
      // native profile. Only authentication failures may try another official
      // credential; quota, request, and transport failures must remain real
      // failures instead of multiplying upstream traffic.
      if (failure.code === "official_vision_auth_unavailable" && candidateIndex + 1 < candidates.length) {
        console.warn(
          `[CodexSplit Provider] native vision credential candidate ${candidateIndex + 1} rejected; trying the next official lane`,
        );
        continue;
      }
      throw failure;
    }
    const text = responseTextFromBody(raw, response.headers.get("content-type") || "");
    if (!text) {
      throw new NativeVisionBridgeError(
        "official_vision_request_failed",
        `官方视觉模型 ${NATIVE_VISION_MODEL} 没有返回图片分析文本。`,
        response.status,
      );
    }
    return { model: NATIVE_VISION_MODEL, text, imageCount: images.length };
  }

  throw lastError || new NativeVisionBridgeError(
    "official_vision_auth_unavailable",
    `无法调用官方视觉模型 ${NATIVE_VISION_MODEL}：没有可用的原生 ChatGPT 订阅凭证。`,
  );
}

function visionTextPart(text: string): Record<string, string> {
  return {
    type: "input_text",
    text: `[官方视觉分析（${NATIVE_VISION_MODEL}）]\n${text.trim()}`,
  };
}

function normalizeChatTextParts(value: any, role = ""): any {
  if (!Array.isArray(value)) return value;
  const parts = value.map((part) => {
    if (!part || typeof part !== "object") return part;
    const type = cleanString(part.type).toLowerCase();
    if (type === "input_text" || type === "output_text") {
      return { ...part, type: "text" };
    }
    return part;
  });

  // Chat tool messages are text-only in the provider contract. Do not leave
  // a multimodal array here after replacing an old screenshot; otherwise
  // Console Go reports `content` as "Input should be a valid string".
  if (role === "tool") {
    return parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return parts;
}

function normalizeChatMessagesAfterVision(value: any): any {
  if (!Array.isArray(value)) return value;
  return value.map((message) => {
    if (!message || typeof message !== "object") return message;
    return {
      ...message,
      ...(Object.prototype.hasOwnProperty.call(message, "content")
        ? { content: normalizeChatTextParts(message.content, cleanString(message.role).toLowerCase()) }
        : {}),
    };
  });
}

function normalizeTextOnlyChatContent(value: any, role = ""): any {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: any[] = [];
    for (const part of value) {
      if (typeof part === "string") {
        if (part) parts.push({ type: "text", text: part });
        continue;
      }
      if (!part || typeof part !== "object") continue;
      const type = cleanString(part.type).toLowerCase();
      if (["input_text", "output_text", "text"].includes(type) && typeof part.text === "string") {
        parts.push({ ...part, type: "text" });
        continue;
      }
      // Keep non-text values intact here so the caller can reject an image
      // explicitly instead of silently discarding it.
      parts.push(part);
    }
    if (role === "tool") {
      return parts
        .map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")
        .join("");
    }
    return parts.length > 0 ? parts : "";
  }
  if (value && typeof value === "object") {
    const type = cleanString(value.type).toLowerCase();
    if (["input_text", "output_text", "text"].includes(type) && typeof value.text === "string") {
      return { ...value, type: "text" };
    }
  }
  return value ?? "";
}

/** Normalize a Chat payload after native vision has removed all images. */
export function normalizeTextOnlyProviderChatPayload(body: any): any {
  const visit = (value: any, depth = 0): any => {
    if (depth > 20 || value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (typeof value !== "object") return value;
    const next: Record<string, any> = { ...value };
    for (const [key, child] of Object.entries(value)) {
      if (key === "messages" && Array.isArray(child)) {
        next[key] = child.map((message: any) => {
          if (!message || typeof message !== "object") return message;
          return {
            ...message,
            ...(Object.prototype.hasOwnProperty.call(message, "content")
              ? { content: normalizeTextOnlyChatContent(message.content, cleanString(message.role).toLowerCase()) }
              : {}),
          };
        });
      } else if (key === "request" || key === "body") {
        next[key] = visit(child, depth + 1);
      }
    }
    return next;
  };
  return visit(body);
}

const TEXT_ONLY_IMAGE_INSPECTION_TOOLS = new Set([
  "view_image",
  "view_image_tool",
  "image_view",
  "open_image",
]);

function toolName(value: any): string {
  return cleanString(value?.function?.name || value?.name).toLowerCase();
}

/**
 * Once an image has been converted by the native vision sidecar, a text-only
 * provider must not try to inspect the same image again through a local image
 * tool. That fallback cannot see the provider's original attachment and can
 * leave the turn waiting on a tool result. Keep ordinary command and browser
 * tools intact; this only removes image-inspection tools from this image turn.
 */
export function stripImageInspectionToolsForTextOnlyTurn(body: any): any {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const next: Record<string, any> = { ...body };
  if (Array.isArray(body.tools)) {
    next.tools = body.tools.filter((tool: any) => !TEXT_ONLY_IMAGE_INSPECTION_TOOLS.has(toolName(tool)));
  }
  for (const key of ["request", "body"]) {
    if (body[key] && typeof body[key] === "object") {
      next[key] = stripImageInspectionToolsForTextOnlyTurn(body[key]);
    }
  }
  return next;
}

/** Fail closed if a text-only provider still contains a native image part. */
export function assertNoNativeVisionImages(body: any): void {
  if (hasNativeVisionImages(body)) {
    throw new NativeVisionBridgeError(
      "official_vision_request_failed",
      `图片尚未完成原生视觉转换，已阻止将原始图片发送给文本模型 ${NATIVE_VISION_MODEL}。`,
    );
  }
}

function rewriteImages(value: any, text: string, state: { inserted: boolean }, depth = 0): any {
  if (depth > 20) return value;
  if (typeof value === "string" && /^data:image\//i.test(value.trim())) {
    if (state.inserted) return undefined;
    state.inserted = true;
    return visionTextPart(text);
  }
  if (isImagePart(value)) {
    if (state.inserted) return undefined;
    state.inserted = true;
    return visionTextPart(text);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => rewriteImages(item, text, state, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
      const next = rewriteImages(child, text, state, depth + 1);
      if (next !== undefined) result[key] = next;
    }
    return result;
  }
  return value;
}

/** Replace all request images with one native-vision text result. */
export function replaceImagesWithNativeVisionText(requestBody: any, visionText: string): any {
  const state = { inserted: false };
  const next = requestBody && typeof requestBody === "object"
    ? { ...requestBody }
    : requestBody;
  for (const key of ["input", "messages", "attachments", "content", "request", "body"]) {
    if (!next || !Object.prototype.hasOwnProperty.call(next, key)) continue;
    next[key] = rewriteImages(next[key], visionText, state);
  }
  if (next && Object.prototype.hasOwnProperty.call(next, "messages")) {
    next.messages = normalizeChatMessagesAfterVision(next.messages);
  }
  if (next?.request && typeof next.request === "object" && Object.prototype.hasOwnProperty.call(next.request, "messages")) {
    next.request.messages = normalizeChatMessagesAfterVision(next.request.messages);
  }
  return next;
}
