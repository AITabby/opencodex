import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  acquireCursorStreamReader,
  decodeAvailableModelsResponse,
  decodeConnectMessages,
  decodeCursorEndStreamError,
  decodeCursorStreamComplete,
  decodeCursorResponse,
  encodeAvailableModelsRequest,
  encodeAgentRunRequest,
  encodeComposerChatRequest,
  encodeGetChatRequest,
  encodeUnifiedChatRequest,
  resolveCursorAgentModelSelector,
  cursorNativeToolRequest,
  frameConnectMessage,
} from "../dist/services/cursor_protocol.js";
import {
  decryptClaudeSafeStorageValue,
  buildAntigravityUserAgent,
  buildGrokUserAgent,
  normalizeAntigravityClientVersion,
  normalizeGrokClientVersion,
  selectClaudeDesktopTokenCache,
  selectAntigravityOAuthClientId,
  extractAntigravityOAuthClientSecrets,
} from "../dist/services/subscription_auth.js";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  ReadArgsSchema,
  LsArgsSchema,
  GrepArgsSchema,
} from "../dist/services/cursor_gen/agent_pb.js";

function bytes(...values) {
  return Uint8Array.from(values);
}

function encryptClaudeSafeStorageValue(value, safeStorageKey) {
  const masterKey = crypto.pbkdf2Sync(
    Buffer.from(safeStorageKey, "utf8"),
    Buffer.from("saltysalt", "utf8"),
    1003,
    16,
    "sha1",
  );
  const cipher = crypto.createCipheriv("aes-128-cbc", masterKey, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), encrypted]).toString("base64");
}

test("Claude Desktop safeStorage cache decrypts and selects the Anthropic OAuth entry", () => {
  const key = "synthetic-claude-safe-storage-key";
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const cache = {
    "desktop-client:org:https://api.anthropic.com:user:inference": {
      token: "claude-access-token",
      refreshToken: "claude-refresh-token",
      expiresAt,
    },
  };
  const encoded = encryptClaudeSafeStorageValue(JSON.stringify(cache), key);

  assert.deepEqual(JSON.parse(decryptClaudeSafeStorageValue(encoded, key)), cache);
  assert.deepEqual(selectClaudeDesktopTokenCache(cache), {
    accessToken: "claude-access-token",
    refreshToken: "claude-refresh-token",
    expiresAt,
  });
});

test("Cursor continuation reuses the original response reader", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("frame"));
    },
  }));
  const reader = acquireCursorStreamReader(response);
  assert.equal(acquireCursorStreamReader(response, reader), reader);
  assert.throws(() => acquireCursorStreamReader(response), /already consumed/);
  await reader.cancel();
});

test("Antigravity OAuth discovery selects the client ID by local vendor context", () => {
  const internalId = "111111111111111111111111111111111111111111111111111111111111111111111111111.apps.googleusercontent.com";
  const antigravityId = "222222222222222222222222222222222222222222222222222222222222222222222222222.apps.googleusercontent.com";
  const binary = `internal google ${internalId} padding ${"x".repeat(500)} oauth client token ${antigravityId}`;

  assert.equal(selectAntigravityOAuthClientId(binary, [internalId, antigravityId]), antigravityId);
});

test("Antigravity OAuth discovery does not merge adjacent client secrets", () => {
  const first = `GOCSPX-${"a".repeat(28)}`;
  const second = `GOCSPX-${"b".repeat(28)}`;

  assert.deepEqual(extractAntigravityOAuthClientSecrets(`${first}${second}`), [first, second]);
});

test("Antigravity User-Agent uses the detected client version", () => {
  assert.equal(normalizeAntigravityClientVersion(" 2.8.0\n"), "2.8.0");
  assert.equal(normalizeAntigravityClientVersion("unknown"), null);
  assert.equal(
    buildAntigravityUserAgent("2.8.0", "darwin", "arm64"),
    "antigravity/hub/2.8.0 darwin/arm64",
  );
  assert.equal(buildAntigravityUserAgent(null, "darwin", "arm64"), null);
});

test("Grok User-Agent uses the detected CLI version", () => {
  assert.equal(normalizeGrokClientVersion("grok 0.2.112 (9bbd559437aa)"), "0.2.112");
  assert.equal(normalizeGrokClientVersion("unknown"), null);
  assert.equal(buildGrokUserAgent("0.2.112"), "grok-cli/0.2.112");
  assert.equal(buildGrokUserAgent(null), null);
});

test("Cursor unary requests are raw protobuf, not Connect response frames", () => {
  const request = encodeAvailableModelsRequest();

  // field 2, bool true; a framed request would start with flags=0 and a
  // four-byte length instead.
  assert.equal(request[0], 0x10);
  assert.notDeepEqual(Array.from(request.slice(0, 5)), Array.from(frameConnectMessage(request).slice(0, 5)));
});

