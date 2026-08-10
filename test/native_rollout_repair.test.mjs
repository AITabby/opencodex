import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repairNativeRollouts, syncProviderMirrorThreadsToNativeCatalog } from "../dist/server/gateway.js";

test("native rollout repair preserves unknown reasoning and keeps an atomic backup", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-rollout-repair-"));
  const previousCodexHome = process.env.OPENCODEX_CODEX_HOME;
  process.env.OPENCODEX_CODEX_HOME = codexHome;
  const rolloutPath = path.join(codexHome, "sessions", "2026", "08", "09", "rollout.jsonl");
  const gatewayReasoningId = `rs_${Date.now().toString().slice(0, 13)}_1`;
  const originalRecords = [
    { type: "session_meta", id: "session-1" },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "历史内容" }] } },
    { type: "response_item", payload: { type: "reasoning", id: "rs_foreign_reasoning", encrypted_content: "opaque" } },
    { type: "response_item", payload: { type: "reasoning", id: gatewayReasoningId, encrypted_content: null } },
    { type: "response_item", payload: { type: "function_call", id: "call/legacy" } },
  ];
  try {
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(rolloutPath, `${originalRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });

    assert.equal(repairNativeRollouts(), 1);
    const repaired = (await fs.readFile(rolloutPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(repaired.some((record) => record.payload?.id === gatewayReasoningId), false);
    assert.equal(repaired.some((record) => record.payload?.id === "rs_foreign_reasoning"), true);
    assert.equal(repaired.find((record) => record.payload?.type === "function_call")?.payload?.id, "fc_import_calllegacy");
    assert.equal(repaired.find((record) => record.payload?.type === "message")?.payload?.content?.[0]?.text, "历史内容");

    const backup = await fs.readFile(`${rolloutPath}.bak`, "utf8");
    assert.match(backup, new RegExp(gatewayReasoningId));
    assert.equal((await fs.stat(`${rolloutPath}.bak`)).mode & 0o777, 0o600);
  } finally {
    if (previousCodexHome === undefined) delete process.env.OPENCODEX_CODEX_HOME;
    else process.env.OPENCODEX_CODEX_HOME = previousCodexHome;
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("provider routes never rewrite the native rollout catalog during restart", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-provider-native-catalog-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-provider-native-routes-"));
  const previousCodexHome = process.env.OPENCODEX_CODEX_HOME;
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousNativeCli = process.env.OPENCODEX_NATIVE_CODEX_CLI_PATH;
  process.env.OPENCODEX_CODEX_HOME = codexHome;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const rolloutPath = path.join(codexHome, "archived_sessions", "rollout-2026-08-10T13-02-32-provider-thread.jsonl");
  const restoredPath = path.join(codexHome, "sessions", "2026", "08", "10", "rollout-2026-08-10T13-02-32-provider-thread.jsonl");
  const nativeCliPath = path.join(codexHome, "fake-native-codex.mjs");
  const threadId = "provider-thread";
  const oldPath = path.join(codexHome, "sessions", "2026", "08", "10", "rollout-old-provider-thread.jsonl");
  const schema = `
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      cli_version TEXT NOT NULL DEFAULT '',
      thread_source TEXT,
      model TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      history_mode TEXT NOT NULL DEFAULT 'legacy',
      recency_at INTEGER NOT NULL DEFAULT 0,
      recency_at_ms INTEGER NOT NULL DEFAULT 0
    );
  `;
  const sqlQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  try {
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(nativeCliPath, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
if (process.argv[2] === "unarchive") {
  fs.mkdirSync(${JSON.stringify(path.dirname(restoredPath))}, { recursive: true });
  fs.renameSync(${JSON.stringify(rolloutPath)}, ${JSON.stringify(restoredPath)});
}
`, { mode: 0o700 });
    await fs.chmod(nativeCliPath, 0o700);
    process.env.OPENCODEX_NATIVE_CODEX_CLI_PATH = nativeCliPath;
    await fs.writeFile(rolloutPath, [
      { type: "session_meta", payload: { id: threadId, thread_source: "user", model_provider: "openai" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第三方历史问题" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第三方历史回答" }] } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, "provider-session-routes.json"), JSON.stringify({
      version: 1,
      threads: {
        [threadId]: {
          externalId: threadId,
          nativeId: threadId,
          nativePath: oldPath,
          selectedModel: "antigravity/gemini-3.6-flash-medium",
          settings: { cwd: "/Users/test" },
        },
      },
    }));
    execFileSync("sqlite3", [dbPath, schema], { stdio: "pipe" });
    execFileSync("sqlite3", [dbPath, `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, preview, first_user_message, has_user_event, archived, archived_at, cli_version, thread_source, model, recency_at, recency_at_ms) VALUES (${sqlQuote(threadId)}, ${sqlQuote(rolloutPath)}, 100, 100, 'vscode', 'openai', '/Users/test', '第三方会话', '{}', 'on-request', '', '', 0, 1, 101, '0.147.0', 'user', 'gpt-5.5', 100, 100000);`], { stdio: "pipe" });

    assert.equal(syncProviderMirrorThreadsToNativeCatalog(), 0);
    const rows = JSON.parse(execFileSync("sqlite3", ["-json", dbPath, `SELECT rollout_path, title, preview, first_user_message, has_user_event, archived, archived_at, model_provider, model FROM threads WHERE id = ${sqlQuote(threadId)};`], { encoding: "utf8" }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rollout_path, rolloutPath);
    assert.equal(rows[0].title, "第三方会话");
    assert.equal(rows[0].preview, "");
    assert.equal(rows[0].first_user_message, "");
    assert.equal(rows[0].has_user_event, 0);
    assert.equal(rows[0].archived, 1);
    assert.equal(rows[0].archived_at, 101);
    assert.equal(rows[0].model_provider, "openai");
    assert.equal(rows[0].model, "gpt-5.5");
    assert.equal(await fs.access(restoredPath).then(() => true, () => false), false);
    assert.equal(await fs.access(rolloutPath).then(() => true, () => false), true);
    const original = (await fs.readFile(rolloutPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(original.some((record) => record.type === "event_msg"), false);

    const routes = JSON.parse(await fs.readFile(path.join(dataDir, "provider-session-routes.json"), "utf8"));
    assert.equal(routes.threads[threadId].nativePath, oldPath);
  } finally {
    if (previousCodexHome === undefined) delete process.env.OPENCODEX_CODEX_HOME;
    else process.env.OPENCODEX_CODEX_HOME = previousCodexHome;
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousNativeCli === undefined) delete process.env.OPENCODEX_NATIVE_CODEX_CLI_PATH;
    else process.env.OPENCODEX_NATIVE_CODEX_CLI_PATH = previousNativeCli;
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
