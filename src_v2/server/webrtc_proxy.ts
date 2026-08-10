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

function accountPoolProfileRoot(): string {
  return path.join(process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex"), "chatgpt-accounts");
}

function accountPoolSettingsPath(): string {
  return path.join(process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex"), "chatgpt_account_settings.json");
}

export type RealtimeProxyOptions = {
  /** The bearer token installed in Codex config for the local gateway. */
  localAdminToken?: string;
  /** Test-only override; production reads the native Codex access token. */
  nativeAccessToken?: string;
  /** Official account identity selected by the outer OpenCodex egress. */
  nativeAccountId?: string;
  /** Replace even a real bearer supplied by native Codex. */
  forceNativeAccessToken?: boolean;
  /** Rewrite the local request URL before resolving the official upstream. */
  requestUrl?: string;
  /** The caller has already established that this is native Live traffic. */
  forceNativeSession?: boolean;
  /** Add the native V3 Live sideband protocol header at the local egress. */
  nativeLiveSideband?: boolean;
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

type NativeAccountCredential = {
  token: string;
  upstreamId: string;
};

function configuredFixedAccountId(): string {
  try {
    const settings = JSON.parse(fs.readFileSync(accountPoolSettingsPath(), "utf8"));
    if (settings?.rotation_enabled !== true || settings?.mode !== "fixed") return "";
    const accountId = typeof settings?.default_account_id === "string" ? settings.default_account_id.trim() : "";
    return accountId && !/[^a-zA-Z0-9._-]/.test(accountId) ? accountId : "";
  } catch {
    return "";
  }
}

function readAccountPoolCredential(accountId: string): NativeAccountCredential {
  const normalized = String(accountId || "").trim();
  if (!normalized || /[^a-zA-Z0-9._-]/.test(normalized)) return { token: "", upstreamId: "" };
  const root = accountPoolProfileRoot();
  const candidates = [path.join(root, normalized)];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !candidates.includes(path.join(root, entry.name))) {
        candidates.push(path.join(root, entry.name));
      }
    }
  } catch {
    return { token: "", upstreamId: "" };
  }
  for (const profile of candidates) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(profile, "auth.json"), "utf8"));
      const profileAccountId = typeof auth?.tokens?.account_id === "string" ? auth.tokens.account_id.trim() : "";
      if (profileAccountId !== normalized && path.basename(profile) !== normalized) continue;
      const token = typeof auth?.tokens?.access_token === "string" ? auth.tokens.access_token.trim() : "";
      if (token) return { token, upstreamId: profileAccountId };
    } catch {
      // An incomplete isolated profile is not a usable credential.
    }
  }
  return { token: "", upstreamId: "" };
}

function readNativeAccountCredential(accountId = ""): NativeAccountCredential {
  const requested = String(accountId || "").trim() || configuredFixedAccountId();
  const accountCredential = readAccountPoolCredential(requested);
  if (accountCredential.token) return accountCredential;
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf-8"));
    return {
      token: typeof auth?.tokens?.access_token === "string" ? auth.tokens.access_token.trim() : "",
      upstreamId: typeof auth?.tokens?.account_id === "string" ? auth.tokens.account_id.trim() : "",
    };
  } catch {
    return { token: "", upstreamId: "" };
  }
}

export function readNativeAccessToken(accountId = ""): string {
  return readNativeAccountCredential(accountId).token;
}

