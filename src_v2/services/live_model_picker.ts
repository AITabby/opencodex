export const LIVE_MODEL_PICKER_TIMEOUT_MS = 15 * 1000;
export const LIVE_MODEL_BINDING_TTL_MS = 30 * 60 * 1000;

const NEGATED_MODEL_DIRECTIVE_PATTERN = /(?:不要\s*(?:用|使用)|别\s*(?:用|使用)|不用|不使用|do not use|don't use)\s*$/i;
const INCIDENTAL_MODEL_MENTION_PATTERN = /(?:关于|相关|了解|介绍|比较|区别|说明|文档|是什么|what\s+is|about|compare|difference)/i;
const SPEECH_MODEL_ALIASES: Record<string, string[]> = {
  qwen: ["千问", "千問", "通义千问", "通義千問"],
  doubao: ["豆包"],
  deepseek: ["深度求索"],
  zhipu: ["智谱", "智譜", "智谱清言", "智譜清言"],
  glm: ["智谱", "智譜", "智谱清言", "智譜清言"],
  baichuan: ["百川"],
  minimax: ["海螺"],
  ernie: ["文心", "文心一言"],
  wenxin: ["文心", "文心一言"],
  spark: ["星火", "讯飞星火", "訊飛星火"],
  xinghuo: ["星火", "讯飞星火", "訊飛星火"],
  hunyuan: ["混元"],
  stepfun: ["阶跃", "階躍"],
  step: ["阶跃", "階躍"],
  yi: ["零一万物"],
  moonshot: ["月之暗面"],
};
const SPEECH_PROVIDER_BRANDS: Record<string, string[]> = {
  volcengine: ["doubao"],
  bytedance: ["doubao"],
  doubao: ["doubao"],
  dashscope: ["qwen"],
  aliyun: ["qwen"],
  zhipu: ["glm"],
  bigmodel: ["glm"],
  moonshot: ["kimi"],
};
const MODEL_BRAND_VARIANT_OMISSIONS: Record<string, string[]> = {
  // Doubao IDs commonly contain the deployment family "seed", while people
  // naturally say only “豆包 + version”. Keep the version for disambiguation.
  doubao: ["seed"],
};
const TEXT_FIELDS = new Set([
  "input", "instructions", "text", "content", "message", "messages", "prompt",
  "transcript", "utterance", "user_text", "task",
]);

function normalizeModelText(value: string): string {
  const chineseDecimal = (match: string, whole: string, fraction: string) => {
    const digits: Record<string, string> = {
      零: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4",
      五: "5", 六: "6", 七: "7", 八: "8", 九: "9",
    };
    const left = whole.split("").map((part) => digits[part] || part).join("");
    const right = fraction.split("").map((part) => digits[part] || part).join("");
    return `${left}.${right}`;
  };
  return String(value)
    // Speech-to-text commonly writes “千问三点七”; normalize that to the
    // same version shape as “qwen3.7” before aliases are compared.
    .replace(/([零一二两三四五六七八九]+)点([零一二两三四五六七八九]+)/g, chineseDecimal)
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:/\\|()[\]{}<>"'`_-]+/g, " ")
    .replace(/([\u4e00-\u9fff])(?=[a-z0-9])/gi, "$1 ")
    .replace(/([a-z0-9])(?=[\u4e00-\u9fff])/gi, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function modelTokens(value: string): string[] {
  return normalizeModelText(value).split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean);
}

function isVersionToken(token: string): boolean {
  return /^(?:v?\d+(?:\.\d+)*|\d{6,8}|preview|latest|thinking|instruct)$/i.test(token);
}

function compactModelText(value: string): string {
  return normalizeModelText(value).replace(/\s+/g, "");
}

function modelBrandAliases(base: string, provider: string): string[] {
  const compactBase = compactModelText(base);
  const brands = new Set<string>();
  if (provider) {
    brands.add(provider);
    for (const brand of SPEECH_PROVIDER_BRANDS[provider] || []) brands.add(brand);
  }
  for (const brand of Object.keys(SPEECH_MODEL_ALIASES)) {
    if (compactBase.startsWith(brand)) brands.add(brand);
  }
  return Array.from(brands).flatMap((brand) => [brand, ...(SPEECH_MODEL_ALIASES[brand] || [])]);
}

function modelAliasSourceBrand(brand: string): string {
  for (const [source, aliases] of Object.entries(SPEECH_MODEL_ALIASES)) {
    if (aliases.includes(brand)) return source;
  }
  return brand;
}

function modelBrandVariantAlias(base: string, sourceBrand: string, displayBrand: string): string {
  const omitted = MODEL_BRAND_VARIANT_OMISSIONS[sourceBrand];
  if (!omitted?.length) return "";
  const baseTokens = modelTokens(base);
  const brandTokens = modelTokens(sourceBrand);
  if (brandTokens.length === 0 || baseTokens.slice(0, brandTokens.length).join(" ") !== brandTokens.join(" ")) return "";
  const suffix = baseTokens
    .slice(brandTokens.length)
    .filter((token) => !omitted.includes(token.toLowerCase()));
  return [displayBrand, ...suffix].join(" ");
}

function replaceModelBrandPrefix(base: string, brand: string, alias: string): string {
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return base.replace(new RegExp(`^${escaped}(?=[a-z0-9]|[-_.]|$)`, "i"), alias);
}

function collectLiveIntentText(value: unknown, key = "", depth = 0, output: string[] = []): string[] {
  if (depth > 6 || value == null) return output;
  if (typeof value === "string") {
    if (!key || TEXT_FIELDS.has(key.toLowerCase())) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLiveIntentText(item, key, depth + 1, output);
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = childKey.toLowerCase();
    if (TEXT_FIELDS.has(normalizedKey) || typeof childValue === "object") {
      collectLiveIntentText(childValue, normalizedKey, depth + 1, output);
    }
  }
  return output;
}

function isUserMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.role === "user" || (item.type === "message" && item.role === "user");
}

/**
 * Responses requests often contain the complete prior conversation in input.
 * Keep user turns separate and inspect them from newest to oldest. This lets a
 * model choice spoken before the actual task persist like a manual picker,
 * while preventing an older Mimo mention from being merged with a newer Qwen
 * mention and becoming ambiguous.
 */
function collectLiveIntentTurns(body: any): string[][] {
  const input = body?.input;
  if (typeof input === "string") return [[input]];
  if (Array.isArray(input)) {
    const turns: string[][] = [];
    for (let index = input.length - 1; index >= 0; index -= 1) {
      if (isUserMessage(input[index])) {
        const text = collectLiveIntentText(input[index]);
        if (text.length > 0) turns.unshift(text);
      }
    }
    if (turns.length > 0) return turns;
    const fallbackText = collectLiveIntentText(input);
    if (fallbackText.length > 0) return [fallbackText];
  }

  const messages = body?.messages;
  if (typeof messages === "string") return [[messages]];
  if (Array.isArray(messages)) {
    const turns: string[][] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isUserMessage(messages[index])) {
        const text = collectLiveIntentText(messages[index]);
        if (text.length > 0) turns.unshift(text);
      }
    }
    if (turns.length > 0) return turns;
    const fallbackText = collectLiveIntentText(messages);
    if (fallbackText.length > 0) return [fallbackText];
  }

  for (const key of ["text", "utterance", "user_text", "task", "prompt", "message", "instructions"]) {
    if (typeof body?.[key] === "string" && body[key].trim()) return [[body[key]]];
  }
  return [];
}

