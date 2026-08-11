import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CredentialStore,
  chooseProviderCredentialId,
  dedupeProviderConfigs,
  maskProviderApiKey,
  normalizeProviderCredentialReference,
  normalizeProviderPoolMode,
} from "../dist/services/credential_store.js";

const credential = (id, status = "ready") => ({
  id,
  label: id,
  credential_ref: `keychain:OpenCodex Provider Credential:provider:test:credential:${id}`,
  status,
});

test("API-key pool selection supports fixed, round-robin, and failed-key skipping", () => {
  const credentials = [credential("a"), credential("b"), credential("c", "expired")];
  assert.equal(chooseProviderCredentialId(credentials, "fixed", "b"), "b");
  assert.equal(chooseProviderCredentialId(credentials, "fixed", "c"), "");
  assert.equal(chooseProviderCredentialId(credentials, "round_robin", "a", [], "a"), "b");
  assert.equal(chooseProviderCredentialId(credentials, "round_robin", "a", ["b"], "a"), "a");
  assert.equal(chooseProviderCredentialId(credentials, "failover", "c"), "a");
});

test("API-key pool helpers normalize policies and never expose the full secret", () => {
  assert.equal(normalizeProviderPoolMode("round_robin"), "round_robin");
  assert.equal(normalizeProviderPoolMode("failover"), "failover");
  assert.equal(normalizeProviderPoolMode("anything-else"), "fixed");
  assert.equal(maskProviderApiKey("sk-test-1234"), "••••••••1234");
  assert.equal(maskProviderApiKey(""), "Key 未找到");
});

test("dashboard provider credential reads can run asynchronously without exposing secrets", async () => {
  const previous = process.env.OPENCODEX_TEST_PROVIDER_KEY;
  process.env.OPENCODEX_TEST_PROVIDER_KEY = "sk-dashboard-test-1234";
  try {
    const groups = await CredentialStore.getProvidersCredentialsPublicAsync([{
      name: "dashboard-test",
      api_key_env: "OPENCODEX_TEST_PROVIDER_KEY",
      credentials: [{ id: "default", label: "API Key 1", status: "unknown" }],
    }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0][0].masked, "••••••••1234");
    assert.equal(groups[0][0].status, "unknown");
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_TEST_PROVIDER_KEY;
    else process.env.OPENCODEX_TEST_PROVIDER_KEY = previous;
  }
});

test("provider credentials repair the legacy Keychain reference for every provider", () => {
  assert.equal(
    normalizeProviderCredentialReference("keychain:provider:minimax"),
    "keychain:OpenCodex Provider Credential:provider:minimax",
  );
  assert.equal(
    normalizeProviderCredentialReference("keychain:provider:opencode-go"),
    "keychain:OpenCodex Provider Credential:provider:opencode-go",
  );
  assert.equal(
    normalizeProviderCredentialReference("keychain:Other Service:provider:minimax"),
    "keychain:Other Service:provider:minimax",
  );
});

