import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { createServer } from "node:http";

// These cases exercise the JSON-RPC/session supervisor used by Desktop
// app-server launches. Standalone CLI invocations remain on the thin
// request-scoped Egress path; the dedicated bridge regression test covers that
// path above this protocol suite.
process.env.OPENCODEX_LEGACY_PROVIDER_BRIDGE = "1";

const fakeNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

let provider = "openai";
let model = "gpt-5.5";
let initialized = false;
const threadId = "thread-1";
const rolloutPath = "/tmp/fake-rollout-thread-1.jsonl";
let activeTurnThreadId = threadId;
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
  trace(message);
  if (!message.method && message.id === "ask-user-1") {
    send({ method: "turn/completed", params: {
      threadId: activeTurnThreadId,
      turn: { id: "turn-1", status: "completed" },
    } });
    return;
  }
  switch (message.method) {
    case "initialize":
      if (initialized) {
        send({ id: message.id, error: { code: -32600, message: "Already initialized" } });
      } else {
        initialized = true;
        send({ id: message.id, result: {} });
        const crashMarker = process.env.FAKE_EXIT_AFTER_INITIALIZE_MARKER || "";
        if (crashMarker && !fs.existsSync(crashMarker)) {
          fs.writeFileSync(crashMarker, "1", "utf8");
          setTimeout(() => process.exit(42), 10);
        }
      }
      break;
    case "thread/list":
      send({ id: message.id, result: { data: [{ id: threadId, modelProvider: "openai" }] } });
      break;
    case "thread/unsubscribe":
      send({ id: message.id, result: {} });
      break;
    case "thread/read":
      if (process.env.FAKE_UNMATERIALIZED_THREAD_HISTORY === "1" && params.includeTurns === true) {
        send({ id: message.id, error: {
          code: -32001,
          message: "thread " + params.threadId + " is not materialized yet; includeTurns is unavailable before first user message",
        } });
      } else if (params.threadId === "legacy-thirdparty") {
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
          ...(process.env.FAKE_THREAD_SETTINGS === "1"
            ? { threadSettings: { model, modelProvider: provider, effort: "medium" } }
            : {}),
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
      send({ id: message.id, result: { thread: { id: params.threadId || threadId, path: rolloutPath, model, modelProvider: provider } } });
      break;
    case "thread/settings/update":
      model = params.model || model;
      send({ id: message.id, result: {} });
      send({ method: "thread/settings/updated", params: {
        threadId: params.threadId || threadId,
        threadSettings: { model, modelProvider: provider },
      } });
      break;
    case "turn/start": {
      const requestedModel = typeof params.model === "string" && params.model ? params.model : model;
      const routedProviderModel = params.client_metadata?.opencodex_model_override || "";
      const routedThirdParty = Boolean(routedProviderModel);
      activeTurnThreadId = params.threadId || threadId;
      if (process.env.FAKE_GATEWAY_OFFLINE === "1" && (provider === "opencodex" || routedThirdParty)) {
        send({ id: message.id, error: {
          code: -32001,
          message: "OpenCodex gateway is unavailable",
        } });
      } else if (process.env.FAKE_GATEWAY_OFFLINE_FILE && (provider === "opencodex" || routedThirdParty) && fs.existsSync(process.env.FAKE_GATEWAY_OFFLINE_FILE)) {
        send({ id: message.id, error: {
          code: -32001,
          message: "OpenCodex gateway is unavailable",
        } });
      } else if (provider === "openai" && requestedModel.includes("/") && !routedThirdParty) {
        send({ id: message.id, error: {
          code: -32602,
          message: "The '" + requestedModel + "' model is not supported when using Codex with a ChatGPT account.",
        } });
      } else {
        const responseThreadId = activeTurnThreadId || threadId;
        send({ id: message.id, result: { thread: { id: responseThreadId, model, modelProvider: routedThirdParty ? "opencodex" : provider } } });
        if (process.env.FAKE_REQUEST_USER_INPUT === "1" && (provider === "opencodex" || routedThirdParty)) {
          send({ id: "ask-user-1", method: "item/tool/requestUserInput", params: {
            threadId: activeTurnThreadId,
            turnId: "turn-1",
            itemId: "question-item-1",
            questions: [{
              id: "q1",
              header: "确认",
              question: "是否继续？",
              options: [{ label: "继续", description: "继续执行" }, { label: "停止", description: "停止执行" }],
            }],
          } });
          break;
        }
        if (process.env.FAKE_EMIT_TURN_STARTED === "1") {
          send({ method: "turn/started", params: { threadId: responseThreadId, turnId: "turn-1" } });
        }
        send({ method: "item/completed", params: {
          threadId: responseThreadId,
          turnId: "turn-1",
          item: { type: "agentMessage", id: "agent-1", text: (routedThirdParty ? "opencodex" : provider) + " reply" },
        } });
        send({ method: "turn/completed", params: {
          threadId: responseThreadId,
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

const restartableNativeSource = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const threadId = "restartable-thirdparty";
const stateFile = process.env.FAKE_THREAD_STATE_FILE;
const traceFile = process.env.FAKE_TRACE_FILE || "";
let initialized = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const trace = (message) => {
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(message) + "\\n");
};
const readThread = () => {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; }
};
const writeThread = (thread) => fs.writeFileSync(stateFile, JSON.stringify(thread), "utf8");
const isArchived = () => process.env.FAKE_ARCHIVED_THREAD === "1"
  && !fs.existsSync(process.env.FAKE_UNARCHIVE_MARKER || stateFile + ".unarchived");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const params = message.params || {};
  trace(message);
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
      // The regression target: the native list is empty after a process
      // restart even though the durable mirror can still be read.
      send({ id: message.id, result: { data: [] } });
      break;
    case "thread/read": {
      const thread = readThread();
      if (thread && params.threadId === thread.id) {
        if (isArchived()) {
          send({ id: message.id, error: {
            code: -32001,
            message: "session " + params.threadId + " is archived. Run codex unarchive " + params.threadId + " to unarchive it first.",
          } });
        } else {
          send({ id: message.id, result: { thread } });
        }
      } else {
        send({ id: message.id, error: { code: -32001, message: "thread not found" } });
      }
      break;
    }
    case "thread/unarchive": {
      const thread = readThread();
      if (thread && params.threadId === thread.id) {
        const activePath = process.env.FAKE_ACTIVE_ROLLOUT_PATH || thread.path;
        const restored = { ...thread, path: activePath };
        writeThread(restored);
        fs.writeFileSync(process.env.FAKE_UNARCHIVE_MARKER || stateFile + ".unarchived", "1", "utf8");
        send({ id: message.id, result: { thread: restored } });
      } else {
        send({ id: message.id, error: { code: -32001, message: "thread not found" } });
      }
      break;
    }
    case "thread/resume": {
      const thread = readThread();
      if (thread && params.threadId === thread.id) {
        if (isArchived()) {
          send({ id: message.id, error: {
            code: -32001,
            message: "session " + params.threadId + " is archived. Run codex unarchive " + params.threadId + " to unarchive it first.",
          } });
        } else {
          send({ id: message.id, result: { thread } });
        }
      } else {
        send({ id: message.id, error: { code: -32001, message: "thread not found" } });
      }
      break;
    }
    case "thread/start": {
      const thread = {
        id: threadId,
        path: stateFile + ".jsonl",
        cwd: "/tmp/opencodex-restart-test",
        name: "Third-party restart test",
        model: params.model || "gpt-5.5",
        modelProvider: params.modelProvider || "openai",
      };
      if (params.ephemeral !== true) writeThread(thread);
      send({ id: message.id, result: { thread } });
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

function waitForNotification(messages, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for notification")), timeoutMs);
    const check = () => {
      const index = messages.findIndex((message) => message.id === undefined && predicate(message));
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

test("native parent receives durable third-party child lifecycle events from the gateway bridge", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-subagent-events-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");

  const gatewayEvents = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer bridge-test-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    const after = Number(requestUrl.searchParams.get("after") || 0);
    const createdAt = new Date().toISOString();
    const events = [
      {
        seq: 1,
        type: "started",
        task_id: "child-gemini",
        parent_task_id: "thread-1",
        parent_turn_id: "turn-1",
        created_at: createdAt,
        task: {
          id: "child-gemini",
          parent_task_id: "thread-1",
          parent_turn_id: "turn-1",
          source: "native-spawn-agent",
          model: "antigravity/gemini-3.6-flash-medium",
          status: "running",
          prompt: "分析第三方子任务",
        },
      },
      {
        seq: 2,
        type: "completed",
        task_id: "child-gemini",
        parent_task_id: "thread-1",
        parent_turn_id: "turn-1",
        created_at: createdAt,
        task: {
          id: "child-gemini",
          parent_task_id: "thread-1",
          parent_turn_id: "turn-1",
          source: "native-spawn-agent",
          model: "antigravity/gemini-3.6-flash-medium",
          status: "completed",
          prompt: "分析第三方子任务",
          output: "MiniMax 已完成分析：把任务拆小可以降低复杂度。",
        },
      },
    ].filter((event) => event.seq > after);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events, next_cursor: 2 }));
  });
  await new Promise((resolve) => gatewayEvents.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gatewayEvents.address().port;

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
      OPENCODEX_GATEWAY_PORT: String(gatewayPort),
      OPENCODEX_ADMIN_TOKEN: "bridge-test-token",
      FAKE_EMIT_TURN_STARTED: "1",
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
    send({ id: 101, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 101), { id: 101, result: {} });
    send({ id: 102, method: "thread/start", params: { model: "gpt-5.5" } });
    assert.equal((await waitForResponse(messages, 102)).result.thread.id, "thread-1");
    send({ id: 103, method: "turn/start", params: { threadId: "thread-1", model: "gpt-5.5", input: [] } });
    assert.equal((await waitForResponse(messages, 103)).error, undefined);

    const started = await waitForNotification(messages, (message) => message.method === "item/started");
    assert.equal(started.params.threadId, "thread-1");
    assert.equal(started.params.item.type, "collabAgentToolCall");
    assert.equal(started.params.item.tool, "spawnAgent");
    assert.equal(started.params.item.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(started.params.item.status, "inProgress");
    assert.deepEqual(started.params.item.receiverThreadIds, ["child-gemini"]);

    const completed = await waitForNotification(messages, (message) =>
      message.method === "item/completed" && message.params?.item?.type === "collabAgentToolCall"
    );
    assert.equal(completed.params.threadId, "thread-1");
    assert.equal(completed.params.item.id, started.params.item.id);
    assert.equal(completed.params.item.status, "completed");
    assert.equal(completed.params.item.agentsStates["child-gemini"].status, "completed");
    assert.equal(completed.params.item.agentsStates["child-gemini"].message, "MiniMax 已完成分析：把任务拆小可以降低复杂度。");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await new Promise((resolve) => gatewayEvents.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("provider bridge keeps a resumed third-party thread on the native app-server when turn/start omits model", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-protocol-"));
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
      OPENCODEX_DATA_DIR: tempRoot,
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
      params: {
        threadId: "thread-1",
        model: null,
        collaborationMode: {
          mode: "default",
          settings: { model: "antigravity/gemini-3.6-flash-medium" },
        },
        responsesapiClientMetadata: { workspace_kind: "local" },
        input: [],
      },
    });
    const turn = await waitForResponse(messages, 4);
    assert.equal(turn.error, undefined);
    assert.equal(turn.result.thread.modelProvider, "opencodex");
    const traceAfterProviderTurn = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "turn/start"
      && entry.params?.client_metadata?.opencodex_model_override === "antigravity/gemini-3.6-flash-medium",
    ));
    assert.equal(traceAfterProviderTurn.some((entry) => entry.runtimeProvider === "opencodex"), false);
    const nativeProviderTurn = traceAfterProviderTurn.find((entry) =>
      entry.runtimeProvider === "openai" && entry.method === "turn/start"
    );
    assert.equal(nativeProviderTurn.params.collaborationMode, undefined);
    assert.equal(nativeProviderTurn.params.responsesapiClientMetadata, undefined);

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
    assert.equal((await readFile(traceFile, "utf8")).includes('"runtimeProvider":"opencodex"'), false);

    // A fresh Desktop turn can carry the picker selection only in
    // collaborationMode.settings.model. It must override the native route
    // model instead of silently spending the GPT quota.
    send({
      id: 7,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: null,
        collaborationMode: {
          mode: "default",
          settings: { model: "antigravity/gemini-3.6-flash-medium" },
        },
        input: [],
      },
    });
    const nestedProviderTurn = await waitForResponse(messages, 7);
    assert.equal(nestedProviderTurn.error, undefined);
    assert.equal(nestedProviderTurn.result.thread.modelProvider, "opencodex");
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

test("a fresh native thread with no materialized history can start a third-party turn", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-unmaterialized-"));
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
      FAKE_UNMATERIALIZED_THREAD_HISTORY: "1",
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

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 61, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 61), { id: 61, result: {} });

    send({ id: 62, method: "thread/start", params: { model: "gpt-5.5" } });
    assert.equal((await waitForResponse(messages, 62)).error, undefined);

    send({
      id: 63,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 63), { id: 63, result: {} });

    send({
      id: 64,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: null,
        input: [{ type: "text", text: "first materializing user message", text_elements: [] }],
      },
    });
    const turn = await waitForResponse(messages, 64);
    assert.equal(turn.error, undefined);
    assert.equal(turn.result.thread.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(turn.result.thread.modelProvider, "opencodex");

    const trace = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "turn/start"
      && entry.params?.client_metadata?.opencodex_model_override === "antigravity/gemini-3.6-flash-medium"
      && JSON.stringify(entry.params?.input || []).includes("first materializing user message"),
    ));
    assert.equal(trace.some((entry) => entry.method === "thread/inject_items"), false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a third-party subagent thread keeps its native turn lifecycle", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-subagent-thread-"));
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

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 71, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 71), { id: 71, result: {} });

    send({
      id: 72,
      method: "thread/start",
      params: { model: "minimax/MiniMax-M3", threadSource: "subagent", subagent_origin: "gpt-live" },
    });
    const started = await waitForResponse(messages, 72);
    assert.equal(started.error, undefined);

    send({ id: 73, method: "turn/start", params: { threadId: "thread-1", model: null, input: [] } });
    const completed = await waitForResponse(messages, 73);
    assert.equal(completed.error, undefined);
    assert.equal(completed.result.thread.id, "thread-1");
    assert.equal(completed.result.thread.model, "minimax/MiniMax-M3");

    const trace = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "turn/start"
      && entry.params?.client_metadata?.["x-openai-subagent"] === "1",
    ));
    const nativeTurn = trace.find((entry) => entry.runtimeProvider === "openai" && entry.method === "turn/start");
    assert.equal(typeof nativeTurn.params.model, "string");
    assert.equal(nativeTurn.params.model.includes("/"), false);
    assert.equal(nativeTurn.params.client_metadata.model_override, "minimax/MiniMax-M3");
    assert.equal(nativeTurn.params.client_metadata.subagent_origin, "gpt-live");
    assert.equal(trace.some((entry) => entry.runtimeProvider === "opencodex" && entry.method === "turn/start"), false);
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

