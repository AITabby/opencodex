import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  deriveProviderNamespace,
  migrateProviderCatalogOwner,
  preserveOfficialModels,
  restoreConfiguredProviderModels,
  resolveOpenAiChatCompletionsUrl,
  resolveOpenAiModelsUrl,
  upsertProviderCatalogModel
} from "../dist/server/gateway.js";

test("custom providers derive a stable namespace from known and unknown URLs", () => {
  assert.equal(deriveProviderNamespace("custom", "https://api.deepseek.com/v1"), "deepseek");
  assert.equal(deriveProviderNamespace("custom", "https://api.xiaomimimo.com/v1"), "xiaomi");
  assert.equal(deriveProviderNamespace("custom", "https://llm.acme-lab.net/v1"), "acme-lab");
  assert.equal(deriveProviderNamespace("my-gateway", "https://api.example.com/v1"), "my-gateway");
});

test("OpenAI-compatible root URLs receive the standard v1 route", () => {
  assert.equal(
    resolveOpenAiChatCompletionsUrl("http://127.0.0.1:8317/"),
    "http://127.0.0.1:8317/v1/chat/completions"
  );
  assert.equal(
    resolveOpenAiModelsUrl("http://127.0.0.1:8317/"),
    "http://127.0.0.1:8317/v1/models"
  );
});

test("OpenAI-compatible versioned and full endpoint URLs are preserved", () => {
  assert.equal(
    resolveOpenAiChatCompletionsUrl("https://api.example.com/openai/v1"),
    "https://api.example.com/openai/v1/chat/completions"
  );
  assert.equal(
    resolveOpenAiChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/chat/completions"
  );
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

test("configured provider models are restored after the desktop rewrites the catalog", () => {
  const catalog = { models: [{ slug: "gpt-5.5", model: "gpt-5.5" }] };

  restoreConfiguredProviderModels(catalog, [{
    name: "127-0-0",
    baseUrl: "http://127.0.0.1:8317/",
    models: ["gemini-3.6-flash-high"]
  }]);

  const restored = catalog.models.find((model) => model.backend_provider === "127-0-0");
  assert.equal(restored?.slug, "127-0-0/gemini-3.6-flash-high");
  assert.equal(restored?.backend_model, "gemini-3.6-flash-high");
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
