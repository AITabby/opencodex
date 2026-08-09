import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

test("the gateway build emits cross-platform launcher artifacts", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const launcher = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
  const artifacts = ["gateway-entry.js", "codex-provider-bridge", "opencodex-codex"];

  assert.equal(packageJson.scripts.build, "node scripts/build.mjs");
  assert.equal(launcher, 'import "./gateway-entry.js";\n');

  for (const artifact of artifacts) {
    const metadata = await stat(new URL(`../dist/${artifact}`, import.meta.url));
    assert.equal(metadata.isFile(), true, `missing build artifact: ${artifact}`);
  }
});