function bearerValue(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

export function isLocalOrPlaceholderBearer(value: string, localAdminToken?: string): boolean {
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

function normalizedRealtimePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isLiveCallPath(pathname: string): boolean {
  return normalizedRealtimePath(pathname) === "/v1/live";
}

function isLiveSidebandPath(pathname: string): boolean {
  return normalizedRealtimePath(pathname).startsWith("/v1/live/");
}

function isRealtimeSidebandPath(pathname: string): boolean {
  return normalizedRealtimePath(pathname) === "/v1/realtime";
}

function isNativeChatGptRequest(req: http.IncomingMessage, pathname: string): boolean {
  return Boolean(
    headerValue(req, "chatgpt-account-id")
    || pathname.startsWith("/backend-api/")
  );
}

export function nativeLiveCallTarget(search = ""): string {
  const targetSearch = `${search ? `${search}&` : "?"}intent=quicksilver&architecture=avas`;
  return `https://chatgpt.com/backend-api/codex/realtime/calls${targetSearch}`;
}

/**
 * Native Codex Live V3 exposes the call id in the path. This is distinct from
 * the public API Realtime WebSocket, which uses `/v1/realtime?call_id=...`.
 */
export function nativeLiveSidebandTarget(pathname: string, search = ""): string {
  const normalizedPath = normalizedRealtimePath(pathname);
  return `https://api.openai.com${normalizedPath}${search ? (search.startsWith("?") ? search : `?${search}`) : ""}`;
}

export function copyNativeRequestHeaders(req: http.IncomingMessage, options: RealtimeProxyOptions = {}, nativeSession = true): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "upgrade") continue;
    // The gateway decodes request bodies before replaying them upstream. Do
    // not forward the original content-encoding or the upstream will try to
    // decompress an already-decoded JSON body and answer with a generic 400.
    if (lowerKey === "content-length" || lowerKey === "transfer-encoding" || lowerKey === "content-encoding") continue;
    if (lowerKey.startsWith("sec-websocket-")) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value === "string") headers[key] = value;
  }

  const incomingAuthorization = headerValue(req, "authorization");
  const incomingAccountId = headerValue(req, "chatgpt-account-id");
  const nativeCredential = options.nativeAccessToken
    ? { token: options.nativeAccessToken, upstreamId: options.nativeAccountId || "" }
    : readNativeAccountCredential(incomingAccountId);
  const nativeToken = nativeCredential.token;
  const shouldReplaceNativeToken = options.forceNativeAccessToken === true
    || isLocalOrPlaceholderBearer(incomingAuthorization, options.localAdminToken);
  if (nativeSession && nativeToken && shouldReplaceNativeToken) {
    headers.authorization = `Bearer ${nativeToken}`;
  } else if (shouldReplaceNativeToken) {
    delete headers.authorization;
  }
  if (options.nativeAccountId) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "chatgpt-account-id") delete headers[key];
    }
    headers["chatgpt-account-id"] = options.nativeAccountId;
  } else if (nativeSession && shouldReplaceNativeToken && nativeCredential.upstreamId && !incomingAccountId) {
    headers["chatgpt-account-id"] = nativeCredential.upstreamId;
  }
  if (options.nativeLiveSideband) {
    headers["openai-alpha"] = "quicksilver=v2";
  }
  return headers;
}

export function resolveRealtimeUpstream(req: http.IncomingMessage, options: RealtimeProxyOptions = {}): RealtimeUpstream {
  const url = new URL(options.requestUrl || req.url || "/", `http://${req.headers.host || "localhost"}`);
  const incomingAuthorization = headerValue(req, "authorization");
  const nativeAccessToken = options.nativeAccessToken || readNativeAccessToken(headerValue(req, "chatgpt-account-id"));
  const localBearer = isLocalOrPlaceholderBearer(incomingAuthorization, options.localAdminToken);
  const websocketRequest = req.method === "GET"
    || req.headers.upgrade?.toLowerCase() === "websocket"
    || (req.headers.connection || "").toLowerCase().includes("upgrade");
  const explicitNativeSession = options.forceNativeSession === true;
  const nativeLiveCall = isLiveCallPath(url.pathname)
    && !websocketRequest
    && (explicitNativeSession || isNativeChatGptRequest(req, url.pathname) || (Boolean(nativeAccessToken) && localBearer));
  const nativeLiveSideband = (isLiveSidebandPath(url.pathname)
    || (isRealtimeSidebandPath(url.pathname) && websocketRequest)
    || (isLiveCallPath(url.pathname) && websocketRequest))
    && (explicitNativeSession || isNativeChatGptRequest(req, url.pathname) || (Boolean(nativeAccessToken) && localBearer));
  const nativeSession = isNativeChatGptRequest(req, url.pathname) || nativeLiveCall || nativeLiveSideband;
  const targetHost = nativeLiveSideband ? "api.openai.com" : (nativeSession ? "chatgpt.com" : "api.openai.com");
  const targetPath = nativeLiveCall
    ? "/backend-api/codex/realtime/calls"
    : (nativeSession ? nativeBackendPath(url.pathname) : url.pathname);
  const targetUrl = nativeLiveCall
    ? nativeLiveCallTarget(url.search)
    : (nativeLiveSideband ? nativeLiveSidebandTarget(url.pathname, url.search) : `https://${targetHost}${targetPath}${url.search}`);
  return {
    targetUrl,
    targetHost,
    targetPath,
    nativeSession,
    nativeLiveCall,
    headers: copyNativeRequestHeaders(req, {
      ...options,
      nativeLiveSideband: options.nativeLiveSideband || nativeLiveSideband,
    }, nativeSession),
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
  const target = new URL(upstream.targetUrl);
  // The provider bridge speaks JSONL on stdout to the native app-server.
  // Never write transport diagnostics there: one plain-text line makes the
  // Desktop parser drop subsequent child/realtime lifecycle messages.
  console.error(`[OpenCodex WebRTC Proxy] Proxying ${upstream.nativeSession ? "native ChatGPT" : "API"} WebSocket signal to wss://${upstream.targetHost}${target.pathname}${target.search}`);

  const targetSocket = tls.connect({
    host: upstream.targetHost,
    port: 443,
    servername: upstream.targetHost,
    rejectUnauthorized: true,
  }, () => {
    let reqLines = `${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n`;
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
