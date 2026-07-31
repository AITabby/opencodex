import http from "node:http";
import { fetchUpstream } from "../services/upstream_fetch.js";

const LOCAL_REQUEST_FIELDS = [
  "protocol",
  "client_metadata",
  "session_id",
  "turn_id",
] as const;

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function safeDiagnosticTarget(target: string): string {
  try {
    const url = new URL(target);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid upstream URL]";
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "Unknown upstream error");
  return message
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,})/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

export type NativeResponsesFetcher = typeof fetchUpstream;

export type NativeResponsesProxyRequest = {
  reqBody: any;
  upstreamModel: string;
  apiKey: string;
  providerUrl: string;
  providerName?: string;
  res: http.ServerResponse;
  fetcher?: NativeResponsesFetcher;
};

export function normalizeResponsesEndpoint(providerUrl: string): string {
  const url = new URL(providerUrl);
  let pathname = url.pathname.replace(/\/+$/, "");

  if (/\/v1\/responses$/i.test(pathname)) {
    url.pathname = pathname.replace(/\/v1\/responses$/i, "/responses");
  } else if (/\/responses$/i.test(pathname)) {
    url.pathname = pathname;
  } else {
    pathname = pathname.replace(/\/chat\/completions$/i, "");
    pathname = pathname.replace(/\/v1$/i, "");
    url.pathname = `${pathname}/responses`.replace(/\/{2,}/g, "/");
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function buildNativeResponsesPayload(reqBody: any, upstreamModel: string): any {
  const payload = reqBody && typeof reqBody === "object" && !Array.isArray(reqBody)
    ? { ...reqBody }
    : {};

  for (const field of LOCAL_REQUEST_FIELDS) delete payload[field];
  payload.model = upstreamModel;
  if (typeof payload.stream !== "boolean") payload.stream = true;
  return payload;
}

function copyResponseHeaders(upstream: Response, res: http.ServerResponse): void {
  for (const [name, value] of upstream.headers.entries()) {
    const normalized = name.toLowerCase();
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(normalized)) {
      res.setHeader(name, value);
    }
  }
  if (!upstream.headers.has("cache-control")) res.setHeader("Cache-Control", "no-store");
}

async function pipeBody(upstream: Response, res: http.ServerResponse): Promise<void> {
  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) res.write(Buffer.from(value));
    }
    if (!res.writableEnded) res.end();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Proxy a Responses request without projecting it through Chat Completions.
 * Semantic SSE events, keep-alive comments, terminal events, status codes,
 * and usage payloads are relayed exactly as the provider returned them.
 */
export async function proxyNativeResponses({
  reqBody,
  upstreamModel,
  apiKey,
  providerUrl,
  providerName = "provider",
  res,
  fetcher = fetchUpstream,
}: NativeResponsesProxyRequest): Promise<void> {
  const targetUrl = normalizeResponsesEndpoint(providerUrl);
  const payload = buildNativeResponsesPayload(reqBody, upstreamModel);
  const controller = new AbortController();
  const abortOnClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", abortOnClose);

  try {
    const upstream = await fetcher(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: payload.stream ? "text/event-stream" : "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      maxAttempts: 1,
      timeoutMs: 120_000,
      operation: `native-responses:${providerName}`,
    });

    console.info(
      `[OpenCodex Provider] response provider=${providerName} model=${upstreamModel} ` +
      `protocol=responses target=${safeDiagnosticTarget(targetUrl)} status=${upstream.status}`,
    );

    copyResponseHeaders(upstream, res);
    res.statusCode = upstream.status;
    await pipeBody(upstream, res);
  } catch (error) {
    console.error(
      `[OpenCodex Provider] native Responses transport failed provider=${providerName} ` +
      `model=${upstreamModel} target=${safeDiagnosticTarget(targetUrl)} error=${safeErrorMessage(error)}`,
    );
    if (!res.headersSent) {
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        error: {
          type: "upstream_unreachable",
          message: "Unable to reach the provider Responses API",
        },
      }));
    } else if (!res.writableEnded) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    res.removeListener("close", abortOnClose);
  }
}

export type DeepSeekResponsesProbe = {
  model: string;
  ok: boolean;
  status: number;
  message: string;
};

export async function probeDeepSeekResponsesModels(
  apiKey: string,
  models: readonly string[],
  providerUrl: string,
  fetcher: NativeResponsesFetcher = fetchUpstream,
): Promise<DeepSeekResponsesProbe[]> {
  const targetUrl = normalizeResponsesEndpoint(providerUrl);
  const results: DeepSeekResponsesProbe[] = [];

  for (const model of models) {
    try {
      const response = await fetcher(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: "Reply with OK.",
          max_output_tokens: 16,
          stream: false,
        }),
        maxAttempts: 1,
        timeoutMs: 120_000,
        operation: `deepseek-responses-probe:${model}`,
      });
      const raw = await response.text();
      let parsed: any;
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
      const validResponse = response.ok && parsed?.object === "response";
      const upstreamMessage = parsed?.error?.message || parsed?.message;
      results.push({
        model,
        ok: validResponse,
        status: response.status,
        message: validResponse
          ? "Responses API verified"
          : safeErrorMessage(upstreamMessage || `Unexpected Responses payload (HTTP ${response.status})`),
      });
    } catch (error) {
      results.push({
        model,
        ok: false,
        status: 0,
        message: safeErrorMessage(error),
      });
    }
  }

  return results;
}
