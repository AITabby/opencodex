import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

let provider = "openai";
let model = "gpt-5.5";
let initialized = false;
const threadId = "thread-1";
const rolloutPath = "/tmp/fake-rollout-thread-1.jsonl";
const runtimeProvider = process.env.OPENCODEX_PROVIDER_BRIDGE_RUNTIME || "openai";
const traceFile = process.env.FAKE_TRACE_FILE || "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const trace = (message) => {
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify({ runtimeProvider, ...message }) + "\\n");
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const params = message.params || {};
  trace({ method: message.method, params });
  switch (message.method) {
    case "initialize":
      if (initialized) {
        send({ id: message.id, error: { code: -32600, message: "Already initialized" } });
      } else {
        initialized = true;
        send({ id: message.id, result: {} });
      }
      break;
    case "thread/list":
      send({ id: message.id, result: { data: [{ id: threadId, modelProvider: "openai" }] } });
      break;
    case "thread/unsubscribe":
      send({ id: message.id, result: {} });
      break;
    case "thread/read":
      if (params.threadId === "legacy-thirdparty") {
        send({ id: message.id, result: { thread: {
          id: "legacy-thirdparty",
          model: "antigravity/gemini-3.6-flash-medium",
          modelProvider: "opencodex",
          name: "Legacy Gemini",
          turns: [{
            id: "legacy-turn",
            items: [
              { type: "userMessage", id: "legacy-user", content: [{ type: "text", text: "legacy user", text_elements: [] }] },
              { type: "agentMessage", id: "legacy-agent", text: "legacy gemini reply" },
            ],
          }],
        } } });
      } else {
        send({ id: message.id, result: { thread: {
          id: params.threadId || threadId,
          model,
          modelProvider: provider,
          turns: [],
        } } });
      }
      break;
    case "thread/start":
      provider = params.modelProvider || provider;
      model = params.model || model;
      send({ id: message.id, result: { thread: { id: threadId, path: rolloutPath, model, modelProvider: provider } } });
      break;
    case "thread/resume":
      if (process.env.FAKE_RESUME_REQUIRES_PATH === "1" && !params.path) {
        send({ id: message.id, error: { code: -32001, message: "no rollout found for thread id " + params.threadId } });
        break;
      }
      provider = params.modelProvider || provider;
      model = params.model || model;
      send({ id: message.id, result: { thread: { id: threadId, path: rolloutPath, model, modelProvider: provider } } });
      break;
    case "thread/settings/update":
      model = params.model || model;
      send({ id: message.id, result: {} });
      send({ method: "thread/settings/updated", params: {
        threadId,
        threadSettings: { model, modelProvider: provider },
      } });
      break;
    case "turn/start": {
      const requestedModel = typeof params.model === "string" && params.model ? params.model : model;
      if (process.env.FAKE_GATEWAY_OFFLINE === "1" && provider === "opencodex") {
        send({ id: message.id, error: {
          code: -32001,
          message: "OpenCodex gateway is unavailable",
        } });
      } else if (process.env.FAKE_GATEWAY_OFFLINE_FILE && provider === "opencodex" && fs.existsSync(process.env.FAKE_GATEWAY_OFFLINE_FILE)) {
        send({ id: message.id, error: {
          code: -32001,
          message: "OpenCodex gateway is unavailable",
        } });
      } else if (provider === "openai" && requestedModel.includes("/")) {
        send({ id: message.id, error: {
          code: -32602,
          message: "The '" + requestedModel + "' model is not supported when using Codex with a ChatGPT account.",
        } });
      } else {
        send({ id: message.id, result: { thread: { id: threadId, model, modelProvider: provider } } });
        send({ method: "item/completed", params: {
          threadId,
          turnId: "turn-1",
          item: { type: "agentMessage", id: "agent-1", text: provider + " reply" },
        } });
        send({ method: "turn/completed", params: {
          threadId,
          turn: { id: "turn-1", status: "completed" },
        } });
      }
      break;
    }
    default:
      send({ id: message.id, result: {} });
  }
});
`;

function waitForResponse(messages, id, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response ${id}`)), timeoutMs);
    const check = () => {
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return;
      clearTimeout(timer);
      clearInterval(interval);
      resolve(messages.splice(index, 1)[0]);
    };
    const interval = setInterval(check, 5);
    timer.unref?.();
    interval.unref?.();
  });
}

