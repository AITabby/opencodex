/**
 * Static API-key provider catalog.
 *
 * The catalog is intentionally separate from provider credentials and live
 * connection status. A preset only supplies a starting endpoint/model list;
 * saving a key and testing a model remain explicit user actions.
 *
 * The CC Switch-derived entries contain only neutral metadata (name, endpoint,
 * protocol and model ids). We do not import its OAuth flow, proxy code,
 * tracking URLs, partner promotions or icon assets.
 */

export type ProviderPresetProtocol = "chat" | "responses";

export type ProviderPresetModel = {
  id: string;
  label?: string;
  protocol?: ProviderPresetProtocol;
  contextWindow?: number;
};

export type ProviderPreset = {
  id: string;
  label: string;
  /** Every entry in this registry is key-based. OAuth lives in the subscription registry. */
  authMode: "api_key";
  defaultBaseUrl: string;
  iconSlug?: string;
  models: ProviderPresetModel[];
  defaultProtocol: ProviderPresetProtocol;
  endpointCandidates?: string[];
  verificationStatus: "catalog_only" | "not_applicable";
  source: "cc-switch" | "opencodex";
};

type PresetOptions = {
  iconSlug?: string;
  defaultProtocol?: ProviderPresetProtocol;
  endpointCandidates?: string[];
  source?: ProviderPreset["source"];
  verificationStatus?: ProviderPreset["verificationStatus"];
};

