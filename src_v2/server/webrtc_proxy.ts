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
  /** The bearer token installed in Codex config for the local gateway. */
  localAdminToken?: string;
  /** Test-only override; production reads the native Codex access token. */
  nativeAccessToken?: string;
};

export type RealtimeUpstream = {
  targetUrl: string;
  targetHost: string;
  targetPath: string;
  nativeSession: boolean;
  headers: Record<string, string>;
};

function headerValue(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function readNativeAccessToken(): string {
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

function isLocalOrPlaceholderBearer(value: string, localAdminToken?: string): boolean {
  const token = bearerValue(value);
  if (!token) return true;
  if (localAdminToken && token === localAdminToken) return true;
  return /dummy|opencodex/i.test(token);
}

function nativeBackendPath(pathname: string): string {
  if (pathname.startsWith("/backend-api/")) return pathname;
  let subPath = pathname;
  if (subPath.startsWith("/v1/")) subPath = subPath.slice(4);
  subPath = subPath.replace(/^\/+/, "");
  if (!subPath.startsWith("codex/")) subPath = `codex/${subPath}`;
  return `/backend-api/${subPath}`;
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
    if (lowerKey.startsWith("sec-websocket-")) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value === "string") headers[key] = value;
  }

  const incomingAuthorization = headerValue(req, "authorization");
  const nativeToken = options.nativeAccessToken || readNativeAccessToken();
  if (nativeSession && nativeToken && isLocalOrPlaceholderBearer(incomingAuthorization, options.localAdminToken)) {
    headers.authorization = `Bearer ${nativeToken}`;
  } else if (isLocalOrPlaceholderBearer(incomingAuthorization, options.localAdminToken)) {
    delete headers.authorization;
  }
  return headers;
}

export function resolveRealtimeUpstream(req: http.IncomingMessage, options: RealtimeProxyOptions = {}): RealtimeUpstream {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const nativeSession = isNativeChatGptRequest(req, url.pathname);
  const targetHost = nativeSession ? "chatgpt.com" : "api.openai.com";
  const targetPath = nativeSession ? nativeBackendPath(url.pathname) : url.pathname;
  const targetUrl = `https://${targetHost}${targetPath}${url.search}`;
  return {
    targetUrl,
    targetHost,
    targetPath,
    nativeSession,
    headers: copyRequestHeaders(req, options, nativeSession),
  };
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
    let reqLines = `${req.method} ${upstream.targetPath}${new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).search} HTTP/1.1\r\n`;
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
