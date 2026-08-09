import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  chooseProviderCredentialId,
  maskProviderApiKey,
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
