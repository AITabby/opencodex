import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("Windows provider credentials use DPAPI CurrentUser without plaintext persistence", {
  skip: process.platform !== "win32",
}, async (t) => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "opencodex-provider-credentials-"));
  t.after(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  const credentialStoreUrl = pathToFileURL(path.resolve("dist/services/credential_store.js")).href;
  const childScript = `
    import fs from "node:fs";
    import { CredentialStore } from ${JSON.stringify(credentialStoreUrl)};

    const secret = fs.readFileSync(0, "utf8");
    const provider = {
      name: "windows-dpapi-test",
      type: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      models: ["synthetic-model"],
    };

    CredentialStore.setApiKey(provider, secret);
    CredentialStore.saveProviders([provider]);
    const loaded = CredentialStore.loadProviders()[0];
    if (!loaded?.credential_ref?.startsWith("dpapi-current-user:")) {
      throw new Error("Provider did not receive a Windows DPAPI credential reference");
    }
    if (CredentialStore.resolveApiKey(loaded) !== secret) {
      throw new Error("Provider credential did not round-trip through Windows DPAPI");
    }

    const storage = CredentialStore.credentialStorage(loaded.credential_ref);
    CredentialStore.deleteProviderSecret(loaded);
    if (CredentialStore.resolveApiKey(loaded) !== "") {
      throw new Error("Deleted provider credential remained readable");
    }
    process.stdout.write(JSON.stringify({ storage }));
  `;
  const syntheticSecret = `synthetic-provider-secret-${randomUUID()}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USERPROFILE: profileDir,
      HOME: profileDir,
    },
    input: syntheticSecret,
    encoding: "utf-8",
    windowsHide: true,
    timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { storage: "windows-dpapi-current-user" });

  const dataDir = path.join(profileDir, ".opencodex");
  const providersRaw = await readFile(path.join(dataDir, "providers.json"), "utf8");
  const vaultRaw = await readFile(path.join(dataDir, "credentials.dpapi.json"), "utf8");
  assert.equal(providersRaw.includes(syntheticSecret), false);
  assert.equal(vaultRaw.includes(syntheticSecret), false);

  const providers = JSON.parse(providersRaw).providers;
  assert.equal(providers.length, 1);
  assert.equal("api_key" in providers[0], false);
  assert.match(providers[0].credential_ref, /^dpapi-current-user:/);

  const vault = JSON.parse(vaultRaw);
  assert.equal(vault.version, 1);
  assert.equal(vault.protection, "dpapi-current-user");
  assert.equal(typeof vault.ciphertext, "string");
  assert.ok(vault.ciphertext.length > 0);
});

test("Windows provider API saves through DPAPI and returns only storage metadata", {
  skip: process.platform !== "win32",
}, async (t) => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "opencodex-provider-api-"));
  t.after(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  const gatewayUrl = pathToFileURL(path.resolve("dist/server/gateway.js")).href;
  const childScript = `
    import fs from "node:fs";
    import net from "node:net";
    import { CodexBridgeServer } from ${JSON.stringify(gatewayUrl)};

    const secret = fs.readFileSync(0, "utf8");
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise((resolve) => probe.close(resolve));

    const server = new CodexBridgeServer(port);
    try {
      await server.start();
      const authorization = \`Bearer \${server.capabilityTokens.admin}\`;
      const saveResponse = await fetch(\`http://127.0.0.1:\${port}/api/providers\`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          preset_id: "deepseek",
          name: "deepseek",
          base_url: "https://api.deepseek.com",
          api_key: secret,
          selected_models: ["deepseek-v4-flash"],
          install_models: false,
        }),
      });
      const saveBody = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saveBody.error || \`Provider save failed: \${saveResponse.status}\`);

      const listResponse = await fetch(\`http://127.0.0.1:\${port}/api/providers\`, {
        headers: { Authorization: authorization },
      });
      const listBody = await listResponse.json();
      if (!listResponse.ok) throw new Error(listBody.error || \`Provider list failed: \${listResponse.status}\`);
      const provider = listBody.providers.find((item) => item.id === "deepseek");
      if (!provider) throw new Error("Saved DeepSeek provider was not returned");
      process.stdout.write(\`\\n__OPENCODEX_RESULT__\${JSON.stringify({
        storage: provider.credential_storage,
        configured: provider.api_key_configured,
        returnedCredentialReference: Object.prototype.hasOwnProperty.call(provider, "credential_ref"),
      })}\\n\`);
    } finally {
      await server.stop();
    }
  `;
  const syntheticSecret = `synthetic-api-secret-${randomUUID()}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USERPROFILE: profileDir,
      HOME: profileDir,
      OPENCODEX_DATA_DIR: path.join(profileDir, ".opencodex"),
      OPENCODEX_CODEX_CONFIG_PATH: path.join(profileDir, ".codex", "config.toml"),
    },
    input: syntheticSecret,
    encoding: "utf-8",
    windowsHide: true,
    timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const resultLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("__OPENCODEX_RESULT__"));
  assert.ok(resultLine, result.stdout);
  assert.deepEqual(JSON.parse(resultLine.slice("__OPENCODEX_RESULT__".length)), {
    storage: "windows-dpapi-current-user",
    configured: true,
    returnedCredentialReference: false,
  });

  const dataDir = path.join(profileDir, ".opencodex");
  const providersRaw = await readFile(path.join(dataDir, "providers.json"), "utf8");
  const vaultRaw = await readFile(path.join(dataDir, "credentials.dpapi.json"), "utf8");
  assert.equal(providersRaw.includes(syntheticSecret), false);
  assert.equal(vaultRaw.includes(syntheticSecret), false);
});
