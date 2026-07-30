import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNativeLiveCallBody, resolveRealtimeUpstream } from "../dist/server/webrtc_proxy.js";

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

test("gateway bearer native Live call uses the ChatGPT backend call shape", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/live", {
      host: "127.0.0.1:8765",
      authorization: "Bearer gateway-token",
      "content-type": "multipart/form-data; boundary=codex-realtime-call-boundary",
    }),
    { localAdminToken: "gateway-token", nativeAccessToken: "native-token" },
  );

  assert.equal(upstream.nativeSession, true);
  assert.equal(upstream.nativeLiveCall, true);
  assert.equal(
    upstream.targetUrl,
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
  );
  assert.equal(upstream.headers.authorization, "Bearer native-token");
});

test("native Live sideband stays on the API WebSocket path", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/live/rtc_test", {
      host: "127.0.0.1:8765",
      authorization: "Bearer gateway-token",
    }),
    { localAdminToken: "gateway-token", nativeAccessToken: "native-token" },
  );

  assert.equal(upstream.nativeSession, true);
  assert.equal(upstream.nativeLiveCall, false);
  assert.equal(upstream.targetUrl, "https://api.openai.com/v1/live/rtc_test");
  assert.equal(upstream.headers.authorization, "Bearer native-token");
});

test("native Live multipart calls are converted to the backend JSON shape", () => {
  const body = Buffer.from(
    "--codex-realtime-call-boundary\r\n"
      + "Content-Disposition: form-data; name=\"sdp\"\r\n"
      + "Content-Type: application/sdp\r\n\r\n"
      + "v=0\r\n\r\n"
      + "--codex-realtime-call-boundary\r\n"
      + "Content-Disposition: form-data; name=\"session\"\r\n"
      + "Content-Type: application/json\r\n\r\n"
      + "{\"model\":\"gpt-live-1-codex\"}\r\n"
      + "--codex-realtime-call-boundary--\r\n",
    "utf8",
  );
  assert.deepEqual(
    JSON.parse(normalizeNativeLiveCallBody(body, "multipart/form-data; boundary=codex-realtime-call-boundary")),
    { sdp: "v=0\r\n", session: { model: "gpt-live-1-codex" } },
  );
});
