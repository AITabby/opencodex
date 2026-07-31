import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import {
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_RESPONSES_MODELS,
  DEEPSEEK_RESPONSES_URL,
  effectiveDeepSeekBaseUrl,
  isDeepSeekResponsesModel,
  selectDeepSeekResponsesModels,
} from "../dist/providers/deepseek.js";
import {
  buildNativeResponsesPayload,
  normalizeResponsesEndpoint,
  probeDeepSeekResponsesModels,
  proxyNativeResponses,
} from "../dist/server/native_responses.js";
import { GatewayRouter } from "../dist/server/router.js";
import { upsertProviderCatalogModel } from "../dist/server/gateway.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("DeepSeek V4 Flash and Pro are both native Responses models", () => {
  assert.deepEqual([...DEEPSEEK_RESPONSES_MODELS], ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(isDeepSeekResponsesModel("deepseek-v4-flash"), true);
  assert.equal(isDeepSeekResponsesModel("deepseek/deepseek-v4-pro"), true);
  assert.equal(isDeepSeekResponsesModel("deepseek-chat"), false);
  assert.equal(effectiveDeepSeekBaseUrl("deepseek", "deepseek", "https://api.deepseek.com/v1"), DEEPSEEK_API_BASE_URL);
});

test("DeepSeek base URL variants normalize to the exact native Responses endpoint", () => {
  for (const input of [
    "https://api.deepseek.com",
    "https://api.deepseek.com/",
    "https://api.deepseek.com/v1",
    "https://api.deepseek.com/v1/",
    "https://api.deepseek.com/chat/completions",
    "https://api.deepseek.com/v1/chat/completions",
    "https://api.deepseek.com/v1/responses",
    "https://api.deepseek.com/responses",
  ]) {
    assert.equal(normalizeResponsesEndpoint(input), DEEPSEEK_RESPONSES_URL, input);
  }
});

test("DeepSeek connectivity checks include only the configured models", () => {
  assert.deepEqual(
    selectDeepSeekResponsesModels([
      "deepseek/deepseek-v4-flash",
      "flash-alias=deepseek-v4-flash",
      "legacy-chat=deepseek-chat",
    ]),
    ["deepseek-v4-flash"],
  );
  assert.deepEqual(
    selectDeepSeekResponsesModels(["pro-alias->deepseek/deepseek-v4-pro"]),
    ["deepseek-v4-pro"],
  );
});

test("native Responses payload preserves the protocol body and removes only local routing metadata", () => {
  const original = {
    model: "deepseek/deepseek-v4-flash",
    protocol: "responses",
    client_metadata: { session_id: "private-session" },
    session_id: "private-session",
    turn_id: "private-turn",
    instructions: "You are helpful.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }],
    tool_choice: "required",
    reasoning: { effort: "max" },
    max_output_tokens: 64,
    stream: true,
  };

  const payload = buildNativeResponsesPayload(original, "deepseek-v4-flash");
  assert.equal(payload.model, "deepseek-v4-flash");
  assert.equal(payload.protocol, undefined);
  assert.equal(payload.client_metadata, undefined);
  assert.equal(payload.session_id, undefined);
  assert.equal(payload.turn_id, undefined);
  assert.deepEqual(payload.input, original.input);
  assert.deepEqual(payload.tools, original.tools);
  assert.equal(payload.tool_choice, "required");
  assert.deepEqual(payload.reasoning, { effort: "max" });
  assert.equal(original.model, "deepseek/deepseek-v4-flash");
  assert.deepEqual(original.client_metadata, { session_id: "private-session" });
});

test("GatewayRouter dispatches both DeepSeek V4 models before Chat conversion", async () => {
  const calls = [];
  const router = new GatewayRouter(async (request) => calls.push(request));
  const res = {};

  for (const model of DEEPSEEK_RESPONSES_MODELS) {
    await router.handleResponses(
      { model: `deepseek/${model}`, protocol: "responses", input: "hello", stream: true },
      model,
      "unit-test-key",
      DEEPSEEK_API_BASE_URL,
      res,
      "deepseek",
    );
  }

  assert.deepEqual(calls.map((call) => call.upstreamModel), [...DEEPSEEK_RESPONSES_MODELS]);
  assert.equal(calls.every((call) => call.providerUrl === DEEPSEEK_API_BASE_URL), true);
  assert.equal(calls.every((call) => call.reqBody.protocol === "responses"), true);
});

