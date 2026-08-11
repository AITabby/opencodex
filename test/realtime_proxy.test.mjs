import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  copyNativeRequestHeaders,
  handleWebRtcProxy,
  nativeLiveSidebandTarget,
  normalizeNativeLiveCallBody,
  readNativeAccountCredential,
  resolveRealtimeUpstream,
} from "../dist/server/webrtc_proxy.js";

function request(url, headers = {}) {
  return { url, headers };
}

test("an explicitly selected Live account never falls back to the process-global token", async () => {
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "opencodex-live-account-"));
  try {
    process.env.OPENCODEX_DATA_DIR = dataDir;
    const profileDir = join(dataDir, "chatgpt-accounts", "account-selected");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "auth.json"), JSON.stringify({
      tokens: { account_id: "upstream-selected", access_token: "selected-token" },
    }));

    assert.deepEqual(readNativeAccountCredential("account-selected", true), {
      upstreamId: "upstream-selected",
      token: "selected-token",
    });
    assert.deepEqual(readNativeAccountCredential("missing-account", true), {
      upstreamId: "",
      token: "",
    });
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("native ChatGPT Realtime requests use the native backend route", () => {
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

test("decoded request bodies do not retain the original content-encoding header", () => {
  const headers = copyNativeRequestHeaders(request("/v1/responses", {
    host: "127.0.0.1:8765",
    authorization: "Bearer gateway-token",
    "content-type": "application/json",
    "content-encoding": "zstd",
  }), { localAdminToken: "gateway-token", nativeAccessToken: "native-token" }, true);

  assert.equal(headers["content-encoding"], undefined);
  assert.equal(headers.authorization, "Bearer native-token");
  assert.equal(headers["content-type"], "application/json");
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

test("native Live sideband keeps the native V3 path-shaped call id", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/live/rtc_test", {
      host: "127.0.0.1:8765",
      authorization: "Bearer gateway-token",
      origin: "http://127.0.0.1:43127",
    }),
    { localAdminToken: "gateway-token", nativeAccessToken: "native-token" },
  );

  assert.equal(upstream.nativeSession, true);
  assert.equal(upstream.nativeLiveCall, false);
  assert.equal(upstream.targetUrl, "https://api.openai.com/v1/live/rtc_test");
  assert.equal(upstream.headers.authorization, "Bearer native-token");
  assert.equal(upstream.headers.origin, "https://chatgpt.com");
  assert.equal(upstream.headers["openai-alpha"], "quicksilver=v2");
});

test("native Live sideband preserves query parameters", () => {
  assert.equal(
    nativeLiveSidebandTarget("/v1/live/rtc_test", "trace=1"),
    "https://api.openai.com/v1/live/rtc_test?trace=1",
  );
});

test("native Live V3 call removes the local session id before upstream create", () => {
  const body = [
    "--codex-realtime-call-boundary",
    'Content-Disposition: form-data; name="sdp"',
    "",
    "v=0\r\n",
    "--codex-realtime-call-boundary",
    'Content-Disposition: form-data; name="session"',
    "Content-Type: application/json",
    "",
    JSON.stringify({ id: "local-session", model: "gpt-live-1-codex" }),
    "--codex-realtime-call-boundary--",
    "",
  ].join("\r\n");

  assert.deepEqual(
    JSON.parse(normalizeNativeLiveCallBody(Buffer.from(body), "multipart/form-data; boundary=codex-realtime-call-boundary")),
    { sdp: "v=0\r\n", session: { model: "gpt-live-1-codex" } },
  );
});

test("a native Live WebSocket at /v1/live is treated as sideband, not session creation", () => {
  const upstream = resolveRealtimeUpstream(
    {
      method: "GET",
      url: "/v1/live",
      headers: {
        host: "127.0.0.1:8765",
        authorization: "Bearer gateway-token",
        upgrade: "websocket",
        connection: "Upgrade",
      },
    },
    {
      localAdminToken: "gateway-token",
      nativeAccessToken: "native-token",
      forceNativeSession: true,
    },
  );

  assert.equal(upstream.nativeLiveCall, false);
  assert.equal(upstream.targetUrl, "https://api.openai.com/v1/live");
  assert.equal(upstream.headers.authorization, "Bearer native-token");
});

