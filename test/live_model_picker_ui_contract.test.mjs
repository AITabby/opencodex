import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Live model picker is independent from OpenCodexBar", async () => {
  const [picker, statusBar, app, gatewayProcess, dashboard, gateway, floatingPicker] = await Promise.all([
    read("macos-app/Sources/OpenCodex/LiveModelPicker.swift"),
    read("voice/OpenCodexBar/Sources/OpenCodexBar/StatusBarController.swift"),
    read("macos-app/Sources/OpenCodex/OpenCodexApp.swift"),
    read("macos-app/Sources/OpenCodex/GatewayProcess.swift"),
    read("src_v2/services/dashboard.ts"),
    read("src_v2/server/gateway.ts"),
    read("macos-app/Sources/OpenCodexLivePicker/main.swift")
  ]);

  assert.match(picker, /选择 GPT-Live 执行模型/);
  assert.match(gatewayProcess, /api\/live-model-picker\/pending/);
  assert.match(gatewayProcess, /api\/live-model-picker\/resolve/);
  assert.match(picker, /\.floating/);
  assert.doesNotMatch(statusBar, /LiveModelPicker/);
  assert.match(dashboard, /live-model-picker-enabled/);
  assert.match(dashboard, /#view-voice \.settings-stack/);
  assert.match(dashboard, /live-picker-setting/);
  assert.match(dashboard, /live-picker-orb/);
  assert.match(dashboard, /z-index:2147483000/);
  assert.match(dashboard, /onpointermove/);
  assert.match(dashboard, /max-height:min\(420px/);
  assert.match(dashboard, /api\('\/api\/live-model-picker\/pending'/);
  assert.match(dashboard, /post\('\/api\/live-model-picker\/settings'/);
  assert.match(gateway, /api\/live-model-picker\/settings/);
  assert.match(gateway, /api\/live-model-picker\/select/);
  assert.match(gateway, /liveModelPickerStatePath/);
  assert.match(gateway, /Do not let a generic/);
  assert.match(gateway, /this\.resetLiveModelPicker\(\)/);
  assert.match(gateway, /if \(!this\.isLiveModelPickerEnabled\(\)\) return/);
  assert.doesNotMatch(gateway, /this\.startLivePickerOverlay\(\);\s*this\.launchDesktopAfterGatewayReadyIfRequested\(\);/);
  assert.match(gatewayProcess, /OPENCODEX_LIVE_PICKER_PATH/);
  assert.doesNotMatch(gatewayProcess, /adminToken = readAdminToken\(\);\s*startLiveModelPicker\(\);/);
  assert.match(floatingPicker, /rightMouseDown/);
  assert.doesNotMatch(floatingPicker, /取消当前模型/);
  assert.doesNotMatch(dashboard, /oncontextmenu/);
  assert.match(floatingPicker, /onOpen: \{ \[weak self\] in self\?\.toggleCard\(\) \}/);
  assert.match(floatingPicker, /availableModels/);
  assert.match(app, /GPT-Live 选择执行模型/);
});
