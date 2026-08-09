import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBridgeServer } from "../dist/server/gateway.js";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let json = {};
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("OAuth account-pool endpoints expose pool state without credentials", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-oauth-account-api-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  const port = 8893;
  const server = new CodexBridgeServer(port);
  let started = false;
  try {
    try {
      await server.start();
      started = true;
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("sandbox forbids local listen; run this integration test outside the restricted test environment");
        return;
      }
      throw error;
    }

    const unauthorized = await request(`http://127.0.0.1:${port}/api/cli-bridge/accounts`);
    assert.equal(unauthorized.status, 401);
    const token = (await fs.readFile(path.join(dataDir, "admin_token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}` };
    const listed = await request(`http://127.0.0.1:${port}/api/cli-bridge/accounts`, { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.json.providers).sort(), ["antigravity", "claude", "cursor", "grok"]);
    assert.equal(listed.json.providers.grok.settings.mode, "round_robin");
    assert.equal(listed.json.providers.grok.accounts.length, 0);
    assert.doesNotMatch(listed.body, /access_token|refresh_token|Bearer/);

    const status = await request(`http://127.0.0.1:${port}/api/cli-bridge/status`, { headers });
    assert.equal(status.status, 200);
    assert.equal(status.json.grok.pool_supported, true);
    assert.equal(status.json.grok.account_count, 0);
    assert.equal(Array.isArray(status.json.grok.accounts), true);
  } finally {
    if (started) await server.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
