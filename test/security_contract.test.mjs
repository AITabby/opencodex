import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const gateway = () => readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
const credentials = () => readFile(new URL("../src_v2/services/credential_store.ts", import.meta.url), "utf8");
const realtimeProxy = () => readFile(new URL("../src_v2/server/webrtc_proxy.ts", import.meta.url), "utf8");
const capabilityTokens = () => readFile(new URL("../src_v2/server/capability_tokens.ts", import.meta.url), "utf8");
const voiceSocket = () => readFile(new URL("../voice/OpenCodexBar/Sources/OpenCodexBar/WebSocketManager.swift", import.meta.url), "utf8");
const gatewayLocator = () => readFile(new URL("../voice/OpenCodexBar/Sources/OpenCodexBar/GatewayLocator.swift", import.meta.url), "utf8");
const voiceKeychain = () => readFile(new URL("../voice/OpenCodexBar/Sources/OpenCodexBar/CapabilityTokenKeychain.swift", import.meta.url), "utf8");

test("gateway is loopback-only and enforces route capabilities", async () => {
  const source = await gateway();
  assert.match(source, /server\.listen\(this\.port, "127\.0\.0\.1"/);
  assert.match(source, /requireCapabilities\(req, res, requiredCapabilities\)/);
  assert.match(source, /requiredCapabilitiesForHttp\(req\.method, url\.pathname\)/);
  assert.match(source, /requiredCapabilitiesForWebSocket\(route\)/);
  assert.match(source, /isProtectedGatewayPath\(url\.pathname\)/);
  assert.match(source, /isAllowedGatewayHost\(req\.headers\.host, this\.port\)/);
  assert.match(source, /isAllowedGatewayOrigin\(origin, this\.port\)/);
  assert.match(source, /classifyWebSocketPath\(url\.pathname\)/);
  assert.match(source, /opencodex_admin=/);
  assert.match(source, /x-opencodex-token/);
  assert.match(source, /timingSafeEqual/);
  assert.doesNotMatch(source, /server\.listen\(this\.port, "0\.0\.0\.0"/);
  assert.doesNotMatch(source, /url\.pathname\.includes\("voice"\)/);
});

test("voice WebSocket uses its dedicated authenticated endpoint", async () => {
  const [manager, locator, keychain] = await Promise.all([voiceSocket(), gatewayLocator(), voiceKeychain()]);
  assert.match(locator, /\/ws\/voice/);
  assert.match(manager, /GatewayLocator\.voiceToken\(\)/);
  assert.match(manager, /forHTTPHeaderField: "Authorization"/);
  assert.match(manager, /webSocketTask\(with: request\)/);
  assert.match(keychain, /OpenCodex Local Capability Tokens/);
  assert.match(keychain, /SecItemCopyMatching/);
  assert.doesNotMatch(locator, /admin_token/);
});

test("capability tokens use platform secure storage without plaintext fallback", async () => {
  const [gatewaySource, store] = await Promise.all([gateway(), capabilityTokens()]);
  assert.match(store, /ProtectedData\]::Protect/);
  assert.match(store, /DataProtectionScope\]::CurrentUser/);
  assert.match(store, /OpenCodex Local Capability Tokens/);
  assert.match(store, /find-generic-password/);
  assert.match(store, /add-generic-password/);
  assert.match(store, /removeLegacyAdminToken/);
  assert.match(store, /all four OPENCODEX_\*_TOKEN environment variables/);
  assert.doesNotMatch(store, /writeFileSync\([^\n]*admin_token/);
  assert.match(gatewaySource, /buildManagedCodexConfig\(managedConfig, this\.port, this\.capabilityTokens\.gateway\)/);
});

test("local gateway credentials are isolated from native upstream credentials", async () => {
  const [gatewaySource, proxySource] = await Promise.all([gateway(), realtimeProxy()]);
  assert.match(gatewaySource, /readNativeAccessToken\(\)/);
  assert.match(gatewaySource, /"authorization",[\s\S]*"cookie",[\s\S]*"x-opencodex-token"/);
  assert.match(gatewaySource, /forwardHeaders\["authorization"\] = `Bearer \$\{nativeAccessToken\}`/);
  assert.match(proxySource, /lowerKey === "cookie"/);
  assert.match(proxySource, /lowerKey === "proxy-authorization"/);
  assert.match(proxySource, /lowerKey === "x-opencodex-token"/);
  assert.doesNotMatch(proxySource, /dummy\|opencodex/);
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
