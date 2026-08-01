import test from "node:test";
import assert from "node:assert/strict";
import {
  optimizeThirdPartyComputerUseImages,
} from "../dist/services/computer_use_image_compat.js";

const screenshot = "data:image/png;base64,AAECAwQFBgcICQ==";

test("third-party Responses tool screenshots are optimized and duplicate images are omitted", async () => {
  const body = {
    model: "deepseek-v4-flash",
    input: [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_image", image_url: screenshot }],
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: [{ type: "input_image", image_url: screenshot }],
      },
    ],
  };

  const result = await optimizeThirdPartyComputerUseImages(body, {
    maxSourceBytes: 0,
    processImage: async () => ({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }),
  });

  assert.equal(result.stats.optimized, 1);
  assert.equal(result.stats.deduplicated, 1);
  assert.match(result.body.input[0].output[0].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(result.body.input[1].output[0].type, "input_text");
});

test("Chat optimization only touches tool-result images and respects original detail", async () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: screenshot } }],
      },
      {
        role: "tool",
        content: [{ type: "image_url", image_url: { url: screenshot, detail: "original" } }],
      },
    ],
  };

  const result = await optimizeThirdPartyComputerUseImages(body, {
    maxSourceBytes: 0,
    processImage: async () => ({ buffer: Buffer.from("must-not-run"), mimeType: "image/jpeg" }),
  });

  assert.equal(result.stats.skippedOriginal, 1);
  assert.equal(result.stats.optimized, 0);
  assert.deepEqual(result.body.messages[0], body.messages[0]);
  assert.deepEqual(result.body.messages[1], body.messages[1]);
});