test("Cursor AvailableModels response decodes names and nested model metadata", () => {
  const nestedModel = bytes(
    0x0a, 0x06, ...new TextEncoder().encode("sonnet"),
    0x8a, 0x01, 0x0d, ...new TextEncoder().encode("Claude Sonnet"),
  );
  const response = bytes(
    0x0a, 0x08, ...new TextEncoder().encode("composer"),
    0x12, nestedModel.length, ...nestedModel,
  );

  assert.deepEqual(decodeAvailableModelsResponse(response), [
    { slug: "composer", name: "composer" },
    { slug: "sonnet", name: "Claude Sonnet" },
  ]);
});

test("Cursor AvailableModels preserves AgentService selector IDs", () => {
  const selector = new TextEncoder().encode("cursor-grok-4.5-high");
  const model = bytes(
    0x0a, 0x08, ...new TextEncoder().encode("grok-4.5"),
    0x8a, 0x01, 0x0b, ...new TextEncoder().encode("Cursor Grok"),
    0xa2, 0x02, selector.length, ...selector,
  );
  const response = bytes(0x12, model.length, ...model);

  assert.deepEqual(decodeAvailableModelsResponse(response), [{
    slug: "grok-4.5",
    name: "Cursor Grok",
    agentModelIds: ["cursor-grok-4.5-high"],
  }]);
});

test("Cursor resolves the selected effort from real AgentService metadata", () => {
  const availableModels = [{
    slug: "grok-4.5",
    name: "Cursor Grok 4.5",
    agentModelIds: [
      "cursor-grok-4.5-low",
      "cursor-grok-4.5-medium",
      "cursor-grok-4.5-high",
    ],
  }];

  assert.equal(
    resolveCursorAgentModelSelector("grok-4.5", "high", availableModels),
    "cursor-grok-4.5-high",
  );
  assert.equal(
    resolveCursorAgentModelSelector("grok-4.5", "medium", availableModels),
    "cursor-grok-4.5-medium",
  );
  assert.throws(
    () => resolveCursorAgentModelSelector("grok-4.5", "xhigh", availableModels),
    /不支持 reasoning_effort="xhigh"/,
  );

  // Composer is a Cursor-native model with only a fast selector and no
  // low/medium/high variants; it must use the selector Cursor actually
  // returned rather than the published picker slug.
  assert.equal(
    resolveCursorAgentModelSelector("composer-2.5", "high", [{
      slug: "composer-2.5",
      name: "Composer 2.5",
      agentModelIds: ["composer-2.5-fast"],
    }]),
    "composer-2.5-fast",
  );
});

test("Cursor selector resolution follows model-specific metadata naming", () => {
  assert.equal(
    resolveCursorAgentModelSelector("gpt-5.5", "xhigh", [{
      slug: "gpt-5.5",
      name: "GPT-5.5",
      agentModelIds: ["gpt-5.5-high", "gpt-5.5-extra-high", "gpt-5.5-extra-high-fast"],
    }]),
    "gpt-5.5-extra-high",
  );
  assert.equal(
    resolveCursorAgentModelSelector("claude-sonnet-4-6", "high", [{
      slug: "claude-sonnet-4-6",
      name: "Sonnet 4.6",
      agentModelIds: [
        "claude-4.6-sonnet-high",
        "claude-4.6-sonnet-high-thinking",
      ],
    }]),
    "claude-4.6-sonnet-high",
  );
  assert.equal(
    resolveCursorAgentModelSelector("kimi-k3", "high", [{
      slug: "kimi-k3",
      name: "Kimi K3",
      agentModelIds: ["kimi-k3-low", "kimi-k3-high", "kimi-k3-max"],
    }]),
    "kimi-k3-high",
  );
  assert.equal(
    resolveCursorAgentModelSelector("glm-5.2", "high", [{
      slug: "glm-5.2",
      name: "GLM 5.2",
      agentModelIds: ["glm-5.2-high", "glm-5.2-max"],
    }]),
    "glm-5.2-high",
  );
});

test("Cursor does not fall back to a base slug when a requested effort is unavailable", () => {
  assert.throws(
    () => resolveCursorAgentModelSelector("kimi-k3", "medium", [{
      slug: "kimi-k3",
      name: "Kimi K3",
      agentModelIds: ["kimi-k3-low", "kimi-k3-high", "kimi-k3-max"],
    }]),
    /不支持 reasoning_effort="medium"/,
  );
  assert.throws(
    () => resolveCursorAgentModelSelector("gpt-5.3-codex", "medium", [{
      slug: "gpt-5.3-codex",
      name: "Codex 5.3",
      agentModelIds: ["gpt-5.3-codex-low", "gpt-5.3-codex-fast", "gpt-5.3-codex-high"],
    }]),
    /不支持 reasoning_effort="medium"/,
  );
});

