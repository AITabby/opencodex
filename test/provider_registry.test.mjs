import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ResponsesStreamEngine, ThinkTagFilter } from "../dist/core/stream_engine.js";
import { responsesInputToChatMessages, transformResponsesToChat } from "../dist/core/transformer.js";
import { buildFullCatalogEntry } from "../dist/services/catalog_sync.js";
import { AnthropicAdapter } from "../dist/adapters/anthropic.js";

test("V2 transformer strips Codex-only envelopes while preserving the user request", () => {
  const result = transformResponsesToChat({
    instructions: "You are helpful.",
    input: [
      { role: "developer", content: "<environment_context>private</environment_context>" },
      { role: "user", content: "<app-context>private</app-context>\n请继续处理" }
    ],
    stream: true
  }, "test-model", "session-1");
  assert.equal(result.messages[0].role, "system");
  assert.match(result.messages[0].content, /^You are helpful\./);
  assert.equal(result.messages[1].content, "请继续处理");
});

test("catalog entries give Computer Use models a direct connected-tool instruction", () => {
  const entry = buildFullCatalogEntry("computer-model", "test-provider");
  assert.equal(entry.supports_computer_use, true);
  assert.match(entry.base_instructions, /native node-repl executor/);
  assert.match(entry.base_instructions, /mcp__node_repl_js/);
  assert.match(entry.base_instructions, /Do not search for or list MCP servers/);
});

test("V2 transformer keeps tool calls aligned with their outputs", () => {
  const messages = responsesInputToChatMessages([
    { type: "message", role: "user", content: "执行命令" },
    { type: "function_call", call_id: "fc_test", name: "exec_command", arguments: '{"cmd":"pwd"}' },
    { type: "function_call_output", call_id: "fc_test", output: "/tmp" }
  ]);
  assert.equal(messages[1].tool_calls[0].id, "fc_test");
  assert.equal(messages[2].tool_call_id, "fc_test");
});

test("Anthropic adapter never emits a tool_use without an id", () => {
  const payload = new AnthropicAdapter().transformPayload({
    model: "claude-test",
    messages: [{
      role: "assistant",
      content: "",
      tool_calls: [{ id: "", type: "function", function: { name: "mcp__node_repl_js", arguments: "{}" } }],
    }],
    stream: true,
  });
  assert.match(payload.body.messages[0].content[0].id, /^toolu_opencodex_/);
});

test("third-party reasoning stays internal to the V2 stream", () => {
  const filter = new ThinkTagFilter();
  assert.deepEqual(filter.filter("<think>internal</think>visible"), { text: "visible", reasoning: "internal" });
  assert.deepEqual(filter.flush(), { text: "", reasoning: "" });
});

test("V2 stream emits indexed text output and a completed lifecycle", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("test-model", "turn-1");
  const write = async (event) => events.push(event);
  await engine.start(write);
  await engine.processChatChunk(write, { choices: [{ delta: { content: "hello" } }] });
  await engine.finish(write);
  assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.output_index === 0));
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("third-party Responses keep the selected catalog model identity and usage", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("deepseek-v4-flash", "turn-model-identity", {
    responseModel: "opencode/deepseek-v4-flash",
  });
  const write = async (event) => events.push(event);
  await engine.start(write);
  await engine.processChatChunk(write, {
    choices: [{ delta: { content: "ok" } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  });
  await engine.finish(write);

  const completed = events.find((event) => event.type === "response.completed")?.response;
  assert.equal(completed.model, "opencode/deepseek-v4-flash");
  assert.deepEqual(completed.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
});

test("V2 stream ignores provider chunks with an empty choices array", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("test-model", "turn-empty-choice");
  const write = async (event) => events.push(event);
  await engine.start(write);
  await engine.processChatChunk(write, { id: "provider-info", choices: [] });
  await engine.processChatChunk(write, { choices: [{ delta: { content: "after-gap" } }] });
  await engine.finish(write);
  assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.delta === "after-gap"));
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("V2 source keeps Computer Use on the Codex-native executor path", async () => {
  const [source, catalog, router] = await Promise.all([
    readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/services/catalog_sync.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/server/router.ts", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(source, /responses_request_debug|debug_req\.json/);
  assert.match(catalog, /experimental_supported_tools/);
  assert.match(catalog, /image_generation_mode: "native_responses"/);
  assert.match(source, /proxyNativeResponses/);
  assert.match(router, /上游流在完成事件前结束/);
  assert.match(router, /generateNativeCodexImage/);
  assert.match(router, /proxyThirdPartyResponses\(\s*reqBody/);
  assert.match(router, /hasComputerUseTool/);
  assert.doesNotMatch(router, /proxyThirdPartyResponsesWithComputerUse|ensureResponsesComputerUseTool|computer_call_output|opencodex_computer_use/);
  assert.match(catalog, /NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS/);
});

test("provider model management treats providers.json as the durable model source", async () => {
  const [gateway, credentials] = await Promise.all([
    readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/services/credential_store.ts", import.meta.url), "utf8")
  ]);
  assert.match(gateway, /providers\.json is the durable source/);
  assert.match(gateway, /const effectiveModels = Array\.isArray\(p\.models\) \? p\.models : \[\]/);
  assert.match(gateway, /setApiKeyOnProviders\(providers, resolvedProviderName, apiKey\)/);
  assert.match(credentials, /public static setApiKeyOnProviders\(/);
});
