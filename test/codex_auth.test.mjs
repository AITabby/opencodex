import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyCodexChatGptAuthHeaders,
  readCodexChatGptAuth
} from "../dist/services/codex_auth.js";

test("native Codex proxy replaces the local gateway token", () => {
  const headers = applyCodexChatGptAuthHeaders(
    { authorization: "Bearer local-admin-token", "content-type": "application/json" },
    { accessToken: "chatgpt-access-token", accountId: "account-1" }
  );
  assert.equal(headers.authorization, "Bearer chatgpt-access-token");
  assert.equal(headers["chatgpt-account-id"], "account-1");
  assert.equal(headers["content-type"], "application/json");
});

test("Codex ChatGPT auth is loaded without exposing unrelated auth fields", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-auth-test-"));
  const authPath = path.join(directory, "auth.json");
  try {
    await fs.writeFile(authPath, JSON.stringify({
      OPENAI_API_KEY: "unrelated",
      tokens: {
        access_token: "access-token",
        account_id: "account-id",
        refresh_token: "refresh-token"
      }
    }));
    assert.deepEqual(readCodexChatGptAuth(authPath), {
      accessToken: "access-token",
      accountId: "account-id"
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
