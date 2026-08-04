import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  buildCodexRoutingConfig,
  buildManagedCodexConfig,
  CodexBridgeServer,
  hasThirdPartyModels,
  isNativeCodexPassthrough,
} from "../dist/server/gateway.js";
import {
  GatewayRouter,
  buildThirdPartyNativeCompactionBody,
} from "../dist/server/router.js";

test("native GPT remains transport-only, including child boundaries", () => {
  assert.equal(isNativeCodexPassthrough(true, false), true);
  assert.equal(isNativeCodexPassthrough(true, true), true);
  assert.equal(isNativeCodexPassthrough(false, false), false);
});

test("native GPT compaction forwards the request bytes unchanged", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-native-compact-raw-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const server = new CodexBridgeServer(0);
    server.isNativeCatalogModel = () => true;
    let forwarded = null;
    server.proxyNativeResponses = async (_req, body, _res, endpoint) => {
      forwarded = { body, endpoint };
    };
    const body = {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: "continue" }],
      instructions: "continue from the compacted state",
      previous_response_id: "resp_native",
      prompt_cache_key: "codex-session",
      service_tier: "default",
      stream: true,
    };
    const rawBody = Buffer.from(JSON.stringify(body));

    await server.handleCompactionRequest({}, body, {}, rawBody);

    assert.equal(forwarded?.endpoint, "responses/compact");
    assert.equal(Buffer.isBuffer(forwarded?.body), true);
    assert.equal(forwarded?.body.toString(), rawBody.toString());
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("third-party native compaction only translates the backend model", () => {
  const body = {
    model: "provider/model",
    protocol: "responses",
    input: [{ type: "message", role: "user", content: "continue" }],
    instructions: "continue",
    previous_response_id: "resp_provider",
    prompt_cache_key: "codex-session",
    service_tier: "default",
  };
  const compact = buildThirdPartyNativeCompactionBody(body, "backend/model");

  assert.equal(compact.model, "backend/model");
  assert.equal(compact.protocol, undefined);
  assert.deepEqual(compact.input, body.input);
  assert.equal(compact.instructions, body.instructions);
  assert.equal(compact.previous_response_id, body.previous_response_id);
  assert.equal(compact.prompt_cache_key, body.prompt_cache_key);
  assert.equal(compact.service_tier, body.service_tier);
});

test("third-party routing has no gateway-generated compaction fallback", () => {
  assert.equal(typeof GatewayRouter.prototype.compactResponses, "undefined");
});

test("native routing is restored when no third-party model remains", () => {
  const managed = buildManagedCodexConfig(
    'model = "gpt-5.6-luna"\n',
    8765,
    "admin-token",
    "/tmp/custom_model_catalog.json",
  );
  const native = buildCodexRoutingConfig(
    managed,
    8765,
    "admin-token",
    "/tmp/custom_model_catalog.json",
    false,
  );

  assert.doesNotMatch(native, /opencodex managed/);
  assert.doesNotMatch(native, /openai_base_url/);
  assert.doesNotMatch(native, /model_catalog_json/);
  assert.match(native, /model = "gpt-5\.6-luna"/);
  assert.equal(hasThirdPartyModels([{ name: "provider", models: ["model"] }], { models: [] }), true);
  assert.equal(hasThirdPartyModels([{ name: "provider", models: [] }], { models: [{ slug: "gpt-5.6-luna" }] }), false);
  assert.equal(hasThirdPartyModels([], { models: [{ slug: "provider/model", backend_provider: "provider" }] }), true);
});
