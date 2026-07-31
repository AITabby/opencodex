import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWebSocketPath,
  isAllowedGatewayHost,
  isAllowedGatewayOrigin,
  isProtectedGatewayPath,
  isRealtimeProxyPath,
  requiredCapabilitiesForHttp,
  requiredCapabilitiesForWebSocket,
} from "../dist/server/security_boundary.js";

const port = 8765;

test("gateway Host validation only accepts the current loopback authority", () => {
  assert.equal(isAllowedGatewayHost("127.0.0.1:8765", port), true);
  assert.equal(isAllowedGatewayHost("localhost:8765", port), true);
  assert.equal(isAllowedGatewayHost("LOCALHOST:8765", port), true);

  assert.equal(isAllowedGatewayHost(undefined, port), false);
  assert.equal(isAllowedGatewayHost("attacker.example:8765", port), false);
  assert.equal(isAllowedGatewayHost("127.0.0.1:9999", port), false);
  assert.equal(isAllowedGatewayHost("127.0.0.1:8765.attacker.example", port), false);
  assert.equal(isAllowedGatewayHost("127.0.0.1:8765 ", port), false);
});

test("gateway Origin validation allows native clients and exact same-origin callers", () => {
  assert.equal(isAllowedGatewayOrigin(undefined, port), true);
  assert.equal(isAllowedGatewayOrigin("app://-", port), true);
  assert.equal(isAllowedGatewayOrigin("http://127.0.0.1:8765", port), true);
  assert.equal(isAllowedGatewayOrigin("http://localhost:8765", port), true);

  assert.equal(isAllowedGatewayOrigin("null", port), false);
  assert.equal(isAllowedGatewayOrigin("https://attacker.example", port), false);
  assert.equal(isAllowedGatewayOrigin("http://localhost:8765.attacker.example", port), false);
  assert.equal(isAllowedGatewayOrigin("http://localhost:9999", port), false);
});

test("every data and proxy namespace is protected", () => {
  for (const pathname of [
    "/api",
    "/api/providers",
    "/v1",
    "/v1/responses",
    "/responses",
    "/responses/stream",
    "/backend-api",
    "/backend-api/codex/realtime",
  ]) {
    assert.equal(isProtectedGatewayPath(pathname), true, pathname);
  }

  for (const pathname of ["/", "/dashboard", "/health", "/visualizer", "/apiary", "/v10"]) {
    assert.equal(isProtectedGatewayPath(pathname), false, pathname);
  }
});

test("Realtime and WebSocket routing use exact path families", () => {
  for (const pathname of [
    "/v1/realtime",
    "/v1/realtime/calls",
    "/v1/audio",
    "/v1/voice",
    "/v1/live",
    "/v1/live/session",
    "/backend-api",
    "/backend-api/codex/realtime",
  ]) {
    assert.equal(isRealtimeProxyPath(pathname), true, pathname);
    assert.equal(classifyWebSocketPath(pathname), "realtime", pathname);
  }

  assert.equal(classifyWebSocketPath("/ws/voice"), "voice");
  assert.equal(classifyWebSocketPath("/v1/responses"), "responses");
  assert.equal(classifyWebSocketPath("/responses/stream"), "responses");

  for (const pathname of ["/", "/companion", "/ws/voice/extra", "/not-realtime", "/v1/voicemail"]) {
    assert.equal(classifyWebSocketPath(pathname), "unknown", pathname);
  }
});

test("HTTP capabilities are least-privilege and method-specific", () => {
  assert.deepEqual(requiredCapabilitiesForHttp("POST", "/v1/responses"), ["gateway"]);
  assert.deepEqual(requiredCapabilitiesForHttp("GET", "/backend-api/codex/realtime"), ["gateway"]);
  assert.deepEqual(requiredCapabilitiesForHttp("POST", "/api/voice/ask"), ["voice"]);
  assert.deepEqual(requiredCapabilitiesForHttp("GET", "/api/voice-settings"), ["admin"]);
  assert.deepEqual(requiredCapabilitiesForHttp("GET", "/api/sessions"), ["admin", "mobile"]);
  assert.deepEqual(requiredCapabilitiesForHttp("POST", "/api/sessions/detail"), ["admin", "mobile"]);
  assert.deepEqual(requiredCapabilitiesForHttp("POST", "/api/sessions/delete"), ["admin"]);
  assert.deepEqual(requiredCapabilitiesForHttp("GET", "/v1/models"), ["gateway", "mobile"]);
  assert.deepEqual(requiredCapabilitiesForHttp("POST", "/api/mobile/messages"), ["mobile"]);
  assert.deepEqual(requiredCapabilitiesForHttp("GET", "/api/task-events"), ["mobile"]);
  assert.deepEqual(requiredCapabilitiesForHttp("GET", "/api/live-model-picker/pending"), ["admin", "gateway"]);
  assert.deepEqual(requiredCapabilitiesForHttp("POST", "/api/live-model-picker/settings"), ["admin"]);
});

test("WebSocket capabilities separate voice from model traffic", () => {
  assert.deepEqual(requiredCapabilitiesForWebSocket("voice"), ["voice"]);
  assert.deepEqual(requiredCapabilitiesForWebSocket("realtime"), ["gateway"]);
  assert.deepEqual(requiredCapabilitiesForWebSocket("responses"), ["gateway"]);
  assert.deepEqual(requiredCapabilitiesForWebSocket("unknown"), ["admin", "gateway", "voice", "mobile"]);
});
