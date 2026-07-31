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

test("dashboard exposes the per-model Chat or Responses protocol choice", async () => {
  const text = await source();
  assert.match(text, /provider-model-rows/);
  assert.match(text, /provider-model-row/);
  assert.match(text, /add-provider-model/);
  assert.match(text, /provider-remove-model/);
  assert.match(text, /多个模型用逗号分隔/);
  assert.match(text, /children\.length>=2/);
  assert.match(text, /value="chat"/);
  assert.match(text, /value="responses"/);
  assert.match(text, /provider-test-model/);
  assert.match(text, /testProviderModelRow/);
  assert.match(text, /\/api\/providers\/test-model/);
  assert.match(text, /<option value="chat"[^>]*>Chat<\/option>/);
  assert.match(text, /<option value="responses"[^>]*>Responses<\/option>/);
  assert.match(text, /model_protocols/);
  assert.match(text, /readProviderModelRows/);
});

test("dashboard exposes a persistent Chinese-English language switch", async () => {
  const text = await source();
  assert.match(text, /id="language-toggle"/);
  assert.match(text, /opencodex\.language/);
  assert.match(text, /OpenCodex Control Center/);
  assert.match(text, /setLanguage/);
  assert.match(text, /MutationObserver/);
  assert.match(text, /closest\('\.session-item,\.session-message,\.log-row/);
});

test("dashboard refreshes subscription status after every model deletion path", async () => {
  const text = await source();
  assert.match(text, /post\('\/api\/models\/delete',\{id:id\}\);await syncDashboardState\(\)/);
  assert.match(text, /post\('\/api\/models\/delete',\{ids:ids\}\);await syncDashboardState\(\)/);
  assert.match(text, /post\('\/api\/providers\/delete',\{name:name\}\);await syncDashboardState\(\)/);
});
