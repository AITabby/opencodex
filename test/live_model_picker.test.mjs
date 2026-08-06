import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLiveModelIntent,
  isLikelyLiveModelIntentRequest,
  isLikelyLiveWorkRequest,
  isLiveModelPickerEntryVisible,
  isToolContinuation,
  liveModelSessionKey,
  normalizeRealtimeWorkModel,
  orderOfficialModelsFirst,
} from "../dist/services/live_model_picker.js";

test("Live model picker keeps official models before third-party models", () => {
  assert.deepEqual(
    orderOfficialModelsFirst(
      ["provider/zeta", "gpt-5.5", "provider/alpha", "gpt-5.4", "gpt-5.5"],
      ["gpt-5.4", "gpt-5.5"],
    ),
    ["gpt-5.4", "gpt-5.5", "provider/alpha", "provider/zeta"],
  );
});

test("Live model picker hides internal and non-API catalog entries", () => {
  assert.equal(isLiveModelPickerEntryVisible({ slug: "gpt-5.6-sol-wm", visibility: "hide", supported_in_api: false }), false);
  assert.equal(isLiveModelPickerEntryVisible({ slug: "internal-alias", visibility: "hidden" }), false);
  assert.equal(isLiveModelPickerEntryVisible({ slug: "provider/model", supported_in_api: true }), true);
  assert.equal(isLiveModelPickerEntryVisible({ slug: "provider/model" }), true);
});

test("Live voice intent selects one uniquely named model", () => {
  const models = ["anthropic/claude-sonnet-4-20250514", "deepseek/deepseek-chat", "opencode/kimi-k2.7-code", "gpt-5.4", "gpt-5.4-mini"];
  assert.equal(
    extractLiveModelIntent({ input: [{ role: "user", content: "这个任务使用 Claude Sonnet 执行" }] }, models),
    "anthropic/claude-sonnet-4-20250514",
  );
  assert.equal(
    extractLiveModelIntent({ instructions: "请用 DeepSeek 完成" }, models),
    "deepseek/deepseek-chat",
  );
  assert.equal(
    extractLiveModelIntent({ input: "这个任务改用 GPT-5.4 执行" }, models),
    "gpt-5.4",
  );
  assert.equal(
    extractLiveModelIntent({ input: "请用 Kimi 模型运行" }, models),
    "opencode/kimi-k2.7-code",
  );
  assert.equal(
    extractLiveModelIntent({ input: "请用 千问 3.7 模型运行" }, ["qwen/qwen3.7"]),
    "qwen/qwen3.7",
  );
  assert.equal(
    extractLiveModelIntent({ input: "切换到 qwen3.7 执行" }, ["opencode/qwen3.7-plus"]),
    "opencode/qwen3.7-plus",
  );
  assert.equal(
    extractLiveModelIntent({ input: "改用 千问 3.7 完成下一个任务" }, ["opencode/qwen3.7-plus"]),
    "opencode/qwen3.7-plus",
  );
  assert.equal(
    extractLiveModelIntent({ input: "千问 3.7" }, ["opencode/qwen3.7-plus"]),
    "opencode/qwen3.7-plus",
  );
  assert.equal(
    extractLiveModelIntent({ input: "千问三点七" }, ["opencode/qwen3.7-plus"]),
    "opencode/qwen3.7-plus",
  );
  assert.equal(
    extractLiveModelIntent(
      {
        input: [
          { role: "user", content: "第一个任务使用 Mimo" },
          { role: "assistant", content: "第一个任务已完成" },
          { role: "user", content: "下一个任务切换到 qwen3.7" },
        ],
      },
      ["opencode/mimo-v2.5", "opencode/qwen3.7-plus"],
    ),
    "opencode/qwen3.7-plus",
  );
  assert.equal(
    extractLiveModelIntent(
      {
        input: [
          { role: "user", content: "第一个任务使用 Mimo" },
          { role: "assistant", content: "第一个任务已完成" },
          { role: "user", content: "运行几个简单的命令" },
        ],
      },
      ["opencode/mimo-v2.5", "opencode/qwen3.7-plus"],
    ),
    "opencode/mimo-v2.5",
  );
  assert.equal(
    extractLiveModelIntent({ input: "请用 通义千问 3.7 模型运行" }, ["qwen/qwen3.7"]),
    "qwen/qwen3.7",
  );
  assert.equal(
    extractLiveModelIntent({ input: "请用 q wen-3.7 模型运行" }, ["qwen/qwen3.7"]),
    "qwen/qwen3.7",
  );
  const domesticModels = [
    "volcengine/doubao-seed-1.6",
    "zhipu/glm-4.6",
    "baichuan/baichuan4",
    "dashscope/qwen3.7",
  ];
  assert.equal(
    extractLiveModelIntent({ input: "请用 豆包 模型运行" }, domesticModels),
    "volcengine/doubao-seed-1.6",
  );
  assert.equal(
    extractLiveModelIntent({ input: "请用 dou bao 模型运行" }, domesticModels),
    "volcengine/doubao-seed-1.6",
  );
  assert.equal(
    extractLiveModelIntent({ input: "请用 智谱 4.6 模型运行" }, domesticModels),
    "zhipu/glm-4.6",
  );
  assert.equal(
    extractLiveModelIntent({ input: "请用 bai chuan 4 模型运行" }, domesticModels),
    "baichuan/baichuan4",
  );
  assert.equal(
    extractLiveModelIntent(
      { input: "请用 豆包 1.6 模型运行" },
      ["volcengine/doubao-seed-1.6", "volcengine/doubao-seed-1.7"],
    ),
    "volcengine/doubao-seed-1.6",
  );
  assert.equal(
    extractLiveModelIntent(
      { input: "请用 豆包 模型运行" },
      ["volcengine/doubao-seed-1.6", "volcengine/doubao-seed-1.7"],
    ),
    "",
  );
  assert.equal(extractLiveModelIntent({ input: "不要使用 Claude" }, models), "");
});