function modelAliases(models: string[]): Map<string, Set<string>> {
  const aliasOwners = new Map<string, Set<string>>();
  const providerCounts = new Map<string, number>();
  const addAlias = (alias: string, model: string) => {
    const normalized = normalizeModelText(alias);
    const hasChineseBrand = /[\u4e00-\u9fff]/.test(normalized);
    if (normalized.length < 3 && !hasChineseBrand) return;
    const owners = aliasOwners.get(normalized) || new Set<string>();
    owners.add(model);
    aliasOwners.set(normalized, owners);
  };

  for (const model of models) {
    const raw = String(model || "").trim();
    if (!raw) continue;
    const slash = raw.indexOf("/");
    const provider = slash > 0 ? normalizeModelText(raw.slice(0, slash)) : "";
    if (provider) providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
    const base = slash >= 0 ? raw.slice(slash + 1) : raw;
    const tokens = modelTokens(base);
    const simplifiedTokens = tokens.filter(token => !isVersionToken(token));
    addAlias(raw, raw);
    addAlias(base, raw);
    for (const brand of modelBrandAliases(base, provider)) {
      const sourceBrand = modelAliasSourceBrand(brand);
      addAlias(brand, raw);
      addAlias(replaceModelBrandPrefix(base, sourceBrand, brand), raw);
      addAlias(modelBrandVariantAlias(base, sourceBrand, brand), raw);
    }
    if (simplifiedTokens.length >= 2) addAlias(simplifiedTokens.join(" "), raw);
    if (simplifiedTokens.length >= 1) addAlias(simplifiedTokens[0], raw);
  }

  for (const [provider, count] of providerCounts) {
    if (count !== 1) continue;
    const model = models.find(item => normalizeModelText(item).startsWith(`${provider} `));
    if (model) addAlias(provider, model);
  }
  return aliasOwners;
}

function expandedIndexFromCompact(value: string, compactOffset: number): number {
  if (compactOffset < 0) return -1;
  let seen = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (/\s/.test(value[index])) continue;
    if (seen === compactOffset) return index;
    seen += 1;
  }
  return -1;
}

