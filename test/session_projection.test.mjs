import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { responsesInputToChatMessages } from "../dist/core/transformer.js";
import { SessionHistoryService } from "../dist/services/session_history.js";

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

test("orphaned tool calls are repaired before the next ordinary user message", () => {
  const merged = SessionHistoryService.repairAndMergeHistory([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-stuck", type: "function", function: { name: "mcp__node_repl_js", arguments: "{}" } }],
    },
    { role: "user", content: "继续回答我" },
  ]);
  assert.deepEqual(merged.map((message) => [message.role, message.tool_call_id || "", message.content]), [
    ["assistant", "", ""],
    ["tool", "call-stuck", "Tool execution failed or was cancelled; continue without this tool result."],
    ["user", "", "继续回答我"],
  ]);
});

test("session history reads native JSONL response items and drops empty messages", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-session-history-"));
  const previousCodexHome = process.env.OPENCODEX_CODEX_HOME;
  const sessionId = "session-jsonl-context";
  const rolloutPath = path.join(codexHome, "sessions", "2026", "08", "10", `rollout-${sessionId}.jsonl`);
  try {
    process.env.OPENCODEX_CODEX_HOME = codexHome;
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(rolloutPath, [
      { type: "session_meta", payload: { id: sessionId } },
      { type: "response_item", payload: { item: { type: "message", role: "user", content: [{ type: "input_text", text: "上一条问题" }] } } },
      { type: "response_item", payload: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "上一条回答" }], internal_chat_message_metadata_passthrough: { reasoning_content: "保留的推理" } } } },
      { type: "response_item", payload: { item: { type: "message", role: "assistant", content: [] } } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "call-custom", call_id: "call-custom", name: "exec_command", input: "{\"cmd\":\"pwd\"}" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-custom", output: "/tmp" } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "call-patch", call_id: "call-patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-patch", output: "Done!" } },
      { type: "response_item", payload: { type: "function_call", id: "call-mcp", call_id: "call-mcp", namespace: "mcp__codegraph", name: "codegraph_explore", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call-mcp", output: "result" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    const reconstructed = SessionHistoryService.reconstructPastMessages(sessionId);
    assert.deepEqual(reconstructed.slice(0, 2).map((message) => message.content), ["上一条问题", "上一条回答"]);
    assert.equal(reconstructed[1].reasoning_content, "保留的推理");
    assert.equal(reconstructed[2].tool_calls[0].id, "call-custom");
    assert.equal(reconstructed[3].tool_call_id, "call-custom");
    assert.deepEqual(JSON.parse(reconstructed[4].tool_calls[0].function.arguments), {
      input: "*** Begin Patch\n*** End Patch",
    });
    assert.equal(reconstructed[6].tool_calls[0].function.name, "mcp__codegraph__codegraph_explore");

    const merged = SessionHistoryService.repairAndMergeHistory([
      { role: "user", content: "当前问题" },
    ], sessionId);
    assert.deepEqual(merged.map((message) => message.content), [
      "上一条问题",
      "上一条回答",
      "",
      "/tmp",
      "",
      "Done!",
      "",
      "result",
      "当前问题",
    ]);
  } finally {
    if (previousCodexHome === undefined) delete process.env.OPENCODEX_CODEX_HOME;
    else process.env.OPENCODEX_CODEX_HOME = previousCodexHome;
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("session detail filters compact tool traces masquerading as user text", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
  assert.match(source, /isSyntheticToolTrace/);
  assert.match(source, /toolMarkers\.length >= 3/);
  assert.match(source, /role === "user" && isSyntheticToolTrace/);
  assert.doesNotMatch(source, /extractTranscriptUserText\(parsed\.content\)\.slice\(0, 300\)/);
});

test("session list uses bounded metadata reads and idempotent deletion", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
  assert.match(source, /SESSION_LIST_PREFIX_BYTES/);
  assert.match(source, /readSessionTextSnapshot\(fullPath/);
  assert.match(source, /already_missing/);
  assert.match(source, /Could not update thread index/);
  assert.doesNotMatch(source, /const lines = fs\.readFileSync\(fullPath, "utf-8"\)\.split\("\\n"\)\.filter\(Boolean\);[\s\S]{0,1600}msgCount = projectCodexSessionMessages\(lines\)\.length/);
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
