import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  classifyProviderModel,
  isNativeSubagentRequest,
  nativeEgressRoute,
  nativeRuntimeArgs,
  normalizeThreadListParams,
} from "../dist/codex-provider-bridge.js";
import { buildManagedCodexConfig } from "../dist/server/gateway.js";

test("1.1.5 classifies official and namespaced provider-owned models safely", () => {
  const catalogs = [{
    models: [
      { slug: "gpt-5.5", provider: "openai" },
      { slug: "cursor/grok-4.5", backend_provider: "cursor" },
      { slug: "glm/glm-5", backend_provider: "glm" },
      { slug: "ownerless-model" },
    ],
  }];

  assert.equal(classifyProviderModel("gpt-5.5", catalogs), "openai");
  assert.equal(classifyProviderModel("gpt-5.5", [{
    models: [{ slug: "gpt-5.5", provider: "opencodex" }],
  }]), "openai");
  assert.equal(classifyProviderModel("cursor/grok-4.5", catalogs), "opencodex");
  assert.equal(classifyProviderModel("glm/glm-5", catalogs), "opencodex");
  assert.equal(classifyProviderModel("ownerless-model", catalogs), "openai");
  assert.equal(classifyProviderModel("antigravity/gemini-3.6-flash-medium", []), "opencodex");
  assert.equal(classifyProviderModel("minimax/minimax-m3", []), "opencodex");
  assert.equal(classifyProviderModel("openai/gpt-5.5", []), "openai");
  assert.equal(classifyProviderModel("antigravity/gemini-3.6-flash-medium", [{
    models: [{ slug: "antigravity/gemini-3.6-flash-medium", provider: "openai" }],
  }]), "opencodex");
  assert.equal(classifyProviderModel("not-in-catalog", catalogs), null);
});

test("1.1.5 history listing is provider-neutral even when Desktop sends a provider filter", () => {
  assert.deepEqual(normalizeThreadListParams({ limit: 100 }), {
    limit: 100,
    modelProviders: [],
  });
  assert.deepEqual(normalizeThreadListParams({ modelProviders: ["opencodex"] }), {
    modelProviders: [],
  });
  assert.deepEqual(normalizeThreadListParams({ modelProviders: [] }), {
    modelProviders: [],
  });
});

test("native child routing is request-scoped and leaves the native provider untouched", () => {
  assert.equal(nativeEgressRoute({ model: "gpt-5.5" }, {}), "native");
  assert.equal(isNativeSubagentRequest({ model: "gpt-5.5" }, {
    "x-openai-subagent": "collab_spawn",
    "x-codex-parent-thread-id": "parent-thread",
  }), true);
  assert.equal(nativeEgressRoute({ model: "gpt-5.5" }, {
    "x-codex-turn-metadata": JSON.stringify({ thread_source: "subagent", subagent_kind: "worker" }),
  }), "gateway");
  assert.equal(nativeEgressRoute({
    model: "gpt-5.5",
    client_metadata: { thread_source: "subagent" },
  }, {}), "gateway");

  const args = nativeRuntimeArgs(["--profile", "default", "app-server", "--listen", "stdio"], 43127);
  assert.deepEqual(args.slice(0, 8), [
    "--profile", "default",
    "-c", "openai_base_url=http://127.0.0.1:43127/v1",
    "-c", "features.responses_websockets=false",
    "-c", "features.responses_websockets_v2=false",
  ]);
  assert.equal(args.includes("model_provider=opencodex"), false);
  assert.equal(args[8], "app-server");
});

