import test from "node:test";
import assert from "node:assert/strict";
import { convertToolsToChatTools, responsesInputToChatMessages, transformResponsesToChat } from "../dist/core/transformer.js";
import { ResponsesStreamEngine } from "../dist/core/stream_engine.js";
import { GoogleGeminiAdapter } from "../dist/adapters/google.js";
import {
  NATIVE_COMPUTER_USE_EXECUTOR_NAMES,
  NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS,
  acceptNativeComputerUseResult,
  appendComputerUseInstructions,
  beginNativeComputerUseResultBridge,
  ensureNativeComputerUseResponsesTool,
  hasComputerUseTool,
  isComputerUseDiscoveryToolName,
  nativeComputerUseMcpDescriptor,
  normalizeComputerUseResponsesTools,
  normalizeNativeComputerUseResponsesPayload,
  normalizeNativeComputerUseToolArguments,
  restoreNativeComputerUseResultOutputs,
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
  assert.match(normalized.code, /import\('@oai\/sky'\)/);
  assert.doesNotMatch(normalized.code, /computer-use-client\.mjs/);
  assert.match(normalized.code, /async \(\) =>/);
  assert.match(normalized.code, /const lines/);
  assert.notEqual(normalized.code, JSON.parse(raw).code);
});


test("ordinary third-party requests do not receive a gateway-specific Computer Use function", () => {
  const names = convertToolsToChatTools().map((tool) => tool.function?.name);
  assert.equal(names.includes("opencodex_computer_use"), false);
  assert.equal(names.includes("mcp__node_repl_js"), false);
});

test("standard node-repl MCP descriptors become the native Computer Use executor", () => {
  const descriptor = {
    type: "mcp",
    server_label: "node_repl",
    server_url: "local",
    allowed_tools: ["js"],
    require_approval: "never",
  };
  assert.equal(hasComputerUseTool([descriptor]), true);
  const tools = convertToolsToChatTools([descriptor], "mcp-descriptor-turn");
  assert.equal(tools.some((tool) => tool.function?.name === "mcp__node_repl_js"), true);
});

