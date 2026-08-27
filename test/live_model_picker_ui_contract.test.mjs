import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CodexSplit no longer ships a standalone GPT-Live picker UI", async () => {
  const [packageFile, packageScript, verifyScript, app, gatewayProcess, dashboard, gateway] = await Promise.all([
    read("macos-app/Package.swift"),
    read("macos-app/scripts/package-app.sh"),
    read("macos-app/scripts/verify-release.sh"),
    read("macos-app/Sources/OpenCodex/OpenCodexApp.swift"),
    read("macos-app/Sources/OpenCodex/GatewayProcess.swift"),
    read("src_v2/services/dashboard.ts"),
    read("src_v2/server/gateway.ts")
  ]);
  const removedSurface = [packageFile, packageScript, verifyScript, app, gatewayProcess, dashboard, gateway].join("\n");

  assert.doesNotMatch(removedSurface, /CodexSplitLivePicker|OpenCodexLivePicker/);
  assert.doesNotMatch(removedSurface, /live-model-picker|live-picker-orb|LiveModelPicker/);
  assert.doesNotMatch(removedSurface, /OPENCODEX_LIVE_PICKER_PATH/);
  assert.doesNotMatch(removedSurface, /liveModelPickerEnabled|liveModelPickerWaiters/);
  assert.doesNotMatch(removedSurface, /LIVE_MODEL_PICKER_TIMEOUT_MS/);
  assert.match(gateway, /chooseLiveWorkRoute/);
  assert.match(gateway, /currentLiveModelBinding/);
  assert.match(gatewayProcess, /OPENCODEX_VOICE_BAR_PATH/);
});
