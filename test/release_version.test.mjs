import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("1.0.6 release surfaces agree on the runtime version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const plist = await readFile(new URL("../macos-app/Info.plist", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");

  assert.equal(packageJson.version, "1.0.6");
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.0\.6<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>1\.0\.6<\/string>/);
  assert.match(gateway, /name: "CodexBridge Engine V2", version: "1\.0\.6"/);
});
