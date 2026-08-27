import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  classifyProviderModel,
  cliEgressRoute,
  extractNativeLiveCallIds,
  OfficialAccountRouter,
  isHardOfficialQuotaFailure,
  isOfficialAuthFailure,
  isOfficialQuotaFailure,
  isNativeControlPlaneRequest,
  isNativeLiveParentRequest,
  isNativeSubagentRequest,
  isNativeLiveCreateCall,
  nativeLiveUpgradeRequestUrl,
  nativeEgressRoute,
  rewriteNativeGatewayRequestBody,
  nativeRuntimeArgs,
  normalizeThreadListParams,
} from "../dist/codex-provider-bridge.js";
import {
  buildDesktopLaunchEnvironment,
  buildManagedCodexConfig,
  clearOwnedProviderBridgeLaunchEnvironment,
  shouldResolveSubagentRoute,
} from "../dist/server/gateway.js";
import { ChatGptAccountPool } from "../dist/services/chatgpt_account_pool.js";

test("1.1.5 classifies official and namespaced provider-owned models safely", () => {
  const catalogs = [{
    models: [
      { slug: "gpt-5.5", provider: "openai" },
      { slug: "cursor/grok-4.5", backend_provider: "cursor" },
      { slug: "glm/glm-5", backend_provider: "glm" },
      { slug: "ownerless-model" },
    ],
  }];

  assert.equal(classifyProviderModel("gpt-5.5", catalogs), "openai");
  assert.equal(classifyProviderModel("gpt-5.5", [{
    models: [{ slug: "gpt-5.5", provider: "opencodex" }],
  }]), "openai");
  assert.equal(classifyProviderModel("cursor/grok-4.5", catalogs), "opencodex");
  assert.equal(classifyProviderModel("glm/glm-5", catalogs), "opencodex");
  assert.equal(classifyProviderModel("ownerless-model", catalogs), "openai");
  assert.equal(classifyProviderModel("antigravity/gemini-3.6-flash-medium", []), "opencodex");
  assert.equal(classifyProviderModel("minimax/minimax-m3", []), "opencodex");
  assert.equal(classifyProviderModel("openai/gpt-5.5", []), "openai");
  assert.equal(classifyProviderModel("antigravity/gemini-3.6-flash-medium", [{
    models: [{ slug: "antigravity/gemini-3.6-flash-medium", provider: "openai" }],
  }]), "opencodex");
  assert.equal(classifyProviderModel("not-in-catalog", catalogs), null);
});

test("standalone CLI keeps official requests native and sends provider-owned models to the gateway", () => {
  assert.equal(cliEgressRoute({ model: "gpt-5.5" }), "native");
  assert.equal(cliEgressRoute({ model: "openai/gpt-5.5" }), "native");
  assert.equal(cliEgressRoute({ model: "antigravity/gemini-3.6-flash-medium" }), "gateway");
  assert.equal(cliEgressRoute({ model: "opencode/deepseek-v4-flash" }), "gateway");
  assert.equal(cliEgressRoute({ model: "minimax/minimax-m3" }), "gateway");
  assert.equal(cliEgressRoute({
    model: "gpt-5.5",
    client_metadata: {
      thread_source: "subagent",
      subagent_origin: "gpt-live",
      model_override: "antigravity/gemini-3.6-flash-medium",
    },
  }), "gateway");
  assert.equal(cliEgressRoute({
    model: "gpt-5.5",
    client_metadata: { thread_source: "subagent", model_override: "codex-auto-review" },
  }), "native");
  assert.equal(cliEgressRoute({ model: "gpt-5.5" }, {
    "x-openai-subagent": "1",
    "x-codex-subagent-source": "gpt-live",
  }), "gateway");
  assert.equal(cliEgressRoute({
    model: "gpt-5.5",
    client_metadata: {
      subagent_origin: "gpt-live",
      model_override: "antigravity/gemini-3.6-flash-medium",
    },
  }), "gateway");
  // The Live source marker can also be present on the native parent turn.
  // Without an actual child marker/override it must stay on native Egress so
  // the native realtime transcript remains attached to the Live conversation.
  assert.equal(isNativeSubagentRequest({
    model: "gpt-5.5",
    client_metadata: { subagent_origin: "gpt-live", thread_id: "live-parent" },
  }), false);
  assert.equal(isNativeLiveParentRequest({
    model: "opencode/deepseek-v4-flash",
    client_metadata: { subagent_origin: "gpt-live", thread_id: "live-parent" },
  }), true);
  assert.equal(cliEgressRoute({
    model: "gpt-5.5",
    client_metadata: { subagent_origin: "gpt-live", thread_id: "live-parent" },
  }), "native");
  assert.equal(nativeEgressRoute({
    model: "opencode/deepseek-v4-flash",
    client_metadata: { subagent_origin: "gpt-live", thread_id: "live-parent" },
  }), "native");
});

test("account failover only recognizes official quota and rate-limit responses", () => {
  assert.equal(isOfficialQuotaFailure({ status: 429, message: "Too many requests" }), true);
  assert.equal(isOfficialQuotaFailure({ status: 400, message: "You exceeded your current quota" }), true);
  assert.equal(isOfficialQuotaFailure({ status: 402, error: { message: "insufficient_quota" } }), true);
  assert.equal(isOfficialQuotaFailure({ status: 400, message: "你已达到使用上限，请在 13:52 后重试" }), true);
  assert.equal(isOfficialQuotaFailure({ status: 502, message: "fetch failed" }), false);
  assert.equal(isOfficialQuotaFailure({ status: 400, message: "The model is not supported when using Codex with a ChatGPT account" }), false);
  assert.equal(isOfficialQuotaFailure({ message: "ECONNRESET" }), false);
  assert.equal(isHardOfficialQuotaFailure({ status: 400, message: "You exceeded your current quota" }), true);
  assert.equal(isHardOfficialQuotaFailure({ status: 400, message: "升级套餐或充值额度以继续" }), true);
  assert.equal(isHardOfficialQuotaFailure({ status: 429, message: "rate limit reached" }), false);
  assert.equal(isOfficialAuthFailure({ status: 401, message: "invalid token" }), true);
  assert.equal(isOfficialAuthFailure({ status: 403, message: "authentication required" }), true);
  assert.equal(isOfficialAuthFailure({ status: 403, message: "quota exceeded" }), false);
  assert.equal(isOfficialAuthFailure({ status: 502, message: "fetch failed" }), false);
});

