/**
 * Automated Verification Test Suite for CodexBridge Engine (src_v2)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { transformResponsesToChat, convertToolsToChatTools } from "../dist/core/transformer.js";
import {
  hasChatToolImages,
  isConsoleGoToolImageRejection,
  isXiaomiChatToolTextRejection,
  isXiaomiMimoProvider,
  normalizeXiaomiChatToolHistory,
  stripChatToolImages,
} from "../dist/services/chat_tool_compat.js";
import { ResponsesStreamEngine, normalizeToolArguments } from "../dist/core/stream_engine.js";
import {
  DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL,
  NATIVE_IMAGE_TOOL_NAME,
  buildNativeCodexImageRequestBody,
  extractImageGenerationContext,
  parseImageGenerationArguments,
} from "../dist/services/native_image_bridge.js";

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

test("v2 transformer preserves Computer Use screenshot output for Chat vision models", () => {
  const chat = transformResponsesToChat({
    model: "computer-model",
    tools: [{ type: "computer" }],
    input: [
      { type: "message", role: "user", content: "检查当前页面" },
      { type: "function_call", call_id: "call-screen", name: "mcp__node_repl_js", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call-screen",
        output: [
          { type: "input_text", text: "当前页面状态" },
          { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "high" },
        ],
      },
    ],
  }, "computer-model");

  const toolMessage = chat.messages.find((message) => message.role === "tool");
  assert.deepEqual(toolMessage?.content, [
    { type: "text", text: "当前页面状态" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "high" } },
  ]);
});

test("Chat fallback strips only rejected Computer Use tool screenshots", () => {
  const payload = {
    messages: [
      { role: "user", content: "检查页面" },
      {
        role: "tool",
        tool_call_id: "call-screen",
        content: [
          { type: "text", text: "当前页面状态" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        ],
      },
    ],
  };

  assert.equal(hasChatToolImages(payload), true);
  assert.equal(isConsoleGoToolImageRejection(400, "Error from provider (Console Go): Upstream request failed", payload), true);
  const fallback = stripChatToolImages(payload);
  assert.equal(fallback.messages[1].content, "当前页面状态");
  assert.equal(payload.messages[1].content[1].type, "image_url");
  assert.equal(isConsoleGoToolImageRejection(400, "invalid tool arguments", payload), false);
});

test("MiMo Chat tool continuations receive a non-empty text field without changing other providers", () => {
  const payload = {
    messages: [
      { role: "user", content: "检查页面" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-screen", type: "function", function: { name: "mcp__node_repl_js", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-screen", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] },
    ],
  };

  const normalized = normalizeXiaomiChatToolHistory(payload);
  assert.equal(normalized.messages[1].content, " ");
  assert.equal(normalized.messages[2].content[0].type, "text");
  assert.equal(normalized.messages[2].content[0].text, " ");
  assert.equal(payload.messages[1].content, "");
  assert.equal(isXiaomiChatToolTextRejection(400, "Error from provider (Xiaomi): Param Incorrect", payload), true);
  assert.equal(isXiaomiChatToolTextRejection(400, "Error from provider (MiniMax): Param Incorrect", payload), false);
  assert.equal(isXiaomiMimoProvider("opencode", "https://opencode.ai/zen/go/v1", "mimo-v2.5"), true);
  assert.equal(isXiaomiMimoProvider("minimax", "https://api.minimaxi.com/v1", "minimax-m3"), false);
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

test("v2 transformer tells Computer Use models to call the connected tool directly", () => {
  const chat = transformResponsesToChat({
    model: "computer-model",
    instructions: "You are helpful.",
    tools: [{ type: "computer" }],
    input: "打开浏览器",
  }, "computer-model");

  assert.equal(chat.messages[0].role, "system");
  assert.match(chat.messages[0].content, /native node-repl executor/);
  assert.match(chat.messages[0].content, /mcp__node_repl_js/);
  assert.equal(chat.tools.some((tool) => tool.function?.name === "mcp__node_repl_js"), true);
});

test("v2 transformer forwards the selected reasoning effort to Chat providers", () => {
  const fromResponsesReasoning = transformResponsesToChat({
    model: "deepseek-v4-flash",
    reasoning: { effort: "xhigh" },
    input: "solve this carefully",
  }, "deepseek-v4-flash");
  const fromLegacyField = transformResponsesToChat({
    model: "deepseek-v4-flash",
    reasoning_effort: "max",
    input: "solve this carefully",
  }, "deepseek-v4-flash");

  assert.equal(fromResponsesReasoning.reasoning_effort, "xhigh");
  assert.equal(fromLegacyField.reasoning_effort, "max");
});

test("v2 default tool contract exposes real Codex subagent controls", () => {
  const names = convertToolsToChatTools().map((tool) => tool.function?.name);

  assert.equal(names[0], "spawn_agent");
  assert.equal(names.includes("wait_agent"), false);
  assert.equal(names.includes("list_agents"), false);
  assert.equal(names.includes("opencodex_computer_use"), false);
  assert.equal(names.includes("mcp__node_repl_js"), false);
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

test("v2 converts Responses image_generation into a gateway-owned native Codex function", () => {
  const tools = convertToolsToChatTools([{ type: "image_generation" }]);
  const imageTool = tools.find((tool) => tool.function?.name === NATIVE_IMAGE_TOOL_NAME);

  assert.ok(imageTool);
  assert.equal(imageTool.function.parameters.required[0], "prompt");
  assert.equal(tools.some((tool) => tool.function?.name === "spawn_agent"), true);
});

test("native Codex image bridge keeps generation independent from the chat model's vision flag", () => {
  const context = extractImageGenerationContext({
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "把这张图改成海报" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    }],
  });
  assert.equal(context.text, "把这张图改成海报");
  assert.deepEqual(context.images, [{ url: "data:image/png;base64,AAAA" }]);
  assert.equal(DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL, "gpt-5.6");
  assert.equal(parseImageGenerationArguments('{"prompt":"画一只猫"}').prompt, "画一只猫");
  const nativeRequest = buildNativeCodexImageRequestBody(
    { prompt: "画一只猫", size: "1024x1024", quality: "medium" },
    context,
    DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL,
  );
  assert.equal(nativeRequest.tools[0].type, "image_generation");
  assert.equal(nativeRequest.tools[0].action, "auto");
  assert.equal(nativeRequest.tools[0].partial_images, 0);
  assert.equal(nativeRequest.tools[0].size, "1024x1024");
  assert.equal(nativeRequest.input[0].content[1].type, "input_image");
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

test("v2 executes internal image calls without leaking them as client function calls", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("mock-coder", "image-turn");
  const emit = async (event) => events.push(event);

  await engine.start(emit);
  await engine.processChatChunk(emit, {
    choices: [{ delta: {
      tool_calls: [{
        index: 0,
        id: "call-image",
        function: { name: NATIVE_IMAGE_TOOL_NAME, arguments: '{"prompt":"一只猫"}' },
      }],
    } }],
  });

  assert.equal(engine.getInternalImageToolCalls()[0].arguments, '{"prompt":"一只猫"}');
  assert.equal(events.some((event) => event.item?.type === "function_call"), false);

  await engine.emitImageGeneration(emit, { result: "AAAA" });
  await engine.finish(emit);

  assert.equal(events.some((event) => event.item?.type === "image_generation_call"), true);
  assert.equal(events.some((event) => event.type === "response.image_generation_call.partial_image"), false);
  assert.equal(events.find((event) => event.type === "response.output_item.done")?.item?.result, "AAAA");
  assert.equal(events.find((event) => event.type === "response.completed")?.response?.output?.[0]?.type, "image_generation_call");
  assert.equal(events.some((event) => event.item?.type === "message"), false);
});
