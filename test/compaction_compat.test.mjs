import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompactionResponse,
  buildCompactionStreamEvents,
  decodeGatewayCompaction,
  encodeGatewayCompaction,
  expandGatewayCompactionItem,
  extractProviderText,
  isCompactionRequestBody,
  isCompactionRequestPath,
} from "../dist/services/compaction_compat.js";
import { responsesInputToChatMessages } from "../dist/core/transformer.js";
import { sanitizeNativeResponsesBody } from "../dist/core/responses_safety.js";

test("gateway compaction envelope round-trips and emits exactly one compaction item", () => {
  const encrypted = encodeGatewayCompaction("Objective: keep the API compatible.", "deepseek-v4-flash");
  const state = decodeGatewayCompaction(encrypted);
  assert.equal(state?.summary, "Objective: keep the API compatible.");

  const response = buildCompactionResponse("deepseek-v4-flash", encrypted);
  assert.equal(response.object, "response.compaction");
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "compaction");
  assert.equal(response.output[0].created_by, "opencodex");
  assert.equal(response.output.filter((item) => item.type === "compaction").length, 1);

  const events = buildCompactionStreamEvents("deepseek-v4-flash", encrypted);
  assert.equal(events.filter((event) => event.type === "response.output_item.done").length, 1);
  assert.equal(events.find((event) => event.type === "response.output_item.done").item.type, "compaction");
  assert.equal(events.find((event) => event.type === "response.completed").response.output[0].type, "compaction");
});

test("compaction requests are recognized by endpoint and trigger body", () => {
  assert.equal(isCompactionRequestPath("/v1/responses/compact"), true);
  assert.equal(isCompactionRequestPath("/responses/compact/"), true);
  assert.equal(isCompactionRequestPath("/v1/responses"), false);
  assert.equal(isCompactionRequestBody({ input: [{ type: "compaction_trigger" }] }), true);
  assert.equal(isCompactionRequestBody({ input: [{ type: "message", role: "user" }] }), false);
});

test("gateway compaction state is expanded for Chat and native Responses history", () => {
  const encrypted = encodeGatewayCompaction("Facts: the user selected Chat for this model.", "deepseek-v4-flash");
  const item = { id: "cmp_test", type: "compaction", encrypted_content: encrypted };

  const expanded = expandGatewayCompactionItem(item);
  assert.equal(expanded.type, "message");
  assert.equal(expanded.role, "developer");

  const messages = responsesInputToChatMessages([item, { type: "message", role: "user", content: "continue" }]);
  assert.match(messages[0].content, /Facts: the user selected Chat/);
  assert.equal(messages[1].content, "continue");

  const native = sanitizeNativeResponsesBody({ input: [item] });
  assert.equal(native.expandedCompactionItems, 1);
  assert.equal(native.body.input[0].type, "message");
});

test("provider text extraction covers Responses and Chat payloads", () => {
  assert.equal(extractProviderText({ output: [{ type: "message", content: [{ type: "output_text", text: "summary" }] }] }), "summary");
  assert.equal(extractProviderText({ choices: [{ message: { content: "summary" } }] }), "summary");
  assert.equal(extractProviderText({ type: "response.output_text.delta", delta: "summary" }), "summary");
});
