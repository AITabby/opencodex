/**
 * Automated Verification Test Suite for CodexBridge Engine (src_v2)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { transformResponsesToChat, convertToolsToChatTools } from "../dist/core/transformer.js";
import { ResponsesStreamEngine, normalizeToolArguments } from "../dist/core/stream_engine.js";

test("v2 transformer handles responses to chat conversion cleanly", () => {
  const reqBody = {
    model: "deepseek-v4-pro",
    instructions: "System prompt",
    input: [
      { type: "message", role: "user", content: "check pwd" },
      { type: "function_call", call_id: "call_123", name: "exec_command", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "call_123", output: "/Users/aitabby" }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "Runs command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } }
        }
      }
    ]
  };

  const chat = transformResponsesToChat(reqBody, "deepseek-v4-pro");
  assert.equal(chat.model, "deepseek-v4-pro");
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[1].role, "user");
  assert.equal(chat.messages[2].role, "assistant");
  assert.equal(chat.messages[3].role, "tool");
  assert.equal(chat.messages[3].tool_call_id, "call_123");
});

test("v2 transformer preserves string Responses input as a user message", () => {
  const chat = transformResponsesToChat({
    model: "composer-2.5",
    input: "你好",
  }, "composer-2.5");

  assert.equal(chat.messages.at(-1)?.role, "user");
  assert.equal(chat.messages.at(-1)?.content, "你好");
  assert.equal(chat.messages.some((message) => String(message.content).includes("Tool Contract & Permission Directive")), false);
});

test("v2 default tool contract exposes real Codex subagent controls", () => {
  const names = convertToolsToChatTools().map((tool) => tool.function?.name);

  assert.equal(names[0], "spawn_agent");
  assert.equal(names.includes("wait_agent"), false);
  assert.equal(names.includes("list_agents"), false);
});

test("v2 explicit desktop tools retain the subagent controls", () => {
  const names = convertToolsToChatTools([
    { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
    { type: "function", function: { name: "view_file", parameters: { type: "object" } } },
    { type: "function", function: { name: "list_dir", parameters: { type: "object" } } }
  ]).map((tool) => tool.function?.name);

  assert.deepEqual(names.slice(0, 1), ["spawn_agent"]);
  assert.deepEqual(names.slice(1), ["exec_command", "view_file", "list_dir"]);
});

test("v2 exec command contract can request desktop-path approval", () => {
  const execTool = convertToolsToChatTools().find((tool) => tool.function?.name === "exec_command");
  const properties = execTool?.function?.parameters?.properties;

  assert.deepEqual(properties?.sandbox_permissions?.enum, ["use_default", "require_escalated"]);
  assert.equal(typeof properties?.justification?.description, "string");
});

test("v2 adds desktop approval fields at the protocol boundary", () => {
  const normalized = JSON.parse(normalizeToolArguments("exec_command", JSON.stringify({
    cmd: "cat > ~/Desktop/game.html <<'EOF'\nhello\nEOF"
  })));

  assert.equal(normalized.sandbox_permissions, "require_escalated");
  assert.equal(typeof normalized.justification, "string");
});

test("v2 stream engine keeps third-party reasoning internal and emits text", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("mock-coder", "turn-123");

  await engine.start(async (evt) => events.push(evt));

  // Process chunk with reasoning tag
  await engine.processChatChunk(async (evt) => events.push(evt), {
    choices: [{ delta: { content: "<think>thinking deeply</think>hello world" } }]
  });

  await engine.finish(async (evt) => events.push(evt));

  const textEvent = events.find((evt) => evt.type === "response.output_text.delta");

  assert.equal(events.some((evt) => evt.type.startsWith("response.reasoning_")), false);
  assert.equal(events.some((evt) => evt.item?.type === "reasoning"), false);
  assert.equal(events.some((evt) => typeof evt.item?.id === "string" && evt.item.id.startsWith("rs_")), false);
  assert.ok(textEvent);
  assert.equal(textEvent.delta, "hello world");
});

test("v2 tool-only responses do not announce an empty message before the tool call", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("mock-coder", "tool-turn");
  const emit = async (event) => events.push(event);

  await engine.start(emit);
  await engine.processChatChunk(emit, {
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }) } }] } }]
  });
  await engine.finish(emit);

  const addedItems = events.filter((event) => event.type === "response.output_item.added");
  assert.equal(addedItems[0]?.item?.type, "function_call");
  assert.equal(addedItems[0]?.output_index, 0);
  assert.match(addedItems[0]?.item?.id || "", /^fc_[A-Za-z0-9_-]+$/);
  assert.equal(addedItems[0]?.item?.call_id, "call_1");
  assert.equal(addedItems.some((event) => event.item?.type === "message" && event.item?.content?.length === 0), false);

  const completedToolIndex = events.findIndex((event) => event.type === "response.output_item.done" && event.item?.type === "function_call");
  const responseDoneIndex = events.findIndex((event) => event.type === "response.done");
  assert.ok(completedToolIndex >= 0);
  assert.ok(completedToolIndex < responseDoneIndex);
});