test("native Responses proxy relays semantic SSE bytes without response.done or [DONE]", async () => {
  const upstreamSse = [
    "event: response.created",
    'data: {"type":"response.created","sequence_number":0}',
    "",
    ": keep-alive",
    "",
    "event: response.completed",
    'data: {"type":"response.completed","sequence_number":1,"response":{"object":"response"}}',
    "",
  ].join("\n");
  const calls = [];
  const fetcher = async (target, options) => {
    calls.push({ target, options });
    return new Response(upstreamSse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Request-Id": "req_test" },
    });
  };
  const server = http.createServer((req, res) => {
    void proxyNativeResponses({
      reqBody: {
        model: "deepseek/deepseek-v4-pro",
        protocol: "responses",
        client_metadata: { session_id: "local-only" },
        input: "hello",
        stream: true,
      },
      upstreamModel: "deepseek-v4-pro",
      apiKey: "unit-test-key",
      providerUrl: "https://api.deepseek.com/v1",
      providerName: "deepseek",
      res,
      fetcher,
    });
  });

  const baseUrl = await listen(server);
  try {
    const response = await fetch(baseUrl);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "req_test");
    assert.equal(body, upstreamSse);
    assert.equal(body.includes("response.done"), false);
    assert.equal(body.includes("[DONE]"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, DEEPSEEK_RESPONSES_URL);
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(sent.model, "deepseek-v4-pro");
    assert.equal(sent.protocol, undefined);
    assert.equal(sent.client_metadata, undefined);
  } finally {
    await close(server);
  }
});

test("native Responses proxy forwards upstream failure and never attempts Chat fallback", async () => {
  const targets = [];
  const fetcher = async (target) => {
    targets.push(target);
    return new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };
  const server = http.createServer((req, res) => {
    void proxyNativeResponses({
      reqBody: { protocol: "responses", input: "hello", stream: false },
      upstreamModel: "deepseek-v4-pro",
      apiKey: "unit-test-key",
      providerUrl: DEEPSEEK_API_BASE_URL,
      providerName: "deepseek",
      res,
      fetcher,
    });
  });

  const baseUrl = await listen(server);
  try {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { message: "model unavailable" } });
    assert.deepEqual(targets, [DEEPSEEK_RESPONSES_URL]);
  } finally {
    await close(server);
  }
});

test("DeepSeek provider probe validates both models against /responses", async () => {
  const calls = [];
  const fetcher = async (target, options) => {
    calls.push({ target, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ object: "response", status: "completed", output: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const results = await probeDeepSeekResponsesModels(
    "unit-test-key",
    DEEPSEEK_RESPONSES_MODELS,
    "https://api.deepseek.com/v1",
    fetcher,
  );

  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(calls.map((call) => call.target), [DEEPSEEK_RESPONSES_URL, DEEPSEEK_RESPONSES_URL]);
  assert.deepEqual(calls.map((call) => call.body.model), [...DEEPSEEK_RESPONSES_MODELS]);
});

test("DeepSeek catalog entries carry native Responses metadata", () => {
  const catalog = { models: [] };
  for (const model of DEEPSEEK_RESPONSES_MODELS) {
    upsertProviderCatalogModel(catalog, model, model, model, "deepseek");
  }

  assert.equal(catalog.models.length, 2);
  for (const model of catalog.models) {
    assert.equal(model.backend_protocol, "responses");
    assert.equal(model.context_window, 1048576);
    assert.equal(model.max_context_window, 1048576);
    assert.deepEqual(model.input_modalities, ["text"]);
    assert.equal(model.supports_search_tool, true);
    assert.equal(model.prefer_websockets, false);
  }
});
