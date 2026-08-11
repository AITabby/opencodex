import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("macOS packaging carries the complete voice runtime", async () => {
  const [packageScript, verifyScript, gateway, app, server, start] = await Promise.all([
    read("macos-app/scripts/package-app.sh"),
    read("macos-app/scripts/verify-release.sh"),
    read("src_v2/server/gateway.ts"),
    read("macos-app/Sources/OpenCodex/GatewayProcess.swift"),
    read("src_v2/server.ts"),
    read("src_v2/start.ts")
  ]);
  assert.match(packageScript, /voice-runtime\/uvx/);
  assert.match(packageScript, /voice-runtime\/uv/);
  assert.match(packageScript, /voice-runtime\/ffmpeg/);
  assert.match(packageScript, /VOICE_HELPER_FILES/);
  assert.match(packageScript, /dist\/voice/);
  assert.match(packageScript, /src_v2\/assets/);
  assert.match(packageScript, /otool -L/);
  assert.match(packageScript, /@rpath\/|opt\/homebrew|usr\/local\/\(Cellar\|opt\)/);
  assert.match(packageScript, /OPENCODEX_NODE_BINARY/);
  assert.match(packageScript, /codesign --deep --force --sign - --timestamp=none/);
  assert.match(packageScript, /--product CodexSplit/);
  assert.match(packageScript, /--product CodexSplitLivePicker/);
  assert.match(packageScript, /Contents\/MacOS\/CodexSplit/);
  assert.match(packageScript, /Resources\/CodexSplitLivePicker/);
  assert.match(verifyScript, /voice-runtime\/uvx/);
  assert.match(verifyScript, /dist\/voice\/minimax_tts\.py/);
  assert.match(verifyScript, /src_v2\/assets\/codexsplit-logo-compact\.png/);
  assert.match(verifyScript, /Resources\/CodexSplitLivePicker/);
  assert.match(gateway, /OPENCODEX_VOICE_RUNTIME_DIR/);
  assert.match(gateway, /useEnergyVAD/);
  assert.match(app, /OPENCODEX_VOICE_RUNTIME_DIR/);
  assert.match(app, /OPENCODEX_VOICE_BAR_PATH/);
  assert.match(app, /gateway_runtime_/);
  assert.match(server, /process\.env\.OPENCODEX_PORT/);
  assert.match(start, /process\.env\.OPENCODEX_PORT/);
});

test("repository build includes the bundled OpenCodexBar source", async () => {
  const [packageJson, buildAll, packageScript] = await Promise.all([
    read("package.json"),
    read("scripts/build-all.sh"),
    read("macos-app/scripts/package-app.sh")
  ]);
  assert.equal(JSON.parse(packageJson).scripts["build:all"], "./scripts/build-all.sh");
  assert.match(buildAll, /npm run build/);
  assert.match(buildAll, /voice\/OpenCodexBar/);
  assert.match(buildAll, /swift build -c release/);
  assert.match(packageScript, /VOICE_BAR_SOURCE=.*voice\/OpenCodexBar/);
});

test("DMG uses a standard Applications drag-install layout", async () => {
  const script = await read("macos-app/scripts/package-dmg.sh");
  assert.match(script, /DMG_STAGING=/);
  assert.match(script, /cp -R "\$APP_BUNDLE" "\$DMG_STAGING\/CodexSplit\.app"/);
  assert.match(script, /ln -s \/Applications "\$DMG_STAGING\/Applications"/);
  assert.match(script, /-srcfolder "\$DMG_STAGING"/);
});

test("desktop app publishes the runtime port and uses the embedded voice bar", async () => {
  const [app, gatewayProcess, info, gateway] = await Promise.all([
    read("macos-app/Sources/OpenCodex/OpenCodexApp.swift"),
    read("macos-app/Sources/OpenCodex/GatewayProcess.swift"),
    read("macos-app/Info.plist"),
    read("src_v2/server/gateway.ts")
  ]);
  assert.match(app, /applicationShouldTerminateAfterLastWindowClosed/);
  assert.match(app, /applicationShouldHandleReopen/);
  assert.match(gatewayProcess, /OPENCODEX_VOICE_BAR_PATH/);
  assert.match(gatewayProcess, /gateway_runtime_/);
  assert.match(gatewayProcess, /OPENCODEX_DATA_DIR/);
  assert.match(gatewayProcess, /CodexSplitLivePicker/);
  assert.match(gatewayProcess, /OPENCODEX_APP_PORT/);
  assert.match(gatewayProcess, /OPENCODEX_ADMIN_TOKEN_PATH/);
  assert.match(gatewayProcess, /sanitizedGatewayEnvironment/);
  assert.match(gatewayProcess, /CODEX_CLI_PATH/);
  assert.match(gatewayProcess, /OPENCODEX_PROVIDER_BRIDGE_PATH/);
  assert.doesNotMatch(gatewayProcess, /launchctl/);
  assert.doesNotMatch(gatewayProcess, /restart_desktop_after_gateway_ready/);
  assert.doesNotMatch(gatewayProcess, /allowDesktopBridgeTakeover/);
  assert.match(gateway, /buildManagedCodexConfig/);
  assert.match(gateway, /Synchronized managed Codex config to port/);
  assert.match(info, /LSMultipleInstancesProhibited/);
});

test("login startup leaves native Desktop untouched and clears only legacy bridge state", async () => {
  const startup = await read("startup.sh");
  assert.doesNotMatch(startup, /launchctl setenv/);
  assert.match(startup, /launchctl getenv CODEX_CLI_PATH/);
  assert.match(startup, /launchctl unsetenv CODEX_CLI_PATH/);
  assert.doesNotMatch(startup, /: > .*restart_desktop_after_gateway_ready/);
  assert.match(startup, /pm2 start \"\$PROJECT_ROOT\/dist\/server\.js\"/);
  assert.match(startup, /--no-treekill/);
});

test("voice streaming deduplicates repeated CDP response snapshots before TTS", async () => {
  const source = await readFile(new URL("../voice/OpenCodexBar/Sources/OpenCodexBar/AppDelegate.swift", import.meta.url), "utf8");
  assert.match(source, /Skipping duplicate snapshot/);
  assert.match(source, /incoming == self\.streamResponseText/);
  assert.match(source, /incoming\.hasPrefix\(self\.streamResponseText\)/);
});
