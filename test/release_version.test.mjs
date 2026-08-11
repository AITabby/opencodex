import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release surfaces use package.json as the runtime version source", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const plist = await readFile(new URL("../macos-app/Info.plist", import.meta.url), "utf8");
  const voicePlist = await readFile(new URL("../voice/OpenCodexBar/Sources/OpenCodexBar/Info.plist", import.meta.url), "utf8");
  const packageScript = await readFile(new URL("../macos-app/scripts/package-app.sh", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");
  const runtimeVersion = await import("../dist/version.js");

  assert.equal(packageJson.name, "codexsplit");
  assert.equal(packageJson.version, "2.0.0");
  assert.equal(lockfile.name, "codexsplit");
  assert.equal(lockfile.version, "2.0.0");
  assert.equal(lockfile.packages[""].name, "codexsplit");
  assert.equal(lockfile.packages[""].version, "2.0.0");
  assert.equal(runtimeVersion.APP_VERSION, packageJson.version);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.aitabby\.codexsplit<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>2\.0\.0<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>2000000<\/string>/);
  assert.match(voicePlist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.aitabby\.codexsplit\.voicebar<\/string>/);
  assert.match(voicePlist, /<key>CFBundleShortVersionString<\/key>\s*<string>2\.0\.0<\/string>/);
  assert.match(voicePlist, /<key>CFBundleVersion<\/key>\s*<string>2000000<\/string>/);
  assert.match(packageScript, /MARKETING_VERSION=/);
  assert.match(packageScript, /BUNDLE_VERSION=/);
  assert.match(gateway, /name: "CodexSplit Engine V2", version: APP_VERSION/);
});
