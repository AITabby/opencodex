import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
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

test("ChatGPT account-pool APIs are admin-protected and never return auth contents", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-chatgpt-account-api-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  const previousNativePath = process.env.OPENCODEX_NATIVE_CODEX_PATH;
  const previousCliPath = process.env.CODEX_CLI_PATH;
  const previousBridgePath = process.env.OPENCODEX_PROVIDER_BRIDGE_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  process.env.CODEX_CLI_PATH = "";
  process.env.OPENCODEX_PROVIDER_BRIDGE_PATH = "";
  const fakeNativePath = path.join(dataDir, "fake-codex");
  await fs.writeFile(fakeNativePath, `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
    } else if (request.method === "account/rateLimits/read") {
      process.stdout.write(JSON.stringify({
        id: request.id,
        result: {
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1700000000 },
            secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1700600000 },
            credits: { hasCredits: true, unlimited: false, balance: "7" },
            planType: "plus",
          },
        },
      }) + "\\n");
    }
  }
});
`);
  await fs.chmod(fakeNativePath, 0o755);
  process.env.OPENCODEX_NATIVE_CODEX_PATH = fakeNativePath;
  const port = 8892;
  const server = new CodexBridgeServer(port);
  let started = false;
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

  try {
    const unauthorized = await request(`http://127.0.0.1:${port}/api/chatgpt-accounts`);
    assert.equal(unauthorized.status, 401);

    const token = (await fs.readFile(path.join(dataDir, "admin_token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const created = await request(`http://127.0.0.1:${port}/api/chatgpt-accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "plus-api", label: "Plus API" }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.account.id, "plus-api");
    assert.equal(created.json.account.auth_status, "missing");

    await fs.writeFile(
      path.join(created.json.account.profile_dir, "auth.json"),
      JSON.stringify({ access_token: "api-test-secret" }),
    );
    const listed = await request(`http://127.0.0.1:${port}/api/chatgpt-accounts?refresh=1`, { headers });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.accounts[0].auth_status, "ready");
    assert.equal(listed.json.accounts[0].usage.status, "fresh");
    assert.equal(listed.json.accounts[0].usage.five_hour.used_percent, 12);
    assert.equal(listed.json.accounts[0].usage.weekly.remaining_percent, 66);
    assert.equal(listed.json.accounts[0].usage.plan_type, "plus");
    assert.doesNotMatch(listed.body, /api-test-secret/);

    const settings = await request(`http://127.0.0.1:${port}/api/chatgpt-accounts/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rotation_enabled: true, mode: "round_robin", default_account_id: "plus-api" }),
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.json.rotation_enabled, true);
    assert.equal(settings.json.mode, "round_robin");
  } finally {
    if (started) await server.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    if (previousNativePath === undefined) delete process.env.OPENCODEX_NATIVE_CODEX_PATH;
    else process.env.OPENCODEX_NATIVE_CODEX_PATH = previousNativePath;
    if (previousCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousCliPath;
    if (previousBridgePath === undefined) delete process.env.OPENCODEX_PROVIDER_BRIDGE_PATH;
    else process.env.OPENCODEX_PROVIDER_BRIDGE_PATH = previousBridgePath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
