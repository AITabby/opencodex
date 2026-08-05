/**
 * Full V2 Server Integration Test Suite
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs/promises";
import { CodexBridgeServer } from "../dist/server/gateway.js";

test("V2 server starts and answers healthcheck cleanly", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-v2-test-`);
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = `${dataDir}/config.toml`;
  const server = new CodexBridgeServer(8799);
  await server.start();

  try {
    const json = await new Promise((resolve, reject) => {
      http.get("http://127.0.0.1:8799/health", (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject);
    });

    assert.equal(json.status, "ok");
    assert.equal(json.name, "CodexBridge Engine V2");
  } finally {
    await server.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
