import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatGptAccountPool } from "../dist/services/chatgpt_account_pool.js";

test("official account rotation is opt-in and disabled by default", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-chatgpt-account-rotation-default-"));
  try {
    const pool = new ChatGptAccountPool(dataDir);
    assert.equal(pool.getSettings().rotation_enabled, false);
    assert.equal(pool.rotationEnabled(), false);
    pool.saveSettings({ mode: "round_robin" });
    assert.equal(pool.getSettings().rotation_enabled, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("ChatGPT account pool keeps metadata separate from isolated auth profiles", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-chatgpt-account-pool-"));
  try {
    const pool = new ChatGptAccountPool(dataDir);
    const first = pool.createAccount({ id: "plus-a", label: "Plus A" });
    const second = pool.createAccount({ id: "plus-b", label: "Plus B" });

    assert.equal(first.auth_status, "missing");
    assert.equal(second.auth_status, "missing");
    assert.equal(await fs.stat(first.profile_dir).then((stat) => stat.isDirectory()), true);
    assert.equal(await fs.readFile(path.join(first.profile_dir, "config.toml"), "utf8"), "cli_auth_credentials_store = \"file\"\n");

    await fs.writeFile(path.join(first.profile_dir, "auth.json"), JSON.stringify({ access_token: "secret-test-token" }));
    assert.equal(pool.listAccounts().find((account) => account.id === "plus-a")?.auth_status, "ready");

    const metadata = await fs.readFile(path.join(dataDir, "chatgpt_accounts.json"), "utf8");
    assert.doesNotMatch(metadata, /secret-test-token/);
    assert.match(metadata, /plus-a/);

    pool.saveSettings({ rotation_enabled: true, mode: "round_robin" });
    const selectedFirst = pool.selectForInvocation();
    assert.equal(selectedFirst?.id, "plus-a");

    await fs.writeFile(path.join(second.profile_dir, "auth.json"), JSON.stringify({ access_token: "another-secret" }));
    const selectedSecond = pool.selectForInvocation();
    // With no official snapshot yet, ready accounts receive one conservative
    // base slot each and the persisted cursor advances deterministically.
    assert.equal(selectedSecond?.id, "plus-b");
    assert.equal(pool.selectNextAvailable("plus-a")?.id, "plus-b");

    pool.markFailure("plus-b", "temporary upstream failure");
    assert.equal(pool.listAccounts().find((account) => account.id === "plus-b")?.auth_status, "cooldown");
    assert.equal(pool.selectForInvocation()?.id, "plus-a");

    pool.markAuthFailure("plus-a", "Bearer leaked-test-token");
    const reauth = pool.listAccounts().find((account) => account.id === "plus-a");
    assert.equal(reauth?.auth_status, "reauth_required");
    assert.doesNotMatch(JSON.stringify(reauth), /leaked-test-token/);

    const removed = pool.removeAccount("plus-a");
    assert.equal(removed?.preserved_profile, true);
    assert.equal(await fs.stat(first.profile_dir).then((stat) => stat.isDirectory()), true);
    assert.equal(pool.listAccounts().some((account) => account.id === "plus-a"), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("ChatGPT account pool uses official remaining quota as weighted rotation", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-chatgpt-account-ranking-"));
  try {
    const initial = new ChatGptAccountPool(dataDir);
    const first = initial.createAccount({ id: "plus-a", label: "Plus A" });
    const second = initial.createAccount({ id: "plus-b", label: "Plus B" });
    await fs.writeFile(path.join(first.profile_dir, "auth.json"), "{}", { mode: 0o600 });
    await fs.writeFile(path.join(second.profile_dir, "auth.json"), "{}", { mode: 0o600 });
    const now = Date.now();
    const usage = (usedPercent) => ({
      status: "fresh",
      source: "official:account/rateLimits/read",
      checked_at: new Date(now).toISOString(),
      fetched_at: new Date(now).toISOString(),
      five_hour: {
        kind: "five_hour",
        label: "5 小时窗口",
        used_percent: usedPercent,
        remaining_percent: 100 - usedPercent,
        window_minutes: 300,
        resets_at: 1700000000,
      },
    });
    await fs.writeFile(path.join(dataDir, "chatgpt_account_usage.json"), JSON.stringify({
      schema_version: 1,
      accounts: {
        "plus-a": { usage: usage(80), fetched_at_ms: now, checked_at_ms: now },
        "plus-b": { usage: usage(20), fetched_at_ms: now, checked_at_ms: now },
      },
    }));

    const pool = new ChatGptAccountPool(dataDir);
    pool.saveSettings({ rotation_enabled: true, mode: "round_robin" });
    const selections = Array.from({ length: 10 }, () => pool.selectForInvocation()?.id);
    assert.equal(selections.filter((id) => id === "plus-a").length, 2);
    assert.equal(selections.filter((id) => id === "plus-b").length, 8);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