test("a native V1 Live sideband at /v1/realtime uses the API Realtime path", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/realtime?call_id=rtc_v1_sideband", {
      host: "127.0.0.1:8765",
      authorization: "Bearer gateway-token",
      upgrade: "websocket",
      connection: "Upgrade",
    }),
    {
      localAdminToken: "gateway-token",
      nativeAccessToken: "native-token",
      forceNativeSession: true,
    },
  );

  assert.equal(upstream.nativeLiveCall, false);
  assert.equal(upstream.nativeSession, true);
  assert.equal(upstream.targetUrl, "https://api.openai.com/v1/realtime?call_id=rtc_v1_sideband");
  assert.equal(upstream.headers.authorization, "Bearer native-token");
  assert.equal(upstream.headers.origin, "https://chatgpt.com");
  assert.equal(upstream.headers["openai-alpha"], "quicksilver=v2");
});

test("a native V3 Live sideband preserves the live path and alpha header", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/live/rtc_v3_sideband", {
      host: "127.0.0.1:8765",
      authorization: "Bearer gateway-token",
      upgrade: "websocket",
      connection: "Upgrade",
    }),
    {
      localAdminToken: "gateway-token",
      nativeAccessToken: "native-token",
      nativeAccountId: "account-id",
      forceNativeAccessToken: true,
      forceNativeSession: true,
      nativeLiveSideband: true,
    },
  );

  assert.equal(upstream.targetUrl, "https://api.openai.com/v1/live/rtc_v3_sideband");
  assert.equal(upstream.headers.authorization, "Bearer native-token");
  assert.equal(upstream.headers["openai-alpha"], "quicksilver=v2");
});

test("a trailing slash on the local Realtime sideband is normalized before upstream", () => {
  const upstream = resolveRealtimeUpstream(
    request("/v1/realtime/?call_id=rtc_v1_trailing", {
      host: "127.0.0.1:8765",
      authorization: "Bearer gateway-token",
      upgrade: "websocket",
      connection: "Upgrade",
    }),
    {
      localAdminToken: "gateway-token",
      nativeAccessToken: "native-token",
      forceNativeSession: true,
    },
  );

  assert.equal(upstream.nativeLiveCall, false);
  assert.equal(upstream.nativeSession, true);
  assert.equal(upstream.targetUrl, "https://api.openai.com/v1/realtime?call_id=rtc_v1_trailing");
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

test("native Live WebSocket bridge completes both handshakes and forwards frames", async () => {
  const upstreamHttp = http.createServer();
  const upstreamWss = new WebSocketServer({
    server: upstreamHttp,
    handleProtocols: (requested) => requested.values().next().value || false,
  });
  let upstreamReceived = "";
  upstreamWss.on("connection", (ws, req) => {
    assert.equal(req.headers["sec-websocket-protocol"], "realtime-v3");
    assert.equal(req.headers.authorization, "Bearer native-token");
    assert.equal(req.headers.origin, "https://chatgpt.com");
    assert.equal(req.headers["openai-alpha"], "quicksilver=v2");
    ws.send(JSON.stringify({ type: "transcript.delta", text: "文字" }));
    ws.on("message", (data) => {
      upstreamReceived = data.toString();
      ws.send(JSON.stringify({ type: "echo", value: upstreamReceived }));
    });
  });
  await new Promise((resolve) => upstreamHttp.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstreamHttp.address().port;

  const localHttp = http.createServer();
  localHttp.on("upgrade", (req, socket, head) => {
    handleWebRtcProxy(req, socket, head, {
      localAdminToken: "gateway-token",
      nativeAccessToken: "native-token",
      forceNativeAccessToken: true,
      forceNativeSession: true,
      nativeLiveSideband: true,
      upstreamTargetUrl: `ws://127.0.0.1:${upstreamPort}/v1/live/rtc_test`,
    });
  });
  await new Promise((resolve) => localHttp.listen(0, "127.0.0.1", resolve));
  const localPort = localHttp.address().port;

  const received = [];
  const client = new WebSocket(`ws://127.0.0.1:${localPort}/v1/live/rtc_test`, "realtime-v3", {
    headers: { authorization: "Bearer gateway-token" },
  });
  client.on("message", (data) => received.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  assert.equal(client.protocol, "realtime-v3");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(received[0], { type: "transcript.delta", text: "文字" });

  client.send(JSON.stringify({ type: "client.message" }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("local WebSocket bridge did not return upstream frame")), 1000);
    const check = () => {
      if (received.some((item) => item.type === "echo")) {
        clearTimeout(timer);
        resolve();
      } else setTimeout(check, 5);
    };
    check();
  });
  assert.equal(upstreamReceived, JSON.stringify({ type: "client.message" }));

  client.close();
  await new Promise((resolve) => client.once("close", resolve));
  await new Promise((resolve) => upstreamWss.close(resolve));
  await new Promise((resolve) => upstreamHttp.close(resolve));
  await new Promise((resolve) => localHttp.close(resolve));
});
