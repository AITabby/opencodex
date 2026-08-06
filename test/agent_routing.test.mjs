import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { AgentProfileStore } from "../dist/services/agent_profile_store.js";
import { TaskRouter, readRoutingCatalog } from "../dist/services/task_router.js";
import { SubagentOrchestrator } from "../dist/services/subagent_orchestrator.js";
import { CodexBridgeServer } from "../dist/server/gateway.js";
import { applyDefaultReasoningCapabilities } from "../dist/services/catalog_sync.js";

test("1.1.0 preserves provider-reported reasoning levels beside a broad false flag", () => {
  const model = applyDefaultReasoningCapabilities({
    reasoning: false,
    supported_reasoning_levels: [
      { effort: "low", description: "fast" },
      { effort: "xhigh", description: "deep" },
    ],
    default_reasoning_level: "xhigh",
  });
  assert.deepEqual(model.supported_reasoning_levels.map((level) => level.effort), ["low", "xhigh"]);
  assert.equal(model.default_reasoning_level, "xhigh");
});

test("1.1.0 merges imported extra reasoning levels when the Desktop cache is stale", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-catalog-merge-"));
  const nativeDir = path.join(root, "codex");
  const dataDir = path.join(root, "opencodex");
  await fs.mkdir(nativeDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.writeFile(path.join(nativeDir, "models_cache.json"), JSON.stringify({ models: [{
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    }] }));
    await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify({ models: [{
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }],
      default_reasoning_level: "max",
    }] }));

    const model = readRoutingCatalog(dataDir, nativeDir).find((entry) => entry.slug === "deepseek/deepseek-v4-pro");
    assert.deepEqual(model?.supported_reasoning_levels.map((level) => level.effort), ["low", "medium", "high", "max"]);
    assert.equal(model?.default_reasoning_level, "max");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("1.1.0 preserves per-model context metadata in the routing catalog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-catalog-context-"));
  try {
    await fs.writeFile(path.join(root, "custom_model_catalog.json"), JSON.stringify({ models: [
      {
        slug: "gpt-5.6-luna",
        backend_model: "gpt-5.6-luna",
        backend_provider: "openai",
        context_window: 272000,
        max_context_window: 1000000,
        context_window_source: "provider_metadata",
      },
      {
        slug: "antigravity/gemini-3.6-flash-medium",
        backend_model: "gemini-3.6-flash-medium",
        backend_provider: "antigravity",
        context_window: 200000,
        max_context_window: 200000,
        context_window_source: "provider_metadata",
      },
    ] }));

    const models = readRoutingCatalog(root, path.join(root, "missing-native"));
    const native = models.find((model) => model.slug === "gpt-5.6-luna");
    const thirdParty = models.find((model) => model.slug === "antigravity/gemini-3.6-flash-medium");
    assert.equal(native?.context_window, 272000);
    assert.equal(native?.max_context_window, 1000000);
    assert.equal(thirdParty?.context_window, 200000);
    assert.equal(thirdParty?.max_context_window, 200000);
    assert.equal(thirdParty?.context_window_source, "provider_metadata");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-agent-routing-"));
  await fs.writeFile(path.join(dataDir, "custom_model_catalog.json"), JSON.stringify({ models: [
    {
      slug: "antigravity/code-model",
      backend_model: "gemini-code-1",
      backend_provider: "antigravity",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
    },
    {
      slug: "thirdparty/review-model",
      backend_model: "review-1",
      backend_provider: "thirdparty",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
      default_reasoning_level: "medium",
    },
    {
      slug: "minimax/minimax-m3",
      backend_model: "minimax-m3",
      backend_provider: "minimax",
      reasoning: true,
      supported_reasoning_levels: [],
    },
    {
      slug: "deepseek/deepseek-v4-pro",
      backend_model: "deepseek-v4-pro",
      backend_provider: "deepseek",
      reasoning: true,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "max" },
      ],
    },
    {
      slug: "opencode/deepseek-v4-flash",
      backend_model: "deepseek-v4-flash",
      backend_provider: "opencode",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "max" },
      ],
    },
  ] }));
  return dataDir;
}