function model(id: string, protocol?: ProviderPresetProtocol, label?: string, contextWindow?: number): ProviderPresetModel {
  return {
    id,
    ...(label ? { label } : {}),
    ...(protocol ? { protocol } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

function preset(
  id: string,
  label: string,
  defaultBaseUrl: string,
  models: ProviderPresetModel[] = [],
  options: PresetOptions = {},
): ProviderPreset {
  return {
    id,
    label,
    authMode: "api_key",
    defaultBaseUrl,
    ...(options.iconSlug ? { iconSlug: options.iconSlug } : {}),
    models,
    defaultProtocol: options.defaultProtocol || models.find((item) => item.protocol)?.protocol || "chat",
    ...(options.endpointCandidates ? { endpointCandidates: options.endpointCandidates } : {}),
    verificationStatus: options.verificationStatus || "catalog_only",
    source: options.source || "cc-switch",
  };
}

/**
 * API-key presets from the current CC Switch Codex provider catalog, merged
 * with OpenCodex's existing entries. Entries with OAuth/subscription-only
 * authentication are deliberately not included here.
 */
export const API_PROVIDER_PRESETS: ProviderPreset[] = [
  // Existing OpenCodex entries. Their ids stay stable for providers.json.
  preset("deepseek", "DeepSeek", "https://api.deepseek.com/", [
    model("deepseek-v4-flash", "responses", "DeepSeek V4 Flash", 1048576),
    model("deepseek-v4-pro", "responses", "DeepSeek V4 Pro", 1048576),
  ], { iconSlug: "deepseek" }),
  preset("qwen", "通义千问 (Qwen)", "https://dashscope.aliyuncs.com/compatible-mode/v1", [
    model("qwen-max"),
    model("qwen-plus"),
  ], { iconSlug: "qwen", source: "opencodex" }),
  preset("minimax", "MiniMax", "https://api.minimaxi.com/v1", [
    model("minimax-m3"),
    model("MiniMax-M3", "responses", "MiniMax M3", 1000000),
  ], { iconSlug: "minimax" }),
  preset("kimi", "Kimi (Moonshot)", "https://api.moonshot.cn/v1", [
    model("moonshot-v1-8k"),
    model("kimi-k2.7-code", "chat", "Kimi K2.7 Code", 262144),
  ], { iconSlug: "kimi" }),
  preset("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", [
    model("anthropic/claude-3.5-sonnet"),
  ], { iconSlug: "openrouter" }),
  preset("opencode-go", "OpenCode Go", "https://opencode.ai/zen/go/v1", [
    model("opencode-go-pro"),
  ]),
  preset("siliconflow", "SiliconFlow (硅基流动)", "https://api.siliconflow.cn/v1", [
    model("deepseek-ai/DeepSeek-V3"),
    model("Pro/MiniMaxAI/MiniMax-M2.7", "chat", "Pro / MiniMax M2.7", 200000),
  ]),
  preset("volcengine", "火山方舟 (Volcengine)", "https://ark.cn-beijing.volces.com/api/v3", [
    model("ep-20241201-xxxx"),
  ]),

  // Official/model-platform API presets.
  preset("zai", "智谱 GLM", "https://open.bigmodel.cn/api/coding/paas/v4", [
    model("glm-5.2", "chat", "GLM-5.2", 200000),
  ], { iconSlug: "zhipu" }),
  preset("zai-en", "智谱 GLM（国际站）", "https://api.z.ai/api/coding/paas/v4", [
    model("glm-5.2", "chat", "GLM-5.2", 200000),
  ], { iconSlug: "zhipu" }),
  preset("qianfan-coding", "百度千帆 Coding Plan", "https://qianfan.baidubce.com/v2/coding", [
    model("qianfan-code-latest", "chat", "Qianfan Code Latest", 131072),
  ]),
  preset("bailian", "阿里百炼 (Bailian)", "https://dashscope.aliyuncs.com/compatible-mode/v1", [
    model("qwen3-coder-plus", "responses", "Qwen3 Coder Plus", 1048576),
  ]),
  preset("kimi-coding", "Kimi For Coding", "https://api.kimi.com/coding/v1", [
    model("kimi-for-coding", "chat", "Kimi For Coding", 262144),
  ], { endpointCandidates: ["https://api.kimi.com/coding/v1"] }),
  preset("stepfun", "StepFun", "https://api.stepfun.com/step_plan/v1", [
    model("step-3.7-flash", "chat", "Step 3.7 Flash", 262144),
    model("step-3.5-flash-2603", "chat", "Step 3.5 Flash 2603", 262144),
    model("step-3.5-flash", "chat", "Step 3.5 Flash", 262144),
  ]),
  preset("stepfun-en", "StepFun（国际站）", "https://api.stepfun.ai/step_plan/v1", [
    model("step-3.7-flash", "chat", "Step 3.7 Flash", 262144),
    model("step-3.5-flash-2603", "chat", "Step 3.5 Flash 2603", 262144),
    model("step-3.5-flash", "chat", "Step 3.5 Flash", 262144),
  ]),
  preset("modelscope", "ModelScope", "https://api-inference.modelscope.cn/v1", [
    model("ZhipuAI/GLM-5.1", "chat", "ZhipuAI / GLM-5.1", 200000),
  ]),
  preset("longcat", "Longcat", "https://api.longcat.chat/openai/v1", [
    model("LongCat-2.0", "responses", "LongCat 2.0", 1048576),
  ]),
  preset("minimax-en", "MiniMax（国际站）", "https://api.minimax.io/v1", [
    model("MiniMax-M3", "responses", "MiniMax M3", 1000000),
  ], { iconSlug: "minimax" }),
  preset("bailing", "百灵 (BaiLing)", "https://api.tbox.cn/api/llm/v1", [
    model("Ling-2.6-1T", "chat", "Ling-2.6-1T", 262144),
  ]),
  preset("xiaomi-mimo", "小米 MiMo", "https://api.xiaomimimo.com/v1", [
    model("mimo-v2.5-pro", "responses", "MiMo V2.5 Pro", 1048576),
    model("mimo-v2.5", "responses", "MiMo V2.5", 1048576),
  ]),
  preset("xiaomi-mimo-token-plan", "小米 MiMo Token Plan", "https://token-plan-cn.xiaomimimo.com/v1", [
    model("mimo-v2.5-pro", "responses", "MiMo V2.5 Pro", 1048576),
    model("mimo-v2.5", "responses", "MiMo V2.5", 1048576),
  ]),
  preset("volcengine-agentplan", "火山 AgentPlan", "https://ark.cn-beijing.volces.com/api/coding/v3", [
    model("ark-code-latest", "responses", "Ark Code Latest", 256000),
  ]),
  preset("byteplus", "BytePlus", "https://ark.ap-southeast.bytepluses.com/api/coding/v3", [
    model("ark-code-latest", "chat", "Ark Code Latest", 256000),
  ]),
  preset("doubaoseed", "豆包 DouBao Seed", "https://ark.cn-beijing.volces.com/api/v3", [
    model("doubao-seed-2-1-pro-260628", "responses", "Doubao Seed 2.1 Pro", 262144),
  ]),
  preset("siliconflow-en", "SiliconFlow（国际站）", "https://api.siliconflow.com/v1", [
    model("MiniMaxAI/MiniMax-M2.7", "chat", "MiniMax M2.7", 200000),
  ]),
  preset("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1", [], {
    defaultProtocol: "chat",
  }),
  preset("novita-ai", "Novita AI", "https://api.novita.ai/v3/openai", [], {
    defaultProtocol: "chat",
  }),
  preset("azure-openai", "Azure OpenAI", "https://YOUR_RESOURCE_NAME.openai.azure.com/openai", [], {
    defaultProtocol: "responses",
  }),

  // Community/API relay presets. These remain catalog-only and use neutral
  // URLs; no CC Switch referral or partner-tracking parameters are copied.
  preset("shengsuanyun", "胜算云", "https://router.shengsuanyun.com/api/v1", [model("openai/gpt-5.6-sol")]),
  preset("patewayai", "PatewayAI", "https://api.pateway.ai/v1", [model("gpt-5.6-sol")]),
  preset("ccsub", "CCSub", "https://www.ccsub.net/v1", [model("gpt-5.6-sol")]),
  preset("subrouter", "SubRouter", "https://subrouter.ai/v1", [model("gpt-5.6-sol")]),
  preset("unity2", "Unity2.ai", "https://api.unity2.ai", [model("gpt-5.6-sol")]),
  preset("qiniu", "七牛 AI", "https://api.qnaigc.com/bypass/openai/v1", [model("gpt-5.6-sol")], {
    endpointCandidates: ["https://api.qnaigc.com/bypass/openai/v1", "https://api.modelink.ai/bypass/openai/v1"],
  }),
  preset("fenno", "FennoAI", "https://api.fenno.ai", [model("gpt-5.6-sol")]),
  preset("zetaapi", "ZetaAPI", "https://api.zetaapi.ai/v1", [model("gpt-5.6-sol")]),
  preset("teamorouter", "TeamoRouter", "https://api.teamorouter.com/v1", [model("gpt-5.6-sol")]),
  preset("amux", "Amux", "https://api.amux.ai/v1", [model("gpt-5.6-sol")]),
  preset("code0", "Code0", "https://code0.ai/v1", [model("gpt-5.6-sol")]),
  preset("nekocode", "NekoCode", "https://nekocode.ai/v1", [model("gpt-5.6-sol")]),
  preset("packycode", "PackyCode", "https://www.packyapi.ai/v1", [model("gpt-5.6-sol")], {
    endpointCandidates: [
      "https://www.packyapi.ai/v1",
      "https://cf.api.fan/v1",
      "https://slb-v1.api.fan/v1",
      "https://www.packyapi.com/v1",
    ],
  }),
  preset("apinebula", "APINebula", "https://apinebula.ai/v1", [model("gpt-5.6-sol", "responses")], {
    defaultProtocol: "responses",
  }),
  preset("aicodemirror", "AICodeMirror", "https://api.aicodemirror.ai/api/codex/backend-api/codex", [model("gpt-5.6-sol", "responses")], {
    defaultProtocol: "responses",
  }),
  preset("aigocode", "AIGoCode", "https://api.aigocode.app", [model("gpt-5.6-sol")]),
  preset("aicoding", "AICoding", "https://api.aicoding.inc", [model("gpt-5.6-sol")]),
  preset("apikey-fun", "APIKEY.FUN", "https://api.apikey.fun/v1", [model("gpt-5.6-sol", "responses")], {
    defaultProtocol: "responses",
    endpointCandidates: ["https://api.apikey.fun/v1", "https://slb.apikey.fun/v1"],
  }),
  preset("claudecn", "ClaudeCN", "https://claudecn.top/v1", [model("gpt-5.6-sol")]),
  preset("a6api", "A6API", "https://api.a6api.com/v1", [model("gpt-5.6-sol")]),
  preset("atlascloud", "AtlasCloud", "https://api.atlascloud.ai/v1", [model("zai-org/glm-5.1", "chat", "GLM 5.1", 200000)]),
  preset("compshare", "Compshare", "https://api.modelverse.cn/v1", [model("gpt-5.6-sol")]),
  preset("compshare-coding", "Compshare Coding Plan", "https://cp.compshare.cn/v1", [model("gpt-5.6-sol")]),
  preset("sssaicode", "SSSAiCode", "https://node-hk.sssaicodeapi.com/api/v1", [model("gpt-5.6-sol")], {
    endpointCandidates: [
      "https://node-hk.sssaicodeapi.com/api/v1",
      "https://node-hk.sssaiapi.com/api/v1",
      "https://node-cf.sssaicodeapi.com/api/v1",
    ],
  }),
  preset("micu", "Micu", "https://www.micuapi.ai/v1", [model("gpt-5.6-sol")]),
  preset("rightcode", "RightCode", "https://www.rightapi.ai/codex/v1", [model("gpt-5.6-sol")]),
  preset("etok", "ETok.ai", "https://api.etok.ai/v1", [model("gpt-5.6-sol")]),
  preset("cubence", "Cubence", "https://api.cubence.com/v1", [model("gpt-5.6-sol")], {
    endpointCandidates: [
      "https://api.cubence.com/v1",
      "https://api-cf.cubence.com/v1",
      "https://api-dmit.cubence.com/v1",
      "https://api-bwg.cubence.com/v1",
    ],
  }),
  preset("crazyrouter", "CrazyRouter", "https://cn.crazyrouter.com/v1", [model("gpt-5.6-sol")]),
  preset("dmxapi", "DMXAPI", "https://www.dmxapi.cn/v1", [model("gpt-5.6-sol")]),
  preset("sudocode", "SudoCode.chat", "https://api.sudocode.chat/v1", [model("gpt-5.6-sol", "responses")], {
    defaultProtocol: "responses",
  }),
  preset("sudocode-us", "SudoCode.us", "https://sudocode.us/v1", [model("gpt-5.6-sol", "responses")], {
    defaultProtocol: "responses",
    endpointCandidates: ["https://sudocode.us/v1", "https://sudocode.run/v1"],
  }),

  // OpenCodex's free-form OpenAI-compatible entry is intentionally retained.
  preset("custom", "自定义兼容接口", "", [], {
    source: "opencodex",
    verificationStatus: "not_applicable",
  }),
];
