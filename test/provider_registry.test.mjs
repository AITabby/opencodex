import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ResponsesStreamEngine, ThinkTagFilter } from "../dist/core/stream_engine.js";
import { responsesInputToChatMessages, transformResponsesToChat } from "../dist/core/transformer.js";

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

test("V2 transformer keeps tool calls aligned with their outputs", () => {
  const messages = responsesInputToChatMessages([
    { type: "message", role: "user", content: "执行命令" },
    { type: "function_call", call_id: "fc_test", name: "exec_command", arguments: '{"cmd":"pwd"}' },
    { type: "function_call_output", call_id: "fc_test", output: "/tmp" }
  ]);
  assert.equal(messages[1].tool_calls[0].id, "fc_test");
  assert.equal(messages[2].tool_call_id, "fc_test");
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

test("V2 source contains no request debug persistence or Computer Use re-enablement", async () => {
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
});
