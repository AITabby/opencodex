import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Live model picker is independent from OpenCodexBar", async () => {
  const [picker, statusBar, app, gatewayProcess, dashboard, gateway] = await Promise.all([
    read("macos-app/Sources/OpenCodex/LiveModelPicker.swift"),
    read("voice/OpenCodexBar/Sources/OpenCodexBar/StatusBarController.swift"),
    read("macos-app/Sources/OpenCodex/OpenCodexApp.swift"),
    read("macos-app/Sources/OpenCodex/GatewayProcess.swift"),
    read("src_v2/services/dashboard.ts"),
    read("src_v2/server/gateway.ts")
  ]);

  assert.match(picker, /选择 GPT-Live 执行模型/);
  assert.match(gatewayProcess, /api\/live-model-picker\/pending/);
  assert.match(gatewayProcess, /api\/live-model-picker\/resolve/);
  assert.match(picker, /\.floating/);
  assert.doesNotMatch(statusBar, /LiveModelPicker/);
  assert.match(dashboard, /live-model-picker-enabled/);
  assert.match(dashboard, /#view-voice \.settings-stack/);
  assert.match(dashboard, /live-picker-setting/);
  assert.match(dashboard, /post\('\/api\/live-model-picker\/settings'/);
  assert.match(gateway, /api\/live-model-picker\/settings/);
  assert.match(app, /GPT-Live 选择执行模型/);
});
