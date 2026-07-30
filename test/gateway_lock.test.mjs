import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { CodexBridgeServer } from "../dist/server/gateway.js";

test("gateway refuses a second instance sharing the same runtime directory and port", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-lock-test-`);
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  const first = new CodexBridgeServer(8801);
  const second = new CodexBridgeServer(8801);

  try {
    await first.start();
    await assert.rejects(second.start(), /already owned/);
  } finally {
    await first.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