test("Cursor AgentService regression sends the resolved modelId", () => {
  const availableModels = [{
    slug: "grok-4.5",
    name: "Cursor Grok 4.5",
    agentModelIds: ["cursor-grok-4.5-high"],
  }];
  const modelId = resolveCursorAgentModelSelector("grok-4.5", "high", availableModels);
  const framed = encodeAgentRunRequest(
    [{ role: "user", content: "hello" }],
    modelId,
    "request-grok-regression",
    "conversation-grok-regression",
  );
  const message = fromBinary(AgentClientMessageSchema, framed.slice(5));
  assert.equal(message.message.value.modelDetails?.modelId, "cursor-grok-4.5-high");
});

test("Cursor chat request contains conversation, model, request, and conversation IDs", () => {
  const request = encodeGetChatRequest(
    [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ],
    "sonnet",
    "request-1",
    "conversation-1",
  );

  // GetChatRequest field 2 is repeated ConversationMessage. The first field
  // is therefore a length-delimited field key (0x12), not a transport frame.
  assert.equal(request[0], 0x12);
  assert.ok(Array.from(request).includes(0x3a)); // field 7: ModelDetails
  assert.ok(Array.from(request).includes(0x4a)); // field 9: request_id
  assert.ok(Array.from(request).includes(0x7a)); // field 15: conversation_id
});

test("Cursor Composer request uses the current GetComposerChatRequest fields", () => {
  const request = encodeComposerChatRequest(
    [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ],
    "composer-2.5",
    "conversation-1",
  );

  // GetComposerChatRequest uses repeated conversation field 1, ModelDetails
  // field 5, and conversation_id field 23.
  assert.equal(request[0], 0x0a);
  assert.ok(Array.from(request).includes(0x2a)); // field 5: ModelDetails
  assert.ok(Array.from(request).includes(0xba)); // field 23: conversation_id
  assert.ok(Array.from(request).includes(0xc0)); // field 24: unified prompt
});

