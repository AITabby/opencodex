import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifyProviderModel,
  normalizeThreadListParams,
} from "../dist/codex-provider-bridge.js";
import { buildManagedCodexConfig } from "../dist/server/gateway.js";

test("1.1.5 classifies official and namespaced provider-owned models safely", () => {
  const catalogs = [{
    models: [
      { slug: "gpt-5.5", provider: "openai" },
      { slug: "cursor/grok-4.5", backend_provider: "cursor" },
      { slug: "glm/glm-5", backend_provider: "glm" },
      { slug: "ownerless-model" },
    ],
  }];

  assert.equal(classifyProviderModel("gpt-5.5", catalogs), "openai");
  assert.equal(classifyProviderModel("gpt-5.5", [{
    models: [{ slug: "gpt-5.5", provider: "opencodex" }],
  }]), "openai");
  assert.equal(classifyProviderModel("cursor/grok-4.5", catalogs), "opencodex");
  assert.equal(classifyProviderModel("glm/glm-5", catalogs), "opencodex");
  assert.equal(classifyProviderModel("ownerless-model", catalogs), "openai");
  assert.equal(classifyProviderModel("antigravity/gemini-3.6-flash-medium", []), "opencodex");
  assert.equal(classifyProviderModel("minimax/minimax-m3", []), "opencodex");
  assert.equal(classifyProviderModel("openai/gpt-5.5", []), "openai");
  assert.equal(classifyProviderModel("antigravity/gemini-3.6-flash-medium", [{
    models: [{ slug: "antigravity/gemini-3.6-flash-medium", provider: "openai" }],
  }]), "opencodex");
  assert.equal(classifyProviderModel("not-in-catalog", catalogs), null);
});

test("1.1.5 history listing is provider-neutral even when Desktop sends a provider filter", () => {
  assert.deepEqual(normalizeThreadListParams({ limit: 100 }), {
    limit: 100,
    modelProviders: [],
  });
  assert.deepEqual(normalizeThreadListParams({ modelProviders: ["opencodex"] }), {
    modelProviders: [],
  });
  assert.deepEqual(normalizeThreadListParams({ modelProviders: [] }), {
    modelProviders: [],
  });
});

test("1.1.5 managed config keeps native OpenAI as the global default", () => {
  const config = buildManagedCodexConfig(
    'model = "gpt-5.5"\n',
    8765,
    "admin-token",
    "/tmp/custom_model_catalog.json",
  );

  assert.match(config, /model_provider = "openai"/);
  assert.doesNotMatch(config, /model_provider = "opencodex"/);
  assert.doesNotMatch(config, /openai_base_url/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:8765\/v1"/);
});

test("1.1.5 uses an official canonical thread and isolated third-party turns", async () => {
  const [source, launcher] = await Promise.all([
    readFile(new URL("../src_v2/codex-provider-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /thread\/inject_items/);
  assert.match(source, /spawnRuntime/);
  assert.match(source, /providerBridgeExecutablePath/);
  assert.match(source, /CODEX_CLI_PATH: bridge/);
  assert.match(source, /OPENCODEX_PROVIDER_BRIDGE_RUNTIME/);
  assert.match(source, /NATIVE_RUNTIME_PROVIDER/);
  assert.match(source, /nativeRouter/);
  assert.match(source, /openai-direct/);
  assert.match(source, /gateway:\$\{gatewayPort\}/);
  assert.match(source, /nativeRuntimeArgs/);
  assert.match(source, /ephemeral: true/);
  assert.match(source, /function beginGatewayTurn/);
  assert.match(source, /method === "thread\/list"/);
  assert.match(source, /thread\/settings\/update/);
  assert.match(source, /modelProviders/);
  assert.match(source, /method === "initialize"/);
  assert.match(source, /pendingParentInitializations/);
  assert.match(source, /lastInitializeResult/);
  assert.doesNotMatch(source, /switchProviderThenRequest/);
  assert.doesNotMatch(source, /providerResumeRequest/);
  assert.doesNotMatch(source, /activeRuntime/);
  assert.match(launcher, /CODEX_CLI_PATH: bridge/);
  assert.match(launcher, /OPENCODEX_NATIVE_CODEX_PATH/);
  assert.match(launcher, /registerProviderBridgeEnvironment/);
  assert.match(launcher, /launchctl.*setenv/);
  assert.match(launcher, /unregisterProviderBridgeEnvironment/);
  assert.match(launcher, /desktopAppServerState/);
  const stopStart = launcher.indexOf("public stop(): Promise<void>");
  assert.ok(stopStart >= 0);
  assert.doesNotMatch(launcher.slice(stopStart), /stopDesktopClients\(\)/);
});
