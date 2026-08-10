import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeLegacyImageRequestBody,
  normalizeLegacyTurnInput,
  splitLegacyImageText,
} from "../dist/services/image_input.js";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("Desktop image marker becomes a first-class native turn image", () => {
  const input = normalizeLegacyTurnInput([{
    type: "text",
    text: `请看这张图 [Image: ${image}] 然后回答`,
  }]);

  assert.deepEqual(input, [
    { type: "text", text: "请看这张图 " },
    { type: "image", url: image },
    { type: "text", text: " 然后回答" },
  ]);
});

test("Responses request preserves structured image input for provider capability routing", () => {
  const body = normalizeLegacyImageRequestBody({
    model: "provider/model",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `[Image: ${image}]` }],
    }],
  });

  assert.deepEqual(body.input[0].content, [{ type: "input_image", image_url: image }]);
});

test("normal Responses and Chat image paths become original data URLs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-request-"));
  const imagePath = path.join(tempDir, "dragged.png");
  const bytes = Buffer.from("dragged-image-bytes", "utf8");
  fs.writeFileSync(imagePath, bytes);
  try {
    const body = normalizeLegacyImageRequestBody({
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "image", url: imagePath }],
      }],
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: `file://${imagePath}`, detail: "auto" } }],
      }],
    });
    const expected = `data:image/png;base64,${bytes.toString("base64")}`;
    assert.equal(body.input[0].content[0].url, expected);
    assert.equal(body.messages[0].content[0].image_url.url, expected);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy image splitter leaves ordinary text untouched", () => {
  assert.equal(splitLegacyImageText("这不是附件", "responses"), null);
});

test("native localImage input becomes an unmodified data URL for a third-party turn", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-input-"));
  const imagePath = path.join(tempDir, "screenshot.png");
  const bytes = Buffer.from("native-image-bytes", "utf8");
  fs.writeFileSync(imagePath, bytes);
  try {
    assert.deepEqual(normalizeLegacyTurnInput([{
      type: "localImage",
      path: imagePath,
      detail: "original",
    }]), [{
      type: "image",
      url: `data:image/png;base64,${bytes.toString("base64")}`,
      detail: "original",
    }]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
