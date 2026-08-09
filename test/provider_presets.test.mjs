import test from "node:test";
import assert from "node:assert/strict";
import { API_PROVIDER_PRESETS } from "../dist/services/provider_presets.js";

test("provider catalog has stable ids and explicit verification state", () => {
  assert.ok(API_PROVIDER_PRESETS.length >= 40);

  const ids = API_PROVIDER_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const preset of API_PROVIDER_PRESETS) {
    assert.match(preset.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.equal(typeof preset.label, "string");
    assert.equal(preset.authMode, "api_key");
    assert.equal(typeof preset.defaultBaseUrl, "string");
    assert.ok(Array.isArray(preset.models));
    assert.ok(["chat", "responses"].includes(preset.defaultProtocol));
    assert.ok(["catalog_only", "not_applicable"].includes(preset.verificationStatus));
    assert.ok(["cc-switch", "opencodex"].includes(preset.source));
  }
});

test("catalog carries CC Switch coverage without importing referral metadata", () => {
  for (const id of ["zai", "bailian", "qianfan-coding", "xiaomi-mimo-token-plan", "nvidia", "novita-ai", "packycode", "dmxapi"]) {
    const preset = API_PROVIDER_PRESETS.find((entry) => entry.id === id);
    assert.ok(preset, `missing preset ${id}`);
    assert.equal(preset.source, "cc-switch");
  }

  const serialized = JSON.stringify(API_PROVIDER_PRESETS);
  assert.doesNotMatch(serialized, /aff=|utm_|ref=|CCSWITCH|cc-switch\.ai/i);
  assert.doesNotMatch(serialized, /oauth|subscription/i);
});

test("custom OpenAI-compatible entry remains available", () => {
  const custom = API_PROVIDER_PRESETS.find((preset) => preset.id === "custom");
  assert.deepEqual(custom, {
    id: "custom",
    label: "自定义兼容接口",
    authMode: "api_key",
    defaultBaseUrl: "",
    models: [],
    defaultProtocol: "chat",
    verificationStatus: "not_applicable",
    source: "opencodex",
  });
});
