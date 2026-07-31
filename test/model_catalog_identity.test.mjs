import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildManagedCodexConfig, deriveProviderNamespace, ensureManagedCatalogConfig, migrateProviderCatalogOwner, preserveOfficialModels, upsertProviderCatalogModel } from "../dist/server/gateway.js";

test("managed Codex config follows the current gateway port across restarts", () => {
  const existing = `model = "gpt-5.5"\n\n# >>> opencodex managed >>>\nmodel_catalog_json = "/Users/test/.opencodex/custom_model_catalog.json"\nopenai_base_url = "http://127.0.0.1:18421/v1"\n# <<< opencodex managed <<<\n\n# >>> opencodex managed >>>\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:18421/v1"\n# <<< opencodex managed <<<\n`;
  const next = buildManagedCodexConfig(existing, 19753, "test-gateway-token", "/Users/test/.opencodex/custom_model_catalog.json");

  assert.match(next, /openai_base_url = "http:\/\/127\.0\.0\.1:19753\/v1"/);
  assert.match(next, /base_url = "http:\/\/127\.0\.0\.1:19753\/v1"/);
  assert.match(next, /experimental_bearer_token = "test-gateway-token"/);
  assert.doesNotMatch(next, /18421/);
  assert.match(next, /model = "gpt-5\.5"/);
  assert.equal((next.match(/# >>> opencodex managed >>>/g) || []).length, 2);
});

test("managed Codex config strips legacy blocks closed with >>>", () => {
  const existing = `model = "gpt-5.5"\n\n# >>> opencodex managed >>>\nmodel_catalog_json = "/Users/test/.opencodex/custom_model_catalog.json"\nopenai_base_url = "http://127.0.0.1:18421/v1"\n# <<< opencodex managed >>>\n`;
  const next = buildManagedCodexConfig(existing, 19753, "test-gateway-token", "/Users/test/.opencodex/custom_model_catalog.json");

  assert.equal((next.match(/# >>> opencodex managed >>>/g) || []).length, 2);
  assert.equal((next.match(/model_catalog_json/g) || []).length, 1);
  assert.doesNotMatch(next, /18421/);
});

test("managed Codex config escapes Windows paths and keeps catalog settings at the TOML root", () => {
  const windowsCatalogPath = String.raw`C:\Users\freed\.opencodex\custom_model_catalog.json`;
  const encodedPath = JSON.stringify(windowsCatalogPath);
  const existing = `[shell_environment_policy.set]\nBROWSER_USE_AVAILABLE_BACKENDS = "chrome"\n`;

  const catalogOnly = ensureManagedCatalogConfig(existing, windowsCatalogPath);
  assert.equal(catalogOnly.startsWith("# >>> opencodex managed >>>"), true);
  assert.equal(catalogOnly.includes(`model_catalog_json = ${encodedPath}`), true);
  assert.ok(catalogOnly.indexOf("model_catalog_json") < catalogOnly.indexOf("[shell_environment_policy.set]"));

  const fullConfig = buildManagedCodexConfig(existing, 19753, "test-gateway-token", windowsCatalogPath);
  assert.equal(fullConfig.includes(`model_catalog_json = ${encodedPath}`), true);
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
