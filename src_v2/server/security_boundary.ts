/**
 * Local gateway trust boundary.
 *
 * Loopback binding prevents direct network exposure, but browsers can still
 * reach loopback services through DNS rebinding or cross-origin requests.
 * Keep Host, Origin, protected-route, and WebSocket routing decisions in one
 * small module so the HTTP and upgrade paths cannot drift apart.
 */

import type { GatewayCapability } from "./capability_tokens.js";

export type WebSocketRoute = "voice" | "realtime" | "responses" | "unknown";

function isPathFamily(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function isAllowedGatewayHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const normalized = hostHeader.toLowerCase();
  if (normalized !== hostHeader.trim().toLowerCase()) return false;

  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);
  if (port === 80) {
    allowed.add("127.0.0.1");
    allowed.add("localhost");
  }
  return allowed.has(normalized);
}

export function isAllowedGatewayOrigin(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  if (originHeader === "app://-") return true;
  return originHeader === `http://127.0.0.1:${port}`
    || originHeader === `http://localhost:${port}`;
}

export function isProtectedGatewayPath(pathname: string): boolean {
  return isPathFamily(pathname, "/api")
    || isPathFamily(pathname, "/v1")
    || isPathFamily(pathname, "/responses")
    || isPathFamily(pathname, "/backend-api");
}

export function isRealtimeProxyPath(pathname: string): boolean {
  return isPathFamily(pathname, "/v1/realtime")
    || isPathFamily(pathname, "/v1/audio")
    || isPathFamily(pathname, "/v1/voice")
    || isPathFamily(pathname, "/v1/live")
    || isPathFamily(pathname, "/backend-api");
}

export function classifyWebSocketPath(pathname: string): WebSocketRoute {
  if (pathname === "/ws/voice") return "voice";
  if (isPathFamily(pathname, "/v1/responses") || isPathFamily(pathname, "/responses")) {
    return "responses";
  }
  if (isRealtimeProxyPath(pathname)) return "realtime";
  return "unknown";
}

export function requiredCapabilitiesForHttp(method: string | undefined, pathname: string): GatewayCapability[] {
  const normalizedMethod = (method || "GET").toUpperCase();

  if (isPathFamily(pathname, "/api/voice")) return ["voice"];

  if (
    pathname === "/api/live-model-picker/pending"
    || pathname === "/api/live-model-picker/resolve"
    || pathname === "/api/live-model-picker/select"
    || pathname === "/api/live-model-picker/reset"
  ) {
    return ["admin", "gateway"];
  }

  if (
    (normalizedMethod === "GET" && pathname === "/api/sessions")
    || (normalizedMethod === "POST" && pathname === "/api/sessions/detail")
    || (normalizedMethod === "GET" && pathname === "/api/models")
  ) {
    return ["admin", "mobile"];
  }

  if (
    (normalizedMethod === "GET" && pathname === "/api/task-events")
    || (normalizedMethod === "POST" && pathname === "/api/mobile/messages")
  ) {
    return ["mobile"];
  }

  if (normalizedMethod === "GET" && pathname === "/v1/models") {
    return ["gateway", "mobile"];
  }

  if (
    isPathFamily(pathname, "/v1")
    || isPathFamily(pathname, "/responses")
    || isPathFamily(pathname, "/backend-api")
  ) {
    return ["gateway"];
  }

  if (isPathFamily(pathname, "/api")) return ["admin"];
  return [];
}

export function requiredCapabilitiesForWebSocket(route: WebSocketRoute): GatewayCapability[] {
  if (route === "voice") return ["voice"];
  if (route === "realtime" || route === "responses") return ["gateway"];
  return ["admin", "gateway", "voice", "mobile"];
}
