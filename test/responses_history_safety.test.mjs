import test from "node:test";
import assert from "node:assert/strict";
import { isNativeResponsesReasoningId, sanitizeNativeResponsesBody } from "../dist/core/responses_safety.js";

test("native Responses history removes third-party reasoning IDs", () => {
  assert.equal(isNativeResponsesReasoningId("rs_0123456789abcdef"), true);
  assert.equal(isNativeResponsesReasoningId("06bc3676e18a741e9725169e350f4835_rs"), false);

  const result = sanitizeNativeResponsesBody({
    model: "gpt-5.5",
    previous_response_id: "06bc3676e18a741e9725169e350f4835",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", id: "06bc3676e18a741e9725169e350f4835_rs", summary: [] },
      { type: "reasoning", id: "rs_0123456789abcdef", encrypted_content: "native" },
    ],
  });

  assert.equal(result.removedReasoningItems, 1);
  assert.equal(result.removedPreviousResponseId, true);
  assert.equal(result.body.input.length, 2);
  assert.equal(result.body.input[1].id, "rs_0123456789abcdef");
  assert.equal(result.body.previous_response_id, undefined);
});
