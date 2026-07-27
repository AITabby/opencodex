import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const gateway = () => readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
const credentials = () => readFile(new URL("../src_v2/services/credential_store.ts", import.meta.url), "utf8");

test("gateway is loopback-only and protects admin APIs", async () => {
  const source = await gateway();
  assert.match(source, /server\.listen\(this\.port, "127\.0\.0\.1"/);
  assert.match(source, /requireAdmin\(req, res\)/);
  assert.match(source, /opencodex_admin=/);
  assert.match(source, /timingSafeEqual/);
  assert.doesNotMatch(source, /server\.listen\(this\.port, "0\.0\.0\.0"/);
});

test("provider and voice APIs never return plaintext credentials", async () => {
  const [source, store] = await Promise.all([gateway(), credentials()]);
  assert.match(source, /const \{ api_key: _apiKey/);
  assert.match(source, /api_key_configured/);
  assert.match(source, /maskVoiceSettings/);
  assert.match(store, /OpenCodex Provider Credential/);
  assert.match(store, /delete provider\.api_key/);
  assert.match(store, /posixPermissions|chmodSync/);
});

test("voice and session shell calls pass user input as arguments", async () => {
  const source = await gateway();
  assert.match(source, /execFileSync\(resolveRuntimeBinary\("uvx"\), edgeArgs/);
  assert.match(source, /execFileSync\(resolveRuntimeBinary\("say"\), \["-o", tmpAiff, text\]/);
  assert.match(source, /execFileSync\("sqlite3", \[dbPath, sql\]/);
  assert.doesNotMatch(source, /execSync\(`uvx edge-tts/);
  assert.doesNotMatch(source, /execSync\(`say -o/);
  assert.doesNotMatch(source, /execSync\(/);
  assert.doesNotMatch(source, /\.exec\(/);
});

test("V2 has no runtime dependency on the retired gateway tree", async () => {
  const source = await gateway();
  const retiredGatewayPattern = new RegExp(["legacy", "proxy", "backup"].join("_"));
  assert.doesNotMatch(source, retiredGatewayPattern);
  assert.equal(source.includes("src/proxy"), false);
  assert.equal(source.includes("dist/proxy"), false);
  assert.match(source, /import\("\.\.\/services\/visualizer\.js"\)/);
});

test("model routing is owned by imported catalog metadata and has no provider-order fallback", async () => {
  const source = await gateway();
  assert.match(source, /findCatalogProvider/);
  assert.match(source, /no fallback provider was selected/);
  assert.doesNotMatch(source, /providers\.find\([\s\S]{0,240}providers\[0\]/);
  assert.match(source, /backend_provider/);
});

test("native GPT models pass through the Codex backend when the gateway is enabled", async () => {
  const source = await gateway();
  assert.match(source, /isNativeCatalogModel/);
  assert.match(source, /proxyNativeResponses/);
  assert.match(source, /chatgpt\.com\/backend-api\/codex\/responses/);
});