test("Bridge alone does not take over a native GPT credential", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-account-router-disabled-"));
  try {
    const pool = new ChatGptAccountPool(tempRoot);
    const account = pool.createAccount({ id: "native-account", label: "Native" });
    await writeFile(join(account.profile_dir, "auth.json"), JSON.stringify({
      tokens: { access_token: "pool-token", account_id: "pool-account" },
    }), "utf8");
    const router = new OfficialAccountRouter(pool);
    assert.equal(router.credentialForRequest({ headers: { authorization: "Bearer native-token" } }), null);
    pool.saveSettings({ rotation_enabled: true, mode: "fixed", default_account_id: "native-account" });
    assert.equal(router.credentialForRequest({ headers: { authorization: "Bearer native-token" } })?.token, "pool-token");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("official account switching changes only the Egress credential, not a session", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-account-router-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  try {
    process.env.OPENCODEX_DATA_DIR = tempRoot;
    await mkdir(join(tempRoot, "chatgpt-accounts", "account-a"), { recursive: true });
    await mkdir(join(tempRoot, "chatgpt-accounts", "account-b"), { recursive: true });
    await writeFile(join(tempRoot, "chatgpt_accounts.json"), JSON.stringify({
      schema_version: 1,
      accounts: [
        { id: "account-a", label: "A", enabled: true },
        { id: "account-b", label: "B", enabled: true },
      ],
    }), "utf8");
    await writeFile(join(tempRoot, "chatgpt_account_settings.json"), JSON.stringify({
      schema_version: 1,
      rotation_enabled: true,
      mode: "round_robin",
      scheduler_cursor: 0,
    }), "utf8");
    await writeFile(join(tempRoot, "chatgpt-accounts", "account-a", "auth.json"), JSON.stringify({
      tokens: { access_token: "token-a", account_id: "official-a" },
    }), "utf8");
    await writeFile(join(tempRoot, "chatgpt-accounts", "account-b", "auth.json"), JSON.stringify({
      tokens: { access_token: "token-b", account_id: "official-b" },
    }), "utf8");

    const pool = new ChatGptAccountPool(tempRoot);
    const router = new OfficialAccountRouter(pool);
    const request = { headers: { authorization: "Bearer native-a", "chatgpt-account-id": "official-a" } };
    const first = router.credentialForRequest(request);
    assert.deepEqual(first && { localId: first.localId, upstreamId: first.upstreamId, token: first.token }, {
      localId: "account-a",
      upstreamId: "official-a",
      token: "token-a",
    });
    const second = router.credentialForRequest(request);
    assert.equal(second?.localId, "account-b");

    pool.saveSettings({ rotation_enabled: true, mode: "fixed", default_account_id: "account-a" });
    const manuallySelected = router.credentialForRequest({
      headers: { authorization: "Bearer unrelated", "chatgpt-account-id": "official-b" },
    });
    assert.equal(manuallySelected?.localId, "account-a");

    pool.saveSettings({ rotation_enabled: true, mode: "round_robin" });
    const next = await router.failover("account-a", { status: 400, body: "You have reached your usage limit" });
    assert.deepEqual(next && { localId: next.localId, upstreamId: next.upstreamId, token: next.token }, {
      localId: "account-b",
      upstreamId: "official-b",
      token: "token-b",
    });
    const after = router.credentialForRequest(request);
    assert.equal(after?.localId, "account-b");
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("1.1.5 history listing is provider-neutral even when Desktop sends a provider filter", () => {
  assert.deepEqual(normalizeThreadListParams({ limit: 100 }), {
    limit: 100,
    modelProviders: [],
  });
  assert.deepEqual(normalizeThreadListParams({ modelProviders: ["opencodex"] }), {
    modelProviders: [],
  });
  assert.deepEqual(normalizeThreadListParams({ modelProviders: [] }), {
    modelProviders: [],
  });
});

test("native child routing is request-scoped and leaves the native provider untouched", () => {
  assert.equal(nativeEgressRoute({ model: "gpt-5.5" }, {}), "native");
  const routedThirdPartyRequest = {
    model: "gpt-5.5",
    client_metadata: { opencodex_model_override: "antigravity/gemini-3.6-flash-medium" },
  };
  assert.equal(nativeEgressRoute(routedThirdPartyRequest, {}), "gateway");
  assert.equal(rewriteNativeGatewayRequestBody(routedThirdPartyRequest).model, "antigravity/gemini-3.6-flash-medium");
  assert.equal(rewriteNativeGatewayRequestBody({ model: "gpt-5.5" }).model, "gpt-5.5");
  const nativeEgressBase = "/__opencodex_test/v1";
  assert.equal(isNativeLiveCreateCall(`${nativeEgressBase}/live`, nativeEgressBase), true);
  assert.equal(isNativeLiveCreateCall(`${nativeEgressBase}/live/rtc_test`, nativeEgressBase), false);
  // Live remains in the native lane; only its upstream path/body shape is
  // special-cased after it has crossed the local Egress boundary.
  assert.equal(nativeEgressRoute({}, {}), "native");
  assert.equal(isNativeSubagentRequest({ model: "gpt-5.5" }, {
    "x-openai-subagent": "collab_spawn",
    "x-codex-parent-thread-id": "parent-thread",
  }), true);
  assert.equal(nativeEgressRoute({ model: "gpt-5.5" }, {
    "x-codex-turn-metadata": JSON.stringify({ thread_source: "subagent", subagent_kind: "worker" }),
  }), "gateway");
  assert.equal(nativeEgressRoute({
    model: "gpt-5.5",
    client_metadata: { thread_source: "subagent" },
  }, {}), "gateway");

  // Internal approval/review turns are native control-plane traffic, not
  // selectable child models. Their subagent markers must not send them into
  // the local provider catalog.
  assert.equal(isNativeControlPlaneRequest({ model: "codex-auto-review" }, {
    "x-openai-subagent": "codex-auto-review",
  }), true);
  assert.equal(nativeEgressRoute({
    model: "codex-auto-review",
    client_metadata: { thread_source: "subagent" },
  }, {}), "native");
  assert.equal(shouldResolveSubagentRoute(true, true), false);
  assert.equal(shouldResolveSubagentRoute(true, false), true);

  const args = nativeRuntimeArgs(["--profile", "default", "app-server", "--listen", "stdio"], 43127);
  assert.deepEqual(args.slice(0, 12), [
    "--profile", "default",
    "-c", "model_provider=opencodex",
    "-c", "model_providers.opencodex.base_url=http://127.0.0.1:43127/v1",
    "-c", "model_providers.opencodex.wire_api=responses",
    "-c", "model_providers.opencodex.requires_openai_auth=false",
    "-c", "openai_base_url=http://127.0.0.1:43127/v1",
  ]);
  assert.deepEqual(args.slice(12, 20), [
    "-c", "experimental_realtime_webrtc_call_base_url=http://127.0.0.1:43127/v1",
    "-c", "experimental_realtime_ws_base_url=ws://127.0.0.1:43127/v1/realtime",
    "-c", "features.responses_websockets=false",
    "-c", "features.responses_websockets_v2=false",
  ]);
  assert.equal(args.filter((value) => value.startsWith("experimental_realtime_")).length, 2);
  assert.equal(args.includes("model_provider=opencodex"), true);
  assert.equal(args[20], "app-server");
});

test("native Live response ids can bind the following sideband to the same account", () => {
  assert.deepEqual(
    extractNativeLiveCallIds(Buffer.from(JSON.stringify({
      call_id: "rtc_u0_test-call",
      session: { id: "session-not-the-call" },
    }))),
    ["rtc_u0_test-call"],
  );
  assert.deepEqual(
    extractNativeLiveCallIds(Buffer.from("{\"sdp\":\"v=0\"}"), {
      "x-realtime-session-id": "rtc_u2_header-call",
    }),
    ["rtc_u2_header-call"],
  );
  assert.deepEqual(
    extractNativeLiveCallIds(Buffer.from("{\"sdp\":\"v=0\"}"), {
      "x-session-id": "rtc_u3_session-header-call",
    }),
    ["rtc_u3_session-header-call"],
  );
  assert.equal(
    nativeLiveUpgradeRequestUrl("/v1/live", "/live", "rtc_u4_latest-call"),
    "/v1/live/rtc_u4_latest-call",
  );
  assert.equal(
    nativeLiveUpgradeRequestUrl("/v1/live?call_id=rtc_u5_query-call", "/live", "rtc_u5_query-call"),
    "/v1/live?call_id=rtc_u5_query-call",
  );
  assert.equal(
    nativeLiveUpgradeRequestUrl("/v1/realtime", "/realtime", "rtc_u6_realtime-call"),
    "/v1/realtime?call_id=rtc_u6_realtime-call",
  );
  assert.equal(
    nativeLiveUpgradeRequestUrl("/v1/realtime/", "/realtime/", "rtc_u7_realtime-call"),
    "/v1/realtime?call_id=rtc_u7_realtime-call",
  );
  assert.equal(
    nativeLiveUpgradeRequestUrl("/v1/live/", "/live/", "rtc_u8_live-call"),
    "/v1/live/rtc_u8_live-call",
  );
  assert.equal(
    nativeLiveUpgradeRequestUrl(
      "/__opencodex_test/v1/v1/live/rtc_u9_duplicate-v1",
      "/v1/live/rtc_u9_duplicate-v1",
    ),
    "/v1/live/rtc_u9_duplicate-v1",
  );
});

test("standalone CLI bridge routes each Responses request by model", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-cli-egress-"));
  const fakeNativePath = join(tempRoot, "fake-native-cli.mjs");
  const tracePath = join(tempRoot, "cli-trace.json");
  const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";

const baseArg = process.argv.find((value) => value.startsWith("openai_base_url=")) || "";
const baseUrl = baseArg.slice("openai_base_url=".length);
const tracePath = process.env.FAKE_CLI_TRACE || "";
const models = JSON.parse(process.env.FAKE_CLI_MODELS || "[]");
const results = [];
for (const model of models) {
  const response = await fetch(new URL("responses", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: [], stream: false }),
  });
  results.push({ model, status: response.status, body: await response.text() });
}
if (tracePath) fs.writeFileSync(tracePath, JSON.stringify({ argv: process.argv, results }));
`;
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);

  const nativeSeen = [];
  const gatewaySeen = [];
  const createUpstream = (seen) => http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const nativeUpstream = createUpstream(nativeSeen);
  const gateway = createUpstream(gatewaySeen);
  await new Promise((resolve) => nativeUpstream.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const nativePort = nativeUpstream.address().port;
  const gatewayPort = gateway.address().port;
  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "--opencodex-cli"], {
    env: {
      ...process.env,
      OPENCODEX_NATIVE_CLI_PATH: fakeNativePath,
      OPENCODEX_NATIVE_UPSTREAM_BASE_URL: `http://127.0.0.1:${nativePort}`,
      OPENCODEX_GATEWAY_PORT: String(gatewayPort),
      FAKE_CLI_TRACE: tracePath,
      FAKE_CLI_MODELS: JSON.stringify(["gpt-5.5", "antigravity/gemini-3.6-flash-medium"]),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI bridge timed out\\n${stderr.join("")}`)), 10000);
      bridge.once("error", reject);
      bridge.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr.join(""));
    assert.equal(nativeSeen.length, 1);
    assert.equal(nativeSeen[0].url, "/backend-api/codex/responses");
    assert.equal(nativeSeen[0].body.model, "gpt-5.5");
    assert.equal(gatewaySeen.length, 1);
    assert.equal(gatewaySeen[0].url, "/v1/responses");
    assert.equal(gatewaySeen[0].body.model, "antigravity/gemini-3.6-flash-medium");
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    assert.match(trace.argv.join(" "), /openai_base_url=http:\/\/127\.0\.0\.1:\d+\/v1/);
    assert.match(trace.argv.join(" "), /features\.responses_websockets=false/);
    assert.equal(trace.results.every((result) => result.status === 200), true);
  } finally {
    if (bridge.exitCode === null) bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await new Promise((resolve) => nativeUpstream.close(resolve));
    await new Promise((resolve) => gateway.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("default app-server bridge keeps native sessions intact while routing GPT-Live child images by lineage", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-thin-app-server-egress-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const fakeNativeSource = `#!/usr/bin/env node
import readline from "node:readline";

const baseArg = process.argv.find((value) => value.startsWith("openai_base_url=")) || "";
const baseUrl = baseArg.slice("openai_base_url=".length);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const requestUpstream = async (params, headers = {}) => {
  const response = await fetch(new URL("responses", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(params),
  });
  return { status: response.status, body: await response.text() };
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  void (async () => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { initialized: true } });
      return;
    }
    if (message.method === "thread/start") {
      // This echo proves the bridge did not rewrite JSON-RPC thread state.
      send({ id: message.id, result: { thread: { id: "native-thread-1", model: message.params?.model || "gpt-5.5" }, echo: message.params } });
      return;
    }
    if (message.method === "turn/start") {
      const params = message.params || {};
      const isLiveChild = params.client_metadata?.subagent_origin === "gpt-live";
      const payload = isLiveChild
        ? {
          model: "gpt-5.5",
          input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }],
          client_metadata: {
            thread_source: "subagent",
            subagent_origin: "gpt-live",
            model_override: "antigravity/gemini-3.6-flash-medium",
          },
        }
        : { model: params.model || "gpt-5.5", input: params.input || [] };
      const upstream = await requestUpstream(payload, isLiveChild
        ? { "x-openai-subagent": "1", "x-codex-subagent-source": "gpt-live" }
        : {});
      send({ id: message.id, result: { status: upstream.status, body: upstream.body } });
      return;
    }
    send({ id: message.id, result: {} });
  })().catch((error) => send({ id: message.id, error: { message: String(error?.message || error) } }));
});
`;
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);

  const nativeSeen = [];
  const gatewaySeen = [];
  const createUpstream = (seen, status = 200) => http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  const nativeUpstream = createUpstream(nativeSeen);
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      gatewaySeen.push({ url: req.url, headers: req.headers, body });
      // A non-multimodal provider failure must be returned as one request
      // failure; it must not terminate the native app-server or bridge.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "image input is not supported" } }));
    });
  });
  await new Promise((resolve) => nativeUpstream.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const nativePort = nativeUpstream.address().port;
  const gatewayPort = gateway.address().port;
  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "app-server"], {
    env: {
      ...process.env,
      OPENCODEX_LEGACY_PROVIDER_BRIDGE: undefined,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_NATIVE_UPSTREAM_BASE_URL: `http://127.0.0.1:${nativePort}`,
      OPENCODEX_GATEWAY_PORT: String(gatewayPort),
      OPENCODEX_DATA_DIR: tempRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request ${id} timed out\\n${stderr.join("")}`)), 8000);
    const interval = setInterval(() => {
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return;
      clearTimeout(timer);
      clearInterval(interval);
      resolve(messages.splice(index, 1)[0]);
    }, 5);
  });

  try {
    send({ id: 1, method: "initialize", params: {} });
    assert.deepEqual(await waitFor(1), { id: 1, result: { initialized: true } });
    send({ id: 2, method: "thread/start", params: { model: "gpt-5.5" } });
    const started = await waitFor(2);
    assert.deepEqual(started.result.echo, { model: "gpt-5.5" });

    send({ id: 3, method: "turn/start", params: { model: "gpt-5.5", input: [] } });
    assert.equal((await waitFor(3)).result.status, 200);
    send({
      id: 4,
      method: "turn/start",
      params: {
        model: "gpt-5.5",
        client_metadata: { thread_source: "subagent", subagent_origin: "gpt-live" },
      },
    });
    assert.equal((await waitFor(4)).result.status, 400);
    // The failed third-party image request did not kill the bridge or poison
    // the next native conversation request.
    send({ id: 5, method: "turn/start", params: { model: "gpt-5.5", input: [] } });
    assert.equal((await waitFor(5)).result.status, 200);

    assert.equal(nativeSeen.length, 2);
    assert.equal(nativeSeen.every((entry) => entry.url === "/backend-api/codex/responses"), true);
    assert.equal(gatewaySeen.length, 1);
    assert.equal(gatewaySeen[0].url, "/v1/responses");
    assert.equal(gatewaySeen[0].body.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(gatewaySeen[0].body.client_metadata.subagent_origin, "gpt-live");
    assert.equal(gatewaySeen[0].body.input[0].content[0].type, "input_image");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await new Promise((resolve) => nativeUpstream.close(resolve));
    await new Promise((resolve) => gateway.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("official Egress rotates credentials without changing the native request", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-account-egress-"));
  const fakeNativePath = join(tempRoot, "fake-native-cli.mjs");
  const tracePath = join(tempRoot, "account-trace.json");
  await mkdir(join(tempRoot, "chatgpt-accounts", "account-a"), { recursive: true });
  await mkdir(join(tempRoot, "chatgpt-accounts", "account-b"), { recursive: true });
  await writeFile(join(tempRoot, "chatgpt_accounts.json"), JSON.stringify({
    schema_version: 1,
    accounts: [
      { id: "account-a", label: "A", enabled: true },
      { id: "account-b", label: "B", enabled: true },
    ],
  }), "utf8");
  await writeFile(join(tempRoot, "chatgpt_account_settings.json"), JSON.stringify({
    schema_version: 1,
    rotation_enabled: true,
    mode: "round_robin",
      scheduler_cursor: 0,
  }), "utf8");
  await writeFile(join(tempRoot, "chatgpt-accounts", "account-a", "auth.json"), JSON.stringify({
    tokens: { access_token: "token-a", account_id: "official-a" },
  }), "utf8");
  await writeFile(join(tempRoot, "chatgpt-accounts", "account-b", "auth.json"), JSON.stringify({
    tokens: { access_token: "token-b", account_id: "official-b" },
  }), "utf8");
  await writeFile(fakeNativePath, `#!/usr/bin/env node