async function waitForTraceEntries(traceFile, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = (await readFile(traceFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (predicate(entries)) return entries;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for expected fake app-server trace");
}

test("provider bridge keeps a resumed third-party thread on the gateway when turn/start omits model", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-protocol-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 1, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 1), { id: 1, result: {} });

    send({ id: 2, method: "thread/list", params: {} });
    assert.equal((await waitForResponse(messages, 2)).result.data[0].modelProvider, "openai");

    send({
      id: 3,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 3), { id: 3, result: {} });

    send({
      id: 4,
      method: "turn/start",
      params: { threadId: "thread-1", model: null, input: [] },
    });
    const turn = await waitForResponse(messages, 4);
    assert.equal(turn.error, undefined);
    assert.equal(turn.result.thread.modelProvider, "opencodex");

    send({
      id: 5,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "gpt-5.5" },
    });
    assert.deepEqual(await waitForResponse(messages, 5), { id: 5, result: {} });

    send({
      id: 6,
      method: "turn/start",
      params: { threadId: "thread-1", model: null, input: [] },
    });
    const nativeTurn = await waitForResponse(messages, 6);
    assert.equal(nativeTurn.error, undefined);
    assert.equal(nativeTurn.result.thread.id, "thread-1");
    assert.equal(nativeTurn.result.thread.modelProvider, "openai");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a new thread can begin on Gemini after native thread/start created its rollout", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-new-thread-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      FAKE_RESUME_REQUIRES_PATH: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 41, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 41), { id: 41, result: {} });

    // Desktop creates the empty conversation with its native default first.
    // Its returned rollout path is the only stable handoff to a fresh
    // third-party app-server process.
    send({ id: 42, method: "thread/start", params: { model: "gpt-5.5" } });
    const started = await waitForResponse(messages, 42);
    assert.equal(started.error, undefined);
    assert.equal(started.result.thread.id, "thread-1");
    assert.equal(started.result.thread.path, "/tmp/fake-rollout-thread-1.jsonl");

    send({
      id: 43,
      method: "thread/resume",
      params: { threadId: "thread-1", model: "gpt-5.5", modelProvider: "opencodex" },
    });
    const resumed = await waitForResponse(messages, 43);
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.thread.modelProvider, "openai");

    send({
      id: 44,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 44), { id: 44, result: {} });

    send({ id: 45, method: "turn/start", params: { threadId: "thread-1", model: null, input: [] } });
    const geminiTurn = await waitForResponse(messages, 45);
    assert.equal(geminiTurn.error, undefined);
    assert.equal(geminiTurn.result.thread.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(geminiTurn.result.thread.modelProvider, "opencodex");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("provider-only native switch escapes an unavailable gateway in the same thread", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-offline-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      FAKE_GATEWAY_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 11, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 11), { id: 11, result: {} });

    send({
      id: 12,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 12), { id: 12, result: {} });

    send({
      id: 13,
      method: "turn/start",
      params: { threadId: "thread-1", model: null, input: [] },
    });
    const unavailable = await waitForResponse(messages, 13);
    assert.equal(unavailable.error.message, "OpenCodex gateway is unavailable");

    // Desktop may report the newly selected provider without repeating the
    // model slug. It must still switch away from the stale third-party model.
    send({
      id: 14,
      method: "turn/start",
      params: { threadId: "thread-1", model: null, modelProvider: "openai", input: [] },
    });
    const nativeTurn = await waitForResponse(messages, 14);
    assert.equal(nativeTurn.error, undefined);
    assert.equal(nativeTurn.result.thread.id, "thread-1");
    assert.equal(nativeTurn.result.thread.modelProvider, "openai");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("the explicitly selected official model takes over after a failed third-party turn", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-selected-native-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({
    models: [{ slug: "gpt-5.6-sol", provider: "opencodex" }],
  }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      FAKE_GATEWAY_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 21, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 21), { id: 21, result: {} });

    send({
      id: 22,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 22), { id: 22, result: {} });

    send({
      id: 23,
      method: "turn/start",
      params: { threadId: "thread-1", model: null, input: [] },
    });
    const unavailable = await waitForResponse(messages, 23);
    assert.equal(unavailable.error.message, "OpenCodex gateway is unavailable");

    // The Desktop may retain stale gateway routing/model fields while sending
    // the newly selected official model. The explicit selection must win,
    // including when the following retry still carries the old third-party
    // model (the failure shown in the Desktop UI).
    send({
      id: 24,
      method: "thread/settings/update",
      params: {
        threadId: "thread-1",
        model: "gpt-5.6-sol",
        modelProvider: "opencodex",
      },
    });
    assert.deepEqual(await waitForResponse(messages, 24), { id: 24, result: {} });

    send({
      id: 25,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: "antigravity/gemini-3.6-flash-medium",
        modelProvider: "opencodex",
        input: [],
      },
    });
    const nativeTurn = await waitForResponse(messages, 25);
    assert.equal(nativeTurn.error, undefined);
    assert.equal(nativeTurn.result.thread.id, "thread-1");
    assert.equal(nativeTurn.result.thread.model, "gpt-5.6-sol");
    assert.equal(nativeTurn.result.thread.modelProvider, "openai");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bringing the gateway back restores third-party turns without restarting the bridge", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-recovery-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const offlineMarker = join(tempRoot, "gateway-offline");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");
  await writeFile(offlineMarker, "offline", "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      FAKE_GATEWAY_OFFLINE_FILE: offlineMarker,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 31, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 31), { id: 31, result: {} });

    send({
      id: 32,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 32), { id: 32, result: {} });

    send({
      id: 33,
      method: "turn/start",
      params: { threadId: "thread-1", model: null, input: [] },
    });
    const unavailable = await waitForResponse(messages, 33);
    assert.equal(unavailable.error.message, "OpenCodex gateway is unavailable");

    // The bridge and native app-server remain alive while the gateway comes
    // back. Removing the marker represents the gateway becoming available.
    await rm(offlineMarker);
    send({
      id: 34,
      method: "turn/start",
      params: { threadId: "thread-1", model: null, input: [] },
    });
    const recoveredTurn = await waitForResponse(messages, 34);
    assert.equal(recoveredTurn.error, undefined);
    assert.equal(recoveredTurn.result.thread.id, "thread-1");
    assert.equal(recoveredTurn.result.thread.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(recoveredTurn.result.thread.modelProvider, "opencodex");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("third-party context is mirrored into the native thread and GPT never resumes a gateway thread", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-canonical-history-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: join(tempRoot, "routes.json"),
      FAKE_TRACE_FILE: traceFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(JSON.stringify(message) + "\n");
  try {
    send({ id: 51, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 51), { id: 51, result: {} });

    send({ id: 52, method: "thread/start", params: { model: "gpt-5.5" } });
    const started = await waitForResponse(messages, 52);
    assert.equal(started.result.thread.id, "thread-1");

    send({
      id: 53,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 53), { id: 53, result: {} });

    send({
      id: 54,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: null,
        input: [{ type: "text", text: "third-party context", text_elements: [] }],
      },
    });
    const gatewayTurn = await waitForResponse(messages, 54);
    assert.equal(gatewayTurn.error, undefined);
    assert.equal(gatewayTurn.result.thread.modelProvider, "opencodex");

    const mirroredEntries = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "thread/inject_items"
      && JSON.stringify(entry.params.items).includes("opencodex reply"),
    ));
    assert.ok(mirroredEntries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "thread/inject_items"
      && JSON.stringify(entry.params.items).includes("third-party context"),
    ));

    send({
      id: 55,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "gpt-5.6-sol" },
    });
    assert.deepEqual(await waitForResponse(messages, 55), { id: 55, result: {} });

    send({ id: 56, method: "turn/start", params: { threadId: "thread-1", model: null, input: [] } });
    const nativeTurn = await waitForResponse(messages, 56);
    assert.equal(nativeTurn.error, undefined);
    assert.equal(nativeTurn.result.thread.model, "gpt-5.6-sol");
    assert.equal(nativeTurn.result.thread.modelProvider, "openai");

    const trace = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "turn/start"
      && entry.params.model === "gpt-5.6-sol",
    ));
    assert.ok(trace.some((entry) =>
      entry.runtimeProvider === "opencodex"
      && entry.method === "turn/start"
      && entry.params.model === "antigravity/gemini-3.6-flash-medium",
    ));
    assert.equal(trace.some((entry) =>
      entry.runtimeProvider === "opencodex" && entry.method === "thread/resume",
    ), false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("an old third-party session migrates locally before an official GPT turn", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-legacy-migration-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: join(tempRoot, "routes.json"),
      FAKE_TRACE_FILE: traceFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const output = readline.createInterface({ input: bridge.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try { messages.push(JSON.parse(line)); } catch {}
  });
  const send = (message) => bridge.stdin.write(JSON.stringify(message) + "\n");
  try {
    send({ id: 61, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 61), { id: 61, result: {} });

    // No thread/list call precedes this resume. The bridge must inspect the
    // local rollout and create a native canonical copy before it ever runs GPT.
    send({ id: 62, method: "thread/resume", params: { threadId: "legacy-thirdparty", model: null } });
    const resumed = await waitForResponse(messages, 62);
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.thread.id, "legacy-thirdparty");
    assert.equal(resumed.result.thread.modelProvider, "opencodex");

    send({
      id: 63,
      method: "thread/settings/update",
      params: { threadId: "legacy-thirdparty", model: "gpt-5.6-sol" },
    });
    assert.deepEqual(await waitForResponse(messages, 63), { id: 63, result: {} });
    send({ id: 64, method: "turn/start", params: { threadId: "legacy-thirdparty", model: null, input: [] } });
    const nativeTurn = await waitForResponse(messages, 64);
    assert.equal(nativeTurn.error, undefined);
    assert.equal(nativeTurn.result.thread.id, "legacy-thirdparty");
    assert.equal(nativeTurn.result.thread.modelProvider, "openai");

    const trace = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "turn/start"
      && entry.params.model === "gpt-5.6-sol",
    ));
    assert.ok(trace.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "thread/inject_items"
      && JSON.stringify(entry.params.items).includes("legacy gemini reply"),
    ));
    assert.equal(trace.some((entry) =>
      entry.runtimeProvider === "opencodex" && entry.method === "thread/resume",
    ), false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});