test("a third-party image attachment keeps native Codex semantics and remains isolated", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-image-isolation-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
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
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
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
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 41, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 41), { id: 41, result: {} });
    send({
      id: 40,
      method: "config/batchWrite",
      params: {
        edits: [
          { keyPath: "openai_base_url", value: "http://stale-desktop-config/v1" },
          { keyPath: "model", value: "antigravity/gemini-3.6-flash-medium", mergeStrategy: "upsert" },
          { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
        ],
      },
    });
    assert.deepEqual(await waitForResponse(messages, 40), { id: 40, result: {} });

    send({ id: 42, method: "thread/start", params: { model: "gpt-5.5" } });
    assert.equal((await waitForResponse(messages, 42)).error, undefined);
    send({
      id: 43,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "antigravity/gemini-3.6-flash-medium" },
    });
    assert.deepEqual(await waitForResponse(messages, 43), { id: 43, result: {} });

    send({
      id: 44,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: null,
        input: [{ type: "text", text: "[Image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==]" }],
      },
    });
    const completed = await waitForResponse(messages, 44);
    assert.equal(completed.error, undefined);

    // The same structured image must stay on the one native app-server
    // request and cross the gateway at Egress. It must never be flattened
    // back into a giant ordinary text prompt.
    await new Promise((resolve) => setTimeout(resolve, 50));
    let trace = [];
    try {
      trace = (await readFile(traceFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {}
    const nativeTurn = trace.find((entry) => entry.runtimeProvider === "openai" && entry.method === "turn/start"
      && JSON.stringify(entry.params?.input || []).includes("iVBORw0KGgo"));
    assert.equal(nativeTurn?.params?.input?.some((item) => item.type === "image" && item.url === "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="), true);
    assert.equal(nativeTurn?.params?.model, "antigravity/gemini-3.6-flash-medium");
    assert.equal(nativeTurn?.params?.modelProvider, "opencodex");
    assert.equal(nativeTurn?.params?.client_metadata?.opencodex_model_override, "antigravity/gemini-3.6-flash-medium");
    const modelConfigWrite = trace.find((entry) => entry.method === "config/batchWrite");
    assert.deepEqual(modelConfigWrite?.params?.edits, [
      { keyPath: "model", value: "antigravity/gemini-3.6-flash-medium", mergeStrategy: "upsert" },
      { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
    ]);
    assert.equal(modelConfigWrite?.params?.reloadUserConfig, false);
    assert.equal(trace.some((entry) => entry.method === "thread/inject_items"), false);
    assert.equal(trace.some((entry) => entry.runtimeProvider === "opencodex"), false);

    // A normal third-party turn immediately afterwards must still use the
    // same logical conversation, and switching back to native GPT must not be
    // affected by the image turn.

    send({
      id: 45,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: null,
        input: [{ type: "text", text: "图片失败后继续普通文本" }],
      },
    });
    assert.equal((await waitForResponse(messages, 45)).error, undefined);

    // Switching back to the native lane is the stronger isolation check: the
    // shared native child must still answer after the rejected attachment.
    send({
      id: 46,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "gpt-5.6-sol" },
    });
    assert.deepEqual(await waitForResponse(messages, 46), { id: 46, result: {} });
    send({ id: 47, method: "turn/start", params: { threadId: "thread-1", model: null, input: [] } });
    assert.equal((await waitForResponse(messages, 47)).error, undefined);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("third-party context stays in the native thread and GPT can continue it", async () => {
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

    const nativeEntries = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.method === "turn/start"
      && entry.params?.client_metadata?.opencodex_model_override === "antigravity/gemini-3.6-flash-medium",
    ));
    assert.equal(nativeEntries.some((entry) => entry.method === "thread/inject_items"), false);
    assert.equal(nativeEntries.some((entry) => entry.runtimeProvider === "opencodex"), false);

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
    assert.equal(trace.some((entry) => entry.runtimeProvider === "opencodex"), false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("third-party requestUserInput answers stay on the originating native runtime", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-server-request-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
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
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
      FAKE_REQUEST_USER_INPUT: "1",
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

  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 81, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 81), { id: 81, result: {} });

    send({ id: 82, method: "thread/start", params: { model: "gpt-5.5" } });
    assert.equal((await waitForResponse(messages, 82)).error, undefined);

    send({
      id: 83,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "opencode/deepseek-chat" },
    });
    assert.deepEqual(await waitForResponse(messages, 83), { id: 83, result: {} });

    send({
      id: 84,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        model: null,
        input: [{ type: "text", text: "请先询问我", text_elements: [] }],
      },
    });
    assert.equal((await waitForResponse(messages, 84)).error, undefined);

    const request = await waitForResponse(messages, "ask-user-1");
    assert.equal(request.method, "item/tool/requestUserInput");
    assert.equal(request.params.threadId, "thread-1");
    assert.equal(request.params.questions[0].id, "q1");

    send({
      id: request.id,
      result: { answers: { q1: { answers: ["继续"] } } },
    });
    const trace = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.runtimeProvider === "openai"
      && entry.id === "ask-user-1"
      && entry.result?.answers?.q1?.answers?.[0] === "继续",
    ));
    const answer = trace.find((entry) =>
      entry.runtimeProvider === "openai"
      && entry.id === "ask-user-1"
      && entry.result?.answers,
    );
    assert.ok(answer);
    assert.equal(answer.method, undefined);
    assert.equal(Object.hasOwn(answer, "params"), false);
    assert.equal(trace.some((entry) => entry.runtimeProvider === "opencodex" && entry.id === "ask-user-1"), false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("an old third-party session binds to its existing local thread before an official GPT turn", async () => {
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
    // local rollout and bind the provider selection to that same thread.
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
    assert.equal(trace.some((entry) => entry.method === "thread/inject_items"), false);
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

test("third-party sessions remain visible after the bridge restarts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-restart-list-"));
  const fakeNativePath = join(tempRoot, "restartable-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
  const stateFile = join(tempRoot, "native-thread.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  const unarchiveMarker = join(tempRoot, "list-unarchived.marker");
  await writeFile(fakeNativePath, restartableNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const environment = {
    ...process.env,
    CODEX_CLI_PATH: "",
    OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
    OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
    OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
    FAKE_THREAD_STATE_FILE: stateFile,
    FAKE_TRACE_FILE: traceFile,
    FAKE_ARCHIVED_THREAD: "1",
    FAKE_UNARCHIVE_MARKER: unarchiveMarker,
  };
  const launch = () => {
    const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages = [];
    const output = readline.createInterface({ input: bridge.stdout });
    output.on("line", (line) => {
      if (!line.trim()) return;
      try { messages.push(JSON.parse(line)); } catch {}
    });
    return {
      bridge,
      messages,
      output,
      send: (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`),
    };
  };

  let first;
  let second;
  try {
    first = launch();
    first.send({ id: 701, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(first.messages, 701), { id: 701, result: {} });
    first.send({
      id: 702,
      method: "thread/start",
      params: {
        model: "antigravity/gemini-3.6-flash-medium",
        // Desktop may mark provider-owned starts ephemeral. The bridge keeps
        // the same local native rollout durable.
        ephemeral: true,
      },
    });
    const started = await waitForResponse(first.messages, 702);
    assert.equal(started.error, undefined);
    assert.equal(started.result.thread.id, "restartable-thirdparty");
    assert.equal(started.result.thread.model, "antigravity/gemini-3.6-flash-medium");

    const startTrace = await waitForTraceEntries(traceFile, (entries) => entries.some((entry) =>
      entry.method === "thread/start"
      && entry.params?.ephemeral === false,
    ));
    assert.ok(startTrace.some((entry) =>
      entry.method === "thread/start"
      && entry.params?.ephemeral === false,
    ));

    first.send({ id: 703, method: "thread/list", params: {} });
    const firstList = await waitForResponse(first.messages, 703);
    assert.ok(firstList.result.data.some((entry) =>
      entry.id === "restartable-thirdparty"
      && entry.model === "antigravity/gemini-3.6-flash-medium",
    ));
    assert.equal(firstList.result.data.every((entry) => Array.isArray(entry.turns)), true);

    first.send({ id: 7031, method: "thread/list", params: { sectionId: "pinned-section" } });
    const sectionList = await waitForResponse(first.messages, 7031);
    assert.equal(sectionList.result.data.some((entry) => entry.id === "restartable-thirdparty"), false);

    first.output.close();
    first.bridge.kill("SIGTERM");
    await once(first.bridge, "exit").catch(() => {});

    second = launch();
    second.send({ id: 704, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(second.messages, 704), { id: 704, result: {} });
    second.send({ id: 705, method: "thread/list", params: {} });
    const restartedList = await waitForResponse(second.messages, 705);
    assert.ok(restartedList.result.data.some((entry) =>
      entry.id === "restartable-thirdparty"
      && entry.model === "antigravity/gemini-3.6-flash-medium",
    ));
    assert.equal(restartedList.result.data.every((entry) => Array.isArray(entry.turns)), true);

    const movedPath = join(tempRoot, "archived-rollout.jsonl");
    await writeFile(movedPath, "durable rollout\n", "utf8");
    const movedThread = JSON.parse(await readFile(stateFile, "utf8"));
    movedThread.path = movedPath;
    await writeFile(stateFile, JSON.stringify(movedThread), "utf8");

    second.send({ id: 706, method: "thread/read", params: { threadId: "restartable-thirdparty" } });
    const read = await waitForResponse(second.messages, 706);
    assert.equal(read.error, undefined);
    assert.equal(read.result.thread.path, movedPath);

    second.send({ id: 707, method: "thread/resume", params: { threadId: "restartable-thirdparty", model: "gpt-5.5" } });
    const resumed = await waitForResponse(second.messages, 707);
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.thread.id, "restartable-thirdparty");
    const trace = (await readFile(traceFile, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const resume = trace.find((entry) => entry.method === "thread/resume");
    assert.equal(resume.params.path, movedPath);
    const savedRoutes = JSON.parse(await readFile(routePath, "utf8"));
    assert.equal(savedRoutes.threads["restartable-thirdparty"].nativePath, movedPath);
  } finally {
    for (const instance of [first, second]) {
      if (!instance) continue;
      instance.output.close();
      if (instance.bridge.exitCode === null && instance.bridge.signalCode === null) {
        instance.bridge.kill("SIGTERM");
        await once(instance.bridge, "exit").catch(() => {});
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a crashed native runtime is replaced without terminating the bridge transport", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-supervisor-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  const crashMarker = join(tempRoot, "crashed-once.marker");
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
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
      FAKE_TRACE_FILE: traceFile,
      FAKE_EXIT_AFTER_INITIALIZE_MARKER: crashMarker,
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
    send({ id: 780, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 780), { id: 780, result: {} });

    const trace = await waitForTraceEntries(traceFile, (entries) =>
      entries.filter((entry) => entry.method === "initialize").length >= 2,
    );
    assert.ok(trace.filter((entry) => entry.method === "initialize").length >= 2);
    assert.equal(bridge.exitCode, null);
    assert.equal(bridge.signalCode, null);

    send({ id: 781, method: "thread/list", params: {} });
    const listed = await waitForResponse(messages, 781);
    assert.equal(listed.error, undefined);
    assert.ok(Array.isArray(listed.result?.data));
  } finally {
    output.close();
    if (bridge.exitCode === null && bridge.signalCode === null) {
      bridge.kill("SIGTERM");
      await once(bridge, "exit").catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("an archived provider route is restored before the bridge resumes it", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-unarchive-"));
  const fakeNativePath = join(tempRoot, "restartable-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
  const stateFile = join(tempRoot, "native-thread.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  const markerFile = join(tempRoot, "unarchived.marker");
  const externalId = "restartable-thirdparty";
  const archivedPath = join(tempRoot, "archived_sessions", "rollout-restartable-thirdparty.jsonl");
  const activePath = join(tempRoot, "sessions", "2026", "08", "10", "rollout-restartable-thirdparty.jsonl");
  const selectedProviderModel = "antigravity/gemini-3.6-flash-medium";
  await writeFile(fakeNativePath, restartableNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");
  await writeFile(stateFile, JSON.stringify({
    id: externalId,
    path: archivedPath,
    name: "Archived provider route",
    model: "gpt-5.5",
    modelProvider: "openai",
  }), "utf8");
  await writeFile(routePath, JSON.stringify({
    version: 1,
    threads: {
      [externalId]: {
        externalId,
        nativeId: externalId,
        nativePath: archivedPath,
        selectedModel: selectedProviderModel,
        archived: true,
      },
    },
  }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
      FAKE_THREAD_STATE_FILE: stateFile,
      FAKE_TRACE_FILE: traceFile,
      FAKE_ARCHIVED_THREAD: "1",
      FAKE_UNARCHIVE_MARKER: markerFile,
      FAKE_ACTIVE_ROLLOUT_PATH: activePath,
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
    send({ id: 750, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 750), { id: 750, result: {} });

    send({
      id: 751,
      method: "thread/resume",
      params: {
        threadId: externalId,
        model: "opencode/newly-added-model",
        modelProvider: "opencodex",
      },
    });
    const resumed = await waitForResponse(messages, 751);
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.thread.model, selectedProviderModel);
    assert.equal(resumed.result.thread.modelProvider, "opencodex");
    assert.equal(await readFile(markerFile, "utf8"), "1");

    const trace = (await readFile(traceFile, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const resumeEntries = trace.filter((entry) => entry.method === "thread/resume");
    const unarchiveIndex = trace.findIndex((entry) => entry.method === "thread/unarchive");
    const readIndex = trace.reduce((last, entry, index) => entry.method === "thread/read" ? index : last, -1);
    assert.equal(resumeEntries.length, 2);
    assert.ok(unarchiveIndex > 0);
    assert.ok(readIndex > unarchiveIndex);
    assert.ok(trace.indexOf(resumeEntries[1]) > readIndex);
    assert.equal(resumeEntries[0].params.path, archivedPath);
    assert.equal(resumeEntries[0].params.model, "gpt-5.5");
    assert.equal(resumeEntries[0].params.modelProvider, "opencodex");
    assert.equal(resumeEntries[1].params.path, activePath);

    const savedRoutes = JSON.parse(await readFile(routePath, "utf8"));
    assert.equal(savedRoutes.threads[externalId].nativePath, activePath);
    assert.equal(savedRoutes.threads[externalId].archived, false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("opening a thread with the current provider picker does not rebind its persisted model", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-route-isolation-"));
  const fakeNativePath = join(tempRoot, "restartable-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
  const stateFile = join(tempRoot, "native-thread.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  const externalId = "restartable-thirdparty";
  const selectedProviderModel = "antigravity/gemini-3.6-flash-medium";
  const currentPickerModel = "opencode/newly-added-model";
  await writeFile(fakeNativePath, restartableNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");
  await writeFile(stateFile, JSON.stringify({
    id: externalId,
    path: stateFile + ".jsonl",
    name: "Third-party route isolation",
    model: "gpt-5.5",
    modelProvider: "openai",
  }), "utf8");
  await writeFile(routePath, JSON.stringify({
    version: 1,
    threads: {
      [externalId]: {
        externalId,
        nativeId: externalId,
        nativePath: stateFile + ".jsonl",
        selectedModel: selectedProviderModel,
      },
    },
  }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
      FAKE_THREAD_STATE_FILE: stateFile,
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
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 801, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 801), { id: 801, result: {} });

    // The picker carries the newly added model while Desktop opens an older
    // third-party session. Reading the session must keep its own model.
    send({
      id: 802,
      method: "thread/read",
      params: {
        threadId: externalId,
        model: currentPickerModel,
        modelProvider: "opencodex",
      },
    });
    const read = await waitForResponse(messages, 802);
    assert.equal(read.error, undefined);
    assert.equal(read.result.thread.model, selectedProviderModel);
    assert.equal(read.result.thread.modelProvider, "opencodex");

    send({
      id: 803,
      method: "thread/resume",
      params: {
        threadId: externalId,
        model: currentPickerModel,
        modelProvider: "opencodex",
      },
    });
    const resumed = await waitForResponse(messages, 803);
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.thread.model, selectedProviderModel);
    assert.equal(resumed.result.thread.modelProvider, "opencodex");

    const trace = (await readFile(traceFile, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const nativeReads = trace.filter((entry) => entry.method === "thread/read" && entry.params.includeTurns !== false);
    const nativeResumes = trace.filter((entry) => entry.method === "thread/resume");
    assert.ok(nativeReads.length > 0);
    assert.ok(nativeResumes.length > 0);
    assert.equal(nativeReads.at(-1).params.model, "gpt-5.5");
    assert.equal(nativeReads.at(-1).params.modelProvider, "openai");
    assert.equal(nativeResumes.at(-1).params.model, "gpt-5.5");
    assert.equal(nativeResumes.at(-1).params.modelProvider, "opencodex");

    const savedRoutes = JSON.parse(await readFile(routePath, "utf8"));
    assert.equal(savedRoutes.threads[externalId].selectedModel, selectedProviderModel);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("third-party reasoning effort survives settings updates and native reads", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-reasoning-settings-"));
  const fakeNativePath = join(tempRoot, "fake-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  const selectedProviderModel = "antigravity/gemini-3.6-flash-medium";
  await writeFile(fakeNativePath, fakeNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");
  await writeFile(routePath, JSON.stringify({ version: 1, threads: {} }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
      FAKE_THREAD_SETTINGS: "1",
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
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 901, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 901), { id: 901, result: {} });

    send({ id: 902, method: "thread/start", params: { model: "gpt-5.5" } });
    assert.equal((await waitForResponse(messages, 902)).error, undefined);
    send({
      id: 903,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: selectedProviderModel, effort: "high" },
    });
    assert.deepEqual(await waitForResponse(messages, 903), { id: 903, result: {} });
    send({ id: 904, method: "thread/read", params: { threadId: "thread-1" } });
    const read = await waitForResponse(messages, 904);
    assert.equal(read.error, undefined);
    assert.equal(read.result.thread.model, selectedProviderModel);
    assert.equal(read.result.thread.modelProvider, "opencodex");
    assert.equal(read.result.thread.threadSettings.effort, "high");

    const savedRoutes = JSON.parse(await readFile(routePath, "utf8"));
    assert.equal(savedRoutes.threads["thread-1"].settings.effort, "high");
    assert.equal(savedRoutes.threads["thread-1"].settings.config.model_reasoning_effort, "high");
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("opening an unregistered native thread does not infer a provider from the picker", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-provider-bridge-native-discovery-"));
  const fakeNativePath = join(tempRoot, "restartable-native-app-server.mjs");
  const emptyCatalogPath = join(tempRoot, "empty-catalog.json");
  const routePath = join(tempRoot, "routes.json");
  const stateFile = join(tempRoot, "native-thread.json");
  const traceFile = join(tempRoot, "trace.jsonl");
  const externalId = "restartable-thirdparty";
  const currentPickerModel = "opencode/newly-added-model";
  await writeFile(fakeNativePath, restartableNativeSource, "utf8");
  await chmod(fakeNativePath, 0o755);
  await writeFile(emptyCatalogPath, JSON.stringify({ models: [] }), "utf8");
  await writeFile(stateFile, JSON.stringify({
    id: externalId,
    path: stateFile + ".jsonl",
    name: "Native discovery route",
    model: "gpt-5.5",
    modelProvider: "openai",
  }), "utf8");
  await writeFile(routePath, JSON.stringify({ version: 1, threads: {} }), "utf8");

  const bridgePath = fileURLToPath(new URL("../dist/codex-provider-bridge.js", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath, "app-server"], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: "",
      OPENCODEX_NATIVE_CODEX_PATH: fakeNativePath,
      OPENCODEX_MODEL_CATALOG_PATH: emptyCatalogPath,
      OPENCODEX_PROVIDER_SESSION_MAP_PATH: routePath,
      FAKE_THREAD_STATE_FILE: stateFile,
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
  const send = (message) => bridge.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 811, method: "initialize", params: {} });
    assert.deepEqual(await waitForResponse(messages, 811), { id: 811, result: {} });
    send({
      id: 812,
      method: "thread/read",
      params: {
        threadId: externalId,
        model: currentPickerModel,
        modelProvider: "opencodex",
      },
    });
    const read = await waitForResponse(messages, 812);
    assert.equal(read.error, undefined);
    assert.equal(read.result.thread.model, "gpt-5.5");
    assert.equal(read.result.thread.modelProvider, "openai");

    const savedRoutes = JSON.parse(await readFile(routePath, "utf8"));
    assert.equal(savedRoutes.threads[externalId].selectedModel, "gpt-5.5");
    const trace = (await readFile(traceFile, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(trace.some((entry) => entry.method === "thread/start"), false);
    assert.equal(trace.some((entry) => entry.method === "thread/read" && entry.params.model === currentPickerModel), false);
  } finally {
    output.close();
    bridge.kill("SIGTERM");
    await once(bridge, "exit").catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});
