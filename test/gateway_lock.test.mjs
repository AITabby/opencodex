import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBridgeServer } from "../dist/server/gateway.js";

test("gateway refuses a second instance sharing the same runtime directory and port", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-lock-test-`);
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  const first = new CodexBridgeServer(8801);
  const second = new CodexBridgeServer(8801);
  const secondRuntimeRoot = second.runtimeFiles.root;

  try {
    await first.start();
    assert.equal(existsSync(secondRuntimeRoot), true);
    await assert.rejects(second.start(), /already owned/);
    assert.equal(existsSync(secondRuntimeRoot), false);
  } finally {
    await first.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