test("catalog-enabled models receive native Computer Use even when the client omits the descriptor", () => {
  const tools = ensureNativeComputerUseResponsesTool([
    { type: "function", name: "exec_command", parameters: { type: "object" } },
  ], true);
  assert.equal(tools?.some((tool) => tool.name === "mcp__node_repl_js"), true);
  assert.equal(tools?.filter((tool) => tool.name === "mcp__node_repl_js").length, 1);
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

test("native Computer Use instructions document the node-repl output and scroll contract", () => {
  const instructions = appendComputerUseInstructions("Base instructions", [{ type: "computer" }]);
  assert.match(instructions, /nodeRepl\.write/);
  assert.match(instructions, /direction: 'up'\|'down'\|'left'\|'right'/);
  assert.match(instructions, /pages\?: number/);
  assert.match(instructions, /never reuse an element index/);
});

test("native Computer Use restores duration-only MCP output through an in-memory sideband", () => {
  const callId = `call-sideband-${Date.now()}`;
  const itemId = `fc-sideband-${Date.now()}`;
  const token = beginNativeComputerUseResultBridge(callId, itemId);
  assert.equal(typeof token, "string");
  assert.equal(acceptNativeComputerUseResult(token, { text: "fresh accessibility tree", images: [] }), true);

  const restored = restoreNativeComputerUseResultOutputs({
    input: [{
      type: "function_call_output",
      id: itemId,
      output: "Wall time: 0.1 seconds\nOutput:\n{\"execution_duration_ms\":57}",
    }],
  });
  assert.equal(restored.recovered, 1);
  assert.equal(restored.body.input[0].output, "fresh accessibility tree");

  const realOutput = restoreNativeComputerUseResultOutputs({
    input: [{ type: "function_call_output", call_id: callId, output: "already preserved" }],
  });
  assert.equal(realOutput.recovered, 0);
  assert.equal(realOutput.body.input[0].output, "already preserved");
});

test("native Computer Use can recover a result from the wrapper token when ids change", () => {
  const token = beginNativeComputerUseResultBridge(
    `call-token-source-${Date.now()}`,
    `fc-token-source-${Date.now()}`,
  );
  assert.equal(acceptNativeComputerUseResult(token, { text: "fresh state after scroll", images: [] }), true);
  const wrappedArguments = JSON.parse(normalizeNativeComputerUseToolArguments(
    JSON.stringify({ code: "nodeRepl.write('state')" }),
    { resultToken: token },
  )).code;

  const restored = restoreNativeComputerUseResultOutputs({
    input: [
      { type: "function_call", call_id: "history-call-id", arguments: wrappedArguments },
      {
        type: "function_call_output",
        call_id: "history-call-id",
        output: "Output: {\"execution_duration_ms\":12}",
      },
    ],
  });
  assert.equal(restored.recovered, 1);
  assert.equal(restored.body.input[1].output, "fresh state after scroll");
});

test("native Computer Use wrapper reports text and screenshots without changing the executor", () => {
  const wrapped = JSON.parse(normalizeNativeComputerUseToolArguments(
    JSON.stringify({ code: "nodeRepl.write('state')" }),
    { resultToken: "token-test" },
  ));
  assert.doesNotMatch(wrapped.code, /new Proxy/);
  assert.match(wrapped.code, /plain facade/);
  assert.match(wrapped.code, /__opencodexOriginalNodeRepl\.write/);
  assert.match(wrapped.code, /__opencodexOriginalNodeRepl\.emitImage/);
  assert.match(wrapped.code, /nodeRepl, console/);
  assert.match(wrapped.code, /token-test/);
  assert.match(wrapped.code, /opencodex-native-computer-use-token-test\.json/);
  assert.match(wrapped.code, /nodeRepl\.write\('state'\)/);
});

test("Gemini adapter exposes and restores the native Computer Use function call", () => {
  const adapter = new GoogleGeminiAdapter();
  const thoughtSignature = "provider-thought-signature";
  const payload = adapter.transformPayload({
    model: "gemini-3.6-flash-medium",
    messages: [
      { role: "user", content: "打开 Chrome" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-cu-gemini",
          type: "function",
          thought_signature: thoughtSignature,
          function: { name: "mcp__node_repl_js", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call-cu-gemini", content: "完成" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "mcp__node_repl_js",
        description: "Native Computer Use",
        parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      },
    }],
    stream: true,
  }).body;

  assert.deepEqual(
    payload.tools?.[0]?.functionDeclarations?.map((tool) => tool.name),
    ["mcp__node_repl_js"],
  );
  assert.equal(payload.contents?.[1]?.parts?.[0]?.thoughtSignature, thoughtSignature);
  assert.equal(payload.contents?.[2]?.parts?.[0]?.functionResponse?.name, "mcp__node_repl_js");

  const legacyPayload = adapter.transformPayload({
    model: "gemini-3.6-flash-medium",
    messages: [
      { role: "user", content: "继续" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-legacy",
          type: "function",
          function: { name: "mcp__node_repl_js", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call-legacy", content: "旧工具结果" },
    ],
  }).body;
  assert.equal(legacyPayload.contents?.some((content) => content.parts?.some((part) => part.functionCall)), false);
  assert.doesNotMatch(JSON.stringify(legacyPayload.contents), /previous tool (call|result)/i);
  assert.doesNotMatch(JSON.stringify(legacyPayload.contents), /旧工具结果/);

  const legacyScreenshotPayload = adapter.transformPayload({
    model: "gemini-3.6-flash-medium",
    messages: [
      { role: "user", content: "继续看屏幕" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-legacy-image",
          type: "function",
          function: { name: "mcp__node_repl_js", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call-legacy-image",
        content: [
          { type: "text", text: "internal accessibility tree" },
          { type: "image_url", image_url: "data:image/png;base64,c2NyZWVuc2hvdA==" },
        ],
      },
    ],
  }).body;
  assert.equal(legacyScreenshotPayload.contents?.some((content) =>
    content.parts?.some((part) => part.inlineData?.data === "c2NyZWVuc2hvdA=="),
  ), true);
  assert.doesNotMatch(JSON.stringify(legacyScreenshotPayload.contents), /internal accessibility tree/);

  const chunks = adapter.processStreamChunk({
    candidates: [{ content: { parts: [{ functionCall: { name: "mcp__node_repl_js", args: { code: "nodeRepl.write('ok')" } }, thoughtSignature }] } }],
  });
  assert.equal(chunks[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name, "mcp__node_repl_js");
  assert.equal(chunks[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.thought_signature, thoughtSignature);
});

test("Gemini adapter drops an orphaned terminal model turn without inventing a prompt", () => {
  const adapter = new GoogleGeminiAdapter();
  const payload = adapter.transformPayload({
    model: "gemini-3.7-flash-medium",
    messages: [
      { role: "user", content: "继续操作浏览器" },
      { role: "assistant", content: "我先检查当前页面。" },
    ],
  }).body;

  assert.equal(payload.contents.at(-1)?.role, "user");
  assert.notEqual(payload.contents.at(-1)?.parts?.[0]?.text, "Continue from the previous tool result.");
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
  assert.match(payload.item.arguments, /import\('@oai\/sky'\)/);

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
  assert.match(completedCall?.item?.arguments || "", /import\('@oai\/sky'\)/);
  assert.match(completedCall?.item?.arguments || "", /opencodex-native-computer-use-call/);
  assert.equal(events.some((event) => event.item?.type === "function_call"), true);
  assert.equal(events.some((event) => event.type === "response.function_call_arguments.delta"), true);
  assert.equal(events.some((event) => event.type === "response.function_call_arguments.done"), true);
  assert.equal(events.some((event) => event.type.startsWith("response.mcp_call")), false);
  assert.equal(events.find((event) => event.type === "response.completed")?.response?.output?.[0]?.type, "function_call");
  assert.equal(events.some((event) => event.type === "response.completed"), true);
});

test("native tool metadata is present in every Responses completion boundary", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("third-party", "cu-signature-turn");
  const emit = async (event) => events.push(event);

  await engine.start(emit);
  await engine.processChatChunk(emit, {
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "call-cu-signature",
      thought_signature: "provider-signature",
      function: { name: "mcp__node_repl_js", arguments: "{}" },
    }] } }],
  });
  await engine.finish(emit);

  const added = events.find((event) => event.type === "response.output_item.added" && event.item?.type === "function_call");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(added?.item?.thought_signature, "provider-signature");
  assert.equal(completed?.response?.output?.find((item) => item.type === "function_call")?.thought_signature, "provider-signature");
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
