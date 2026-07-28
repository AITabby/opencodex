import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = () => readFile(new URL("../src_v2/services/dashboard.ts", import.meta.url), "utf8");

test("dashboard contains the complete voice configuration and one CDP launch path", async () => {
  const text = await source();
  for (const id of ["stt-api-key", "stt-base-url", "tts-api-key", "tts-base-url", "interaction-mode", "restart-cdp"]) {
    assert.match(text, new RegExp(`id=\\"${id}\\"`));
  }
  assert.doesNotMatch(text, /launch-voice-bar/);
  assert.match(text, /CDP 注入模式/);
  assert.match(text, /updateVoiceRuntimeStatus/);
});

test("dashboard keeps session import, scan, and delete controls", async () => {
  const text = await source();
  for (const marker of ["session-import-input", "session-scan-modal", "import-scanned-sessions", "deleteActiveSession", "session-message-image"]) {
    assert.match(text, new RegExp(marker));
  }
});

test("dashboard keeps visible progress states for destructive and network actions", async () => {
  const text = await source();
  for (const marker of ["runButton(button,labels,task)", "测试中…", "删除中…", "保存中…", "重启中…", "refresh-logs"]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(text, /button\.pending/);
});

test("dashboard uses the gateway admin cookie without embedding credentials", async () => {
  const text = await source();
  assert.doesNotMatch(text, /api_key.{0,20}localStorage/i);
  assert.match(text, /fetch\(/);
  assert.match(text, /api\('\/api\/providers'\)/);
});

test("sidebar settings icon matches the primary navigation size", async () => {
  const text = await source();
  assert.match(
    text,
    /\.app-safety \.ico\{[^}]*width:20px[^}]*height:20px[^}]*margin:0[^}]*font-size:18px/,
  );
});
