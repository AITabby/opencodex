import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatGptAccountLoginService } from "../dist/services/chatgpt_account_auth.js";
import { ChatGptAccountPool } from "../dist/services/chatgpt_account_pool.js";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("official account login uses an isolated CODEX_HOME and reports completion", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-chatgpt-account-login-"));
  const fakeNativePath = path.join(dataDir, "fake-codex");
  await fs.writeFile(fakeNativePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "login") {
  setTimeout(() => fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ access_token: "isolated-test-token" })), 80);
  setTimeout(() => process.exit(0), 150);
}
`);
  await fs.chmod(fakeNativePath, 0o755);
  const pool = new ChatGptAccountPool(dataDir);
  const account = pool.createAccount({ id: "plus-login", label: "Plus Login" });
  const login = new ChatGptAccountLoginService(pool, () => fakeNativePath);
  try {
    const started = login.start(account.id);
    assert.equal(started.status, "pending");
    assert.equal(started.account_id, account.id);

    let completed = login.status(account.id, started.flow_id);
    for (let attempt = 0; attempt < 20 && completed.status === "pending"; attempt += 1) {
      await wait(150);
      completed = login.status(account.id, started.flow_id);
    }
    assert.equal(completed.status, "completed");
    assert.equal(completed.auth_status, "ready");
    assert.equal(await fs.readFile(path.join(account.profile_dir, "auth.json"), "utf8").then((value) => value.includes("isolated-test-token")), true);
  } finally {
    login.stopAll();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
