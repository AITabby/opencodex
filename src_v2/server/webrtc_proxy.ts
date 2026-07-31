/**
 * WebRTC / Realtime Signaling Proxy Engine for OpenCodex Gateway V2
 * Transparently proxies WebSocket & HTTP WebRTC signaling requests to api.openai.com
 * with native-session routing/auth isolation and duplex streaming.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { URL } from "node:url";

const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");

export type RealtimeProxyOptions = {
  /** Current and grace-period bearer tokens accepted by the local gateway. */
  localGatewayTokens?: string[];
  /** Test-only override; production reads the native Codex access token. */
  nativeAccessToken?: string;
};

export type RealtimeUpstream = {
  targetUrl: string;
  targetHost: string;
  targetPath: string;
  nativeSession: boolean;
  nativeLiveCall: boolean;
  headers: Record<string, string>;
};

function headerValue(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

export function readNativeAccessToken(): string {
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf-8"));
    return typeof auth?.tokens?.access_token === "string" ? auth.tokens.access_token.trim() : "";
  } catch {
    return "";
  }
}

function bearerValue(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

function isLocalGatewayBearer(value: string, localGatewayTokens: string[] = []): boolean {
  const token = bearerValue(value);
  return Boolean(token && localGatewayTokens.some((candidate) => candidate === token));
}

function nativeBackendPath(pathname: string): string {
  if (pathname.startsWith("/backend-api/")) return pathname;
  let subPath = pathname;
  if (subPath.startsWith("/v1/")) subPath = subPath.slice(4);
  subPath = subPath.replace(/^\/+/, "");
  if (!subPath.startsWith("codex/")) subPath = `codex/${subPath}`;
  return `/backend-api/${subPath}`;
}

function isLiveCallPath(pathname: string): boolean {
  return pathname === "/v1/live";
}

function isLiveSidebandPath(pathname: string): boolean {
  return pathname.startsWith("/v1/live/");
}

function isNativeChatGptRequest(req: http.IncomingMessage, pathname: string): boolean {
  return Boolean(
    headerValue(req, "chatgpt-account-id")
    || pathname.startsWith("/backend-api/")
  );
}

function copyRequestHeaders(req: http.IncomingMessage, options: RealtimeProxyOptions, nativeSession: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "upgrade") continue;
    if (lowerKey === "content-length" || lowerKey === "transfer-encoding") continue;
    if (lowerKey === "cookie" || lowerKey === "proxy-authorization" || lowerKey === "x-opencodex-token") continue;
    if (lowerKey.startsWith("sec-websocket-")) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value === "string") headers[key] = value;
  }

  const incomingAuthorization = headerValue(req, "authorization");
  const nativeToken = options.nativeAccessToken || readNativeAccessToken();
  if (nativeSession && nativeToken && isLocalGatewayBearer(incomingAuthorization, options.localGatewayTokens)) {
    headers.authorization = `Bearer ${nativeToken}`;
  } else if (isLocalGatewayBearer(incomingAuthorization, options.localGatewayTokens)) {
    delete headers.authorization;
  }
  return headers;
}

export function resolveRealtimeUpstream(req: http.IncomingMessage, options: RealtimeProxyOptions = {}): RealtimeUpstream {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const incomingAuthorization = headerValue(req, "authorization");
  const nativeAccessToken = options.nativeAccessToken || readNativeAccessToken();
  const localBearer = isLocalGatewayBearer(incomingAuthorization, options.localGatewayTokens);
  const nativeLiveCall = isLiveCallPath(url.pathname)
    && (isNativeChatGptRequest(req, url.pathname) || (Boolean(nativeAccessToken) && localBearer));
  const nativeLiveSideband = isLiveSidebandPath(url.pathname)
    && (isNativeChatGptRequest(req, url.pathname) || (Boolean(nativeAccessToken) && localBearer));
  const nativeSession = isNativeChatGptRequest(req, url.pathname) || nativeLiveCall || nativeLiveSideband;
  const targetHost = nativeLiveSideband ? "api.openai.com" : (nativeSession ? "chatgpt.com" : "api.openai.com");
  const targetPath = nativeLiveCall
    ? "/backend-api/codex/realtime/calls"
    : (nativeSession && !nativeLiveSideband ? nativeBackendPath(url.pathname) : url.pathname);
  const targetSearch = nativeLiveCall
    ? `${url.search ? `${url.search}&` : "?"}intent=quicksilver&architecture=avas`
    : url.search;
  const targetUrl = `https://${targetHost}${targetPath}${targetSearch}`;
  return {
    targetUrl,
    targetHost,
    targetPath,
    nativeSession,
    nativeLiveCall,
    headers: copyRequestHeaders(req, options, nativeSession),
  };
}

