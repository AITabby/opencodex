import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityTokenStore, GATEWAY_CAPABILITIES } from "../dist/server/capability_tokens.js";

const tokenEnvironmentNames = [
  "OPENCODEX_ADMIN_TOKEN",
  "OPENCODEX_GATEWAY_TOKEN",
  "OPENCODEX_VOICE_TOKEN",
  "OPENCODEX_MOBILE_TOKEN",
];

test("Windows migrates the legacy token into a DPAPI capability vault and rotates atomically", {
  skip: process.platform !== "win32",
}, async () => {
  const savedEnvironment = Object.fromEntries(tokenEnvironmentNames.map((name) => [name, process.env[name]]));
  for (const name of tokenEnvironmentNames) delete process.env[name];

  const root = await mkdtemp(path.join(os.tmpdir(), "opencodex-p1-token-"));
  const legacyAdminToken = "a".repeat(64);
  try {
    await writeFile(path.join(root, "admin_token"), `${legacyAdminToken}\n`, { mode: 0o600 });

    const firstStore = new CapabilityTokenStore(root);
    const first = firstStore.snapshot();
    assert.equal(first.admin, legacyAdminToken);
    assert.equal(new Set(Object.values(first)).size, GATEWAY_CAPABILITIES.length);
    await assert.rejects(readFile(path.join(root, "admin_token"), "utf8"), /ENOENT/);

    const vaultPath = path.join(root, "capability_tokens.dpapi.json");
    const vault = await readFile(vaultPath, "utf8");
    assert.match(vault, /"protection": "dpapi-current-user"/);
    for (const token of Object.values(first)) assert.equal(vault.includes(token), false);

    const secondStore = new CapabilityTokenStore(root);
    assert.deepEqual(secondStore.snapshot(), first);

    const rotated = secondStore.rotate("voice");
    assert.equal(rotated.previousToken, first.voice);
    assert.notEqual(rotated.token, first.voice);
    assert.equal(secondStore.get("admin"), first.admin);
    assert.equal(secondStore.get("gateway"), first.gateway);
    assert.equal(secondStore.get("mobile"), first.mobile);

    const thirdStore = new CapabilityTokenStore(root);
    assert.equal(thirdStore.get("voice"), rotated.token);
  } finally {
    for (const name of tokenEnvironmentNames) {
      const value = savedEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const resolvedRoot = path.resolve(root);
    const allowedPrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolvedRoot.startsWith(allowedPrefix));
    await rm(resolvedRoot, { recursive: true, force: true });
  }
});
