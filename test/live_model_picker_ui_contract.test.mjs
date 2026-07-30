import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Live model picker is owned by the optional OpenCodexBar floating orb", async () => {
  const [picker, statusBar, app, dashboard, gateway] = await Promise.all([
    read("voice/OpenCodexBar/Sources/OpenCodexBar/LiveModelPickerController.swift"),
    read("voice/OpenCodexBar/Sources/OpenCodexBar/StatusBarController.swift"),
    read("macos-app/Sources/OpenCodex/OpenCodexApp.swift"),
    read("src_v2/services/dashboard.ts"),
    read("src_v2/server/gateway.ts")
  ]);

  assert.match(picker, /OpenCodexBar\.liveModelPickerEnabled/);
  assert.match(picker, /api\/live-model-picker\/pending/);
  assert.match(picker, /api\/live-model-picker\/resolve/);
  assert.match(picker, /\.floating/);
  assert.match(statusBar, /toggleLiveModelPicker/);
  assert.match(statusBar, /开启 GPT-Live 模型选择悬浮球/);
  assert.match(dashboard, /live-model-picker-enabled/);
  assert.match(dashboard, /post\('\/api\/live-model-picker\/settings'/);
  assert.match(gateway, /api\/live-model-picker\/settings/);
  assert.doesNotMatch(app, /GPT-Live 选择执行模型/);
});