test("Cursor AgentService request advertises Responses tools in the native MCP catalog", () => {
  const framed = encodeAgentRunRequest(
    [{ role: "user", content: "审查并运行必要的只读检查" }],
    "composer-2.5",
    "request-1",
    "conversation-1",
    {
      tools: [{
        type: "function",
        function: {
          name: "exec_command",
          description: "Execute a workspace command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      }],
    },
  );
  const message = fromBinary(AgentClientMessageSchema, framed.slice(5));
  assert.equal(message.message.case, "runRequest");
  assert.equal(message.message.value.action?.action.case, "userMessageAction");
  // The bridge explicitly selects the native Agent workflow for a tool turn.
  assert.equal(message.message.value.action?.action.value.userMessage?.mode, 1);
  assert.deepEqual(message.message.value.mcpTools?.mcpTools.map((tool) => ({
    name: tool.name,
    provider: tool.providerIdentifier,
    toolName: tool.toolName,
  })), [{ name: "exec_command", provider: "opencodex-responses", toolName: "exec_command" }]);
});

test("Cursor AgentService advertises only tools implemented by the bridge", () => {
  const framed = encodeAgentRunRequest(
    [{ role: "user", content: "run the command" }],
    "composer-2.5",
    "request-2",
    "conversation-2",
    {
      tools: [
        {
          type: "function",
          function: {
            name: "exec_command",
            description: "Execute a workspace command",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        },
        {
          type: "function",
          function: {
            name: "write_stdin",
            description: "Write to a running process",
            parameters: { type: "object", properties: { chars: { type: "string" } } },
          },
        },
        {
          type: "function",
          function: {
            name: "mcp__node_repl_js__run",
            description: "Run JavaScript",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
  );
  const message = fromBinary(AgentClientMessageSchema, framed.slice(5));
  assert.deepEqual(message.message.value.mcpTools?.mcpTools.map((tool) => tool.name), ["exec_command"]);
});

test("Cursor native workspace tools normalize to Codex exec_command calls", () => {
  const root = "/Users/aitabby/projects/opencodex";
  const requests = [
    cursorNativeToolRequest(create(ExecServerMessageSchema, {
      id: 1,
      execId: "read-1",
      message: { case: "readArgs", value: create(ReadArgsSchema, { path: "README.md", toolCallId: "tool-1" }) },
    }), root),
    cursorNativeToolRequest(create(ExecServerMessageSchema, {
      id: 2,
      execId: "ls-1",
      message: { case: "lsArgs", value: create(LsArgsSchema, { path: ".", ignore: [], toolCallId: "tool-2" }) },
    }), root),
    cursorNativeToolRequest(create(ExecServerMessageSchema, {
      id: 3,
      execId: "grep-1",
      message: { case: "grepArgs", value: create(GrepArgsSchema, { pattern: "1\\.0\\.2", path: "src_v2", toolCallId: "tool-3" }) },
    }), root),
  ];

  assert.deepEqual(requests.map((request) => request?.name), ["exec_command", "exec_command", "exec_command"]);
  assert.deepEqual(requests.map((request) => request?.transport), ["shell", "shell", "shell"]);
  assert.match(JSON.parse(requests[0].arguments).cmd, /^cat /);
  assert.match(JSON.parse(requests[1].arguments).cmd, /^ls -la /);
  assert.match(JSON.parse(requests[2].arguments).cmd, /^rg --line-number .*1\\.0\\.2/);
});

test("Cursor AgentService encodes an external shell result into the continuation state", () => {
  const framed = encodeAgentRunRequest(
    [
      { role: "user", content: "run date" },
      { role: "tool", content: JSON.stringify({ exit_code: 0, stdout: "1785229993", stderr: "" }) },
      { role: "user", content: "Continue the original task using the tool result above. Do not repeat that tool call." },
    ],
    "composer-2.5",
    "request-resume",
    "conversation-resume",
    {
      continuation: {
        transport: "shell",
        callId: "cursor_shell_exec-1",
        execId: "exec-1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "date +%s", workdir: "/Users/aitabby/projects/opencodex" }),
        output: JSON.stringify({ exit_code: 0, stdout: "1785229993", stderr: "" }),
        isError: false,
      },
    },
  );
  const message = fromBinary(AgentClientMessageSchema, framed.slice(5));
  assert.equal(message.message.case, "runRequest");
  assert.equal(message.message.value.conversationState?.turns.length, 1);
  assert.match(message.message.value.action?.action.value.userMessage?.text || "", /Continue the original task/);
});

test("Cursor AgentService resumes with the native ResumeAction after a tool turn", () => {
  const framed = encodeAgentRunRequest(
    [{ role: "user", content: "continue the agent task" }],
    "composer-2.5",
    "request-resume-action",
    "conversation-resume-action",
    { resume: true },
  );
  const message = fromBinary(AgentClientMessageSchema, framed.slice(5));
  assert.equal(message.message.case, "runRequest");
  assert.equal(message.message.value.action?.action.case, "resumeAction");
});

test("Cursor unified chat request adds the current ChatService routing fields", () => {
  const request = encodeUnifiedChatRequest(
    [{ role: "user", content: "Hello" }],
    "composer-2.5",
    "conversation-1",
  );

  assert.equal(request[0], 0x0a); // field 1: conversation
  assert.ok(Array.from(request).includes(0xb0)); // field 22: is_chat
  assert.ok(Array.from(request).includes(0x88)); // field 33: unified prompt
  assert.ok(Array.from(request).includes(0xa8)); // field 37: fallback policy
});

test("Cursor Connect decoder handles framed streaming messages and raw unary responses", () => {
  const message = bytes(0x0a, 0x05, ...new TextEncoder().encode("hello"));
  const framed = frameConnectMessage(message);

  assert.deepEqual(Array.from(decodeConnectMessages(framed)[0]), Array.from(message));
  assert.deepEqual(Array.from(decodeCursorResponse(message)[0]), Array.from(message));
});

test("Cursor end-stream decoder prefers the actionable upstream detail", () => {
  const trailer = new TextEncoder().encode(JSON.stringify({
    error: {
      message: "Error",
      details: [{ debug: { details: { title: "Outdated Client Error", detail: "Please upgrade Cursor" } } }],
    },
  }));
  assert.equal(decodeCursorEndStreamError(trailer), "Please upgrade Cursor");
});

test("Cursor AgentService decoder recognizes turn_ended without confusing text updates", () => {
  const turnEnded = bytes(0x72, 0x00); // InteractionUpdate field 14
  const interactionUpdate = bytes(0x0a, turnEnded.length, ...turnEnded); // AgentServerMessage field 1
  assert.equal(decodeCursorStreamComplete(interactionUpdate), true);

  const textUpdate = bytes(0x0a, 0x05, ...new TextEncoder().encode("hello"));
  assert.equal(decodeCursorStreamComplete(textUpdate), false);
});

test("Cursor prompt suggestions are terminal metadata, not assistant text", () => {
  const suggestion = bytes(0x92, 0x01, 0x03, 0x0a, 0x01, 0x3f); // InteractionUpdate field 18
  const interactionUpdate = bytes(0x0a, suggestion.length, ...suggestion); // AgentServerMessage field 1
  assert.equal(decodeCursorStreamComplete(interactionUpdate), true);
});
