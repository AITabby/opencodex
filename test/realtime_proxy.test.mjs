import test from "node:test";
import assert from "node:assert/strict";
import { resolveRealtimeUpstream } from "../dist/server/webrtc_proxy.js";

function request(url, headers = {}) {
  return { url, headers };
}

test("native ChatGPT Realtime requests keep the global gateway but use the native backend route", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/realtime/calls", {
      host: "127.0.0.1:8765",
      "chatgpt-account-id": "account-id",
      authorization: "Bearer gateway-token",
      origin: "app://-",
    }),
    { localAdminToken: "gateway-token", nativeAccessToken: "native-token" },
  );

  assert.equal(upstream.nativeSession, true);
  assert.equal(upstream.targetUrl, "https://chatgpt.com/backend-api/codex/realtime/calls");
  assert.equal(upstream.headers.authorization, "Bearer native-token");
  assert.equal(upstream.headers.origin, "app://-");
  assert.equal(upstream.headers.host, undefined);
});

test("API Realtime requests remain on api.openai.com and preserve a real API bearer", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/realtime", {
      host: "127.0.0.1:8765",
      authorization: "Bearer sk-test-key",
    }),
    { localAdminToken: "gateway-token", nativeAccessToken: "native-token" },
  );

  assert.equal(upstream.nativeSession, false);
  assert.equal(upstream.targetUrl, "https://api.openai.com/v1/realtime");
  assert.equal(upstream.headers.authorization, "Bearer sk-test-key");
});

test("the local gateway bearer is never forwarded as an upstream Realtime credential", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/realtime", {
      host: "127.0.0.1:8765",
      authorization: "Bearer gateway-token",
    }),
    { localAdminToken: "gateway-token" },
  );

  assert.equal(upstream.headers.authorization, undefined);
});

test("an already native backend path is not double-prefixed", () => {
  const upstream = resolveRealtimeUpstream(
    request("/backend-api/codex/realtime", {
      host: "127.0.0.1:8765",
      "chatgpt-account-id": "account-id",
    }),
    { nativeAccessToken: "native-token" },
  );

  assert.equal(upstream.targetUrl, "https://chatgpt.com/backend-api/codex/realtime");
});
