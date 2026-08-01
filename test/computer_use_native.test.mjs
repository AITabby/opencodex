import test from "node:test";
import assert from "node:assert/strict";
import { convertToolsToChatTools, responsesInputToChatMessages, transformResponsesToChat } from "../dist/core/transformer.js";
import { ResponsesStreamEngine } from "../dist/core/stream_engine.js";
import {
  NATIVE_COMPUTER_USE_EXECUTOR_NAMES,
  NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS,
  appendComputerUseInstructions,
  hasComputerUseTool,
  isComputerUseDiscoveryToolName,
  nativeComputerUseMcpDescriptor,
  normalizeComputerUseResponsesTools,
  normalizeNativeComputerUseToolArguments,
  normalizeNativeComputerUseResponsesPayload,
} from "../dist/services/computer_use_native.js";

test("Responses computer descriptors become the real Codex native executor", () => {
  assert.equal(hasComputerUseTool([{ type: "computer" }]), true);
  assert.equal(hasComputerUseTool([{ type: "computer_use_preview" }]), true);

  const tools = convertToolsToChatTools([
    { type: "computer", display_width: 1440, display_height: 900 },
    { type: "computer_use_preview" },
  ]);
  const nativeTools = tools.filter((tool) => NATIVE_COMPUTER_USE_EXECUTOR_NAMES.has(tool.function?.name));
  assert.equal(nativeTools.length, 1);
  assert.equal(nativeTools[0].function.name, "mcp__node_repl_js");
  assert.equal(nativeTools[0].function.parameters.required[0], "code");
  assert.equal(tools.some((tool) => tool.function?.name === "opencodex_computer_use"), false);
});

test("discovery helpers are hidden while mcp__node_repl_js remains executable by Codex", () => {
  const tools = convertToolsToChatTools([
    {
      type: "function",
      function: {
        name: "mcp__node_repl_js",
        description: "Native node repl",
        parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      },
    },
    { type: "function", function: { name: "list_mcp_resources", parameters: { type: "object" } } },
    { type: "function", function: { name: "mcp__node_repl_js_add_node_module_dir", parameters: { type: "object" } } },
    { type: "function", function: { name: "mcp__codex_apps__plugin_management__get_app_permissions", parameters: { type: "object" } } },
    { type: "function", function: { name: "mcp__codex_apps__sites__open", parameters: { type: "object" } } },
  ]);
  const names = tools.map((tool) => tool.function?.name);

  assert.equal(names.includes("mcp__node_repl_js"), true);
  assert.equal(names.includes("list_mcp_resources"), false);
  assert.equal(names.includes("mcp__node_repl_js_add_node_module_dir"), false);
  assert.equal(names.some((name) => String(name).startsWith("mcp__codex_apps__plugin_management__")), false);
  assert.equal(names.some((name) => String(name).startsWith("mcp__codex_apps__")), false);
  assert.equal(isComputerUseDiscoveryToolName("mcp__node_repl_js"), false);
  assert.equal(isComputerUseDiscoveryToolName("mcp__node_repl_js_reset"), true);
});

test("native executor restores the Responses MCP server and tool identity", () => {
  assert.deepEqual(nativeComputerUseMcpDescriptor("mcp__node_repl_js"), {
    serverLabel: "node_repl",
    toolName: "js",
  });
  assert.deepEqual(nativeComputerUseMcpDescriptor("mcp__node_repl__js"), {
    serverLabel: "node_repl",
    toolName: "js",
  });
});

test("native executor arguments bootstrap sky and isolate persistent REPL variables", () => {
  const raw = JSON.stringify({
    title: "Read Chrome state",
    code: "const lines = (await sky.get_app_state({ app: 'com.google.Chrome' })).text.split('\\n');\\nnodeRepl.write(lines.join('\\n'));",
  });
  const normalized = JSON.parse(normalizeNativeComputerUseToolArguments(raw));

  assert.match(normalized.code, /opencodex-native-computer-use-call/);
  assert.match(normalized.code, /setupComputerUseRuntime/);
  assert.match(normalized.code, /async \(\) =>/);
  assert.match(normalized.code, /const lines/);
  assert.notEqual(normalized.code, JSON.parse(raw).code);
});

test("ordinary third-party requests do not receive a gateway-specific Computer Use function", () => {
  const names = convertToolsToChatTools().map((tool) => tool.function?.name);
  assert.equal(names.includes("opencodex_computer_use"), false);
  assert.equal(names.includes("mcp__node_repl_js"), false);
});

test("native Computer Use instruction names the Codex executor and forbids discovery", () => {
  const instructions = appendComputerUseInstructions("Base instructions", [{ type: "computer" }]);
  assert.match(instructions, /native node-repl executor/);
  assert.match(instructions, /mcp__node_repl_js/);
  assert.match(instructions, /Every direct action must include/);
  assert.match(instructions, /There is no `sky\.open_app`/);
  assert.match(instructions, /state\.text/);
  assert.match(instructions, /up to two more times/);
  assert.match(instructions, /disableDiff/);
  assert.match(instructions, /image\/jpeg/);
  assert.match(instructions, /image result was omitted/);
  assert.match(instructions, /never redeclare an existing top-level/);
  assert.match(instructions, /Do not search for or list MCP servers/);
  assert.equal(appendComputerUseInstructions("Base instructions", []).includes(NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS), false);
});

