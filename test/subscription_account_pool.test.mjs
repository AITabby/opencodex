import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubscriptionAccountPool } from "../dist/services/subscription_account_pool.js";
import { SubscriptionAccountLoginService } from "../dist/services/subscription_account_auth.js";

test("OAuth account pool keeps accounts separate and rotates ready credentials", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-oauth-account-pool-"));
  try {
    const pool = new SubscriptionAccountPool(dataDir);
    const first = pool.createAccount({ provider: "grok", id: "grok-a", label: "Grok A" });
    const second = pool.createAccount({ provider: "grok", id: "grok-b", label: "Grok B" });

    assert.equal(first.auth_status, "missing");
    assert.equal(second.auth_status, "missing");
    await fs.writeFile(path.join(first.profile_dir, "auth.json"), JSON.stringify({ token: "first-secret" }), { mode: 0o600 });
    await fs.writeFile(path.join(second.profile_dir, "auth.json"), JSON.stringify({ token: "second-secret" }), { mode: 0o600 });
    assert.equal(pool.listAccounts("grok").every((account) => account.auth_status === "ready"), true);

    pool.saveSettings("grok", { mode: "round_robin" });
    assert.equal(pool.selectForRequest("grok")?.id, "grok-a");
    assert.equal(pool.selectForRequest("grok")?.id, "grok-b");

    const metadata = await fs.readFile(path.join(dataDir, "subscription_accounts.json"), "utf8");
    assert.match(metadata, /grok-a/);
    assert.doesNotMatch(metadata, /first-secret|second-secret/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("OAuth login profiles stay invisible until success and repeated captures deduplicate", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-oauth-login-profile-"));
  try {
    const pool = new SubscriptionAccountPool(dataDir);
    const pending = pool.createLoginProfile({ provider: "antigravity", label: "Antigravity A" });
    assert.equal(pool.listAccounts("antigravity").length, 0);
    await fs.writeFile(path.join(pending.profile_dir, "auth.json"), JSON.stringify({ token: "same-login" }), { mode: 0o600 });
    const first = pool.registerLoginProfile(pending);
    assert.equal(first.auth_status, "ready");

    const repeated = pool.createLoginProfile({ provider: "antigravity", label: "Antigravity duplicate" });
    await fs.writeFile(path.join(repeated.profile_dir, "auth.json"), JSON.stringify({ token: "same-login" }), { mode: 0o600 });
    assert.equal(pool.findDuplicateCredential("antigravity", repeated.profile_dir, repeated.id)?.id, first.id);
    assert.equal(pool.compactDuplicateAccounts("antigravity"), 0);
    pool.registerLoginProfile(repeated);
    assert.equal(pool.compactDuplicateAccounts("antigravity"), 1);
    assert.deepEqual(pool.listAccounts("antigravity").map((account) => account.id), [first.id]);

    const cancelled = pool.createLoginProfile({ provider: "antigravity", label: "Cancelled" });
    pool.discardLoginProfile(cancelled);
    await assert.rejects(fs.stat(cancelled.profile_dir));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("cancelled or unsuccessful OAuth login does not create a visible account", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-oauth-login-cancel-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-oauth-login-bin-"));
  const previousPath = process.env.PATH;
  try {
    const fakeGrok = path.join(binDir, "grok");
    await fs.writeFile(fakeGrok, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 10);\n", { mode: 0o700 });
    process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
    const pool = new SubscriptionAccountPool(dataDir);
    const login = new SubscriptionAccountLoginService(pool);
    const started = login.startLogin("grok", "Cancelled Grok");
    assert.equal(pool.listAccounts("grok").length, 0);
    assert.equal(login.cancelLogin(started.flow_id), true);
    assert.equal(login.getFlow(started.flow_id)?.status, "failed");
    assert.equal(pool.listAccounts("grok").length, 0);
    assert.equal(login.getPending("grok"), null);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  }
});
