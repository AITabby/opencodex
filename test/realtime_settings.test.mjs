import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import {
  REALTIME_MODEL_OVERRIDE_TTL_MS,
  armRealtimeWorkModel,
  consumeRealtimeWorkModel,
  loadRealtimeSettings,
} from "../dist/services/realtime_settings.js";

test("realtime work model is armed as a one-shot override", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-realtime-settings-`);
  try {
    const armed = armRealtimeWorkModel("opencode/deepseek-v4-pro", dataDir, 1000);
    assert.equal(armed.pending_work_model, "opencode/deepseek-v4-pro");
    assert.equal(loadRealtimeSettings(dataDir).pending_work_model, "opencode/deepseek-v4-pro");

    const consumed = consumeRealtimeWorkModel(dataDir, 1001);
    assert.equal(consumed.model, "opencode/deepseek-v4-pro");
    assert.equal(consumed.settings.pending_work_model, "");
    assert.equal(consumed.settings.last_applied_model, "opencode/deepseek-v4-pro");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("expired realtime work model is cleared without being applied", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-realtime-settings-`);
  try {
    armRealtimeWorkModel("gpt-5.5", dataDir, 1000);
    const consumed = consumeRealtimeWorkModel(dataDir, 1000 + REALTIME_MODEL_OVERRIDE_TTL_MS + 1);
    assert.equal(consumed.model, "");
    assert.equal(consumed.settings.pending_work_model, "");
    assert.equal(consumed.settings.last_applied_model, "");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