test("Responses Computer Use descriptors become a direct function tool for third-party providers", () => {
  const tools = normalizeComputerUseResponsesTools([
    { type: "computer", display_width: 1440, display_height: 900 },
    { type: "function", function: { name: "mcp__codex_apps__sites__open", parameters: { type: "object" } } },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].name, "mcp__node_repl_js");
  assert.equal(tools[0].parameters.required[0], "code");

  const payload = normalizeNativeComputerUseResponsesPayload({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "mcp__node_repl_js",
      call_id: "call_1",
      arguments: JSON.stringify({ code: "const lines = [];" }),
    },
  });
  assert.equal(payload.item.name, "js");
  assert.equal(payload.item.namespace, "mcp__node_repl");
  assert.match(payload.item.arguments, /setupComputerUseRuntime/);

  const nativeCallIds = new Set(["call_2"]);
  const completedArguments = normalizeNativeComputerUseResponsesPayload({
    type: "response.function_call_arguments.done",
    item_id: "call_2",
    arguments: JSON.stringify({ code: "const lines = [];" }),
  }, nativeCallIds);
  assert.match(completedArguments.arguments, /opencodex-native-computer-use-call/);
});

test("native Computer Use survives a continuation that omits the tool list", () => {
  const sessionId = `native-cu-${Date.now()}`;
  transformResponsesToChat({
    model: "computer-model",
    tools: [{ type: "function", function: { name: "mcp__node_repl_js", parameters: { type: "object" } } }],
    input: "打开浏览器",
  }, "computer-model", sessionId);

  const continuation = transformResponsesToChat({
    model: "computer-model",
    input: "继续",
  }, "computer-model", sessionId);
  assert.equal(continuation.tools.some((tool) => tool.function?.name === "mcp__node_repl_js"), true);
});

test("native node-repl calls are emitted to the Codex client", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("third-party", "cu-turn");
  const emit = async (event) => events.push(event);

  await engine.start(emit);
  await engine.processChatChunk(emit, {
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "call-cu-1",
      function: { name: "mcp__node_repl_js", arguments: JSON.stringify({ code: "return await sky.list_apps();" }) },
    }] } }],
  });
  await engine.finish(emit);

  const call = events.find((event) => event.item?.type === "function_call");
  assert.equal(call?.item?.name, "js");
  assert.equal(call?.item?.namespace, "mcp__node_repl");
  assert.equal(call?.item?.call_id, "call-cu-1");
  assert.match(call?.item?.id || "", /^fc_[A-Za-z0-9_-]+$/);
  const completedCall = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "function_call");
  assert.match(completedCall?.item?.arguments || "", /setupComputerUseRuntime/);
  assert.match(completedCall?.item?.arguments || "", /opencodex-native-computer-use-call/);
  assert.equal(events.some((event) => event.item?.type === "function_call"), true);
  assert.equal(events.some((event) => event.type === "response.function_call_arguments.delta"), true);
  assert.equal(events.some((event) => event.type === "response.function_call_arguments.done"), true);
  assert.equal(events.some((event) => event.type.startsWith("response.mcp_call")), false);
  assert.equal(events.find((event) => event.type === "response.completed")?.response?.output?.[0]?.type, "function_call");
  assert.equal(events.some((event) => event.type === "response.completed"), true);
});

test("native Computer Use keeps explanatory text in commentary before the first tool call", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("third-party", "cu-phase-turn", { forceCommentary: true });
  const emit = async (event) => events.push(event);

  await engine.start(emit);
  await engine.processChatChunk(emit, {
    choices: [{ delta: { content: "先检查当前窗口状态。" } }],
  });
  await engine.processChatChunk(emit, {
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "call-cu-phase-1",
      function: { name: "mcp__node_repl_js", arguments: "{}" },
    }] } }],
  });
  await engine.finish(emit);

  const messageAdded = events.find((event) => event.type === "response.output_item.added" && event.item?.type === "message");
  const messageDone = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");
  const completedMessage = events.find((event) => event.type === "response.completed")?.response?.output?.find((item) => item.type === "message");
  assert.equal(messageAdded?.item?.phase, "commentary");
  assert.equal(messageDone?.item?.phase, "commentary");
  assert.equal(completedMessage?.phase, "commentary");
});

test("Responses MCP continuations become Chat tool calls and outputs", () => {
  const messages = responsesInputToChatMessages([
    { type: "message", role: "user", content: "打开浏览器" },
    {
      type: "mcp_call",
      id: "mcp_native_1",
      server_label: "node_repl",
      name: "js",
      arguments: '{"code":"return await sky.list_apps();"}',
      status: "completed",
      output: "[Chrome]",
    },
    { type: "mcp_call_output", call_id: "mcp_native_2", output: "继续执行" },
  ]);

  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].tool_calls[0].id, "mcp_native_1");
  assert.equal(messages[1].tool_calls[0].function.name, "mcp__node_repl_js");
  assert.equal(messages[2].tool_call_id, "mcp_native_1");
  assert.equal(messages[3].tool_call_id, "mcp_native_2");
});