/**
 * Codex's API-shaped Frameless Realtime client sends `/v1/live` as a
 * multipart request. ChatGPT-authenticated Codex uses the backend's JSON
 * `{sdp, session}` shape instead. Normalize only that native create-call
 * request; ordinary OpenAI API Realtime traffic remains untouched.
 */
export function normalizeNativeLiveCallBody(rawBody: Buffer, contentType: string): Buffer {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  if (!boundaryMatch) {
    throw new Error("native /v1/live request is missing a multipart boundary");
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const marker = `--${boundary}`;
  const parts = rawBody.toString("utf8").split(marker);
  let sdp = "";
  let session: unknown;
  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r?\n/, "");
    if (!part.trim() || part.trim() === "--") continue;
    const separator = part.indexOf("\r\n\r\n");
    const alternateSeparator = part.indexOf("\n\n");
    const splitAt = separator >= 0 ? separator : alternateSeparator;
    if (splitAt < 0) continue;
    const headers = part.slice(0, splitAt).toLowerCase();
    let value = part.slice(splitAt + (separator >= 0 ? 4 : 2));
    // The CRLF immediately before the next multipart boundary is framing,
    // while any preceding CRLF belongs to the SDP itself.
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    const name = /name="([^"]+)"/i.exec(headers)?.[1];
    if (name === "sdp") sdp = value;
    if (name === "session") {
      try {
        session = JSON.parse(value);
      } catch {
        throw new Error("native /v1/live session part is not valid JSON");
      }
    }
  }
  if (!sdp || !session || typeof session !== "object") {
    throw new Error("native /v1/live multipart body must contain sdp and session parts");
  }
  return Buffer.from(JSON.stringify({ sdp, session }), "utf8");
}

export function handleWebRtcProxy(req: http.IncomingMessage, socket: any, head: Buffer, options: RealtimeProxyOptions = {}): void {
  const upstream = resolveRealtimeUpstream(req, options);
  console.log(`[OpenCodex WebRTC Proxy] Proxying ${upstream.nativeSession ? "native ChatGPT" : "API"} WebSocket signal to wss://${upstream.targetHost}${upstream.targetPath}`);

  const targetSocket = tls.connect({
    host: upstream.targetHost,
    port: 443,
    servername: upstream.targetHost,
    rejectUnauthorized: true,
  }, () => {
    let reqLines = `${req.method} ${upstream.targetPath}${new URL(req.url || "/", "http://127.0.0.1").search} HTTP/1.1\r\n`;
    reqLines += `Host: ${upstream.targetHost}\r\n`;
    reqLines += "Connection: Upgrade\r\nUpgrade: websocket\r\n";
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) reqLines += `${key}: ${item}\r\n`;
      } else if (value) {
        reqLines += `${key}: ${value}\r\n`;
      }
    }
    for (const [key, value] of Object.entries(req.headers)) {
      if (!key.toLowerCase().startsWith("sec-websocket-")) continue;
      if (Array.isArray(value)) {
        for (const item of value) reqLines += `${key}: ${item}\r\n`;
      } else if (value) {
        reqLines += `${key}: ${value}\r\n`;
      }
    }
    reqLines += "\r\n";

    targetSocket.write(reqLines);
    if (head && head.length > 0) targetSocket.write(head);
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  targetSocket.on("error", (err) => {
    console.error(`[OpenCodex WebRTC Proxy Error] ${err.message}`);
    try { socket.destroy(); } catch {}
  });
  targetSocket.on("close", () => {
    try { socket.destroy(); } catch {}
  });
  socket.on("error", () => {
    try { targetSocket.destroy(); } catch {}
  });
  socket.on("close", () => {
    try { targetSocket.destroy(); } catch {}
  });
}
