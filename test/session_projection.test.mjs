import test from "node:test";
import assert from "node:assert/strict";
import { responsesInputToChatMessages } from "../dist/core/transformer.js";

test("session projection preserves visible user and assistant messages", () => {
  const result = responsesInputToChatMessages([
    { type: "message", role: "user", content: "请检查这个页面" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "这是完整的 AI 回复。" }] }
  ]);
  assert.deepEqual(result, [
    { role: "user", content: "请检查这个页面" },
    { role: "assistant", content: "这是完整的 AI 回复。" }
  ]);
});

test("internal Codex envelopes are not projected to third-party providers", () => {
  const result = responsesInputToChatMessages([
    { type: "message", role: "user", content: "<environment_context>private</environment_context>你好" }
  ]);
  assert.equal(result[0].content, "你好");
});

test("session detail filters compact tool traces masquerading as user text", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
  assert.match(source, /isSyntheticToolTrace/);
  assert.match(source, /toolMarkers\.length >= 3/);
  assert.match(source, /role === "user" && isSyntheticToolTrace/);
  assert.doesNotMatch(source, /extractTranscriptUserText\(parsed\.content\)\.slice\(0, 300\)/);
});

test("subscription imports require live provider models and explicit ownership", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
  assert.match(source, /return \[\];\s*\n  }\n\n  private async fetchGrokModelsDynamic/);
  assert.match(source, /return \[\];\s*\n  }\n\n  public async start/);
  assert.match(source, /hasCatalogModelsForProvider\(catalogModels, "antigravity"\)/);
  assert.match(source, /hasCatalogModelsForProvider\(catalogModels, "grok"\)/);
  assert.match(source, /catalog\.models = catalog\.models\.filter\(\(m: any\) => m\.backend_provider !== "antigravity"\)/);
  assert.match(source, /catalog\.models = catalog\.models\.filter\(\(m: any\) => m\.backend_provider !== "grok"\)/);
});