function hasModelDirectiveContext(text: string, index: number, aliasLength: number): boolean {
  const start = Math.max(0, index - 64);
  const end = Math.min(text.length, index + aliasLength + 64);
  const context = text.slice(start, end);
  if (NEGATED_MODEL_DIRECTIVE_PATTERN.test(text.slice(start, index))) return false;
  // A short model-only utterance such as “千问 3.7” is itself a picker
  // action. Reject obvious discussion/education mentions, but do not require
  // a fixed verb before accepting a uniquely matched model name. This is
  // deliberately not a keyword-trigger system: the model name is the signal.
  return !INCIDENTAL_MODEL_MENTION_PATTERN.test(context);
}

/** Extract an explicit, uniquely resolvable model choice from a Live task. */
export function extractLiveModelIntent(body: any, models: string[]): string {
  if (!body || !Array.isArray(models) || models.length === 0) return "";
  const turns = collectLiveIntentTurns(body);
  if (turns.length === 0) return "";

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const text = normalizeModelText(turns[turnIndex].join("\n"));
    if (!text) continue;
    const selected = extractModelFromText(text, models);
    if (selected) return selected;
  }
  return "";
}

function extractModelFromText(text: string, models: string[]): string {
  if (!text) return "";
  let bestAliasLength = 0;
  const matchedModels = new Set<string>();
  const compactText = compactModelText(text);
  for (const [alias, candidates] of modelAliases(models)) {
    let offset = text.indexOf(alias);
    const compactAlias = compactModelText(alias);
    const compactOffset = compactAlias.length >= 3 ? compactText.indexOf(compactAlias) : -1;
    const compactMatch = offset < 0 && compactOffset >= 0;
    if (compactMatch) offset = expandedIndexFromCompact(text, compactOffset);
    while (offset >= 0) {
      const matchLength = Math.max(alias.length, compactAlias.length);
      if (hasModelDirectiveContext(text, offset, alias.length)) {
        if (matchLength > bestAliasLength) {
          bestAliasLength = matchLength;
          matchedModels.clear();
        }
        if (matchLength < bestAliasLength) {
          offset = text.indexOf(alias, offset + Math.max(alias.length, 1));
          continue;
        }
        for (const candidate of candidates) matchedModels.add(candidate);
      }
      offset = compactMatch ? -1 : text.indexOf(alias, offset + alias.length);
    }
  }
  return matchedModels.size === 1 ? Array.from(matchedModels)[0] : "";
}

export function normalizeRealtimeWorkModel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\r\n\t]/g, "").slice(0, 200);
}

export function liveModelSessionKey(body: any): string {
  const metadata = body?.client_metadata || {};
  return String(
    metadata.session_id ||
    metadata.thread_id ||
    metadata.conversation_id ||
    body?.session_id ||
    body?.thread_id ||
    body?.conversation_id ||
    "__active__",
  ).trim() || "__active__";
}

export function isLikelyLiveWorkRequest(body: any): boolean {
  const metadata = body?.client_metadata;
  const tools = body?.tools;
  const input = Array.isArray(body?.input) ? body.input : [];
  // Codex Desktop's Responses requests do not always expose tools at the
  // top level. The real work request advertises the native workspace tool
  // bundle as an `additional_tools` input item instead. Treat that shape as
  // the same handoff boundary; otherwise the request is forwarded to native
  // GPT before the selected provider ever sees `spawn_agent`.
  const hasWorkspaceToolBundle = input.some((item: any) => item?.type === "additional_tools");
  const hasCustomToolActivity = input.some((item: any) =>
    item?.type === "custom_tool_call" || item?.type === "custom_tool_call_output",
  );
  return Boolean(
    metadata && (
      (Array.isArray(tools) && tools.length > 0) ||
      Object.prototype.hasOwnProperty.call(metadata, "x-openai-subagent") ||
      hasWorkspaceToolBundle ||
      hasCustomToolActivity
    )
  );
}

/**
 * A Live conversation can send a model-switch turn without a session_id and
 * without tools. The active realtime connection plus request metadata is the
 * reliable boundary for that turn; requiring session_id drops the switch
 * before intent extraction gets a chance to run.
 */
export function isLikelyLiveModelIntentRequest(body: any, realtimeActive: boolean): boolean {
  if (!realtimeActive || !body || typeof body !== "object") return false;
  const metadata = body.client_metadata;
  return Boolean(
    (metadata && typeof metadata === "object" && !Array.isArray(metadata)) ||
    body.session_id ||
    body.thread_id ||
    body.conversation_id
  );
}

export function isToolContinuation(body: any): boolean {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some((item: any) =>
    item?.type === "function_call_output" ||
    item?.type === "computer_call_output" ||
    item?.type === "custom_tool_call_output" ||
    item?.role === "tool",
  );
}