test("1.1.0 Agent Profiles survive save/load and auto routing uses user policy", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "code",
      name: "代码实现",
      task_types: ["coding"],
      tags: ["implementation"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1" },
      reasoning_effort: "high",
      tools: ["read", "exec", "apply_patch"],
      live_enabled: true,
      subagent_enabled: true,
    });
    store.upsertProfile({
      id: "review",
      name: "代码审查",
      task_types: ["review"],
      model_ref: { provider: "thirdparty", backend_model: "review-1" },
      reasoning_effort: "medium",
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "code" });

    const router = new TaskRouter(store);
    const route = router.resolve({ source: "gpt-live", task_type: "coding", required_tools: ["exec"] });
    assert.equal(route.ok, true);
    assert.equal(route.profile_id, "code");
    assert.equal(route.model, "antigravity/code-model");
    assert.equal(route.backend_model, "gemini-code-1");
    assert.equal(route.reasoning_effort, "high");

    const reloaded = new AgentProfileStore(dataDir);
    assert.equal(reloaded.loadProfiles().length, 2);
    assert.equal(reloaded.loadProfiles().find((profile) => profile.id === "code")?.model_ref?.backend_model, "gemini-code-1");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 keeps Profile bindings for catalogs without a provider namespace", async () => {
  const dataDir = await fixture();
  try {
    const catalogPath = path.join(dataDir, "custom_model_catalog.json");
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    catalog.models.push({ slug: "custom/no-provider", backend_model: "custom-model-1" });
    await fs.writeFile(catalogPath, JSON.stringify(catalog));

    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "providerless",
      name: "无命名空间模型",
      task_types: ["coding"],
      model_ref: { provider: "", backend_model: "custom-model-1", catalog_slug: "custom/no-provider" },
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "providerless" });

    const route = new TaskRouter(store).resolve({ source: "subagent", task_type: "coding" });
    assert.equal(route.ok, true);
    assert.equal(route.profile_id, "providerless");
    assert.equal(route.model, "custom/no-provider");
    assert.equal(route.backend_model, "custom-model-1");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 routes from the user's model capability description and preserves its reasoning", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "capability-model",
      name: "代码模型",
      description: "代码实现、调试、重构和技术分析",
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1", catalog_slug: "antigravity/code-model" },
      reasoning_effort: "high",
      subagent_enabled: true,
      enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto" });

    const route = new TaskRouter(store).resolve({
      source: "subagent",
      task_text: "请重构这个模块并修复代码实现中的 bug",
    });
    assert.equal(route.ok, true);
    assert.equal(route.model, "antigravity/code-model");
    assert.equal(route.reasoning_effort, "high");
    assert.match(route.reason, /user_capabilities=/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 forced routing uses the request reasoning when the target has no bound Profile", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "code",
      name: "代码实现",
      task_types: ["coding"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1" },
      reasoning_effort: "medium",
    });
    store.saveRoutingSettings({ mode: "forced", forced_model: "thirdparty/review-model" });
    const router = new TaskRouter(store);
    const route = router.resolve({ source: "subagent", task_type: "coding", reasoning_effort: "high" });
    assert.equal(route.ok, true);
    assert.equal(route.model, "thirdparty/review-model");
    assert.equal(route.reasoning_effort, "high");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 keeps a saved Profile reasoning setting over an explicit per-turn value", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "code",
      name: "代码实现",
      task_types: ["coding"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1" },
      reasoning_effort: "high",
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "code" });
    const route = new TaskRouter(store).resolve({
      source: "subagent",
      task_type: "coding",
      reasoning_effort: "low",
    });
    assert.equal(route.ok, true);
    assert.equal(route.reasoning_effort, "high");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 explicit child model wins over capability routing and normalizes inherited reasoning", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "code",
      name: "代码实现",
      description: "负责代码实现",
      task_types: ["coding"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1" },
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "code" });
    const router = new TaskRouter(store);

    const explicitReview = router.resolve({
      source: "subagent",
      task_type: "coding",
      forced_model: "thirdparty/review-model",
      reasoning_effort: "max",
    });
    assert.equal(explicitReview.ok, true);
    assert.equal(explicitReview.model, "thirdparty/review-model");
    assert.equal(explicitReview.reasoning_effort, "medium");

    const automaticOnlyMiniMax = router.resolve({
      source: "subagent",
      forced_model: "minimax/minimax-m3",
      reasoning_effort: "max",
    });
    assert.equal(automaticOnlyMiniMax.ok, true);
    assert.equal(automaticOnlyMiniMax.model, "minimax/minimax-m3");
    assert.equal(automaticOnlyMiniMax.reasoning_effort, "medium");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 preserves an explicitly selected DeepSeek max level for a child turn", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    const route = new TaskRouter(store).resolve({
      source: "subagent",
      forced_model: "deepseek/deepseek-v4-pro",
      reasoning_effort: "max",
      preserve_reasoning_effort: true,
    });
    assert.equal(route.ok, true);
    assert.equal(route.model, "deepseek/deepseek-v4-pro");
    assert.equal(route.reasoning_effort, "max");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.2.0 spawn_agent forwards the child constraints to the gateway for one routing decision", async () => {
  const dataDir = await fixture();
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "model-opencode-deepseek-v4-flash",
      name: "opencode/deepseek-v4-flash",
      description: "复杂代码分析",
      model_ref: {
        provider: "opencode",
        backend_model: "deepseek-v4-flash",
        catalog_slug: "opencode/deepseek-v4-flash",
      },
      reasoning_effort: "max",
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto" });

    let childRequest;
    globalThis.fetch = async (_url, init) => {
      childRequest = JSON.parse(init.body);
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"child done"}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-opencodex-subagent-model": "opencode/deepseek-v4-flash",
            "x-opencodex-subagent-reasoning-effort": "max",
            "x-opencodex-subagent-task-id": "gateway-selected-child",
          },
        },
      );
    };

    const server = new CodexBridgeServer(0);
    const result = await server.dispatchThirdPartySubagent({
      id: "call-1",
      call_id: "call-1",
      name: "spawn_agent",
      // The stale profile id and parent high simulate the real third-party
      // dispatch path that previously bypassed the saved Web Profile.
      arguments: JSON.stringify({
        task_name: "deep-review",
        message: "分析这段代码的复杂问题",
        model: "opencode/deepseek-v4-flash",
        profile_id: "stale-profile-id",
        reasoning_effort: "high",
      }),
    }, { parent_reasoning_effort: "high" }, 0);

    assert.equal(childRequest.model, undefined);
    assert.equal(childRequest.forced_model, undefined);
    assert.equal(childRequest.profile_id, undefined);
    assert.equal(childRequest.task_type, undefined);
    assert.equal(childRequest.reasoning, undefined);
    assert.equal(childRequest.client_metadata["x-openai-subagent"], "1");
    assert.equal(childRequest.client_metadata.thread_source, "subagent");
    assert.equal(childRequest.client_metadata.parent_task_id, "gateway-main");
    assert.equal(childRequest.client_metadata.model_override, "opencode/deepseek-v4-flash");
    assert.equal(childRequest.client_metadata.profile_id, "stale-profile-id");
    assert.equal(childRequest.client_metadata.task_type, "deep-review");
    assert.equal(childRequest.client_metadata.reasoning_effort, "high");
    assert.equal(result.model, "opencode/deepseek-v4-flash");
    assert.equal(result.reasoning_effort, "max");
    assert.equal(result.task_id, "gateway-selected-child");
    assert.equal(result.output, "child done");
    // The dispatcher only forwards the request. No local TaskRouter or task
    // record is created before the gateway receives it.
    assert.equal(server.subagentOrchestrator.list(10).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 never silently swaps an unavailable Profile model", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "missing",
      name: "失效模型",
      task_types: ["coding"],
      model_ref: { provider: "antigravity", backend_model: "removed-model" },
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "missing" });
    const router = new TaskRouter(store);
    const route = router.resolve({ source: "gpt-live", task_type: "coding" });
    assert.equal(route.ok, false);
    assert.equal(route.unavailable, true);
    assert.match(route.reason, /not available/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 only falls back when the user explicitly configured fallback Profile ids", async () => {
  const dataDir = await fixture();
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "missing",
      name: "主代码模型",
      task_types: ["coding"],
      model_ref: { provider: "antigravity", backend_model: "removed-model" },
      fallback_profile_ids: ["backup"],
    });
    store.upsertProfile({
      id: "backup",
      name: "备用代码模型",
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1" },
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "missing" });
    const route = new TaskRouter(store).resolve({ source: "subagent", task_type: "coding" });
    assert.equal(route.ok, true);
    assert.equal(route.profile_id, "backup");
    assert.match(route.reason, /explicit fallback=backup/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 records native child-task lifecycle without claiming cancellation is execution", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-subagent-lifecycle-"));
  try {
    const orchestrator = new SubagentOrchestrator(dataDir);
    const started = orchestrator.start({
      task_id: "child-1",
      parent_task_id: "parent-1",
      profile_id: "code",
      provider: "antigravity",
      model: "antigravity/code-model",
      backend_model: "gemini-code-1",
      reasoning_effort: "high",
    });
    assert.equal(started.status, "running");
    assert.equal(orchestrator.requestCancel("child-1")?.status, "cancel_requested");
    assert.equal(orchestrator.list(1)[0].parent_task_id, "parent-1");
    assert.equal(orchestrator.complete("child-1")?.status, "completed");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 routes an actual native subagent request through the shared gateway boundary", async () => {
  const dataDir = await fixture();
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "code",
      name: "代码实现",
      description: "负责代码实现",
      task_types: ["coding"],
      tags: ["代码"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1", catalog_slug: "antigravity/code-model" },
      reasoning_effort: "high",
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "code" });
    const server = new CodexBridgeServer(0);
    const route = server.chooseSubagentRoute({
      client_metadata: { "x-openai-subagent": "1", session_id: "child-1", parent_task_id: "parent-1" },
      input: "请完成代码实现",
    });
    assert.equal(route?.model, "antigravity/code-model");
    assert.equal(route?.reasoning_effort, "high");
    assert.equal(server.subagentOrchestrator.list(1)[0].status, "running");
    server.subagentOrchestrator.complete(route.task_id);
    assert.equal(server.subagentOrchestrator.list(1)[0].status, "completed");
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 binds an explicitly named native child model to its Web Profile reasoning", async () => {
  const dataDir = await fixture();
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "code",
      name: "代码实现",
      description: "负责代码实现",
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1", catalog_slug: "antigravity/code-model" },
      reasoning_effort: "high",
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto" });

    const server = new CodexBridgeServer(0);
    const route = server.chooseSubagentRoute({
      model: "antigravity/code-model",
      reasoning: { effort: "low" },
      client_metadata: {
        "x-openai-subagent": "1",
        session_id: "parent-profile",
        thread_id: "child-profile",
        parent_thread_id: "parent-profile",
      },
      input: "请完成代码实现",
    });
    assert.equal(route?.model, "antigravity/code-model");
    assert.equal(route?.reasoning_effort, "high");
    server.subagentOrchestrator.complete(route.task_id);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 recognizes native subagent headers and ignores their prewarm request", async () => {
  const dataDir = await fixture();
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "native-code",
      name: "原生代码实现",
      description: "负责代码实现、调试和重构",
      task_types: ["coding"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1", catalog_slug: "antigravity/code-model" },
      reasoning_effort: "high",
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "native-code" });

    const server = new CodexBridgeServer(0);
    const headers = {
      "x-openai-subagent": "guardian",
      "x-codex-parent-thread-id": "parent-native",
      "session-id": "child-native",
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "child-native",
        parent_thread_id: "parent-native",
        thread_source: "subagent",
        subagent_kind: "guardian",
        request_kind: "turn",
      }),
    };
    const route = server.chooseSubagentRoute({ input: "请完成代码重构" }, { headers });
    assert.equal(route?.model, "antigravity/code-model");
    assert.equal(route?.reasoning_effort, "high");
    assert.equal(server.subagentOrchestrator.list(1)[0].parent_task_id, "parent-native");
    server.subagentOrchestrator.complete(route.task_id);

    const prewarm = server.chooseSubagentRoute({ input: "预热" }, {
      headers: {
        ...headers,
        "x-codex-turn-metadata": JSON.stringify({ ...JSON.parse(headers["x-codex-turn-metadata"]), request_kind: "prewarm" }),
      },
    });
    assert.equal(prewarm, null);
    assert.equal(server.subagentOrchestrator.list(10).length, 1);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 accepts multiple child requests from one parent and routes each independently", async () => {
  const dataDir = await fixture();
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "implementation",
      name: "快速实现",
      description: "快速完成常规代码实现和前端修改",
      task_types: ["implementation"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1", catalog_slug: "antigravity/code-model" },
      reasoning_effort: "medium",
      subagent_enabled: true,
    });
    store.upsertProfile({
      id: "review",
      name: "深度审查",
      description: "复杂代码分析、深度调试和架构审查",
      task_types: ["review"],
      model_ref: { provider: "thirdparty", backend_model: "review-1", catalog_slug: "thirdparty/review-model" },
      reasoning_effort: "high",
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto" });

    const server = new CodexBridgeServer(0);
    const first = server.chooseSubagentRoute({
      client_metadata: {
        "x-openai-subagent": "1",
        // Real child turns can inherit the parent's session_id while exposing
        // their own thread_id. The latter must be the routing identity.
        session_id: "parent-1",
        thread_id: "child-implementation",
        parent_thread_id: "parent-1",
        parent_task_id: "parent-1",
      },
      task_type: "implementation",
      input: "完成一个快速的前端实现任务",
    });
    const second = server.chooseSubagentRoute({
      client_metadata: {
        "x-openai-subagent": "1",
        session_id: "parent-1",
        thread_id: "child-review",
        parent_thread_id: "parent-1",
        parent_task_id: "parent-1",
      },
      task_type: "review",
      input: "进行一次复杂的架构审查",
    });

    assert.equal(first?.model, "antigravity/code-model");
    assert.equal(second?.model, "thirdparty/review-model");
    assert.equal(first?.task_id, "child-implementation");
    assert.equal(second?.task_id, "child-review");
    assert.equal(server.subagentOrchestrator.list(10).filter((task) => task.parent_task_id === "parent-1").length, 2);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("1.1.0 keeps a non-native child body's explicit reasoning selection", async () => {
  const dataDir = await fixture();
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  try {
    const store = new AgentProfileStore(dataDir);
    store.upsertProfile({
      id: "code",
      name: "代码实现",
      description: "负责代码实现",
      task_types: ["coding"],
      model_ref: { provider: "antigravity", backend_model: "gemini-code-1" },
      subagent_enabled: true,
    });
    store.saveRoutingSettings({ mode: "auto", default_profile_id: "code" });
    const server = new CodexBridgeServer(0);
    const route = server.chooseSubagentRoute({
      model: "thirdparty/review-model",
      reasoning: { effort: "max" },
      client_metadata: { "x-openai-subagent": "1", session_id: "child-explicit", parent_task_id: "parent-explicit" },
      input: "请按用户指定的模型完成审查",
    });
    assert.equal(route?.model, "thirdparty/review-model");
    assert.equal(route?.reasoning_effort, "max");
    server.subagentOrchestrator.complete(route.task_id);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
