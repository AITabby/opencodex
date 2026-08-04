import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;
// The caller owns the per-request timeout through attemptSignal().  The
// dispatcher-level header timeout must not be shorter than the native
// Responses compaction timeout, otherwise a valid but slow compaction request
// is aborted after 30 seconds before the caller's 10-minute budget applies.
export const MAX_UPSTREAM_HEADERS_TIMEOUT_MS = 600_000;
// Keep the gateway's HTTP client on HTTP/1.1. Native Codex already owns the
// native transport; the gateway must not introduce a separate HTTP/2 session
// whose stream lifecycle differs from the native client.
export const UPSTREAM_ALLOW_H2 = false;

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Keep upstream connections bounded and short-lived enough that a provider or
 * VPN cannot leave a stale keep-alive socket in the pool for a long time.
 * Pipelining stays disabled because these are mostly streaming POST requests.
 */
export const upstreamAgent = new Agent({
  connections: 8,
  pipelining: 1,
  allowH2: UPSTREAM_ALLOW_H2,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  maxRequestsPerClient: 100,
  connectTimeout: 10_000,
  headersTimeout: MAX_UPSTREAM_HEADERS_TIMEOUT_MS,
  // Streaming responses have their own idle timeout in the caller.
  bodyTimeout: 0,
});

// Keep the dispatcher and fetch implementation inside the same bundled
// undici instance. Passing an Agent through RequestInit can cross a Node
// built-in-undici boundary under PM2 and fail before network I/O with
// `invalid onRequestStart method`.
setGlobalDispatcher(upstreamAgent);

export type UpstreamFetchOptions = RequestInit & {
  /** Human-readable operation name for diagnostics; never includes credentials. */
  operation?: string;
  /** Maximum number of attempts including the first request. */
  maxAttempts?: number;
  /** Timeout for each connect/headers attempt. Streaming body is not limited here. */
  timeoutMs?: number;
  /** Base delay for exponential backoff. Set to zero in deterministic tests. */
  retryDelayMs?: number;
  /** Injection point for unit tests. */
  fetchImpl?: typeof fetch;
};

export class UpstreamFetchError extends Error {
  readonly target: string;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(target: string, attempts: number, cause: unknown, retryable = true) {
    super("fetch failed", { cause });
    this.name = "UpstreamFetchError";
    this.target = target;
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

function safeTarget(rawTarget: string): string {
  try {
    const url = new URL(rawTarget);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function errorCause(error: unknown): any {
  if (!error || typeof error !== "object") return undefined;
  return (error as any).cause || error;
}

export function upstreamErrorDetails(error: unknown): {
  message: string;
  code?: string;
  syscall?: string;
  hostname?: string;
  cause?: string;
} {
  const raw = error as any;
  const cause = errorCause(error);
  return {
    message: String(raw?.message || cause?.message || error || "unknown error"),
    code: typeof cause?.code === "string" ? cause.code : undefined,
    syscall: typeof cause?.syscall === "string" ? cause.syscall : undefined,
    hostname: typeof cause?.hostname === "string" ? cause.hostname : undefined,
    cause: typeof cause?.message === "string" && cause !== raw ? cause.message : undefined,
  };
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return String((error as any)?.name || "") === "AbortError" || String((error as any)?.code || "") === "ABORT_ERR";
}

export function isRetryableUpstreamError(error: unknown): boolean {
  const details = upstreamErrorDetails(error);
  if (details.code && RETRYABLE_ERROR_CODES.has(details.code)) return true;
  if (String((error as any)?.name || "") === "TimeoutError") return true;
  if (details.message === "upstream headers timeout") return true;
  return details.message === "fetch failed" || details.message.startsWith("fetch failed:");
}

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body === undefined || body === null || typeof body === "string") return true;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return true;
  return typeof Buffer !== "undefined" && Buffer.isBuffer(body);
}

function attemptSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("upstream headers timeout", "TimeoutError")), timeoutMs);
  const abortFromParent = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchUpstream(rawTarget: string, options: UpstreamFetchOptions = {}): Promise<Response> {
  const target = new URL(rawTarget).toString();
  const displayTarget = safeTarget(target);
  const operation = options.operation || "upstream request";
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(options.maxAttempts ?? DEFAULT_ATTEMPTS)));
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  // The dispatcher is created by the bundled undici dependency. Pair it with
  // undici's fetch as well; Node's built-in fetch may use a different
  // embedded undici version and rejects this Agent with `invalid
  // onRequestStart method` before any network request is sent.
  const fetchImpl = options.fetchImpl || (undiciFetch as unknown as typeof fetch);
  const replayableBody = isReplayableBody(options.body);
  const requestInit: RequestInit = { ...options };
  delete (requestInit as any).operation;
  delete (requestInit as any).maxAttempts;
  delete (requestInit as any).timeoutMs;
  delete (requestInit as any).retryDelayMs;
  delete (requestInit as any).fetchImpl;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const currentAttempt = attemptSignal(options.signal, timeoutMs);
    try {
      const response = await fetchImpl(target, {
        ...requestInit,
        signal: currentAttempt.signal,
      } as RequestInit);
      // The attempt timeout is only for connecting and receiving headers. Do
      // not leave it attached to the returned streaming body.
      currentAttempt.cleanup();
      if (attempt > 1) {
        console.info(`[OpenCodex Upstream] recovered operation=${operation} target=${displayTarget} attempt=${attempt} elapsed_ms=${Date.now() - startedAt}`);
      }
      return response;
    } catch (error) {
      currentAttempt.cleanup();
      lastError = error;
      const retryable = replayableBody && isRetryableUpstreamError(error) && !isAbortError(error, options.signal);
      const willRetry = retryable && attempt < maxAttempts;
      const details = upstreamErrorDetails(error);
      console.warn(
        `[OpenCodex Upstream] failed operation=${operation} target=${displayTarget} ` +
        `attempt=${attempt}/${maxAttempts} retry=${willRetry} elapsed_ms=${Date.now() - startedAt} ` +
        `code=${details.code || "unknown"} syscall=${details.syscall || "unknown"} ` +
        `hostname=${details.hostname || "unknown"} cause=${details.cause || details.message}`,
      );
      if (!willRetry) {
        throw new UpstreamFetchError(displayTarget, attempt, error, retryable);
      }
      const delay = retryDelayMs * (2 ** (attempt - 1)) + Math.floor(Math.random() * Math.max(1, retryDelayMs));
      if (delay > 0) await sleep(delay);
    }
  }

  throw new UpstreamFetchError(displayTarget, maxAttempts, lastError, true);
}

export async function closeUpstreamDispatcher(): Promise<void> {
  await upstreamAgent.close();
}