import fs from "node:fs";
const baseArg = process.argv.find((value) => value.startsWith("openai_base_url=")) || "";
const baseUrl = baseArg.slice("openai_base_url=".length);
const tracePath = process.env.FAKE_ACCOUNT_TRACE || "";
const requestBody = { model: "gpt-5.5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "same request" }] }], stream: false };
const response = await fetch(new URL("responses", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer native-a", "chatgpt-account-id": "official-a" },
  body: JSON.stringify(requestBody),
});
if (tracePath) fs.writeFileSync(tracePath, JSON.stringify({ status: response.status, body: await response.text() }));
`, "utf8");
  await chmod(fakeNativePath, 0o755);

  const seen = [];
  const nativeUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        authorization: req.headers.authorization,
        accountId: req.headers["chatgpt-account-id"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      if (seen.length === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "You have reached your usage limit" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => nativeUpstream.listen(0, "127.0.0.1", resolve));
  const nativePort = nativeUpstream.address().port;
  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "--opencodex-cli"], {
    env: {
      ...process.env,
      OPENCODEX_DATA_DIR: tempRoot,
      OPENCODEX_NATIVE_CLI_PATH: fakeNativePath,
      OPENCODEX_NATIVE_UPSTREAM_BASE_URL: `http://127.0.0.1:${nativePort}`,
      FAKE_ACCOUNT_TRACE: tracePath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`account egress timed out\\n${stderr.join("")}`)), 10000);
      bridge.once("error", reject);
      bridge.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr.join(""));
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((entry) => entry.authorization), ["Bearer token-a", "Bearer token-b"]);
    assert.deepEqual(seen.map((entry) => entry.accountId), ["official-a", "official-b"]);
    assert.deepEqual(seen[0].body, seen[1].body);
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    assert.equal(trace.status, 200);
  } finally {
    if (bridge.exitCode === null) bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await new Promise((resolve) => nativeUpstream.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("native app-server child request crosses the external bridge into the gateway", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-native-egress-"));
  const fakeNativePath = join(tempRoot, "fake-native-egress.mjs");
  const tracePath = join(tempRoot, "egress-trace.json");
  const settingsTracePath = join(tempRoot, "settings-trace.jsonl");
const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import readline from "node:readline";

const baseArg = process.argv.find((value) => value.startsWith("openai_base_url=")) || "";
const baseUrl = baseArg.slice("openai_base_url=".length);
const tracePath = process.env.FAKE_EGRESS_TRACE || "";
const settingsTracePath = process.env.FAKE_EGRESS_SETTINGS_TRACE || "";
const childDisplayThread = process.env.FAKE_EGRESS_CHILD_THREAD || "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const trace = (value) => { if (tracePath) fs.writeFileSync(tracePath, JSON.stringify(value)); };
const rl = readline.createInterface({ input: process.stdin });
const handleLine = async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/settings/update") {
    if (settingsTracePath) fs.appendFileSync(settingsTracePath, JSON.stringify(message.params) + "\\n");
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method !== "thread/start") {
    send({ id: message.id, result: {} });
    return;
  }
  const websocketFallback = await new Promise((resolve, reject) => {
    const request = http.request(new URL("responses", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGVzdA==",
        "sec-websocket-version": "13",
      },
    });
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, body: "" });
    });
    request.once("error", reject);
    request.end();
  });
  const response = await fetch(new URL("responses", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openai-subagent": "collab_spawn",
      "x-codex-parent-thread-id": "parent-thread-1",
      ...(childDisplayThread ? { "thread-id": childDisplayThread } : {}),
      ...(childDisplayThread ? { "session-id": childDisplayThread } : {}),
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "subagent", subagent_kind: "worker" }),
    },
    body: JSON.stringify({ model: "gpt-5.5", input: [], stream: true }),
  });
  trace({ argv: process.argv, websocketFallback, status: response.status, response: await response.text() });
  if (childDisplayThread) {
    send({ method: "thread/settings/updated", params: {
      threadId: childDisplayThread,
      threadSettings: { model: "gpt-5.5", modelProvider: "openai", effort: "low" },
    } });
  }
  send({ id: message.id, result: { reasoningEffort: "low", thread: { id: "child-thread-1", model: "gpt-5.5", modelProvider: "openai" } } });
};
rl.on("line", (line) => { void handleLine(line); });
`;
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);

  const seen = [];
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, {
        "content-type": "application/json",
        "x-opencodex-subagent-model": "antigravity/gemini-3.6-flash-medium",
        "x-opencodex-subagent-reasoning-effort": "high",
        "x-opencodex-subagent-task-id": "child-thread-1",
        "x-opencodex-subagent-thread-id": "child-thread-1",
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_GATEWAY_PORT: String(gatewayPort),
      OPENCODEX_DATA_DIR: tempRoot,
      OPENCODEX_LEGACY_PROVIDER_BRIDGE: "1",
      FAKE_EGRESS_TRACE: tracePath,
      FAKE_EGRESS_SETTINGS_TRACE: settingsTracePath,
      FAKE_EGRESS_CHILD_THREAD: "child-thread-1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 101, method: "initialize", params: {} });
    assert.deepEqual(await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`initialize timed out\\n${stderr.join("")}`)), 8000);
      const interval = setInterval(() => {
        const index = messages.findIndex((message) => message.id === 101);
        if (index < 0) return;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(messages.splice(index, 1)[0]);
      }, 5);
    }), { id: 101, result: {} });

    send({ id: 102, method: "thread/start", params: { model: "gpt-5.5" } });
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`thread/start timed out\\n${stderr.join("")}`)), 8000);
      const interval = setInterval(() => {
        const index = messages.findIndex((message) => message.id === 102);
        if (index < 0) return;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(messages.splice(index, 1)[0]);
      }, 5);
    });
    assert.equal(started.error, undefined);
    assert.equal(started.result.reasoningEffort, "high");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/v1/responses");
    assert.equal(seen[0].headers["x-openai-subagent"], "collab_spawn");
    assert.equal(seen[0].headers["x-codex-parent-thread-id"], "parent-thread-1");
    assert.equal(seen[0].headers["thread-id"], "child-thread-1");
    assert.equal(seen[0].headers["session-id"], "child-thread-1");
    assert.equal(seen[0].body.model, "gpt-5.5");
    const childSettings = messages.find((message) => message.method === "thread/settings/updated");
    assert.equal(childSettings?.params?.threadId, "child-thread-1");
    assert.equal(childSettings?.params?.threadSettings?.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(childSettings?.params?.threadSettings?.modelProvider, "opencodex");
    assert.equal(childSettings?.params?.threadSettings?.effort, "high");
    assert.equal(messages
      .filter((message) => message.method === "thread/settings/updated" && message.params?.threadId === "child-thread-1")
      .every((message) => message.params?.threadSettings?.effort === "high"), true);
    const persistedSettings = (await readFile(settingsTracePath, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(persistedSettings.some((settings) => settings.threadId === "child-thread-1" && settings.effort === "high"), true);
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    assert.equal(trace.websocketFallback.status, 426);
    assert.match(trace.websocketFallback.body, /Upgrade Required|upgrade_required/);
    assert.match(trace.argv.join(" "), /openai_base_url=http:\/\/127\.0\.0\.1:\d+\/__opencodex_(?:native_egress_)?[a-f0-9]+\/v1/);
    assert.match(trace.argv.join(" "), /features\.responses_websockets=false/);
    assert.equal(trace.argv.some((value) => value.includes("model_provider=opencodex")), true);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await new Promise((resolve) => gateway.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("desktop bridge keeps native sessions on one runtime while account choice stays at Egress", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-desktop-account-binding-"));
  const fakeNativePath = join(tempRoot, "fake-native-account.mjs");
  const tracePath = join(tempRoot, "account-runtime-trace.jsonl");
  const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const accountId = process.env.OPENCODEX_CHATGPT_ACCOUNT_ID || null;
const tracePath = process.env.FAKE_ACCOUNT_TRACE || "";
let counter = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (message) => {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, JSON.stringify({
    accountId,
    codeHome: process.env.CODEX_HOME || null,
    method: message.method || null,
    params: message.params || null,
  }) + "\\n");
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    counter += 1;
    send({ id: message.id, result: { thread: {
      id: (accountId || "default") + "-thread-" + counter,
      model: message.params?.model || "gpt-5.5",
      modelProvider: "openai",
    } } });
    return;
  }
  if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [] } });
    return;
  }
  send({ id: message.id, result: {} });
});
`;
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);

  const pool = new ChatGptAccountPool(tempRoot);
  const first = pool.createAccount({ id: "plus-a", label: "Plus A" });
  const second = pool.createAccount({ id: "plus-b", label: "Plus B" });
  await writeFile(join(first.profile_dir, "auth.json"), JSON.stringify({ access_token: "test-a" }));
  await writeFile(join(second.profile_dir, "auth.json"), JSON.stringify({ access_token: "test-b" }));
  pool.saveSettings({ rotation_enabled: true, mode: "round_robin" });

  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_DATA_DIR: tempRoot,
      OPENCODEX_LEGACY_PROVIDER_BRIDGE: "1",
      FAKE_ACCOUNT_TRACE: tracePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request ${id} timed out\\n${stderr.join("")}`)), 8000);
    const interval = setInterval(() => {
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return;
      clearTimeout(timer);
      clearInterval(interval);
      resolve(messages.splice(index, 1)[0]);
    }, 5);
  });

  try {
    send({ id: 201, method: "initialize", params: {} });
    assert.deepEqual(await waitFor(201), { id: 201, result: {} });
    send({ id: 202, method: "thread/start", params: { model: "gpt-5.5" } });
    const firstStarted = await waitFor(202);
    send({ id: 203, method: "thread/start", params: { model: "gpt-5.5" } });
    const secondStarted = await waitFor(203);
    assert.equal(firstStarted.error, undefined);
    assert.equal(secondStarted.error, undefined);
    send({ id: 204, method: "thread/start", params: { model: "gpt-5.5" } });
    const thirdStarted = await waitFor(204);
    assert.equal(thirdStarted.error, undefined);

    const trace = (await readFile(tracePath, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const starts = trace.filter((entry) => entry.method === "thread/start");
    assert.deepEqual(starts.map((entry) => entry.accountId), [null, null, null]);
    assert.equal(starts.every((entry) => entry.codeHome === starts[0].codeHome), true);

    const routes = JSON.parse(await readFile(join(tempRoot, "provider-session-routes.json"), "utf8"));
    const saved = Object.values(routes.threads);
    assert.equal(saved.every((route) => Object.hasOwn(route, "accountId") === false), true);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("desktop bridge does not migrate a native session after an Egress quota error", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-desktop-account-failover-"));
  const fakeNativePath = join(tempRoot, "fake-native-failover.mjs");
  const tracePath = join(tempRoot, "account-failover-trace.jsonl");
  const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const accountId = process.env.OPENCODEX_CHATGPT_ACCOUNT_ID || "default";
const tracePath = process.env.FAKE_ACCOUNT_TRACE || "";
let counter = 0;
let turnStarts = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (message) => {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, JSON.stringify({ accountId, method: message.method || null, params: message.params || null }) + "\\n");
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    counter += 1;
    send({ id: message.id, result: { thread: { id: accountId + "-thread-" + counter, path: "/tmp/" + accountId, model: message.params?.model || "gpt-5.5", modelProvider: "openai" } } });
    return;
  }
  if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: { id: message.params?.threadId, turns: [{ items: [
      { type: "userMessage", content: [{ type: "text", text: "previous question" }] },
      { type: "agentMessage", text: "previous answer" },
    ] }] } } });
    return;
  }
  if (message.method === "thread/inject_items") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    turnStarts += 1;
    if (turnStarts === 1) {
      send({ id: message.id, error: { status: 429, message: "usage limit reached" } });
    } else {
      send({ id: message.id, result: { turn: { id: "turn-" + accountId } } });
      send({ method: "turn/completed", params: { threadId: message.params?.threadId } });
    }
    return;
  }
  send({ id: message.id, result: {} });
});
`;
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);

  const pool = new ChatGptAccountPool(tempRoot);
  const first = pool.createAccount({ id: "plus-a", label: "Plus A" });
  const second = pool.createAccount({ id: "plus-b", label: "Plus B" });
  await writeFile(join(first.profile_dir, "auth.json"), JSON.stringify({ access_token: "test-a" }));
  await writeFile(join(second.profile_dir, "auth.json"), JSON.stringify({ access_token: "test-b" }));
  pool.saveSettings({ rotation_enabled: true, mode: "round_robin", default_account_id: "plus-a" });

  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_DATA_DIR: tempRoot,
      OPENCODEX_LEGACY_PROVIDER_BRIDGE: "1",
      FAKE_ACCOUNT_TRACE: tracePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request ${id} timed out\\n${stderr.join("")}`)), 8000);
    const interval = setInterval(() => {
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return;
      clearTimeout(timer);
      clearInterval(interval);
      resolve(messages.splice(index, 1)[0]);
    }, 5);
  });

  try {
    send({ id: 301, method: "initialize", params: {} });
    assert.deepEqual(await waitFor(301), { id: 301, result: {} });
    send({ id: 302, method: "thread/start", params: { model: "gpt-5.5" } });
    const started = await waitFor(302);
    assert.equal(started.error, undefined);
    send({
      id: 303,
      method: "turn/start",
      params: {
        threadId: started.result.thread.id,
        model: "gpt-5.5",
        input: [{ type: "text", text: "current question" }],
      },
    });
    const completed = await waitFor(303);
    assert.ok(completed.error);

    const trace = (await readFile(tracePath, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const turnStarts = trace.filter((entry) => entry.method === "turn/start");
    assert.deepEqual(turnStarts.map((entry) => entry.accountId), ["default"]);
    assert.equal(trace.some((entry) => entry.method === "thread/inject_items"), false);

    const routes = JSON.parse(await readFile(join(tempRoot, "provider-session-routes.json"), "utf8"));
    const saved = Object.values(routes.threads).find((route) => route.externalId === started.result.thread.id);
    assert.equal(Object.hasOwn(saved, "accountId"), false);
    assert.equal(saved.retiredNativeIds, undefined);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("desktop bridge resumes an existing conversation without account binding", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-desktop-unbound-account-") );
  const fakeNativePath = join(tempRoot, "fake-native-unbound.mjs");
  const tracePath = join(tempRoot, "unbound-account-trace.jsonl");
  const routesPath = join(tempRoot, "provider-session-routes.json");
  const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const accountId = process.env.OPENCODEX_CHATGPT_ACCOUNT_ID || "default";
const tracePath = process.env.FAKE_ACCOUNT_TRACE || "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (message) => {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, JSON.stringify({ accountId, method: message.method || null, params: message.params || null }) + "\\n");
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: { id: message.params?.threadId, name: "Existing conversation", turns: [{ items: [
      { type: "userMessage", content: [{ type: "text", text: "previous question" }] },
      { type: "agentMessage", text: "previous answer" },
    ] }] } } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: accountId + "-thread", path: "/tmp/" + accountId, model: "gpt-5.5", modelProvider: "openai" } } });
  } else if (message.method === "thread/inject_items" || message.method === "thread/name/set") {
    send({ id: message.id, result: {} });
  } else if (message.method === "turn/start") {
    if (accountId === "plus-a") {
      send({ id: message.id, error: { status: 400, message: "你已达到使用上限，请在 13:52 后重试" } });
    } else {
      send({ id: message.id, result: { turn: { id: "turn-plus-b" } } });
      send({ method: "turn/completed", params: { threadId: message.params?.threadId, turn: { status: "completed" } } });
    }
  } else {
    send({ id: message.id, result: {} });
  }
});
`;
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(routesPath, JSON.stringify({
    version: 1,
    threads: {
      "existing-thread": {
        externalId: "existing-thread",
        nativeId: "existing-thread",
        selectedModel: "gpt-5.5",
      },
    },
  }), "utf8");

  const pool = new ChatGptAccountPool(tempRoot);
  const first = pool.createAccount({ id: "plus-a", label: "Plus A" });
  const second = pool.createAccount({ id: "plus-b", label: "Plus B" });
  await writeFile(join(first.profile_dir, "auth.json"), JSON.stringify({ access_token: "test-a" }));
  await writeFile(join(second.profile_dir, "auth.json"), JSON.stringify({ access_token: "test-b" }));
  pool.saveSettings({ rotation_enabled: true, mode: "round_robin", default_account_id: null, scheduler_cursor: 0 });

  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_DATA_DIR: tempRoot,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routesPath,
      OPENCODEX_LEGACY_PROVIDER_BRIDGE: "1",
      FAKE_ACCOUNT_TRACE: tracePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request ${id} timed out\\n${stderr.join("")}`)), 8000);
    const interval = setInterval(() => {
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return;
      clearTimeout(timer);
      clearInterval(interval);
      resolve(messages.splice(index, 1)[0]);
    }, 5);
  });

  try {
    send({ id: 401, method: "initialize", params: {} });
    assert.deepEqual(await waitFor(401), { id: 401, result: {} });
    send({
      id: 402,
      method: "turn/start",
      params: {
        threadId: "existing-thread",
        model: "gpt-5.5",
        input: [{ type: "text", text: "current question" }],
      },
    });
    const completed = await waitFor(402);
    assert.equal(completed.error, undefined);

    const trace = (await readFile(tracePath, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const turnStarts = trace.filter((entry) => entry.method === "turn/start");
    assert.deepEqual(turnStarts.map((entry) => entry.accountId), ["default"]);
    const routes = JSON.parse(await readFile(routesPath, "utf8"));
    const saved = Object.values(routes.threads).find((route) => route.externalId === "existing-thread");
    assert.equal(Object.hasOwn(saved, "accountId"), false);
    assert.equal(saved.retiredNativeIds, undefined);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("1.1.5 managed config keeps native OpenAI as the global default", () => {
  const config = buildManagedCodexConfig(
    'model = "gpt-5.5"\n',
    8765,
    "admin-token",
    "/tmp/custom_model_catalog.json",
  );

  assert.match(config, /model_provider = "openai"/);
  assert.doesNotMatch(config, /model_provider = "opencodex"/);
  assert.doesNotMatch(config, /openai_base_url/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:8765\/v1"/);
});

test("Desktop bridge environment is process-scoped and native restore removes bridge state", () => {
  const base = {
    CODEX_CLI_PATH: "/old/opencodex/codex-provider-bridge",
    OPENCODEX_NATIVE_CODEX_PATH: "/old/native/codex",
    OPENCODEX_PROVIDER_BRIDGE_PATH: "/old/opencodex/codex-provider-bridge",
    OPENCODEX_PROVIDER_SPLIT: "1",
    OPENCODEX_PROVIDER_BRIDGE_RUNTIME: "opencodex",
    OPENCODEX_LEGACY_PROVIDER_BRIDGE: "1",
    OPENCODEX_GATEWAY_PORT: "8765",
    OPENCODEX_DATA_DIR: "/tmp/codexsplit-app-data",
    PATH: "/usr/bin",
  };

  const native = buildDesktopLaunchEnvironment(base, "native", "", "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(native.CODEX_CLI_PATH, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(native.OPENCODEX_NATIVE_CODEX_PATH, undefined);
  assert.equal(native.OPENCODEX_PROVIDER_BRIDGE_PATH, undefined);
  assert.equal(native.OPENCODEX_PROVIDER_SPLIT, undefined);
  assert.equal(native.OPENCODEX_PROVIDER_BRIDGE_RUNTIME, undefined);
  assert.equal(native.OPENCODEX_LEGACY_PROVIDER_BRIDGE, undefined);
  assert.equal(native.OPENCODEX_GATEWAY_PORT, undefined);

  const bridge = buildDesktopLaunchEnvironment(
    base,
    "bridge",
    "/Applications/CodexSplit.app/Contents/Resources/dist/codex-provider-bridge",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    18765,
  );
  assert.equal(bridge.CODEX_CLI_PATH, "/Applications/CodexSplit.app/Contents/Resources/dist/codex-provider-bridge");
  assert.equal(bridge.OPENCODEX_NATIVE_CODEX_PATH, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(bridge.OPENCODEX_PROVIDER_SPLIT, "1");
  assert.equal(bridge.OPENCODEX_LEGACY_PROVIDER_BRIDGE, "1");
  assert.equal(bridge.OPENCODEX_GATEWAY_PORT, "18765");
  assert.equal(bridge.OPENCODEX_DATA_DIR, "/tmp/codexsplit-app-data");
});

test("native restore clears an inherited legacy bridge environment", () => {
  const keys = [
    "CODEX_CLI_PATH",
    "OPENCODEX_NATIVE_CODEX_PATH",
    "OPENCODEX_PROVIDER_BRIDGE_PATH",
    "OPENCODEX_PROVIDER_SPLIT",
    "OPENCODEX_PROVIDER_BRIDGE_RUNTIME",
    "OPENCODEX_LEGACY_PROVIDER_BRIDGE",
    "OPENCODEX_GATEWAY_PORT",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CODEX_CLI_PATH = "/old/opencodex/codex-provider-bridge";
    process.env.OPENCODEX_PROVIDER_BRIDGE_PATH = "/old/opencodex/codex-provider-bridge";
    process.env.OPENCODEX_PROVIDER_SPLIT = "1";
    process.env.OPENCODEX_LEGACY_PROVIDER_BRIDGE = "1";
    assert.equal(clearOwnedProviderBridgeLaunchEnvironment(), true);
    assert.equal(process.env.CODEX_CLI_PATH, undefined);
    assert.equal(process.env.OPENCODEX_PROVIDER_BRIDGE_PATH, undefined);
    assert.equal(process.env.OPENCODEX_PROVIDER_SPLIT, undefined);
    assert.equal(process.env.OPENCODEX_LEGACY_PROVIDER_BRIDGE, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("1.1.5 keeps one local native conversation and routes provider turns at Egress", async () => {
  const [source, launcher] = await Promise.all([
    readFile(new URL("../src_v2/codex-provider-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /spawnRuntime/);
  assert.match(source, /OPENCODEX_PROVIDER_BRIDGE_RUNTIME/);
  assert.match(source, /rewriteNativeGatewayRequestBody/);
  assert.doesNotMatch(source, /thread\/inject_items/);
  assert.doesNotMatch(source, /function beginGatewayTurn/);
  assert.doesNotMatch(source, /ensureRuntime\(GATEWAY_PROVIDER\)/);
  assert.doesNotMatch(source, /ephemeral: true/);
  assert.match(source, /method === "thread\/list"/);
  assert.match(source, /thread\/settings\/update/);
  assert.match(source, /modelProviders/);
  assert.match(source, /method === "initialize"/);
  assert.match(source, /pendingParentInitializations/);
  assert.match(source, /lastInitializeResult/);
  assert.doesNotMatch(source, /switchProviderThenRequest/);
  assert.doesNotMatch(source, /providerResumeRequest/);
  assert.doesNotMatch(source, /activeRuntime/);
  assert.match(launcher, /environment\.CODEX_CLI_PATH = bridgePath/);
  assert.match(launcher, /OPENCODEX_NATIVE_CODEX_PATH/);
  assert.match(launcher, /buildDesktopLaunchEnvironment/);
  assert.doesNotMatch(launcher, /launchctl\s+setenv/);
  assert.match(launcher, /clearOwnedProviderBridgeLaunchEnvironment/);
  assert.match(launcher, /desktopAppServerState/);
  assert.match(launcher, /explicit user action/);
  assert.doesNotMatch(
    launcher,
    /registerProviderBridgeEnvironment\(this\.port\)/,
  );
  const stopStart = launcher.indexOf("public stop(): Promise<void>");
  assert.ok(stopStart >= 0);
  assert.doesNotMatch(launcher.slice(stopStart), /stopDesktopClients\(\)/);
  assert.doesNotMatch(launcher.slice(stopStart), /clearOwnedProviderBridgeLaunchEnvironment\(\)/);
});
