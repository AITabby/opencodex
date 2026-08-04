import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  buildFullCatalogEntry,
  CatalogSyncService,
  extractModelReasoningLevels,
  findModelRegistryMatch,
  flattenModelRegistry,
  getActualContextWindow,
  getProviderModelContextWindow,
} from "../dist/services/catalog_sync.js";
import { clearProviderModelSelections } from "../dist/services/credential_store.js";
import { buildConfiguredProviderCatalogEntries, buildManagedCodexConfig, deriveProviderNamespace, migrateProviderCatalogOwner, preserveOfficialModels, stripManagedCodexConfig, upsertProviderCatalogModel } from "../dist/server/gateway.js";
import { readRoutingCatalog } from "../dist/services/task_router.js";

test("catalog entries preserve the selected upstream protocol", () => {
  const responses = buildFullCatalogEntry("opencode/deepseek-v4-flash", "opencode", undefined, "responses");
  const chat = buildFullCatalogEntry("deepseek-chat", "deepseek", undefined, "chat");

  assert.equal(responses.protocol, "responses");
  assert.equal(responses.backend_protocol, "responses");
  assert.equal(chat.protocol, "chat");
  assert.equal(chat.backend_protocol, "chat");
});

test("reasoning-enabled catalog entries expose the default low/medium/high tiers", () => {
  const entry = buildFullCatalogEntry("deepseek-v4-flash", "deepseek", undefined, "chat", { reasoning: true });

  assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high"]);
  assert.equal(entry.default_reasoning_level, "medium");
});

test("models without an explicit non-reasoning flag receive the default reasoning tiers", () => {
  const entry = buildFullCatalogEntry("manual/manual-model", "manual");

  assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high"]);
  assert.equal(entry.default_reasoning_level, "medium");
  assert.equal(entry.context_window, 200000);
  assert.deepEqual(entry.truncation_policy, { mode: "tokens", limit: 40000 });
});

test("model-specific reasoning metadata adds only that model's extra tiers", () => {
  const baseline = buildFullCatalogEntry("provider/model-a", "provider");
  const extended = buildFullCatalogEntry("provider/model-b", "provider", undefined, "chat", {
    supported_reasoning_levels: [
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh", description: "Provider-reported extra tier" },
      { effort: "max", description: "Provider-reported maximum tier" },
    ],
  });

  assert.deepEqual(baseline.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high"]);
  assert.equal(baseline.default_reasoning_level, "medium");
  assert.deepEqual(
    extended.supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.ok(extended.supported_reasoning_levels.every((level) => typeof level.description === "string" && level.description.length > 0));
  assert.equal(extended.default_reasoning_level, "medium");
});

test("native model capability fields use the existing camelCase interface", () => {
  const entry = buildFullCatalogEntry("gpt-native", "openai", undefined, "responses", {
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "ultra", description: "Deep" },
    ],
    defaultReasoningEffort: "ultra",
  });

  assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "ultra"]);
  assert.equal(entry.default_reasoning_level, "ultra");
});