test("Live voice intent ignores ambiguous or incidental model mentions", () => {
  const models = ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4"];
  assert.equal(extractLiveModelIntent({ input: "这个任务用 Claude 执行" }, models), "");
  assert.equal(extractLiveModelIntent({ input: "帮我写一个 Claude 相关的说明" }, models), "");
});

test("Live picker identifies a tool-capable work handoff", () => {
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1" }, tools: [{ type: "function" }] }), true);
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1", "x-openai-subagent": "1" }, tools: [] }), true);
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1" }, input: [{ type: "additional_tools" }] }), true);
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1" }, input: [{ type: "custom_tool_call" }] }), true);
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1" }, tools: [] }), false);
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1" }, input: [{ type: "message", role: "user" }] }), false);
  assert.equal(isLikelyLiveWorkRequest({ tools: [{ type: "function" }] }), false);
});

test("Live model switching also accepts metadata-only turns without a session id", () => {
  assert.equal(isLikelyLiveModelIntentRequest({ client_metadata: {} }, true), true);
  assert.equal(isLikelyLiveModelIntentRequest({ client_metadata: { turn_id: "t1" } }, true), true);
  assert.equal(isLikelyLiveModelIntentRequest({ client_metadata: {} }, false), false);
  assert.equal(isLikelyLiveModelIntentRequest({ input: "切换到 qwen3.7" }, true), false);
});

test("Live picker binds continuations to the same client session", () => {
  const body = { client_metadata: { session_id: "session-123" }, input: [{ type: "function_call_output", call_id: "call-1" }] };
  assert.equal(liveModelSessionKey(body), "session-123");
  assert.equal(isToolContinuation(body), true);
  assert.equal(isToolContinuation({ client_metadata: { session_id: "session-123" }, input: [{ type: "custom_tool_call_output" }] }), true);
  assert.equal(normalizeRealtimeWorkModel("  opencode/deepseek-v4-pro\n"), "opencode/deepseek-v4-pro");
});
