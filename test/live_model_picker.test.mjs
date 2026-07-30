import test from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyLiveWorkRequest,
  isToolContinuation,
  liveModelSessionKey,
  normalizeRealtimeWorkModel,
} from "../dist/services/live_model_picker.js";

test("Live picker identifies a tool-capable work handoff", () => {
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1" }, tools: [{ type: "function" }] }), true);
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1", "x-openai-subagent": "1" }, tools: [] }), true);
  assert.equal(isLikelyLiveWorkRequest({ client_metadata: { session_id: "s1" }, tools: [] }), false);
  assert.equal(isLikelyLiveWorkRequest({ tools: [{ type: "function" }] }), false);
});

test("Live picker binds continuations to the same client session", () => {
  const body = { client_metadata: { session_id: "session-123" }, input: [{ type: "function_call_output", call_id: "call-1" }] };
  assert.equal(liveModelSessionKey(body), "session-123");
  assert.equal(isToolContinuation(body), true);
  assert.equal(normalizeRealtimeWorkModel("  opencode/deepseek-v4-pro\n"), "opencode/deepseek-v4-pro");
});