test("provider loading repairs legacy refs and merges duplicate provider records without losing removable old keys", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "opencodex-provider-migration-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    await writeFile(path.join(dataDir, "providers.json"), JSON.stringify({ providers: [
      {
        name: "opencode",
        baseUrl: "https://opencode.ai/zen/go/v1",
        credential_ref: "keychain:OpenCodex Provider Credential:provider:opencode",
        credentials: [{ id: "default", label: "API Key 1", credential_ref: "keychain:OpenCodex Provider Credential:provider:opencode", status: "unknown" }],
      },
      {
        name: "opencode",
        baseUrl: "https://opencode.ai/zen/go/v1",
        credential_ref: "keychain:OpenCodex Provider Credential:provider:opencode",
        credentials: [{ id: "default", label: "API Key 1", credential_ref: "keychain:OpenCodex Provider Credential:provider:opencode", status: "unknown" }],
      },
      {
        name: "opencode-go",
        preset_id: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        credential_ref: "keychain:provider:opencode-go",
        credentials: [{ id: "default", label: "API Key 1", credential_ref: "keychain:provider:opencode-go", status: "expired", status_code: 401 }],
      },
      {
        name: "minimax",
        preset_id: "minimax",
        baseUrl: "https://api.minimaxi.com/v1",
        credential_ref: "keychain:provider:minimax",
        credentials: [{ id: "default", label: "API Key 1", credential_ref: "keychain:provider:minimax", status: "expired", status_code: 401 }],
      },
    ] }, null, 2));

    const loaded = CredentialStore.loadProviders();
    assert.equal(loaded.length, 2);

    const opencode = CredentialStore.findProvider(loaded, "opencode-go");
    assert.ok(opencode);
    assert.equal(opencode.name, "opencode");
    assert.equal(opencode.preset_id, "opencode-go");
    assert.equal(opencode.credentials.length, 2);
    assert.equal(new Set(opencode.credentials.map((credential) => credential.id)).size, 2);
    assert.ok(opencode.credentials.some((credential) => credential.credential_ref.endsWith(":provider:opencode-go")));
    assert.ok(opencode.credentials.some((credential) => credential.credential_ref.endsWith(":provider:opencode")));
    assert.ok(opencode.credentials.every((credential) => credential.credential_ref.startsWith("keychain:OpenCodex Provider Credential:")));

    const minimax = CredentialStore.findProvider(loaded, "minimax");
    assert.ok(minimax);
    assert.equal(minimax.credentials[0].credential_ref, "keychain:OpenCodex Provider Credential:provider:minimax");
    assert.equal(minimax.credentials[0].status, "unknown");

    const saved = JSON.parse(await readFile(path.join(dataDir, "providers.json"), "utf8"));
    assert.equal(saved.providers.length, 2);
    assert.ok(saved.providers.every((provider) => (provider.credentials || []).every((credential) => !credential.api_key)));
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("provider identity deduplication keeps providers with different endpoints separate", () => {
  const providers = dedupeProviderConfigs([
    { name: "custom", baseUrl: "https://one.example/v1" },
    { name: "custom", baseUrl: "https://two.example/v1" },
    { name: "custom", baseUrl: "https://one.example/v1", models: ["model-b"] },
    { name: "minimax", preset_id: "minimax", baseUrl: "https://one.example/v1" },
    { name: "minimax", preset_id: "minimax", baseUrl: "https://two.example/v1" },
  ]);
  assert.equal(providers.length, 4);
  assert.deepEqual(providers.find((provider) => provider.baseUrl.includes("one"))?.models, ["model-b"]);
});

test("API-key pool source exposes secure management, status, and runtime failover boundaries", async () => {
  const [store, gateway, router, dashboard] = await Promise.all([
    readFile(new URL("../src_v2/services/credential_store.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/server/router.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/services/dashboard.ts", import.meta.url), "utf8"),
  ]);
  for (const marker of [
    "addApiKeyCredential",
    "removeApiKeyCredential",
    "markProviderCredentialFailure",
    "getProviderCredentialsPublic",
    "getProvidersCredentialsPublicAsync",
    "writeKeychainSecret",
    "model_test_status",
  ]) assert.match(store, new RegExp(marker));
  for (const marker of [
    "/api/providers/credentials/add",
    "/api/providers/credentials/remove",
    "/api/providers/credentials/policy",
    "/api/providers/credentials/test",
    "/api/providers/test-model",
    "recordProviderModelTest",
    "model_test_status",
    "credential_count: publicCredentials.length",
  ]) assert.match(gateway, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  assert.match(router, /ProviderCredentialError/);
  assert.match(router, /credential failover/);
  for (const marker of [
    "provider-pool-new-key",
    "provider-pool-add-key",
    "data-provider-credential-test",
    "data-provider-credential-remove",
    "顺序轮询",
    "失败自动切换",
    "已失效",
    "/api/providers/credentials/test",
  ]) assert.match(dashboard, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  assert.doesNotMatch(gateway, /credentials: p\.credentials/);
});
