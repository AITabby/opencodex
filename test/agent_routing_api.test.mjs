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
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("1.1.0 Agent routing APIs persist Profile and GPT-Live mode", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-agent-api-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify({ models: [{
    slug: "antigravity/code-model",
    backend_model: "gemini-code-1",
    backend_provider: "antigravity",
  }] }));
  const server = new CodexBridgeServer(8891);
  let started = false;
  try {
    await server.start();
    started = true;
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("sandbox forbids local listen; run this integration test outside the restricted test environment");
      if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
      else process.env.OPENCODEX_DATA_DIR = previousDataDir;
      if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
      else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
      await fs.rm(dataDir, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  try {
    const token = await fs.readFile(path.join(dataDir, "admin_token"), "utf8");
    const headers = { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json" };
    const initial = await request("http://127.0.0.1:8891/api/agent-profiles", { method: "GET", headers });
    assert.equal(initial.status, 200);
    assert.equal(initial.json.models[0].slug, "antigravity/code-model");

    const profile = await request("http://127.0.0.1:8891/api/agent-profiles", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "code",
        name: "代码实现",
        task_types: ["coding"],
        model_ref: { provider: "antigravity", backend_model: "gemini-code-1", catalog_slug: "antigravity/code-model" },
        reasoning_effort: "high",
      }),
    });
    assert.equal(profile.status, 200);

    const settings = await request("http://127.0.0.1:8891/api/agent-routing/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ mode: "auto", default_profile_id: "code" }),
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.json.mode, "auto");

    const saved = await request("http://127.0.0.1:8891/api/agent-profiles", { method: "GET", headers });
    assert.equal(saved.json.profiles[0].model_available, true);
    assert.equal(saved.json.routing.mode, "auto");
  } finally {
    if (started) await server.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