test("Agent routing reads the existing native Codex model cache", async () => {
  const nativeDir = await mkdtemp(path.join(os.tmpdir(), "opencodex-native-models-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "opencodex-routing-models-"));
  try {
    await writeFile(path.join(nativeDir, "models_cache.json"), JSON.stringify({ models: [{
      slug: "native-model",
      display_name: "Native Model",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
      defaultReasoningEffort: "ultra",
    }] }));
    const models = readRoutingCatalog(dataDir, nativeDir);
    assert.deepEqual(models.map((model) => model.slug), ["native-model"]);
    assert.deepEqual(models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "ultra"]);
    assert.equal(models[0].default_reasoning_level, "ultra");
  } finally {
    await Promise.all([rm(nativeDir, { recursive: true, force: true }), rm(dataDir, { recursive: true, force: true })]);
  }
});

test("an explicit non-reasoning model exposes no selectable reasoning tiers", () => {
  const entry = buildFullCatalogEntry("provider/model-c", "provider", undefined, "chat", { reasoning: false });
  assert.deepEqual(entry.supported_reasoning_levels, []);
  assert.equal(entry.default_reasoning_level, undefined);
});

test("third-party context uses provider or registry metadata and never invents a size", () => {
  assert.equal(getActualContextWindow("deepseek-v4-flash"), undefined);
  assert.equal(getActualContextWindow("minimax-m3"), undefined);
  assert.equal(getActualContextWindow("gemini-2.5-pro"), undefined);
  assert.equal(buildFullCatalogEntry("custom-model", "test", 1048576).context_window, 1048576);
  assert.equal(buildFullCatalogEntry("mimo-v2.5", "opencode", undefined, "chat", { context_window: 1000000, metadata_source: "model_registry" }).context_window, 1000000);
  assert.equal(buildFullCatalogEntry("mimo-v2.5", "opencode", undefined, "chat", { context_window: 1000000, metadata_source: "model_registry" }).context_window_source, "model_registry");
  assert.equal(buildFullCatalogEntry("mimo-v2.5", "opencode", undefined, "chat", { context_window: 1000000, context_window_source: "provider_metadata", metadata_source: "provider_metadata" }).context_window, 1000000);
  assert.equal(getProviderModelContextWindow({ model_metadata: { "provider-model": { context_length: 123456 } } }, "provider-model"), 123456);
  assert.equal(getProviderModelContextWindow({ model_metadata: { "registry-model": { context_length: 1000000, metadata_source: "model_registry" } } }, "registry-model"), undefined);
  assert.equal(getProviderModelContextWindow({ models: [{ name: "gemini-2.5-pro", inputTokenLimit: 1048576 }] }, "gemini-2.5-pro"), 1048576);
});

test("model registry context is used when the model identity is known", () => {
  const metadata = {
    limit: { context: 1000000, output: 128000 },
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
  };

  assert.equal(getActualContextWindow("minimax-m3"), undefined);
  assert.equal(buildFullCatalogEntry("minimax/minimax-m3", "minimax", undefined, "chat", { ...metadata, metadata_source: "model_registry" }).context_window, 1000000);
  assert.equal(buildFullCatalogEntry("minimax/minimax-m3", "minimax", undefined, "chat", { ...metadata, metadata_source: "model_registry" }).max_context_window, 1000000);
  assert.equal(buildFullCatalogEntry("minimax/minimax-m3", "minimax", undefined, "chat", { ...metadata, metadata_source: "model_registry" }).auto_compact_token_limit, 800000);
  assert.equal(buildFullCatalogEntry("minimax/minimax-m3", "minimax", undefined, "chat", { ...metadata, context_window_source: "provider_metadata", metadata_source: "provider_metadata" }).context_window, 1000000);
});

test("provider model variants resolve to the base model registry context", () => {
  const match = findModelRegistryMatch({
    google: {
      models: {
        "gemini-3.6-flash": { limit: { context: 1048576 } },
      },
    },
  }, { name: "antigravity" }, "gemini-3.6-flash-medium");
  assert.equal(match?.metadata?.limit?.context, 1048576);
  assert.equal(match?.providerMatched, false);
});

test("a registry-only refresh cannot overwrite a previously verified provider context", () => {
  const preserved = CatalogSyncService.mergeProviderModelMetadata(
    {
      "gpt-5.6-luna": {
        context_window: 1050000,
        max_context_window: 1050000,
        context_window_source: "provider_metadata",
        metadata_source: "provider_metadata",
      },
    },
    {
      "gpt-5.6-luna": {
        context_window: 200000,
        max_context_window: 200000,
        context_window_source: "model_registry",
        metadata_source: "model_registry",
      },
    },
  );

  assert.equal(preserved["gpt-5.6-luna"].context_window, 1050000);
  assert.equal(preserved["gpt-5.6-luna"].context_window_source, "provider_metadata");

  const lowered = CatalogSyncService.mergeProviderModelMetadata(
    preserved,
    {
      "gpt-5.6-luna": {
        context_window: 272000,
        max_context_window: 272000,
        context_window_source: "provider_metadata",
        metadata_source: "provider_metadata",
      },
    },
  );
  assert.equal(lowered["gpt-5.6-luna"].context_window, 272000);
});

test("provider-owned registry metadata is allowed to enlarge the provider route while native remains separate", () => {
  const opencode = buildFullCatalogEntry(
    "opencode/gpt-5.6-luna",
    "opencode",
    undefined,
    "responses",
    {
      context_window: 1050000,
      max_context_window: 1050000,
      context_window_source: "provider_metadata",
      metadata_source: "provider_metadata",
    },
  );
  const native = { slug: "gpt-5.6-luna", context_window: 272000 };

  assert.equal(opencode.context_window, 1050000);
  assert.equal(native.context_window, 272000);
});

test("native restore clears provider model state without removing credentials", () => {
  const cleared = clearProviderModelSelections([{
    name: "opencode",
    baseUrl: "https://opencode.ai/zen/go/v1",
    credential_ref: "keychain:OpenCodex Provider Credential:provider:opencode",
    models: ["gpt-5.6-luna"],
    model_protocols: { "gpt-5.6-luna": "responses" },
    model_metadata: { "gpt-5.6-luna": { context_window: 1050000 } },
    last_test_status: "connected",
  }]);

  assert.deepEqual(cleared, [{
    name: "opencode",
    baseUrl: "https://opencode.ai/zen/go/v1",
    credential_ref: "keychain:OpenCodex Provider Credential:provider:opencode",
    models: [],
  }]);
});

test("Codex cache rebuild removes stale third-party models and preserves native context", () => {
  const models = CatalogSyncService.mergeCatalogModelsIntoCodexCache(
    [
      { slug: "gpt-5.6-luna", context_window: 272000 },
      { slug: "opencode/gpt-5.6-luna", provider: "opencodex", context_window: 200000 },
      { slug: "legacy-third-party", context_window: 200000 },
    ],
    [{ slug: "opencode/gpt-5.6-luna", context_window: 1050000 }],
  );

  assert.deepEqual(models.map((model) => model.slug), ["gpt-5.6-luna", "opencode/gpt-5.6-luna"]);
  assert.equal(models[0].context_window, 272000);
  assert.equal(models[1].context_window, 1050000);
});

test("configured provider models can reconstruct a missing Codex catalog entry", () => {
  const entries = buildConfiguredProviderCatalogEntries([{
    name: "minimax",
    baseUrl: "https://api.minimaxi.com/v1",
    models: ["minimax-m3"],
    model_protocols: { "minimax-m3": "chat" },
    model_metadata: {
      "minimax-m3": { context_window: 1000000, reasoning: true, supported_reasoning_levels: [] },
    },
  }]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, "minimax/minimax-m3");
  assert.equal(entries[0].backend_model, "minimax-m3");
  assert.equal(entries[0].context_window, 1000000);
  assert.deepEqual(entries[0].supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high"]);
});

test("existing provider-owned catalog entries preserve their explicit reasoning range", () => {
  const catalog = {
    models: [{
      slug: "deepseek/deepseek-v4-flash",
      model: "deepseek/deepseek-v4-flash",
      backend_model: "deepseek-v4-flash",
      backend_provider: "deepseek",
      supported_reasoning_levels: [{ effort: "high" }],
    }],
  };

  preserveOfficialModels(catalog);
  const entry = catalog.models.find((model) => model.backend_provider === "deepseek");

  assert.deepEqual(
    entry.supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high"],
  );
});

test("model registry metadata is read by provider and model rather than a hardcoded model map", () => {
  const records = flattenModelRegistry({
    "opencode-go": {
      models: {
        "mimo-v2.5": {
          reasoning: true,
          reasoning_options: [],
          limit: { context: 1000000 },
        },
      },
    },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "opencode-go");
  assert.equal(records[0].metadata.limit.context, 1000000);
  assert.deepEqual(extractModelReasoningLevels(records[0].metadata), []);
});

test("reasoning option descriptors expose their discrete effort values", () => {
  assert.deepEqual(
    extractModelReasoningLevels({
      reasoning: true,
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["low", "medium", "high"] },
        { type: "budget_tokens", min: 1 },
      ],
    }),
    [
      { effort: "low", description: "轻度推理（速度优先）" },
      { effort: "medium", description: "中等推理（速度与深度平衡）" },
      { effort: "high", description: "深度推理（复杂任务）" },
    ],
  );
});

test("managed Codex config follows the current gateway port across restarts", () => {
  const existing = `model = "gpt-5.5"\n\n# >>> opencodex managed >>>\nmodel_catalog_json = "/Users/test/.opencodex/custom_model_catalog.json"\nopenai_base_url = "http://127.0.0.1:18421/v1"\n# <<< opencodex managed >>>\n\n# >>> opencodex managed >>>\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:18421/v1"\n# <<< opencodex managed <<<\n`;
  const next = buildManagedCodexConfig(existing, 19753, "test-admin-token", "/Users/test/.opencodex/custom_model_catalog.json");

  assert.match(next, /openai_base_url = "http:\/\/127\.0\.0\.1:19753\/v1"/);
  assert.match(next, /base_url = "http:\/\/127\.0\.0\.1:19753\/v1"/);
  assert.match(next, /experimental_bearer_token = "test-admin-token"/);
  assert.doesNotMatch(next, /18421/);
  assert.match(next, /model = "gpt-5\.5"/);
  assert.equal((next.match(/# >>> opencodex managed >>>/g) || []).length, 2);
});

test("managed Codex config strips corrupted duplicate blocks and orphaned keys idempotently", () => {
  const corrupted = `# >>> opencodex managed >>>\nmodel_catalog_json = "/path/1"\nopenai_base_url = "http://127.0.0.1:8765/v1"\n# <<< opencodex managed >>>\n\n# >>> opencodex managed >>>\nmodel_catalog_json = "/path/1"\nopenai_base_url = "http://127.0.0.1:8765/v1"\n# <<< opencodex managed >>>\n\nmodel = "gpt-5.5"\nmodel_catalog_json = "/path/2"\n\n# >>> opencodex managed >>>\n[model_providers.opencodex]\nname = "OpenCodex"\n# <<< opencodex managed >>>\n\n[model_providers.opencodex]\nname = "OpenCodex"\n`;
  const firstPass = buildManagedCodexConfig(corrupted, 8765, "token-1");
  const secondPass = buildManagedCodexConfig(firstPass, 8765, "token-1");

  assert.equal((firstPass.match(/# >>> opencodex managed >>>/g) || []).length, 2);
  assert.equal((firstPass.match(/model_catalog_json/g) || []).length, 1);
  assert.equal((firstPass.match(/\[model_providers\.opencodex\]/g) || []).length, 1);
  assert.equal(firstPass, secondPass);
});

test("Codex restart waits for the new gateway before launching the desktop", async () => {
  const gateway = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
  const restartStart = gateway.indexOf('url.pathname === "/api/restart-codex"');
  const restartEnd = gateway.indexOf('url.pathname === "/assets/opencodex-logo.png"', restartStart);
  assert.ok(restartStart >= 0 && restartEnd > restartStart);

  const restartBlock = gateway.slice(restartStart, restartEnd);
  assert.match(restartBlock, /requestDesktopLaunchAfterGatewayReady\(\);\s*stopDesktopClients\(\);/);
  assert.ok(
    restartBlock.indexOf("stopDesktopClients();") < restartBlock.indexOf('execFileSync("/opt/homebrew/bin/pm2", ["restart", "opencodex"]'),
  );
  assert.match(
    gateway,
    /this\.startLivePickerOverlay\(\);\s*this\.launchDesktopAfterGatewayReadyIfRequested\(\);\s*resolve\(\);/,
  );
});

test("custom providers derive a stable namespace from known and unknown URLs", () => {
  assert.equal(deriveProviderNamespace("custom", "https://api.deepseek.com/v1"), "deepseek");
  assert.equal(deriveProviderNamespace("custom", "https://api.xiaomimimo.com/v1"), "xiaomi");
  assert.equal(deriveProviderNamespace("custom", "https://llm.acme-lab.net/v1"), "acme-lab");
  assert.equal(deriveProviderNamespace("my-gateway", "https://api.example.com/v1"), "my-gateway");
});

test("renaming a custom provider migrates its catalog namespace", () => {
  const catalog = {
    models: [{
      slug: "test/mimo-2.5",
      model: "test/mimo-2.5",
      backend_model: "mimo-2.5",
      backend_provider: "test",
      display_name: "test/mimo-2.5"
    }]
  };

  migrateProviderCatalogOwner(catalog, "test", "xiaomi");

  assert.equal(catalog.models[0].slug, "xiaomi/mimo-2.5");
  assert.equal(catalog.models[0].model, "xiaomi/mimo-2.5");
  assert.equal(catalog.models[0].backend_provider, "xiaomi");
  assert.equal(catalog.models[0].backend_model, "mimo-2.5");
  assert.equal(catalog.models[0].display_name, "xiaomi/mimo-2.5");
});

test("third-party model with an official slug gets a provider namespace", () => {
  const catalog = {
    models: [{
      slug: "gpt-5.5",
      model: "gpt-5.5",
      display_name: "GPT-5.5"
    }]
  };

  upsertProviderCatalogModel(catalog, "gpt-5.5", "gpt-5.5", "GPT-5.5", "cursor");

  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].slug, "gpt-5.5");
  assert.equal(catalog.models[0].backend_provider, undefined);
  assert.equal(catalog.models[1].slug, "cursor/gpt-5.5");
  assert.equal(catalog.models[1].backend_model, "gpt-5.5");
  assert.equal(catalog.models[1].backend_provider, "cursor");
  assert.equal(catalog.models[1].display_name, "cursor/gpt-5.5");
});

test("updating an owned namespaced model does not overwrite the native model", () => {
  const catalog = {
    models: [
      { slug: "gpt-5.5", model: "gpt-5.5" },
      { slug: "cursor/gpt-5.5", model: "cursor/gpt-5.5", backend_model: "gpt-5.5", backend_provider: "cursor" }
    ]
  };

  upsertProviderCatalogModel(catalog, "gpt-5.5", "gpt-5.5", "Cursor GPT-5.5", "cursor");

  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].backend_provider, undefined);
  assert.equal(catalog.models[1].slug, "cursor/gpt-5.5");
  assert.equal(catalog.models[1].backend_model, "gpt-5.5");
  assert.equal(catalog.models[1].display_name, "cursor/gpt-5.5");
});

test("provider-owned models are namespaced even without a collision", () => {
  const catalog = { models: [] };

  upsertProviderCatalogModel(catalog, "deepseek-chat", "deepseek-chat", "DeepSeek Chat", "deepseek");

  assert.equal(catalog.models[0].slug, "deepseek/deepseek-chat");
  assert.equal(catalog.models[0].backend_model, "deepseek-chat");
  assert.equal(catalog.models[0].display_name, "deepseek/deepseek-chat");
});

test("upserting a model records native Responses preference", () => {
  const catalog = { models: [] };

  upsertProviderCatalogModel(catalog, "deepseek-v4-flash", "deepseek-v4-flash", "DeepSeek V4 Flash", "opencode-go", "responses");

  assert.equal(catalog.models[0].protocol, "responses");
  assert.equal(catalog.models[0].backend_protocol, "responses");
});

test("updating an existing provider model preserves its recorded metadata context", () => {
  const catalog = {
    models: [{
      slug: "deepseek/deepseek-v4-flash",
      model: "deepseek/deepseek-v4-flash",
      backend_model: "deepseek-v4-flash",
      backend_provider: "deepseek",
      context_window: 200000,
      max_context_window: 200000,
      context_window_source: "model_registry",
    }],
  };

  upsertProviderCatalogModel(catalog, "deepseek-v4-flash", "deepseek-v4-flash", "DeepSeek V4 Flash", "deepseek");

  assert.equal(catalog.models[0].context_window, 200000);
  assert.equal(catalog.models[0].max_context_window, 200000);
  assert.equal(catalog.models[0].context_window_source, "model_registry");
});

test("legacy provider-owned entries migrate to the provider namespace", () => {
  const catalog = {
    models: [{
      slug: "deepseek-chat",
      model: "deepseek-chat",
      backend_model: "deepseek-chat",
      backend_provider: "deepseek"
    }]
  };

  preserveOfficialModels(catalog);

  const migrated = catalog.models.find((model) => model.backend_provider === "deepseek");
  assert.equal(migrated?.slug, "deepseek/deepseek-chat");
  assert.equal(migrated?.backend_model, "deepseek-chat");
  assert.equal(migrated?.display_name, "deepseek/deepseek-chat");
});

test("gateway startup does not re-import Cursor from login presence alone", async () => {
  const source = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Restored .* Cursor models into the empty managed catalog/);
  assert.doesNotMatch(source, /if \(!hadThirdPartyModels && hasCursorCredential\(\)\)/);
});
