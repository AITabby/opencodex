/**
 * Automated Verification Test Suite for CodexBridge Engine (src_v2)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { transformResponsesToChat, convertToolsToChatTools, stripSubagentDispatchTools, stripSubagentRuntimeTools, buildGatewaySubagentResponseTool } from "../dist/core/transformer.js";
import {
  hasChatToolImages,
  isConsoleGoToolImageRejection,
  isXiaomiChatToolTextRejection,
  isXiaomiMimoProvider,
  normalizeXiaomiChatToolHistory,
  stripChatToolImages,
} from "../dist/services/chat_tool_compat.js";
import { ResponsesStreamEngine, normalizeToolArguments } from "../dist/core/stream_engine.js";
import { GatewayRouter } from "../dist/server/router.js";
import { ChatGptAccountPool } from "../dist/services/chatgpt_account_pool.js";
import { AdapterFactory } from "../dist/adapters/factory.js";
import {
  DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL,
  NATIVE_IMAGE_FALLBACK_MODEL,
  NATIVE_IMAGE_TOOL_NAME,
  buildNativeCodexImageRequestBody,
  extractImageGenerationContext,
  parseImageGenerationArguments,
} from "../dist/services/native_image_bridge.js";
import {
  NATIVE_VISION_MODEL,
  analyzeWithNativeVision,
  assertNoNativeVisionImages,
  extractNativeVisionImages,
  extractNativeVisionImagesInCurrentTurn,
  hasNativeVisionImages,
  hasNativeVisionImagesInCurrentTurn,
  isProviderImageInputRejection,
  replaceImagesWithNativeVisionText,
  normalizeTextOnlyProviderChatPayload,
  stripImageInspectionToolsForTextOnlyTurn,
} from "../dist/services/native_vision_bridge.js";

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

test("v2 transformer preserves native Computer Use call/output pairs and screenshots", () => {
  const chat = transformResponsesToChat({
    model: "text-only-computer-model",
    input: [
      { type: "message", role: "user", content: "检查当前页面" },
      { type: "computer_call", call_id: "call-computer", action: { type: "screenshot" } },
      {
        type: "computer_call_output",
        call_id: "call-computer",
        output: {
          type: "computer_screenshot",
          image_url: "data:image/png;base64,SCREENSHOT",
        },
      },
    ],
  }, "text-only-computer-model");

  const assistant = chat.messages.find((message) => message.role === "assistant");
  const tool = chat.messages.find((message) => message.role === "tool");
  assert.equal(assistant?.tool_calls?.[0]?.id, "call-computer");
  assert.equal(assistant?.tool_calls?.[0]?.function?.name, "mcp__node_repl_js");
  assert.equal(tool?.tool_call_id, "call-computer");
  assert.equal(tool?.content?.[0]?.type, "image_url");
  assert.equal(tool?.content?.[0]?.image_url?.url, "data:image/png;base64,SCREENSHOT");
});

test("v2 transformer restores provider reasoning content on a tool continuation", () => {
  const chat = transformResponsesToChat({
    model: "deepseek-v4-flash",
    input: [
      { type: "message", role: "user", content: "先问我一个问题" },
      { type: "function_call", call_id: "call_question", name: "request_user_input", arguments: "{}" },
      { type: "function_call_output", call_id: "call_question", output: "继续" },
    ],
  }, "deepseek-v4-flash", undefined, true, "deepseek", "provider-private-thinking");

  const assistant = chat.messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.reasoning_content, "provider-private-thinking");
  assert.equal(assistant?.tool_calls?.[0]?.id, "call_question");
});

test("v2 stream engine retains provider reasoning privately for tool continuations", async () => {
  const engine = new ResponsesStreamEngine("deepseek-v4-flash");
  const events = [];
  const write = async (payload) => events.push(payload);
  await engine.start(write);
  await engine.processChatChunk(write, {
    choices: [{
      delta: {
        reasoning_content: "provider-private-thinking",
        tool_calls: [{
          index: 0,
          id: "call_question",
          type: "function",
          function: { name: "request_user_input", arguments: "{}" },
        }],
      },
    }],
  });

  assert.equal(engine.getReasoningContent(), "provider-private-thinking");
  assert.deepEqual(engine.getToolCallIds(), ["call_question"]);
  assert.equal(events.some((event) => event.type === "response.output_item.added" && event.item?.type === "reasoning"), false);
});

test("v2 Chat continuation restores reasoning_content for the matching provider call", async () => {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requests.length === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {
        reasoning_content: "provider-private-thinking",
        tool_calls: [{
          index: 0,
          id: "call-question",
          type: "function",
          function: { name: "request_user_input", arguments: "{}" },
        }],
      } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "已继续" }, finish_reason: "stop" }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const responseSink = () => {
    const chunks = [];
    return {
      headersSent: false,
      writableEnded: false,
      socket: { setNoDelay() {} },
      setHeader() {},
      flushHeaders() { this.headersSent = true; },
      writeHead() { this.headersSent = true; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        this.writableEnded = true;
      },
      chunks,
    };
  };

  const port = upstream.address().port;
  const providerUrl = `http://127.0.0.1:${port}/v1`;
  const router = new GatewayRouter();
  const requestBody = (input) => ({
    model: "opencode/deepseek-v4-flash",
    protocol: "chat",
    input,
    tools: [{
      type: "function",
      function: { name: "request_user_input", parameters: { type: "object" } },
    }],
    stream: true,
    client_metadata: { session_id: "reasoning-continuation-test" },
  });

  try {
    await router.handleResponses(
      requestBody([{ type: "message", role: "user", content: "先问我" }]),
      "deepseek-v4-flash",
      "test-key",
      providerUrl,
      responseSink(),
      "opencode",
      {},
      "opencode/deepseek-v4-flash",
      false,
      "",
      "deepseek",
    );
    const continuationSink = responseSink();
    await router.handleResponses(
      requestBody([
        { type: "message", role: "user", content: "先问我" },
        { type: "function_call", call_id: "call-question", name: "request_user_input", arguments: "{}" },
        { type: "function_call_output", call_id: "call-question", output: "继续" },
      ]),
      "deepseek-v4-flash",
      "test-key",
      providerUrl,
      continuationSink,
      "opencode",
      {},
      "opencode/deepseek-v4-flash",
      false,
      "",
      "deepseek",
    );

    const assistant = requests[1].messages.find((message) => message.role === "assistant");
    assert.equal(assistant.reasoning_content, "provider-private-thinking");
    assert.equal(assistant.tool_calls[0].id, "call-question");
    assert.equal(requests.length, 2);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("provider-specific adapters are reachable without changing the OpenAI fallback", () => {
  assert.equal(AdapterFactory.getAdapter(undefined, undefined).name, "openai");
  assert.equal(AdapterFactory.getAdapter(undefined, undefined, "deepseek").name, "deepseek");
  assert.equal(AdapterFactory.getAdapter(undefined, undefined, "minimax").name, "minimax");

  const nonStreaming = transformResponsesToChat(
    { input: "hello", stream: false },
    "deepseek-v4-pro",
    undefined,
    true,
    "deepseek",
  );
  assert.equal(nonStreaming.stream, false);
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

test("native vision fallback only activates for an explicit provider image rejection", async () => {
  const requestBody = {
    model: "opencode/deepseek-v4-flash",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "这张图有什么问题？" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
      ],
    }],
  };
  assert.equal(hasNativeVisionImages(requestBody), true);
  assert.equal(isProviderImageInputRejection(
    400,
    "Failed to deserialize messages[1]: unknown variant `image_url`, expected `text`",
    requestBody,
  ), true);
  assert.equal(isProviderImageInputRejection(
    400,
    "[invalid_request_error] Input should be a valid string",
    requestBody,
  ), true);
  assert.equal(isProviderImageInputRejection(
    400,
    "Input should be a valid string",
    { input: [{ type: "message", role: "user", content: "普通文字" }] },
  ), false);
  assert.equal(isProviderImageInputRejection(401, "invalid API key", requestBody), false);

  let captured;
  const result = await analyzeWithNativeVision(requestBody, {
    authorization: "Bearer native-subscription-token",
    "chatgpt-account-id": "account-1",
  }, {
    providerApiKey: "third-party-key",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init.body));
      return new Response(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"截图显示请求失败\"}\n\n"
          + "data: {\"type\":\"response.completed\",\"response\":{}}\n\n"
          + "data: [DONE]\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  assert.equal(result.model, NATIVE_VISION_MODEL);
  assert.equal(result.imageCount, 1);
  assert.equal(captured.model, NATIVE_VISION_MODEL);
  assert.equal(captured.store, false);
  assert.equal(captured.stream, true);
  assert.equal(captured.input[0].content[1].image_url, "data:image/png;base64,AAAA");

  const rewritten = replaceImagesWithNativeVisionText(requestBody, result.text);
  assert.equal(hasNativeVisionImages(rewritten), false);
  assert.match(rewritten.input[0].content[1].text, /截图显示请求失败/);
  assert.equal(requestBody.input[0].content[1].type, "input_image");
});

test("native vision does not reread historical images on a text-only follow-up", () => {
  const historicalImage = {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: "data:image/png;base64,OLD" }],
  };
  const currentText = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "好的，我知道了" }],
  };
  assert.equal(hasNativeVisionImages({ input: [historicalImage, currentText] }), true);
  assert.equal(hasNativeVisionImagesInCurrentTurn({ input: [historicalImage, currentText] }), false);
  assert.equal(hasNativeVisionImagesInCurrentTurn({
    messages: [
      { role: "user", content: "之前的问题" },
      { role: "assistant", content: "之前的回答" },
      { role: "user", content: [
        { type: "text", text: "请看这张新图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,NEW" } },
      ] },
    ],
  }), true);
});

test("native vision sidecar receives only the new image from a mixed history", async () => {
  const requestBody = {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,HISTORICAL" }],
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "再看一张新图" },
          { type: "input_image", image_url: "data:image/png;base64,CURRENT" },
        ],
      },
    ],
  };
  const currentImages = extractNativeVisionImagesInCurrentTurn(requestBody);
  assert.equal(currentImages.length, 1);
  assert.equal(currentImages[0].url, "data:image/png;base64,CURRENT");

  let captured;
  await analyzeWithNativeVision(requestBody, {
    authorization: "Bearer native-subscription-token",
    "chatgpt-account-id": "account-1",
  }, {
    images: currentImages,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init.body));
      return new Response(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"新图说明\"}\n\n"
          + "data: [DONE]\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const imageParts = captured.input[0].content.filter((part) => part.type === "input_image");
  assert.equal(imageParts.length, 1);
  assert.equal(imageParts[0].image_url, "data:image/png;base64,CURRENT");
});

test("native vision recognizes a normally dragged Desktop image item", () => {
  const requestBody = {
    input: [
      { type: "message", role: "user", content: "请看这张图" },
      { type: "image", url: "data:image/png;base64,DRAGGED", detail: "auto" },
    ],
  };
  const images = extractNativeVisionImages(requestBody);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, "data:image/png;base64,DRAGGED");
  assert.equal(extractNativeVisionImagesInCurrentTurn(requestBody)[0].url, "data:image/png;base64,DRAGGED");
});

test("native vision recognizes a Computer Use screenshot output", () => {
  const requestBody = {
    input: [
      { type: "message", role: "user", content: "检查当前页面" },
      { type: "computer_call", call_id: "call-screen", action: { type: "screenshot" } },
      {
        type: "computer_call_output",
        call_id: "call-screen",
        output: { type: "computer_screenshot", image_url: "data:image/png;base64:COMPUTER_SCREEN" },
      },
    ],
  };
  const images = extractNativeVisionImages(requestBody);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, "data:image/png;base64:COMPUTER_SCREEN");
  const rewritten = replaceImagesWithNativeVisionText(requestBody, "页面显示登录失败");
  assert.equal(hasNativeVisionImages(rewritten), false);
  assert.match(JSON.stringify(rewritten), /页面显示登录失败/);
});

test("native vision replacement keeps Chat tool content as provider-compatible text", () => {
  const rewritten = replaceImagesWithNativeVisionText({
    messages: [
      {
        role: "tool",
        tool_call_id: "call-1",
        content: [
          { type: "input_text", text: "浏览器结果：" },
          { type: "image_url", image_url: { url: "data:image/png;base64,OLD" } },
        ],
      },
    ],
  }, "页面显示登录失败");

  assert.equal(rewritten.messages[0].content, "浏览器结果：[官方视觉分析（gpt-5.6-luna）]\n页面显示登录失败");
  assert.equal(typeof rewritten.messages[0].content, "string");
  assert.doesNotMatch(JSON.stringify(rewritten), /input_text|image_url|data:image/i);
});

test("native vision uses the selected official account-pool credential", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-native-vision-account-pool-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const pool = new ChatGptAccountPool(dataDir);
    const account = pool.createAccount({ id: "vision-account", label: "Vision Account" });
    await fs.writeFile(path.join(account.profile_dir, "auth.json"), JSON.stringify({
      tokens: { access_token: "pool-vision-token", account_id: "pool-upstream-id" },
    }));
    pool.saveSettings({ rotation_enabled: true, mode: "fixed", default_account_id: account.id });

    let capturedHeaders;
    await analyzeWithNativeVision({
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "描述图片" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      }],
    }, {
      // The Desktop request can carry a syntactically valid but stale token.
      // An enabled official account pool must still provide the selected
      // profile to the native vision sidecar.
      authorization: "Bearer stale-native-token",
      "chatgpt-account-id": "stale-global-id",
    }, {
      providerApiKey: "third-party-key",
      fetchImpl: async (_url, init) => {
        capturedHeaders = init.headers;
        return new Response(
          "data: {\"type\":\"response.output_text.delta\",\"delta\":\"图片描述\"}\n\n"
            + "data: [DONE]\n\n",
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    assert.equal(capturedHeaders.Authorization, "Bearer pool-vision-token");
    assert.equal(capturedHeaders["chatgpt-account-id"], "pool-upstream-id");
    assert.equal(new Headers(capturedHeaders).get("content-type"), "application/json");
    assert.equal(new Headers(capturedHeaders).get("accept"), "*/*");
    assert.equal(new Headers(capturedHeaders).get("accept-encoding"), "identity");
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("native vision retries the current native credential after a stale pool token", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-native-vision-fallback-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const pool = new ChatGptAccountPool(dataDir);
    const account = pool.createAccount({ id: "stale-vision-account", label: "Stale Vision Account" });
    await fs.writeFile(path.join(account.profile_dir, "auth.json"), JSON.stringify({
      tokens: { access_token: "stale-pool-token", account_id: "stale-pool-id" },
    }));
    pool.saveSettings({ rotation_enabled: true, mode: "fixed", default_account_id: account.id });

    let attempts = 0;
    let secondAuthorization = "";
    const result = await analyzeWithNativeVision({
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,FALLBACK" }],
      }],
    }, {
      authorization: "Bearer current-native-token",
      "chatgpt-account-id": "current-native-id",
    }, {
      providerApiKey: "third-party-key",
      fetchImpl: async (_url, init) => {
        attempts += 1;
        if (attempts === 2) secondAuthorization = String(init.headers?.Authorization || "");
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { message: "Could not parse your authentication token" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          "data: {\"type\":\"response.output_text.delta\",\"delta\":\"当前凭证可以看图\"}\n\n"
            + "data: [DONE]\n\n",
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    assert.equal(attempts, 2);
    assert.equal(secondAuthorization, "Bearer current-native-token");
    assert.equal(result.text, "当前凭证可以看图");
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("text-only provider payloads normalize nested Chat content and fail on leftover images", () => {
  const payload = normalizeTextOnlyProviderChatPayload({
    request: {
      messages: [{
        role: "tool",
        content: [
          { type: "input_text", text: "截图结果：" },
          { type: "output_text", text: "已完成" },
        ],
      }],
    },
  });
  assert.equal(payload.request.messages[0].content, "截图结果：已完成");
  assertNoNativeVisionImages(payload);

  assert.throws(() => assertNoNativeVisionImages({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,RAW" } }] }],
  }), /原始图片/);
});

test("text-only image turns remove image inspection tools but preserve command tools", () => {
  const payload = stripImageInspectionToolsForTextOnlyTurn({
    tools: [
      { type: "function", name: "view_image" },
      { type: "function", name: "exec_command" },
    ],
    request: {
      tools: [
        { type: "function", function: { name: "open_image" } },
        { type: "function", function: { name: "write_stdin" } },
      ],
    },
  });
  assert.deepEqual(payload.tools.map((tool) => tool.name), ["exec_command"]);
  assert.deepEqual(payload.request.tools.map((tool) => tool.function.name), ["write_stdin"]);
});

test("native vision failure ends only the current turn after the original image attempt", async () => {
  let upstreamRequests = 0;
  let capturedUpstreamBody = "";
  const upstream = createServer(async (_req, res) => {
    upstreamRequests += 1;
    capturedUpstreamBody = await new Promise((resolve) => {
      let body = "";
      _req.setEncoding("utf8");
      _req.on("data", (chunk) => { body += chunk; });
      _req.on("end", () => resolve(body));
    });
    if (upstreamRequests === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "Input should be a valid string",
        },
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: {\"choices\":[{\"delta\":{\"content\":\"后续文字正常\"},\"finish_reason\":\"stop\"}]}\n\n"
        + "data: [DONE]\n\n",
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const createSink = () => ({
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {},
    chunks: [],
    socket: { setNoDelay() {} },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() { this.headersSent = true; },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
  });
  const sink = createSink();

  const router = new GatewayRouter();
  const port = upstream.address().port;
  try {
    const result = await router.handleResponses({
      model: "opencode/text-only-regression",
      protocol: "chat",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "帮我看看这张图" },
          { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
        ],
      }],
      stream: true,
    }, "text-only-regression", "test-key", `http://127.0.0.1:${port}/v1`, sink, "opencode", {}, "opencode/text-only-regression");

    assert.equal(result.completed, false);
    assert.equal(upstreamRequests, 1);
    assert.match(capturedUpstreamBody, /input_image|image_url|data:image/i);
    assert.equal(sink.statusCode, 200);
    assert.match(Buffer.concat(sink.chunks).toString(), /response\.failed/);
    assert.match(Buffer.concat(sink.chunks).toString(), /official_vision_(auth_unavailable|invalid_request)|官方视觉模型/);
    assert.match(Buffer.concat(sink.chunks).toString(), /data: \[DONE\]/);

    const nextSink = createSink();
    const nextResult = await router.handleResponses({
      model: "opencode/text-only-regression",
      protocol: "chat",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "帮我看看这张图" },
            { type: "input_image", image_url: "data:image/png;base64:TEST_FAILURE_CASE" },
          ],
        },
        { type: "message", role: "user", content: "继续说" },
      ],
      stream: true,
    }, "text-only-regression", "test-key", `http://127.0.0.1:${port}/v1`, nextSink, "opencode", {}, "opencode/text-only-regression");
    assert.equal(nextResult.completed, true);
    assert.equal(upstreamRequests, 2);
    assert.match(Buffer.concat(nextSink.chunks).toString(), /后续文字正常/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("empty provider streams terminate as one failed turn instead of an incomplete reconnect", async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const sink = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {},
    chunks: [],
    socket: { setNoDelay() {} },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() { this.headersSent = true; },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
  };

  const router = new GatewayRouter();
  const port = upstream.address().port;
  try {
    const result = await router.handleResponses({
      model: "opencode/deepseek-empty-stream-regression",
      protocol: "chat",
      input: [{ type: "message", role: "user", content: "空流测试" }],
      stream: true,
    }, "deepseek-empty-stream-regression", "test-key", `http://127.0.0.1:${port}/v1`, sink, "opencode", {}, "opencode/deepseek-empty-stream-regression");

    assert.equal(result.completed, false);
    const events = Buffer.concat(sink.chunks)
      .toString()
      .split(/\r?\n\r?\n/)
      .map((event) => event.split("\n").find((line) => line.startsWith("data:")))
      .filter(Boolean)
      .map((line) => line.slice("data:".length).trim())
      .filter((data) => data && data !== "[DONE]")
      .map((data) => JSON.parse(data));
    assert.equal(events.find((event) => event.type === "response.failed")?.response?.status, "failed");
    assert.equal(events.find((event) => event.type === "response.completed")?.response?.status, "failed");
    assert.equal(events.find((event) => event.type === "response.done")?.response?.status, "failed");
    assert.match(Buffer.concat(sink.chunks).toString(), /data: \[DONE\]/);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Responses image/provider failures close the turn before the next text request", async () => {
  let requests = 0;
  const upstream = createServer(async (req, res) => {
    requests += 1;
    for await (const _chunk of req) {}
    if (requests === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Error from provider (Console Go): Upstream request failed" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"后续文字正常\"}\n\n"
        + "data: {\"type\":\"response.completed\",\"response\":{}}\n\n"
        + "data: [DONE]\n\n",
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const createSink = () => {
    const chunks = [];
    return {
      headersSent: false,
      writableEnded: false,
      statusCode: 0,
      socket: { setNoDelay() {} },
      setHeader() {},
      flushHeaders() { this.headersSent = true; },
      writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        this.writableEnded = true;
      },
      chunks,
    };
  };

  const router = new GatewayRouter();
  const port = upstream.address().port;
  try {
    const failedSink = createSink();
    const failed = await router.handleResponses({
      model: "opencode/responses-image-regression",
      protocol: "responses",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "帮我看图" }, { type: "input_image", image_url: "data:image/png;base64:FAIL" }],
      }],
      stream: true,
    }, "responses-image-regression", "test-key", `http://127.0.0.1:${port}/v1`, failedSink, "opencode", {}, "opencode/responses-image-regression");

    const failedBody = Buffer.concat(failedSink.chunks).toString();
    assert.equal(failed.completed, false);
    assert.equal(failedSink.statusCode, 200);
    assert.match(failedBody, /response\.failed/);
    assert.match(failedBody, /response\.done/);
    assert.match(failedBody, /data: \[DONE\]/);

    const nextSink = createSink();
    const next = await router.handleResponses({
      model: "opencode/responses-image-regression",
      protocol: "responses",
      input: [{ type: "message", role: "user", content: "继续说" }],
      stream: true,
    }, "responses-image-regression", "test-key", `http://127.0.0.1:${port}/v1`, nextSink, "opencode", {}, "opencode/responses-image-regression");
    assert.equal(next.completed, true);
    assert.match(Buffer.concat(nextSink.chunks).toString(), /后续文字正常/);
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
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

test("1.1.0 subagent tool lets the main agent dispatch zero, one, or many children", () => {
  const spawnTool = convertToolsToChatTools().find((tool) => tool.function?.name === "spawn_agent");
  const properties = spawnTool?.function?.parameters?.properties;
  assert.equal(typeof properties?.reasoning_effort?.description, "string");
  assert.equal(typeof properties?.model?.description, "string");
  assert.equal(typeof properties?.profile_id?.description, "string");
  assert.equal(properties?.task_type, undefined);
  assert.equal(properties?.required_tools, undefined);
  assert.equal(properties?.permission, undefined);
  assert.match(spawnTool?.function?.description || "", /explicit binding overrides capability auto-routing/);
  assert.match(spawnTool?.function?.description || "", /saved model capability directory/);
  assert.match(spawnTool?.function?.description || "", /no child, one child, or multiple independent children/);
  assert.match(spawnTool?.function?.description || "", /multiple calls may be issued/);
});

test("1.1.0 exposes the same spawn_agent contract on the native Responses tool path", () => {
  const tool = buildGatewaySubagentResponseTool();
  assert.equal(tool.type, "function");
  assert.equal(tool.name, "spawn_agent");
  assert.equal(typeof tool.parameters?.properties?.reasoning_effort?.description, "string");
  assert.match(tool.description, /multiple independent children/);
});

test("subagent turns do not advertise nested gateway or native agent controls", () => {
  const tools = convertToolsToChatTools([
    { type: "function", function: { name: "spawn_agent", parameters: { type: "object" } } },
    { type: "function", function: { name: "multi_agent_v1_spawn_agent", parameters: { type: "object" } } },
    { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
  ], undefined, false);
  const names = tools.map((tool) => tool.function?.name);
  assert.equal(names.includes("spawn_agent"), false);
  assert.equal(names.includes("multi_agent_v1_spawn_agent"), false);
  assert.equal(names.includes("exec_command"), true);

  const raw = stripSubagentDispatchTools([
    { type: "function", function: { name: "spawn_agent" } },
    { type: "function", function: { name: "multi_agent_v1_wait_agent" } },
    { type: "function", function: { name: "view_file" } },
  ]);
  assert.deepEqual(raw?.map((tool) => tool.function?.name), ["view_file"]);
});

test("subagent Responses conversion keeps worker tools but removes nested dispatch", () => {
  const chat = transformResponsesToChat({
    model: "child-model",
    input: "只完成当前分析，不再创建子代理",
    tools: [
      { type: "function", function: { name: "spawn_agent", parameters: { type: "object" } } },
      { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
    ],
  }, "child-model", undefined, false);
  const names = (chat.tools || []).map((tool) => tool.function?.name);
  assert.equal(names.includes("spawn_agent"), false);
  assert.equal(names.includes("exec_command"), true);
});

test("subagent runtime tools omit host orchestration tools while keeping workers", () => {
  const tools = stripSubagentRuntimeTools([
    { type: "function", function: { name: "exec_command" } },
    { type: "function", function: { name: "update_plan" } },
    { type: "function", function: { name: "codex_app_read_thread_terminal" } },
    { type: "function", function: { name: "mcp__openaiDeveloperDocs_search_openai_docs" } },
  ]);
  assert.deepEqual(tools?.map((tool) => tool.function?.name), ["exec_command"]);
});

test("1.1.0 enables parallel tool calls for dynamic subagent fan-out", () => {
  const chat = transformResponsesToChat({
    model: "main-model",
    input: "拆解这个复杂任务",
  }, "main-model");

  assert.equal(chat.parallel_tool_calls, true);
  assert.equal(chat.tools.some((tool) => tool.function?.name === "spawn_agent"), true);

  const explicitlySequential = transformResponsesToChat({
    model: "main-model",
    input: "保持顺序",
    parallel_tool_calls: false,
  }, "main-model");
  assert.equal(explicitlySequential.parallel_tool_calls, false);
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
  assert.equal(DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL, "gpt-image-2");
  assert.equal(NATIVE_IMAGE_FALLBACK_MODEL, "gpt-image-1.5");
  assert.equal(parseImageGenerationArguments('{"prompt":"画一只猫"}').prompt, "画一只猫");
  const nativeRequest = buildNativeCodexImageRequestBody(
    { prompt: "画一只猫", size: "1024x1024", quality: "medium" },
    context,
    DEFAULT_NATIVE_IMAGE_MAINLINE_MODEL,
  );
  assert.equal(nativeRequest.model, "gpt-image-2");
  assert.equal(nativeRequest.prompt, "画一只猫");
  assert.equal(nativeRequest.background, "auto");
  assert.equal(nativeRequest.quality, "medium");
  assert.equal(nativeRequest.size, "1024x1024");
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

test("stream engine reports output so providers without a terminal SSE marker can close cleanly", async () => {
  const engine = new ResponsesStreamEngine("deepseek-v4-flash");
  assert.equal(engine.hasOutput(), false);
  await engine.processChatChunk(async () => {}, { choices: [{ delta: { content: "已完成分析" } }] });
  assert.equal(engine.hasOutput(), true);
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

test("1.1.0 stream preserves multiple subagent calls from one main-agent turn", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("main-model", "fanout-turn");
  const emit = async (event) => events.push(event);

  await engine.start(emit);
  await engine.processChatChunk(emit, {
    choices: [{ delta: { tool_calls: [
      { index: 0, id: "child-call-1", function: { name: "spawn_agent", arguments: '{"task_name":"analysis","message":"分析任务"}' } },
      { index: 1, id: "child-call-2", function: { name: "spawn_agent", arguments: '{"task_name":"review","message":"审查任务"}' } },
    ] } }],
  });
  await engine.finish(emit);

  const completedCalls = events.filter((event) => event.type === "response.output_item.done" && event.item?.type === "function_call");
  assert.equal(completedCalls.length, 2);
  assert.deepEqual(completedCalls.map((event) => event.item.name), ["spawn_agent", "spawn_agent"]);
  assert.deepEqual(completedCalls.map((event) => event.item.call_id), ["child-call-1", "child-call-2"]);
});

test("1.1.0 consumes gateway-owned spawn_agent calls without leaking them to Desktop", async () => {
  const events = [];
  const engine = new ResponsesStreamEngine("third-party-main", "gateway-dispatch-turn", {
    internalToolNames: ["spawn_agent"],
  });
  const emit = async (event) => events.push(event);

  await engine.start(emit);
  await engine.processChatChunk(emit, {
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "child-call-1",
      function: { name: "spawn_agent", arguments: '{"message":"分析 DeepSeek 的调用链","reasoning_effort":"max"}' },
    }] } }],
  });

  const calls = engine.takeInternalToolCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "spawn_agent");
  assert.match(calls[0].arguments, /max/);
  assert.equal(events.some((event) => event.item?.type === "function_call"), false);
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
