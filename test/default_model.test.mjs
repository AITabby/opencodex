import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBridgeServer, writePrivateTextFile } from "../dist/server/gateway.js";

test("requests without a model resolve from configured/native/catalog state", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-default-model-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  const previousCodexHome = process.env.OPENCODEX_CODEX_HOME;
  const previousDefaultModel = process.env.OPENCODEX_DEFAULT_MODEL;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  process.env.OPENCODEX_CODEX_HOME = path.join(dataDir, "codex");
  try {
    const secureConfigPath = path.join(dataDir, "secure-config.toml");
    writePrivateTextFile(secureConfigPath, "experimental_bearer_token = \"test\"\n");
    assert.equal((await fs.stat(secureConfigPath)).mode & 0o777, 0o600);
    await fs.writeFile(process.env.OPENCODEX_CODEX_CONFIG_PATH, 'model = "native-config-model"\n');
    const configured = new CodexBridgeServer(0);
    assert.equal(configured.defaultRequestModel(), "native-config-model");

    await fs.writeFile(process.env.OPENCODEX_CODEX_CONFIG_PATH, "");
    await fs.writeFile(
      path.join(dataDir, "custom_model_catalog.json"),
      JSON.stringify({ models: [{ slug: "custom/catalog-model", backend_model: "catalog-model", backend_provider: "custom" }] }),
    );
    process.env.OPENCODEX_DEFAULT_MODEL = "custom/catalog-model";
    const catalog = new CodexBridgeServer(0);
    assert.equal(catalog.defaultRequestModel(), "custom/catalog-model");
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    if (previousCodexHome === undefined) delete process.env.OPENCODEX_CODEX_HOME;
    else process.env.OPENCODEX_CODEX_HOME = previousCodexHome;
    if (previousDefaultModel === undefined) delete process.env.OPENCODEX_DEFAULT_MODEL;
    else process.env.OPENCODEX_DEFAULT_MODEL = previousDefaultModel;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