test("native app-server child request crosses the external bridge into the gateway", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-native-egress-"));
  const fakeNativePath = join(tempRoot, "fake-native-egress.mjs");
  const tracePath = join(tempRoot, "egress-trace.json");
  const settingsTracePath = join(tempRoot, "settings-trace.jsonl");
const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import readline from "node:readline";

const baseArg = process.argv.find((value) => value.startsWith("openai_base_url=")) || "";
const baseUrl = baseArg.slice("openai_base_url=".length);
const tracePath = process.env.FAKE_EGRESS_TRACE || "";
const settingsTracePath = process.env.FAKE_EGRESS_SETTINGS_TRACE || "";
const childDisplayThread = process.env.FAKE_EGRESS_CHILD_THREAD || "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const trace = (value) => { if (tracePath) fs.writeFileSync(tracePath, JSON.stringify(value)); };
const rl = readline.createInterface({ input: process.stdin });
const handleLine = async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/settings/update") {
    if (settingsTracePath) fs.appendFileSync(settingsTracePath, JSON.stringify(message.params) + "\\n");
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method !== "thread/start") {
    send({ id: message.id, result: {} });
    return;
  }
  const websocketFallback = await new Promise((resolve, reject) => {
    const request = http.request(new URL("responses", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGVzdA==",
        "sec-websocket-version": "13",
      },
    });
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, body: "" });
    });
    request.once("error", reject);
    request.end();
  });
  const response = await fetch(new URL("responses", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openai-subagent": "collab_spawn",
      "x-codex-parent-thread-id": "parent-thread-1",
      ...(childDisplayThread ? { "thread-id": childDisplayThread } : {}),
      ...(childDisplayThread ? { "session-id": childDisplayThread } : {}),
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "subagent", subagent_kind: "worker" }),
    },
    body: JSON.stringify({ model: "gpt-5.5", input: [], stream: true }),
  });
  trace({ argv: process.argv, websocketFallback, status: response.status, response: await response.text() });
  if (childDisplayThread) {
    send({ method: "thread/settings/updated", params: {
      threadId: childDisplayThread,
      threadSettings: { model: "gpt-5.5", modelProvider: "openai", effort: "low" },
    } });
  }
  send({ id: message.id, result: { thread: { id: "native-thread-1", model: "gpt-5.5", modelProvider: "openai" } } });
};
rl.on("line", (line) => { void handleLine(line); });
`;
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);

  const seen = [];
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, {
        "content-type": "application/json",
        "x-opencodex-subagent-model": "antigravity/gemini-3.6-flash-medium",
        "x-opencodex-subagent-reasoning-effort": "high",
        "x-opencodex-subagent-task-id": "child-thread-1",
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  const bridgePath = new URL("../dist/codex-provider-bridge.js", import.meta.url);
  const bridge = spawn(process.execPath, [fileURLToPath(bridgePath), "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_GATEWAY_PORT: String(gatewayPort),
      OPENCODEX_DATA_DIR: tempRoot,
      FAKE_EGRESS_TRACE: tracePath,
      FAKE_EGRESS_SETTINGS_TRACE: settingsTracePath,
      FAKE_EGRESS_CHILD_THREAD: "child-thread-1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 101, method: "initialize", params: {} });
    assert.deepEqual(await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`initialize timed out\\n${stderr.join("")}`)), 8000);
      const interval = setInterval(() => {
        const index = messages.findIndex((message) => message.id === 101);
        if (index < 0) return;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(messages.splice(index, 1)[0]);
      }, 5);
    }), { id: 101, result: {} });

    send({ id: 102, method: "thread/start", params: { model: "gpt-5.5" } });
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`thread/start timed out\\n${stderr.join("")}`)), 8000);
      const interval = setInterval(() => {
        const index = messages.findIndex((message) => message.id === 102);
        if (index < 0) return;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(messages.splice(index, 1)[0]);
      }, 5);
    });
    assert.equal(started.error, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/v1/responses");
    assert.equal(seen[0].headers["x-openai-subagent"], "collab_spawn");
    assert.equal(seen[0].headers["x-codex-parent-thread-id"], "parent-thread-1");
    assert.equal(seen[0].headers["thread-id"], "child-thread-1");
    assert.equal(seen[0].headers["session-id"], "child-thread-1");
    assert.equal(seen[0].body.model, "gpt-5.5");
    const childSettings = messages.find((message) => message.method === "thread/settings/updated");
    assert.equal(childSettings?.params?.threadId, "child-thread-1");
    assert.equal(childSettings?.params?.threadSettings?.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(childSettings?.params?.threadSettings?.modelProvider, "opencodex");
    assert.equal(childSettings?.params?.threadSettings?.effort, "high");
    const persistedSettings = (await readFile(settingsTracePath, "utf8"))
      .trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(persistedSettings.some((settings) => settings.threadId === "child-thread-1" && settings.effort === "high"), true);
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    assert.equal(trace.websocketFallback.status, 426);
    assert.match(trace.websocketFallback.body, /Upgrade Required|upgrade_required/);
    assert.match(trace.argv.join(" "), /openai_base_url=http:\/\/127\.0\.0\.1:\d+\/__opencodex_native_egress_[a-f0-9]+\/v1/);
    assert.match(trace.argv.join(" "), /features\.responses_websockets=false/);
    assert.equal(trace.argv.some((value) => value.includes("model_provider=opencodex")), false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await new Promise((resolve) => {
      if (bridge.exitCode !== null) resolve();
      else bridge.once("exit", resolve);
    });
    await new Promise((resolve) => gateway.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("1.1.5 managed config keeps native OpenAI as the global default", () => {
  const config = buildManagedCodexConfig(
    'model = "gpt-5.5"\n',
    8765,
    "admin-token",
    "/tmp/custom_model_catalog.json",
  );

  assert.match(config, /model_provider = "openai"/);
  assert.doesNotMatch(config, /model_provider = "opencodex"/);
  assert.doesNotMatch(config, /openai_base_url/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:8765\/v1"/);
});

test("1.1.5 uses an official canonical thread and isolated third-party turns", async () => {
  const [source, launcher] = await Promise.all([
    readFile(new URL("../src_v2/codex-provider-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /thread\/inject_items/);
  assert.match(source, /spawnRuntime/);
  assert.match(source, /OPENCODEX_PROVIDER_BRIDGE_RUNTIME/);
  assert.match(source, /ephemeral: true/);
  assert.match(source, /function beginGatewayTurn/);
  assert.match(source, /method === "thread\/list"/);
  assert.match(source, /thread\/settings\/update/);
  assert.match(source, /modelProviders/);
  assert.match(source, /method === "initialize"/);
  assert.match(source, /pendingParentInitializations/);
  assert.match(source, /lastInitializeResult/);
  assert.doesNotMatch(source, /switchProviderThenRequest/);
  assert.doesNotMatch(source, /providerResumeRequest/);
  assert.doesNotMatch(source, /activeRuntime/);
  assert.match(launcher, /CODEX_CLI_PATH: bridge/);
  assert.match(launcher, /OPENCODEX_NATIVE_CODEX_PATH/);
  assert.match(launcher, /registerProviderBridgeEnvironment/);
  assert.match(launcher, /launchctl.*setenv/);
  assert.match(launcher, /unregisterProviderBridgeEnvironment/);
  assert.match(launcher, /desktopAppServerState/);
  const stopStart = launcher.indexOf("public stop(): Promise<void>");
  assert.ok(stopStart >= 0);
  assert.doesNotMatch(launcher.slice(stopStart), /stopDesktopClients\(\)/);
});
