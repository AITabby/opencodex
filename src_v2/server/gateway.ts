/**
 * CodexBridge Gateway Server (OpenCodex V2 Core)
 * Ultra-clean, modular HTTP Gateway Server listening on port 8765.
 */

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { GatewayRouter } from "./router.js";
import { CredentialStore } from "../services/credential_store.js";
import { RequestDecompressor } from "../core/decompressor.js";
import { CatalogSyncService, buildFullCatalogEntry } from "../services/catalog_sync.js";
import { SubscriptionAuthService } from "../services/subscription_auth.js";
import { fetchCursorModels } from "../services/cursor_protocol.js";
import { getClaudeDesktopVersion, getCursorClientVersion } from "../services/subscription_auth.js";
import { handleWebRtcProxy, normalizeNativeLiveCallBody, resolveRealtimeUpstream } from "./webrtc_proxy.js";
import { ProviderConfig } from "../core/types.js";
import { closeUpstreamDispatcher, fetchUpstream, upstreamErrorDetails } from "../services/upstream_fetch.js";
import { LIVE_MODEL_BINDING_TTL_MS, LIVE_MODEL_PICKER_TIMEOUT_MS, isLikelyLiveWorkRequest, isToolContinuation, liveModelSessionKey, normalizeRealtimeWorkModel } from "../services/live_model_picker.js";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MASKED_CREDENTIAL = "••••••••";

function isSyntheticToolTrace(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  const toolMarkers = text.match(/(?:read_file|write_file|command|shell_command|function_call)\(/g) || [];
  const hasControlSeparators = /[\u0000-\u001f]/.test(text);
  return toolMarkers.length >= 3 || (toolMarkers.length >= 1 && hasControlSeparators);
}

function extractSessionUuid(value: string): string {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] || value;
}

function extractTranscriptUserText(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = value.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const text = (match?.[1] || value).replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "").trim();
  return isSyntheticToolTrace(text) ? "" : text;
}

function extractRealtimeTranscriptMessages(value: unknown): Array<{ role: "user" | "assistant"; text: string }> {
  if (typeof value !== "string") return [];
  const match = value.match(/<transcript_delta>([\s\S]*?)<\/transcript_delta>/i);
  if (!match) return [];
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^\s*(user|assistant)\s*:\s*([\s\S]*?)\s*$/i);
    if (!parsed) continue;
    const text = parsed[2].trim();
    if (text && !isSyntheticToolTrace(text)) {
      messages.push({ role: parsed[1].toLowerCase() as "user" | "assistant", text });
    }
  }
  return messages;
}

function isInternalRolloutRecord(record: any): boolean {
  if (record?.type === "turn_context" && record.payload?.model === "codex-auto-review") return true;
  if (record?.type !== "session_meta") return false;
  const payload = record.payload || {};
  return payload.thread_source === "subagent" || Boolean(payload.source && typeof payload.source === "object" && payload.source.subagent);
}

type ProjectedSessionMessage = { role: "user" | "assistant"; text: string };

function projectCodexSessionMessages(lines: string[]): ProjectedSessionMessage[] {
  const parsedMessages: Array<ProjectedSessionMessage & { source: "event" | "response" }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "event_msg" && parsed.payload?.type === "user_message" && parsed.payload?.message && !isSyntheticToolTrace(parsed.payload.message)) {
        const msg = parsed.payload.message;
        const realtimeMessages = extractRealtimeTranscriptMessages(msg);
        if (realtimeMessages.length > 0) {
          for (const item of realtimeMessages) parsedMessages.push({ ...item, source: "event" });
        } else if (!msg.startsWith("The following is the Codex agent history") && !msg.startsWith("<")) {
          parsedMessages.push({ role: "user", text: msg, source: "event" });
        }
      } else if (parsed.type === "event_msg" && parsed.payload?.type === "agent_message" && parsed.payload?.message) {
        const msg = parsed.payload.message;
        if (!msg.startsWith("{\"risk_level\"") && !msg.startsWith("{\"outcome\"")) {
          parsedMessages.push({ role: "assistant", text: msg, source: "event" });
        }
      } else if (parsed.type === "response_item") {
        const role = parsed.payload?.role;
        const text = parsed.payload?.content
          ?.map((part: any) => part?.text || part?.input_text || "")
          .join("")
          .trim();
        if (role === "user" || role === "assistant") {
          const realtimeMessages = extractRealtimeTranscriptMessages(text);
          if (realtimeMessages.length > 0) {
            for (const item of realtimeMessages) parsedMessages.push({ ...item, source: "response" });
          } else if (text && !(role === "user" && isSyntheticToolTrace(text)) && !text.startsWith("The following is the Codex agent history") && !text.startsWith("<") && !text.startsWith("{\"risk_level\"") && !text.startsWith("{\"outcome\"")) {
            parsedMessages.push({ role, text, source: "response" });
          }
        }
      }
    } catch {}
  }

  const eventRoles = new Set(parsedMessages.filter((item) => item.source === "event").map((item) => item.role));
  return parsedMessages
    .filter((item) => item.source === "event" || !eventRoles.has(item.role))
    .filter((item, index, list) => index === 0 || item.role !== list[index - 1].role || item.text !== list[index - 1].text)
    .map(({ role, text }) => ({ role, text }));
}

function projectAntigravitySessionMessages(lines: string[]): ProjectedSessionMessage[] {
  const messages: ProjectedSessionMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "USER_INPUT") {
        const realtimeMessages = extractRealtimeTranscriptMessages(parsed.content);
        if (realtimeMessages.length > 0) {
          messages.push(...realtimeMessages);
        } else {
          // Session detail must preserve the complete original user input.
          // The list title has its own length limit; truncating here loses
          // pasted commands, tracebacks, and the end of long voice messages.
          const cleanText = extractTranscriptUserText(parsed.content);
          if (cleanText && !isSyntheticToolTrace(cleanText) && !cleanText.startsWith("<")) messages.push({ role: "user", text: cleanText });
        }
      } else if (parsed.type === "PLANNER_RESPONSE" && parsed.content) {
        messages.push({ role: "assistant", text: parsed.content });
      }
    } catch {}
  }
  return messages;
}

function restartDesktopClients(launchWithCdp: boolean): void {
  const processNames = [
    "ChatGPT", "Codex", "Codex (Service)", "bare-modifier-monitor",
    "browser_crashpad_handler", "Codex Helper", "Codex Helper (Renderer)",
    "Codex Helper (GPU)", "SkyComputerUseClient", "SkyComputerUseService"
  ];
  for (const processName of processNames) {
    try { execFileSync("killall", ["-9", processName], { stdio: "ignore" }); } catch {}
  }
  try { execFileSync("pkill", ["-TERM", "-f", "[c]odex.*app-server"], { stdio: "ignore" }); } catch {}
  try { execFileSync("sleep", ["0.8"], { stdio: "ignore" }); } catch {}
  try { execFileSync("pkill", ["-KILL", "-f", "[c]odex.*app-server"], { stdio: "ignore" }); } catch {}
  if (!launchWithCdp) return;

  for (const application of ["ChatGPT", "Codex"]) {
    try {
      execFileSync("open", ["-a", application, "--args", "--remote-debugging-port=8315"], { stdio: "ignore" });
      return;
    } catch {}
  }
}

function maskVoiceSettings(settings: any): any {
  return {
    ...settings,
    stt_api_key: settings?.stt_api_key || settings?.stt_credential_ref ? MASKED_CREDENTIAL : "",
    tts_api_key: settings?.tts_api_key || settings?.tts_credential_ref ? MASKED_CREDENTIAL : ""
  };
}

type ProviderTestStatus = "untested" | "connected" | "failed" | "simulated";

type LiveModelPickerWaiter = {
  requestId: string;
  sessionKey: string;
  models: string[];
  createdAt: number;
  resolve: (model: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

function recordProviderTest(providerName: string, status: ProviderTestStatus, message: string): void {
  const name = String(providerName || "").trim().toLowerCase();
  if (!name) return;
  const providers = CredentialStore.loadProviders();
  const provider = providers.find((item: any) => item.name === name || item.preset_id === name) as any;
  if (!provider) return;
  provider.last_test_status = status;
  provider.last_test_at = new Date().toISOString();
  provider.last_test_message = message.slice(0, 500);
  CredentialStore.saveProviders(providers);
}

type SubscriptionImportState = {
  imported_at?: string;
  last_test_status?: ProviderTestStatus;
  last_test_at?: string;
  last_test_message?: string;
};

function readSubscriptionImports(dataDir: string): Record<string, SubscriptionImportState> {
  const statePath = path.join(dataDir, "subscription_imports.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function recordSubscriptionImport(dataDir: string, providerName: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dataDir, "subscription_imports.json");
  const imports = readSubscriptionImports(dataDir);
  imports[providerName] = {
    ...imports[providerName],
    imported_at: new Date().toISOString(),
    last_test_status: "untested",
    last_test_message: "订阅已导入，等待测试连接"
  };
  fs.writeFileSync(statePath, JSON.stringify(imports, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(statePath, 0o600);
}

function recordSubscriptionTest(dataDir: string, providerName: string, status: ProviderTestStatus, message: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dataDir, "subscription_imports.json");
  const imports = readSubscriptionImports(dataDir);
  imports[providerName] = {
    ...imports[providerName],
    last_test_status: status,
    last_test_at: new Date().toISOString(),
    last_test_message: message.slice(0, 500)
  };
  fs.writeFileSync(statePath, JSON.stringify(imports, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(statePath, 0o600);
}


function catalogModelOwner(model: any): string {
  const owner = normalizeNamespace(String(model?.backend_provider || model?.provider_name || ""));
  return owner === "opencode-go" ? "opencode" : owner;
}

function catalogModelSlug(model: any): string {
  return String(model?.slug || model?.model || model?.id || "").trim();
}

function normalizeNamespace(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function deriveProviderNamespace(requestedName: string, baseUrl: string): string {
  const requested = normalizeNamespace(requestedName);
  const aliases: Record<string, string> = { "opencode-go": "opencode" };
  if (requested && requested !== "custom") return aliases[requested] || requested;

  let hostname = "";
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch {}
  const knownHosts: Array<[string, string]> = [
    ["deepseek.com", "deepseek"],
    ["x.ai", "xai"],
    ["xiaomimimo.com", "xiaomi"],
    ["openrouter.ai", "openrouter"],
    ["minimaxi.com", "minimax"],
    ["moonshot.cn", "kimi"],
    ["aliyuncs.com", "qwen"],
    ["siliconflow.cn", "siliconflow"],
    ["opencode.ai", "opencode"],
    ["volces.com", "volcengine"],
    ["anthropic.com", "claude"],
    ["openai.com", "openai"],
  ];
  const known = knownHosts.find(([suffix]) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  if (known) return known[1];

  const labels = hostname.split(".").filter(Boolean).filter((label) => !["api", "www", "llm", "gateway", "chat"].includes(label));
  if (labels.length > 1) labels.pop();
  const derived = normalizeNamespace(labels.join("-"));
  return derived || "custom";
}

function providerUrlFingerprint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(baseUrl || "").trim().toLowerCase();
  }
}

function stableShortHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function namespaceModelSlug(providerName: string, rawSlug: string): string {
  const owner = normalizeNamespace(providerName) || "provider";
  const slug = String(rawSlug || "").trim();
  if (!slug) return `${owner}/model`;
  return slug.toLowerCase().startsWith(`${owner}/`) ? slug : `${owner}/${slug}`;
}

function providerDisplayName(providerName: string, rawSlug: string): string {
  const owner = normalizeNamespace(providerName) || "provider";
  const slug = String(rawSlug || "").trim();
  const unscoped = slug.toLowerCase().startsWith(`${owner}/`)
    ? slug.slice(owner.length + 1)
    : slug;
  return `${owner}/${unscoped || "model"}`;
}

function isOfficialCachedModel(model: any): boolean {
  const slug = catalogModelSlug(model).toLowerCase();
  if (!slug || slug === "codex-auto-review" || catalogModelOwner(model)) return false;
  const provider = String(model?.provider || model?.model_provider || "").trim().toLowerCase();
  return provider === "openai" || /^(gpt-|o\d|codex-|chatgpt)/i.test(slug);
}

function readOfficialModelMap(): Map<string, any> {
  const official = new Map<string, any>();
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    for (const model of Array.isArray(cache.models) ? cache.models : []) {
      if (isOfficialCachedModel(model)) official.set(catalogModelSlug(model).toLowerCase(), model);
    }
  } catch {}

  // The cache is normally authoritative. If it is absent or empty, ask the
  // native Codex installation for its current catalog instead of inventing a
  // list. This keeps official models independent from imported providers.
  if (official.size === 0) {
    for (const model of CatalogSyncService.getOfficialModels()) {
      const slug = catalogModelSlug(model).toLowerCase();
      if (slug && slug !== "codex-auto-review") official.set(slug, model);
    }
  }
  return official;
}

function scopedCatalogSlug(providerName: string, rawSlug: string, usedSlugs: Set<string>): string {
  const base = `${providerName}/${rawSlug}`;
  let candidate = base;
  let suffix = 2;
  while (usedSlugs.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

export function migrateProviderCatalogOwner(catalog: any, previousProviderName: string, nextProviderName: string): void {
  if (!catalog || !Array.isArray(catalog.models)) return;
  const previous = normalizeNamespace(previousProviderName);
  const next = normalizeNamespace(nextProviderName);
  if (!previous || !next || previous === next) return;

  const migrated: any[] = [];
  for (const model of catalog.models) {
    if (catalogModelOwner(model) !== previous) {
      migrated.push(model);
      continue;
    }

    const currentSlug = catalogModelSlug(model);
    const rawSlug = currentSlug.toLowerCase().startsWith(`${previous}/`)
      ? currentSlug.slice(previous.length + 1)
      : String(model?.backend_model || currentSlug).trim();
    if (!rawSlug) continue;

    const backendModel = String(model?.backend_model || rawSlug).trim();
    const duplicate = migrated.find((entry: any) =>
      catalogModelOwner(entry) === next
      && String(entry?.backend_model || "").trim().toLowerCase() === backendModel.toLowerCase()
    );
    if (duplicate) continue;

    const usedSlugs = new Set<string>(migrated
      .map((entry: any) => catalogModelSlug(entry).toLowerCase())
      .filter(Boolean));
    const canonical = namespaceModelSlug(next, rawSlug);
    const slug = usedSlugs.has(canonical.toLowerCase())
      ? scopedCatalogSlug(next, rawSlug, usedSlugs)
      : canonical;
    migrated.push({
      ...model,
      slug,
      model: slug,
      backend_provider: next,
      backend_model: backendModel,
      display_name: providerDisplayName(next, slug)
    });
  }

  catalog.models = migrated;
}

export function upsertProviderCatalogModel(
  catalog: any,
  rawSlug: string,
  backendModel: string,
  displayName: string,
  providerName: string
): void {
  if (!catalog || typeof catalog !== "object") return;
  if (!Array.isArray(catalog.models)) catalog.models = [];

  const slug = String(rawSlug || "").trim();
  const backend = String(backendModel || slug).trim();
  const owner = normalizeNamespace(providerName);
  if (!slug || !backend || !owner) return;
  const canonicalSlug = namespaceModelSlug(owner, slug);

  const owned = catalog.models.find((model: any) => {
    if (catalogModelOwner(model) !== owner) return false;
    const modelSlug = catalogModelSlug(model).toLowerCase();
    const modelBackend = String(model?.backend_model || "").trim().toLowerCase();
    return modelSlug === canonicalSlug.toLowerCase()
      || modelSlug === slug.toLowerCase()
      || modelBackend === slug.toLowerCase()
      || modelBackend === backend.toLowerCase();
  });
  if (owned) {
    owned.slug = canonicalSlug;
    owned.model = canonicalSlug;
    owned.backend_model = backend;
    owned.display_name = providerDisplayName(owner, canonicalSlug);
    return;
  }

  const usedSlugs = new Set<string>(catalog.models
    .map((model: any) => catalogModelSlug(model).toLowerCase())
    .filter((slug: string) => Boolean(slug)));
  const catalogSlug = usedSlugs.has(canonicalSlug.toLowerCase())
    ? scopedCatalogSlug(owner, slug, usedSlugs)
    : canonicalSlug;
  const entry = buildFullCatalogEntry(catalogSlug, owner);
  entry.backend_model = backend;
  entry.display_name = providerDisplayName(owner, catalogSlug);
  catalog.models.push(entry);
}

export function preserveOfficialModels(catalog: any): void {
  if (!catalog || typeof catalog !== "object") return;
  if (!Array.isArray(catalog.models)) catalog.models = [];

  const officialMap = readOfficialModelMap();
  const usedSlugs = new Set<string>(officialMap.keys());
  const ownerless: any[] = [];
  const thirdParty: any[] = [];

  for (const model of catalog.models) {
    const slug = catalogModelSlug(model);
    if (!slug) continue;
    const key = slug.toLowerCase();
    const owner = catalogModelOwner(model);

    if (!owner) {
      if (officialMap.has(key)) continue;
      if (!usedSlugs.has(key)) {
        usedSlugs.add(key);
        ownerless.push(model);
      }
      continue;
    }

    // Every provider-owned model gets a stable namespace, even when there is
    // no current collision. This makes future imports and provider changes
    // order-independent.
    const rawSlug = slug.toLowerCase().startsWith(`${owner}/`)
      ? slug.slice(owner.length + 1)
      : slug;
    const canonical = namespaceModelSlug(owner, rawSlug);
    const alias = usedSlugs.has(canonical.toLowerCase())
      ? scopedCatalogSlug(owner, rawSlug, usedSlugs)
      : canonical;
    const backendModel = String(model.backend_model || rawSlug).trim();
    const moved = {
      ...model,
      slug: alias,
      model: alias,
      backend_provider: owner,
      backend_model: backendModel,
      display_name: providerDisplayName(owner, alias)
    };
    usedSlugs.add(alias.toLowerCase());
    thirdParty.push(moved);
  }

  // Official native entries are deliberately first; the web endpoint filters
  // them out, while the desktop client receives them before third-party ones.
  catalog.models = [...officialMap.values(), ...ownerless, ...thirdParty];
}


function hasAntigravityCredential(): boolean {
  return SubscriptionAuthService.hasAntigravityCredential();
}

function hasGrokCredential(): boolean {
  return SubscriptionAuthService.hasGrokCredential();
}

function hasClaudeCredential(): boolean {
  return SubscriptionAuthService.hasClaudeCredential();
}

function hasCursorCredential(): boolean {
  return SubscriptionAuthService.hasCursorCredential();
}

function hasCatalogModelsForProvider(catalogModels: any[], providerName: string): boolean {
  return catalogModels.some((model: any) => model?.backend_provider === providerName);
}

function credentialsMatch(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function resolveRuntimeBinary(name: string): string {
  const runtimeDir = process.env.OPENCODEX_VOICE_RUNTIME_DIR;
  const candidates = [
    runtimeDir ? path.join(runtimeDir, name) : "",
    path.join(os.homedir(), ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === name || fs.existsSync(candidate)) || name;
}

function listRolloutFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(entryPath);
    }
  };
  visit(root);
  return result;
}

function readLogTail(filePath: string, maxBytes = 256 * 1024): string[] {
  if (!fs.existsSync(filePath)) return [];
  let fd: number | null = null;
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf-8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function redactLogLine(line: string): string {
  return line
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,})/g, "[REDACTED]");
}

function isGatewayReasoningItem(record: any): boolean {
  const payload = record?.type === "response_item" ? record.payload : record;
  if (!payload || payload.type !== "reasoning") return false;

  const id = typeof payload.id === "string" ? payload.id : "";
  const legacyGatewayId = /^rs_\d{13}_\d+$/i.test(id);
  const v2GatewayId = /^rs_[0-9a-f]{16}$/i.test(id) && payload.encrypted_content == null;
  const importedThinking = typeof payload.encrypted_content === "string"
    && payload.encrypted_content.startsWith("anthropic-thinking-v1:");
  return legacyGatewayId || v2GatewayId || importedThinking;
}

function normalizeStoredFunctionCallId(record: any): boolean {
  const payload = record?.type === "response_item" ? record.payload : record;
  if (!payload || payload.type !== "function_call" || typeof payload.id !== "string") return false;
  if (/^fc_[A-Za-z0-9_-]+$/.test(payload.id)) return false;

  const safeSource = payload.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "legacy";
  payload.id = `fc_import_${safeSource}`;
  return true;
}

/**
 * Remove only gateway-created reasoning records before native mode resumes.
 * Native Responses reasoning records carry server-managed encrypted content;
 * deleting those would damage a normal GPT rollout, so the V2 pattern also
 * requires the null encrypted_content that this gateway emitted.
 */
function repairNativeRollouts(): number {
  const roots = [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions"),
  ];
  let repaired = 0;

  for (const rolloutPath of roots.flatMap(listRolloutFiles)) {
    let records: any[];
    try {
      records = fs.readFileSync(rolloutPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      continue;
    }

    let changed = false;
    for (const record of records) {
      if (normalizeStoredFunctionCallId(record)) changed = true;
    }

    const sanitized = records.filter((record) => {
      if (isGatewayReasoningItem(record)) {
        changed = true;
        return false;
      }
      return true;
    });
    if (!changed) continue;

    try {
      fs.writeFileSync(rolloutPath, `${sanitized.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
      repaired++;
    } catch (error: any) {
      console.error(`[OpenCodex V2] Could not repair native rollout ${rolloutPath}: ${error.message}`);
    }
  }

  if (repaired > 0) {
    console.log(`[OpenCodex V2] Repaired ${repaired} native rollout(s) before switching off the gateway.`);
  }
  return repaired;
}

export class CodexBridgeServer {
  private port: number;
  private server: http.Server | null = null;
  private serverLockFd: number | null = null;
  private serverLockPath = "";
  private gatewayRestartInProgress = false;
  private router = new GatewayRouter();
  private claudeModelFetchError = "";
  public config: any = { providers: [] };
  private readonly dataDir: string;
  private readonly adminToken: string;
  private liveModelPickerWaiters = new Map<string, LiveModelPickerWaiter>();
  private liveModelBindings = new Map<string, { model: string; expiresAt: number }>();
  private realtimeActiveUntil = 0;

  constructor(port = 8765) {
    this.port = port;
    this.dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex");
    this.adminToken = this.loadOrCreateAdminToken();
    this.config.providers = CredentialStore.loadProviders();
  }

  private loadOrCreateAdminToken(): string {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tokenPath = path.join(this.dataDir, "admin_token");
    try {
      const existing = fs.readFileSync(tokenPath, "utf-8").trim();
      if (existing.length >= 32) {
        fs.chmodSync(tokenPath, 0o600);
        return existing;
      }
    } catch {}

    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    return token;
  }

  private markRealtimeActive(): void {
    this.realtimeActiveUntil = Date.now() + 15 * 60 * 1000;
  }

  private isRealtimeActive(): boolean {
    return this.realtimeActiveUntil > Date.now();
  }

  private availableRealtimeWorkModels(): string[] {
    const models = new Set<string>();
    const addCatalog = (catalogPath: string) => {
      try {
        const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
        for (const model of Array.isArray(catalog?.models) ? catalog.models : []) {
          const slug = normalizeRealtimeWorkModel(model?.slug || model?.id || model?.model);
          if (slug) models.add(slug);
        }
      } catch {}
    };
    addCatalog(path.join(os.homedir(), ".codex", "models_catalog.json"));
    addCatalog(path.join(os.homedir(), ".opencodex", "custom_model_catalog.json"));
    return Array.from(models).sort((a, b) => a.localeCompare(b));
  }

  private liveModelPickerSettingsPath(): string {
    return path.join(os.homedir(), ".opencodex", "voice_settings.json");
  }

  private isLiveModelPickerEnabled(): boolean {
    try {
      const settings = JSON.parse(fs.readFileSync(this.liveModelPickerSettingsPath(), "utf-8"));
      return settings?.live_model_picker_enabled === true;
    } catch {
      return false;
    }
  }

  private setLiveModelPickerEnabled(enabled: boolean): void {
    const settingsPath = this.liveModelPickerSettingsPath();
    let settings: any = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    settings.live_model_picker_enabled = enabled;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    try { fs.chmodSync(settingsPath, 0o600); } catch {}
  }

  private async chooseLiveWorkModel(body: any): Promise<string> {
    if (!this.isRealtimeActive()) {
      this.liveModelBindings.clear();
      return "";
    }

    const now = Date.now();
    const sessionKey = liveModelSessionKey(body);
    const existing = this.liveModelBindings.get(sessionKey);
    if (existing?.expiresAt > now && isToolContinuation(body)) return existing.model;
    if (existing) this.liveModelBindings.delete(sessionKey);
    if (!isLikelyLiveWorkRequest(body)) return "";

    const models = this.availableRealtimeWorkModels();
    if (models.length === 0) {
      console.warn("[OpenCodex Realtime] No models available for the Live picker; falling back to the desktop model");
      return "";
    }

    const requestId = randomUUID();
    const selected = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.liveModelPickerWaiters.delete(requestId);
        resolve("");
      }, LIVE_MODEL_PICKER_TIMEOUT_MS);
      this.liveModelPickerWaiters.set(requestId, {
        requestId,
        sessionKey,
        models,
        createdAt: now,
        resolve,
        timer,
      });
    });

    if (selected) {
      this.liveModelBindings.set(sessionKey, {
        model: selected,
        expiresAt: Date.now() + LIVE_MODEL_BINDING_TTL_MS,
      });
    }
    return selected;
  }

  private pendingLiveModelPicker(): any {
    const waiter = Array.from(this.liveModelPickerWaiters.values())
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!waiter) return { pending: false, realtime_active: this.isRealtimeActive(), enabled: this.isLiveModelPickerEnabled() };
    return {
      pending: true,
      realtime_active: this.isRealtimeActive(),
      enabled: this.isLiveModelPickerEnabled(),
      request_id: waiter.requestId,
      models: waiter.models,
      created_at: waiter.createdAt,
    };
  }

  private resolveLiveModelPicker(requestId: unknown, model: unknown): { ok: boolean; error?: string; cancelled?: boolean } {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    const waiter = this.liveModelPickerWaiters.get(id);
    if (!waiter) return { ok: false, error: "模型选择请求已过期" };
    const selected = normalizeRealtimeWorkModel(model);
    if (!selected) {
      clearTimeout(waiter.timer);
      this.liveModelPickerWaiters.delete(id);
      waiter.resolve("");
      return { ok: true, cancelled: true };
    }
    if (!waiter.models.includes(selected)) {
      return { ok: false, error: "所选模型不在当前可用模型列表中" };
    }
    clearTimeout(waiter.timer);
    this.liveModelPickerWaiters.delete(id);
    waiter.resolve(selected);
    return { ok: true };
  }

  private acquireServerLock(): void {
    const lockPath = path.join(this.dataDir, `gateway-${this.port}.lock`);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port: this.port, started_at: Date.now() }));
      this.serverLockFd = fd;
      this.serverLockPath = lockPath;
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    let ownerPid: number | undefined;
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      if (Number.isInteger(owner?.pid)) ownerPid = owner.pid;
    } catch {}

    if (ownerPid === process.pid) {
      throw new Error(`Gateway port ${this.port} is already owned by this process`);
    }
    if (ownerPid) {
      try {
        process.kill(ownerPid, 0);
        throw new Error(`Gateway port ${this.port} is already owned by PID ${ownerPid}`);
      } catch (error: any) {
        if (error?.message?.includes("already owned")) throw error;
        // The recorded owner is gone; remove only this stale lock and retry.
      }
    }

    try { fs.unlinkSync(lockPath); } catch {}
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port: this.port, started_at: Date.now() }));
    this.serverLockFd = fd;
    this.serverLockPath = lockPath;
  }

  private releaseServerLock(): void {
    if (this.serverLockFd !== null) {
      try { fs.closeSync(this.serverLockFd); } catch {}
      this.serverLockFd = null;
    }
    if (this.serverLockPath) {
      try { fs.unlinkSync(this.serverLockPath); } catch {}
      this.serverLockPath = "";
    }
  }

  private isAdminAuthorized(req: http.IncomingMessage): boolean {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    if (credentialsMatch(bearer, this.adminToken)) return true;

    const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
    const cookieToken = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("opencodex_admin="))
      ?.slice("opencodex_admin=".length) || "";
    return credentialsMatch(cookieToken, this.adminToken);
  }

  private requireAdmin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (this.isAdminAuthorized(req)) return true;
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": "Bearer"
    });
    res.end(JSON.stringify({ error: "OpenCodex admin authentication required" }));
    return false;
  }

  private issueAdminCookie(res: http.ServerResponse): void {
    res.setHeader("Set-Cookie", `opencodex_admin=${this.adminToken}; HttpOnly; SameSite=Strict; Path=/`);
  }

  private parseRawBuffer(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const MAX_BYTES = MAX_REQUEST_BYTES;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy();
          reject(new Error("Request body exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const rawBuffer = Buffer.concat(chunks);
        const contentEncoding = req.headers["content-encoding"] as string | null;
        try {
          const decompressed = RequestDecompressor.decompressBody(rawBuffer, contentEncoding);
          resolve(decompressed);
        } catch {
          resolve(rawBuffer);
        }
      });
      req.on("error", reject);
    });
  }

  private parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const MAX_BYTES = MAX_REQUEST_BYTES;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy();
          reject(new Error("Request body exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const rawBuffer = Buffer.concat(chunks);
          const contentEncoding = req.headers["content-encoding"] as string | null;
          const decompressed = RequestDecompressor.decompressBody(rawBuffer, contentEncoding);
          const str = decompressed.toString("utf-8");
          resolve(str ? JSON.parse(str) : {});
        } catch (err) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private stripReasoningSuffix(modelId: string): string {
    let clean = (modelId || "").trim();
    if (clean.includes("gemini") || clean.includes("grok") || clean.includes("antigravity")) {
      return clean;
    }
    for (const level of ["-minimal", "-low", "-medium", "-high", "-xhigh"]) {
      if (clean.endsWith(level)) {
        return clean.slice(0, -level.length);
      }
    }
    return clean;
  }

  private readImportedModelCatalog(): any[] {
    const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
    try {
      const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      return Array.isArray(data.models) ? data.models : [];
    } catch {
      return [];
    }
  }

  private findCatalogMatches(rawModelName: string): any[] {
    const requested = this.stripReasoningSuffix(rawModelName).toLowerCase();
    if (!requested) return [];
    const catalog = this.readImportedModelCatalog();
    const identityCandidates = (entry: any): string[] => [
      entry.slug, entry.model, entry.id
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());
    const backendCandidates = (entry: any): string[] => [
      entry.backend_model, entry.display_name
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());

    const exactIdentityMatches = catalog.filter((entry) => identityCandidates(entry).some((value) => value === requested));
    if (exactIdentityMatches.length > 0) return exactIdentityMatches;

    const exactBackendMatches = catalog.filter((entry) => backendCandidates(entry).some((value) => value === requested));
    if (exactBackendMatches.length > 0) return exactBackendMatches;

    if (requested.length >= 3) {
      // Accept a short UI alias such as "opus" only when it resolves to one
      // subscription provider. Ambiguous aliases deliberately do not guess.
      return catalog.filter((entry) => [...identityCandidates(entry), ...backendCandidates(entry)].some((value) => value.includes(requested)));
    }
    return [];
  }

  private findCatalogProvider(rawModelName: string, providers: ProviderConfig[]): ProviderConfig | null {
    const matches = this.findCatalogMatches(rawModelName);

    const providerNames = Array.from(new Set(matches
      .map((entry) => catalogModelOwner(entry))
      .filter(Boolean)));
    if (providerNames.length !== 1) return null;

    const providerName = providerNames[0];
    const subscriptionKeys = ["antigravity", "grok", "claude", "cursor"];
    if (subscriptionKeys.includes(providerName)) {
      return {
        name: providerName,
        preset_id: providerName,
        baseUrl: `https://subscription.${providerName}.internal`,
        models: matches.map((entry) => String(entry.slug || entry.model || "")).filter(Boolean)
      };
    }

    return providers.find((provider) => provider.name.toLowerCase() === providerName || provider.preset_id?.toLowerCase() === providerName)
      || { name: providerName, baseUrl: "", models: matches.map((entry) => String(entry.slug || entry.model || "")).filter(Boolean) };
  }

  private findCatalogBackendModel(rawModelName: string): string | null {
    const matches = this.findCatalogMatches(rawModelName);
    const owned = matches.find((entry) => catalogModelOwner(entry));
    if (!owned) return null;
    return String(owned.backend_model || owned.model || owned.slug || "").trim() || null;
  }


  private isNativeCatalogModel(rawModelName: string): boolean {
    const requested = this.stripReasoningSuffix(rawModelName).toLowerCase();
    if (!requested) return false;
    const catalog = this.readImportedModelCatalog();
    return catalog.some((entry: any) => {
      const owner = catalogModelOwner(entry);
      if (owner) return false;
      return [entry.slug, entry.model, entry.id]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .some((value) => value.trim().toLowerCase() === requested);
    });
  }

  private async proxyNativeResponses(req: http.IncomingMessage, body: any, res: http.ServerResponse): Promise<void> {
    const targetUrl = "https://chatgpt.com/backend-api/codex/responses";
    const skipHeaders = new Set(["host", "content-length", "transfer-encoding", "connection", "accept-encoding", "content-encoding"]);
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (skipHeaders.has(key.toLowerCase())) continue;
      if (typeof value === "string") forwardHeaders[key] = value;
      else if (Array.isArray(value)) forwardHeaders[key] = value.join(", ");
    }
    forwardHeaders["host"] = "chatgpt.com";

    try {
      const upstreamRes = await fetchUpstream(targetUrl, {
        method: "POST",
        headers: forwardHeaders,
        body: JSON.stringify(body),
        operation: "native-responses",
      });
      const responseHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      res.writeHead(upstreamRes.status, responseHeaders);
      if (upstreamRes.body) {
        // @ts-ignore Node's fetch body is an async iterable at runtime.
        for await (const chunk of upstreamRes.body) res.write(chunk);
      }
      res.end();
    } catch (err: any) {
      const details = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Native Responses proxy error:`, {
        ...details,
        attempts: err?.attempts,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err.message,
          type: "upstream_unreachable",
          retryable: Boolean(err?.retryable),
          attempts: err?.attempts,
          cause_code: details.code,
        }));
      }
    }
  }

  private ensurePythonScripts() {
    const minimaxScript = `import sys
import os
import json
import urllib.request
import binascii

def main():
    if len(sys.argv) < 3:
        print("ERROR: Missing text or output path")
        sys.exit(1)
        
    text = sys.argv[1]
    output_path = sys.argv[2]
    voice_id = sys.argv[3] if len(sys.argv) > 3 else "presenter_male"
    speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5
    
    api_key = os.environ.get("MINIMAX_API_KEY")
    api_host = os.environ.get("MINIMAX_API_HOST", "https://api.minimaxi.com")
    
    if not api_key:
        print("ERROR: Missing MINIMAX_API_KEY environment variable")
        sys.exit(1)
        
    url = f"{api_host}/v1/t2a_v2"
    
    payload = {
        "model": "speech-2.8-turbo",
        "text": text,
        "stream": False,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": speed,
            "vol": 1.0,
            "pitch": 2,
            "emotion": "happy"
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3"
        },
        "output_format": "hex"
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req) as response:
            res_body = response.read().decode('utf-8')
            res_json = json.loads(res_body)
            
            if res_json.get("base_resp", {}).get("status_code") == 0:
                audio_hex = res_json.get("data", {}).get("audio", "")
                if audio_hex:
                    audio_bytes = binascii.unhexlify(audio_hex)
                    with open(output_path, "wb") as f:
                        f.write(audio_bytes)
                    print(f"SUCCESS: Audio written to {output_path}")
                else:
                    print("ERROR: No audio data in response")
                    sys.exit(1)
            else:
                msg = res_json.get("base_resp", {}).get("status_msg", "Unknown error")
                print(f"ERROR: MiniMax API failed: {msg}")
                sys.exit(1)
    except Exception as e:
        print(f"ERROR: Exception occurred: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()`;

    const transcribeScript = `import sys
import os
import warnings

warnings.filterwarnings("ignore")

try:
    import whisper
    
    if len(sys.argv) < 2:
        print("ERROR: Missing audio file path")
        sys.exit(1)
        
    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"ERROR: File not found: {audio_path}")
        sys.exit(1)
        
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].strip() else "base"
    model = whisper.load_model(model_name)
    
    result = model.transcribe(audio_path, fp16=False)
    print(result.get("text", "").strip())
except Exception as e:
    print(f"ERROR: {str(e)}")
    sys.exit(1)`;

    const sileroVadScript = `import sys
import os
import json
import base64
import warnings

warnings.filterwarnings("ignore")

import torch
import numpy as np

def main():
    try:
        from silero_vad import load_silero_vad, get_speech_timestamps
        model = load_silero_vad()
    except Exception as e:
        print(json.dumps({"error": f"Failed to load VAD model: {str(e)}"}))
        sys.exit(1)

    print(json.dumps({"status": "ready"}), flush=True)

    accumulated_samples = []

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        
        line = line.strip()
        if not line:
            continue
            
        try:
            req = json.loads(line)
            action = req.get("action")
            
            if action == "reset":
                accumulated_samples = []
                print(json.dumps({"status": "reset"}), flush=True)
                continue
                
            elif action == "chunk":
                b64_data = req.get("data", "")
                pcm_bytes = base64.b64decode(b64_data)
                
                chunk_samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                accumulated_samples.extend(chunk_samples)
                
                audio_tensor = torch.from_numpy(np.array(accumulated_samples, dtype=np.float32))
                
                speech_timestamps = get_speech_timestamps(audio_tensor, model, sampling_rate=16000, threshold=0.45)
                has_speech = len(speech_timestamps) > 0
                
                total_duration_sec = len(audio_tensor) / 16000.0
                last_speech_end_sec = 0.0
                if has_speech:
                    last_speech_end_sec = speech_timestamps[-1]['end'] / 16000.0
                    
                silence_at_end_sec = total_duration_sec - last_speech_end_sec
                
                result = {
                    "has_speech": has_speech,
                    "total_duration": total_duration_sec,
                    "last_speech_end": last_speech_end_sec,
                    "silence_at_end": silence_at_end_sec,
                }
                print(json.dumps(result), flush=True)
                
            elif action == "exit":
                break
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

if __name__ == "__main__":
    main()`;

    try {
      fs.writeFileSync("/tmp/ocb_minimax_tts.py", minimaxScript, "utf-8");
      fs.writeFileSync("/tmp/ocb_transcribe.py", transcribeScript, "utf-8");
      fs.writeFileSync("/tmp/ocb_silero_vad_daemon.py", sileroVadScript, "utf-8");
      console.log("[OpenCodex] Written helper python scripts to /tmp successfully.");
    } catch (err: any) {
      console.error("[OpenCodex] Failed to write helper python scripts: " + err.message);
    }
  }

  private vadProcess: any = null;
  private vadStdoutBuffer: string = "";
  private vadCallbackQueue: ((value: any) => void)[] = [];
  private readonly useEnergyVAD = process.env.OPENCODEX_VOICE_ENERGY_VAD === "1" || Boolean(process.env.OPENCODEX_VOICE_RUNTIME_DIR);
  private currentSystemUtterance: string = "";
  private voiceSessionThreadIds = new Map<string, string>();
  // Native voice responses are observed through one shared CDP connection.
  // Keeping this state on the gateway prevents overlapping voice/ask requests
  // from broadcasting chunks from more than one Codex response at once.
  private nativeVoiceObserverWs: any = null;
  private nativeVoiceObserverTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeVoiceObserverRun = 0;
  private mcpProcess: any = null;
  private mcpRequestId = 0;
  private mcpRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void; onDelta?: (text: string) => void; accumulatedReply: string }>();
  private mcpStdoutBuffer = "";

  private startVADDaemon() {
    if (this.vadProcess) return;

    const scriptPath = "/tmp/ocb_silero_vad_daemon.py";
    console.error(`[OpenCodex VAD] Starting persistent VAD daemon from: ${scriptPath}`);

    this.vadProcess = spawn("python3", [scriptPath]);
    this.vadStdoutBuffer = "";
    this.vadCallbackQueue = [];

    this.vadProcess.stdout.on("data", (data: Buffer) => {
      this.vadStdoutBuffer += data.toString();
      let lines = this.vadStdoutBuffer.split("\n");
      this.vadStdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const res = JSON.parse(trimmed);
          if (res.status === "ready") {
            console.error("[OpenCodex VAD] Daemon is warmed up and ready.");
            continue;
          }
          if (res.status === "reset") {
            const cb = this.vadCallbackQueue.shift();
            if (cb) cb(res);
            continue;
          }
          const cb = this.vadCallbackQueue.shift();
          if (cb) cb(res);
        } catch (e: any) {
          console.error(`[OpenCodex VAD Daemon Parse Error] ${e.message} for line: ${trimmed}`);
        }
      }
    });

    this.vadProcess.stderr.on("data", (data: Buffer) => {
      console.error(`[OpenCodex VAD Daemon Stderr] ${data.toString().trim()}`);
    });

    this.vadProcess.on("close", (code: number) => {
      console.error(`[OpenCodex VAD Daemon Closed] Exit code: ${code}`);
      this.vadProcess = null;
      this.vadCallbackQueue = [];
    });
  }

  private sendVADRequest(req: any): Promise<any> {
    if (this.useEnergyVAD) {
      if (req?.action === "reset") return Promise.resolve({ status: "reset" });
      if (req?.action === "chunk") {
        try {
          const pcm = Buffer.from(String(req.data || ""), "base64");
          let sum = 0;
          let samples = 0;
          for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
            const sample = pcm.readInt16LE(offset) / 32768;
            sum += sample * sample;
            samples++;
          }
          const rms = samples > 0 ? Math.sqrt(sum / samples) : 0;
          const db = rms > 0 ? 20 * Math.log10(rms) : -120;
          return Promise.resolve({ has_speech: db > -42, silence_at_end: db > -42 ? 0 : 1 });
        } catch {
          return Promise.resolve({ has_speech: false, silence_at_end: 0 });
        }
      }
    }
    this.startVADDaemon();
    return new Promise((resolve) => {
      if (!this.vadProcess) {
        resolve({ error: "VAD process not running" });
        return;
      }
      this.vadCallbackQueue.push(resolve);
      this.vadProcess.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private antigravityModelFetchError = "";

  private async fetchAntigravityModelsDynamic(): Promise<Array<{ slug: string; name: string }>> {
    this.antigravityModelFetchError = "";
    try {
      let token = await SubscriptionAuthService.getAntigravityAccessToken();

      if (!token) {
        this.antigravityModelFetchError = hasAntigravityCredential()
          ? "检测到 Antigravity 登录态，但访问令牌已失效且刷新失败；请在 Antigravity 中重新登录"
          : "未检测到 Antigravity 登录凭证，请先完成登录";
        return [];
      }

      const fetchModels = async (accessToken: string): Promise<Response> => fetch(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/hub/2.2.1 darwin/arm64"
          },
          body: JSON.stringify({ project: "default-cli-project" }),
          signal: AbortSignal.timeout(30000),
        },
      );

      let res = await fetchModels(token);
      if (res.status === 401 || res.status === 403) {
        const refreshedToken = await SubscriptionAuthService.getAntigravityAccessToken(true);
        if (refreshedToken) res = await fetchModels(refreshedToken);
      }
      if (!res.ok) {
        this.antigravityModelFetchError = `Antigravity 模型目录请求失败（HTTP ${res.status}）`;
        return [];
      }

      const data = await res.json() as any;
      const modelsMap = data.models && typeof data.models === "object" ? data.models : {};
      const result: Array<{ slug: string; name: string }> = [];
      const seen = new Set<string>();

      // The desktop client can place models in multiple groups. Preserve the
      // vendor ordering while collecting every group, then fall back to the
      // model map for responses without sort metadata.
      const modelIds: string[] = [];
      for (const sort of Array.isArray(data.agentModelSorts) ? data.agentModelSorts : []) {
        for (const group of Array.isArray(sort?.groups) ? sort.groups : []) {
          for (const id of Array.isArray(group?.modelIds) ? group.modelIds : []) {
            if (typeof id === "string" && id.trim()) modelIds.push(id.trim());
          }
        }
      }
      if (modelIds.length === 0) modelIds.push(...Object.keys(modelsMap));

      for (const id of modelIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const info = modelsMap[id] || {};
        const displayName = info.displayName || id;
        result.push({ slug: id, name: displayName });
      }
      if (result.length > 0) return result;

      this.antigravityModelFetchError = "Antigravity 实时模型目录返回成功，但没有可用模型";
    } catch (err: any) {
      this.antigravityModelFetchError = `Antigravity 模型目录请求异常：${err?.message || "未知错误"}`;
      console.error("[OpenCodex] Dynamic Antigravity model fetch failed:", err?.message);
    }

    // Do not manufacture subscription models when the live catalog request
    // fails. A fallback list can make a model from one subscription appear
    // to belong to another provider and falsely report an import.
    return [];
  }

  private async fetchGrokModelsDynamic(): Promise<Array<{ slug: string; name: string }>> {
    try {
      let token = await SubscriptionAuthService.getGrokAccessToken();

      if (token) {
        let res = await fetch("https://api.x.ai/v1/models", {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        });
        if (res.status === 401 || res.status === 403) {
          token = await SubscriptionAuthService.getGrokAccessToken(true);
          if (token) {
            res = await fetch("https://api.x.ai/v1/models", {
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
              }
            });
          }
        }
        if (res.ok) {
          const data = await res.json() as any;
          if (Array.isArray(data.data) && data.data.length > 0) {
            const result: Array<{ slug: string; name: string }> = [];
            for (const item of data.data) {
              const id = item.id;
              if (id) {
                result.push({ slug: id, name: item.name || id });
              }
            }
            if (result.length > 0) return result;
          }
        }
      }
    } catch (err: any) {
      console.error("[OpenCodex] Dynamic Grok model fetch failed:", err?.message);
    }
    return [];
  }

  private async fetchClaudeModelsDynamic(): Promise<Array<{ slug: string; name: string }>> {
    this.claudeModelFetchError = "";
    try {
      const token = await SubscriptionAuthService.getClaudeAccessToken();
      if (!token) {
        const failure = SubscriptionAuthService.getClaudeAuthFailure();
        this.claudeModelFetchError = failure.includes("requires a Pro or Max subscription")
          ? "已读取 Claude 登录态，但 Claude Code 订阅要求 Pro 或 Max 套餐"
          : failure.startsWith("authorize_http_403")
            ? "已读取 Claude 登录态，但 Claude 上游拒绝了订阅授权"
            : failure.startsWith("desktop_cookie_unavailable")
              ? "未能读取 Claude Desktop 登录态，请重新登录 Claude"
              : "Claude 登录态无法换取可用订阅令牌";
        return [];
      }
      const isApiKey = token.startsWith("sk-ant-");
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "Accept": "application/json",
      };
      if (isApiKey) {
        headers["x-api-key"] = token;
      } else {
        headers["anthropic-beta"] = "oauth-2025-04-20";
        headers["anthropic-client-platform"] = "DESKTOP_APP";
        headers["anthropic-client-version"] = getClaudeDesktopVersion();
      }
      const res = await fetch("https://api.anthropic.com/v1/models?beta=true", {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        if (Array.isArray(data.data) && data.data.length > 0) {
          return data.data
            .filter((m: any) => m?.id)
            .map((m: any) => ({ slug: String(m.id), name: String(m.display_name || m.id) }));
        }
      } else {
        const errorText = (await res.text()).replace(/\s+/g, " ");
        this.claudeModelFetchError = /requires a Pro or Max subscription/i.test(errorText)
          ? "已读取 Claude 登录态，但 Claude Code 订阅要求 Pro 或 Max 套餐"
          : res.status === 401
            ? "Claude 订阅令牌已失效，请重新登录 Claude"
            : `Claude 模型目录请求失败（HTTP ${res.status}）`;
      }
    } catch (err: any) {
      console.error("[OpenCodex] Dynamic Claude model fetch failed:", err?.message);
      this.claudeModelFetchError = "Claude 模型目录请求异常，请稍后重试";
    }
    return [];
  }

  private async fetchCursorModelsDynamic(): Promise<Array<{ slug: string; name: string }>> {
    try {
      let token = await SubscriptionAuthService.getCursorAccessToken();
      if (!token) return [];
      let result = await fetchCursorModels(token, getCursorClientVersion(), AbortSignal.timeout(15000));
      if (result.length > 0) return result;

      token = await SubscriptionAuthService.getCursorAccessToken(true);
      if (!token) return [];
      result = await fetchCursorModels(token, getCursorClientVersion(), AbortSignal.timeout(15000));
      return result;
    } catch (err: any) {
      console.error("[OpenCodex] Dynamic Cursor model fetch failed:", err?.message);
    }
    return [];
  }

  public async start(overridePort?: number): Promise<void> {

    if (overridePort && typeof overridePort === "number") {
      this.port = overridePort;
    }
    this.acquireServerLock();
    try {
      this.ensurePythonScripts();
    } catch (error) {
      this.releaseServerLock();
      throw error;
    }
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
    let managedConfig = "";
    try { managedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : ""; } catch {}
    // Native mode deliberately leaves the imported catalog untouched. In
    // managed mode, always repair the catalog first so native Codex models
    // cannot disappear just because a third-party entry was deleted.
    if (managedConfig.includes("opencodex managed")) {
      const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
      let catalog: any = { models: [] };
      if (fs.existsSync(catalogPath)) {
        try { catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")); } catch {}
      }
      if (!Array.isArray(catalog.models)) catalog.models = [];
      const before = JSON.stringify(catalog.models);
      preserveOfficialModels(catalog);

      if (before !== JSON.stringify(catalog.models)) {
        try {
          fs.mkdirSync(path.dirname(catalogPath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), { encoding: "utf-8", mode: 0o600 });
          try { fs.chmodSync(catalogPath, 0o600); } catch {}
        } catch (err: any) {
          // A read-only test/container home must not prevent the gateway from
          // starting. The next writable start will persist the repair.
          console.warn(`[OpenCodex Gateway] Could not persist model catalog repair: ${err?.message || err}`);
        }
      }
    }
    return new Promise(async (resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

        // Handle WebSocket Upgrade HTTP requests with 426 Upgrade Required (triggers codex-rs HTTP fallback)
        if (req.headers.upgrade?.toLowerCase() === "websocket" || (req.headers.connection || "").toLowerCase().includes("upgrade")) {
          if (url.pathname.includes("realtime") || url.pathname.includes("audio") || url.pathname.startsWith("/v1/live/")) {
            // Handled by server.on("upgrade") for transparent proxying to api.openai.com
            return;
          }
          res.writeHead(426, {
            "Content-Type": "application/json",
            "Sec-WebSocket-Version": "13",
            "Connection": "close",
          });
          res.end(JSON.stringify({ error: { message: "Responses WebSocket transport is disabled; use HTTP", type: "upgrade_required" } }));
          return;
        }

        // 1. Handshake / Healthcheck & Dashboard UI
        if (req.method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", name: "CodexBridge Engine V2", version: "1.0.5", opencodex: true }));
          return;
        }

        // The dashboard and the bundled visualizer establish a same-origin,
        // HttpOnly admin cookie. Native voice/mobile clients use the same
        // token through Authorization: Bearer. Keep every local-data and
        // process-control API behind that boundary.
        if (url.pathname.startsWith("/api/") && !this.requireAdmin(req, res)) {
          return;
        }

        // Native OpenAI Realtime / Audio / Voice transparent HTTP proxy
        if (url.pathname.startsWith("/v1/realtime") || url.pathname.startsWith("/v1/audio") || url.pathname.startsWith("/v1/voice") || url.pathname === "/v1/live" || url.pathname.startsWith("/v1/live/") || url.pathname.startsWith("/backend-api/")) {
          if (url.pathname === "/v1/live" || url.pathname.startsWith("/v1/live/")) this.markRealtimeActive();
          const realtimeUpstream = resolveRealtimeUpstream(req, { localAdminToken: this.adminToken });
          const targetUrl = realtimeUpstream.targetUrl;

          try {
            const rawBody = ["POST", "PUT", "PATCH"].includes(req.method || "") ? await this.parseRawBuffer(req) : undefined;
            const requestHeaders = { ...realtimeUpstream.headers };
            let upstreamBody: BodyInit | undefined = rawBody ? new Uint8Array(rawBody) : undefined;
            if (realtimeUpstream.nativeLiveCall && req.method === "POST" && rawBody) {
              const normalizedBody = normalizeNativeLiveCallBody(rawBody, requestHeaders["content-type"] || "");
              upstreamBody = new Uint8Array(normalizedBody).slice();
              requestHeaders["content-type"] = "application/json";
            }
            const upstreamRes = await fetchUpstream(targetUrl, {
              method: req.method,
              headers: {
                ...requestHeaders,
                host: realtimeUpstream.targetHost,
                "accept-encoding": "identity",
              },
              body: upstreamBody,
              operation: realtimeUpstream.nativeSession ? "realtime-native-http" : "realtime-api-http",
            });

            const respHeaders: Record<string, string> = {};
            upstreamRes.headers.forEach((value, key) => {
              respHeaders[key] = value;
            });

            res.writeHead(upstreamRes.status, respHeaders);
            if (upstreamRes.body) {
              // @ts-ignore
              for await (const chunk of upstreamRes.body) {
                res.write(chunk);
              }
            }
            res.end();
          } catch (err: any) {
            const details = upstreamErrorDetails(err);
            console.error(`[CodexBridge V2] Realtime HTTP proxy error:`, {
              ...details,
              attempts: err?.attempts,
            });
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: err.message,
                type: "upstream_unreachable",
                retryable: Boolean(err?.retryable),
                attempts: err?.attempts,
                cause_code: details.code,
              }));
            }
          }
          return;
        }

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
          const { getDashboardHtml } = await import("../services/dashboard.js");
          this.issueAdminCookie(res);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(getDashboardHtml());
          return;
        }

        // 2. V2 Core: Responses API (/v1/responses)
        if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
          try {
            const body = await this.parseJsonBody(req);
            const liveWorkModel = await this.chooseLiveWorkModel(body);
            const effectiveBody = liveWorkModel ? { ...body, model: liveWorkModel } : body;
            if (liveWorkModel && body.model !== liveWorkModel) {
              console.log(`[OpenCodex Realtime] Applied selected Live work model: ${body.model || "(default)"} -> ${liveWorkModel}`);
            }
            console.log(`[CodexBridge V2 DEBUG] POST /v1/responses body keys:`, Object.keys(effectiveBody), "model:", effectiveBody.model);
            const rawRequestedModel = effectiveBody.model || "deepseek-v4-pro";
            const requestedModel = this.stripReasoningSuffix(rawRequestedModel);
            const providers = CredentialStore.loadProviders();
            // Subscription imports are the source of truth. A model may only
            // use the provider recorded beside it in the imported catalog.
            const provider = this.findCatalogProvider(requestedModel, providers);

            if (!provider) {
              if (this.isNativeCatalogModel(requestedModel)) {
                await this.proxyNativeResponses(req, effectiveBody, res);
                return;
              }
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: `Model "${rawRequestedModel}" is not present in an imported provider catalog; no fallback provider was selected`
              }));
              return;
            }

            const apiKey = CredentialStore.resolveApiKey(provider);
            const rawUrl = (provider as any).baseUrl || (provider as any).base_url || (provider as any).url || "https://opencode.ai/zen/go/v1";
            const providerUrl = rawUrl.endsWith("/chat/completions") ? rawUrl : `${rawUrl.replace(/\/$/, "")}/chat/completions`;
            const upstreamModel = this.findCatalogBackendModel(requestedModel) || requestedModel;

            await this.router.handleResponses(effectiveBody, upstreamModel, apiKey, providerUrl, res, provider.name);
          } catch (err: any) {
            if (!res.headersSent) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          }
          return;
        }

        // 3. Dashboard REST API Routes
        if (req.method === "GET" && url.pathname === "/api/gateway/status") {
          const configPath = path.join(os.homedir(), ".codex", "config.toml");
          let active = false;
          if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            active = content.includes("opencodex managed");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ active }));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/live-model-picker/pending") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.pendingLiveModelPicker()));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/live-model-picker/settings") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ enabled: this.isLiveModelPickerEnabled() }));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/live-model-picker/settings") {
          try {
            const body = await this.parseJsonBody(req);
            if (typeof body?.enabled !== "boolean") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "enabled 必须是布尔值" }));
              return;
            }
            this.setLiveModelPickerEnabled(body.enabled);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ enabled: body.enabled }));
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/live-model-picker/resolve") {
          try {
            const body = await this.parseJsonBody(req);
            const result = this.resolveLiveModelPicker(body?.request_id, body?.model);
            res.writeHead(result.ok ? 200 : 409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/providers/presets") {
          const presets = [
            { id: "deepseek", label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com/v1", iconSlug: "deepseek", models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] },
            { id: "qwen", label: "通义千问 (Qwen)", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", iconSlug: "qwen", models: [{ id: "qwen-max" }, { id: "qwen-plus" }] },
            { id: "minimax", label: "MiniMax", defaultBaseUrl: "https://api.minimaxi.com/v1", iconSlug: "minimax", models: [{ id: "minimax-m3" }] },
            { id: "kimi", label: "Kimi (Moonshot)", defaultBaseUrl: "https://api.moonshot.cn/v1", iconSlug: "kimi", models: [{ id: "moonshot-v1-8k" }] },
            { id: "custom", label: "自定义兼容接口", defaultBaseUrl: "", iconSlug: "", models: [] },
            { id: "openrouter", label: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", iconSlug: "openrouter", models: [{ id: "anthropic/claude-3.5-sonnet" }] },
            { id: "opencode-go", label: "OpenCode Go", defaultBaseUrl: "https://opencode.ai/zen/go/v1", iconSlug: "", models: [{ id: "opencode-go-pro" }] },
            { id: "siliconflow", label: "SiliconFlow (硅基流动)", defaultBaseUrl: "https://api.siliconflow.cn/v1", iconSlug: "", models: [{ id: "deepseek-ai/DeepSeek-V3" }] },
            { id: "volcengine", label: "火山方舟 (Volcengine)", defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", iconSlug: "", models: [{ id: "ep-20241201-xxxx" }] }
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ presets }));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/providers") {
          const configPath = path.join(os.homedir(), ".codex", "config.toml");
          let isGatewayActive = false;
          if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            isGatewayActive = content.includes("opencodex managed");
          }

          const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
          let catalogModels: any[] = [];
          if (fs.existsSync(catalogPath)) {
            try {
              const cat = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              catalogModels = cat.models || [];
            } catch {}
          }

          const subscriptionImports = readSubscriptionImports(this.dataDir);
          const cliProviders = [
            {
              id: "antigravity",
              name: "antigravity",
              status: hasCatalogModelsForProvider(catalogModels, "antigravity") ? "configured" : "not_configured",
              test_status: subscriptionImports.antigravity?.last_test_status || "untested",
              credential_storage: "keychain",
              active_models: catalogModels.filter((m: any) => m.backend_provider === "antigravity").map((m: any) => ({ id: m.slug, enabled: true }))
            },
            {
              id: "grok",
              name: "grok",
              status: hasCatalogModelsForProvider(catalogModels, "grok") ? "configured" : "not_configured",
              test_status: subscriptionImports.grok?.last_test_status || "untested",
              credential_storage: "keychain",
              active_models: catalogModels.filter((m: any) => m.backend_provider === "grok").map((m: any) => ({ id: m.slug, enabled: true }))
            },
            {
              id: "claude",
              name: "claude",
              status: hasCatalogModelsForProvider(catalogModels, "claude") ? "configured" : "not_configured",
              test_status: subscriptionImports.claude?.last_test_status || "untested",
              credential_storage: "none",
              active_models: catalogModels.filter((m: any) => m.backend_provider === "claude").map((m: any) => ({ id: m.slug, enabled: true }))
            }
          ];

          const apiProviders = CredentialStore.loadProviders().map((p: any) => {
            const hasApiKey = Boolean(CredentialStore.resolveApiKey(p));
            const effectiveModels = (p.models || []).filter((model: string) => {
              const raw = String(model);
              const alias = raw.includes("=") ? raw.split("=")[0] : raw.includes("->") ? raw.split("->")[0] : raw;
              return catalogModels.some((cm: any) =>
                catalogModelOwner(cm) === normalizeNamespace(p.name)
                && [cm.slug, cm.id, cm.display_name, cm.backend_model].filter(Boolean).some((value: any) => String(value) === alias)
              );
            });
            const hasActiveModel = effectiveModels.length > 0;

            const status = hasActiveModel || hasApiKey ? "configured" : "not_configured";

            const { api_key: _apiKey, api_key_env: _apiKeyEnv, refresh_token: _refreshToken, ...safeProvider } = p;
            return {
              ...safeProvider,
              models: effectiveModels,
              id: p.name,
              api_key_configured: hasApiKey,
              status,
              test_status: p.last_test_status || "untested",
              credential_storage: hasApiKey ? (p.credential_ref ? "keychain" : "local-secure-store") : "none",
              active_models: effectiveModels.map((m: string) => {
                const raw = String(m);
                const alias = raw.includes("=") ? raw.split("=")[0] : raw.includes("->") ? raw.split("->")[0] : raw;
                const catalogModel = catalogModels.find((cm: any) =>
                  catalogModelOwner(cm) === normalizeNamespace(p.name)
                  && [cm.slug, cm.id, cm.display_name, cm.backend_model].filter(Boolean).some((value: any) => String(value) === alias)
                );
                return { id: catalogModel?.slug || alias, enabled: true };
              })
            };
          });

          const providers = [...cliProviders, ...apiProviders];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ providers }));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/providers") {
          try {
            const body = await this.parseJsonBody(req);
            const requestedProviderName = String(body.name || body.preset_id || "custom").trim().toLowerCase();
            const presetId = String(body.preset_id || requestedProviderName).trim().toLowerCase();
            const baseUrl = String(body.base_url || "").trim();
            const apiKey = String(body.api_key || "").trim();
            const selectedModels: string[] = Array.isArray(body.selected_models) ? body.selected_models : [];

            let providers = CredentialStore.loadProviders();
            let provider = providers.find((p: any) => p.name === requestedProviderName)
              || providers.find((p: any) => p.preset_id === presetId);
            const previousProviderName = normalizeNamespace(provider?.name || "");
            const providerName = deriveProviderNamespace(
              presetId === "custom" ? "custom" : (provider?.preset_id || requestedProviderName),
              baseUrl
            );
            let resolvedProviderName = providerName;
            if (!provider) {
              const conflict = providers.find((p: any) => normalizeNamespace(p.name) === resolvedProviderName);
              if (conflict && providerUrlFingerprint((conflict as any).baseUrl || (conflict as any).base_url) !== providerUrlFingerprint(baseUrl)) {
                resolvedProviderName = `${resolvedProviderName}-${stableShortHash(providerUrlFingerprint(baseUrl))}`;
              }
            } else if (provider.preset_id === "custom" && previousProviderName !== resolvedProviderName) {
              const conflict = providers.find((p: any) => p !== provider && normalizeNamespace(p.name) === resolvedProviderName);
              if (conflict && providerUrlFingerprint((conflict as any).baseUrl || (conflict as any).base_url) !== providerUrlFingerprint(baseUrl)) {
                resolvedProviderName = `${resolvedProviderName}-${stableShortHash(providerUrlFingerprint(baseUrl))}`;
              }
            }
            if (!provider) {
              provider = { name: resolvedProviderName, preset_id: presetId, baseUrl, models: selectedModels };
              providers.push(provider);
            } else {
              provider.baseUrl = baseUrl || provider.baseUrl;
              provider.name = resolvedProviderName;
              provider.preset_id = presetId;
              // The dashboard sends the complete current list. Replace the
              // stored list so removals and edits are reflected on reopen.
              provider.models = Array.from(new Set(selectedModels));
            }

            // Saving or changing configuration invalidates the previous connectivity result.
            provider.last_test_status = "untested";
            delete provider.last_test_at;
            delete provider.last_test_message;

            if (apiKey) {
              CredentialStore.setApiKey(resolvedProviderName, apiKey);
            }
            CredentialStore.saveProviders(providers);

            // Update custom model catalog if install_models is true.
            // Remove models previously owned by this provider but omitted from
            // the latest list, otherwise the next edit resurrects them.
            if (body.install_models !== false) {
              const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
              let catalog: any = { models: [] };
              if (fs.existsSync(catalogPath)) {
                try { catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")); } catch {}
              }
              if (!Array.isArray(catalog.models)) catalog.models = [];
              migrateProviderCatalogOwner(catalog, previousProviderName, resolvedProviderName);
              preserveOfficialModels(catalog);

              const desiredSlugs = new Set<string>();
              for (const modelStr of selectedModels) {
                const separator = modelStr.includes("=") ? "=" : (modelStr.includes("->") ? "->" : "");
                const parts = separator ? modelStr.split(separator) : [modelStr];
                for (const part of parts) {
                  const value = String(part || "").trim().toLowerCase();
                  if (value) desiredSlugs.add(value);
                }
              }
              catalog.models = catalog.models.filter((entry: any) => {
                if (catalogModelOwner(entry) !== resolvedProviderName) return true;
                return ![entry.slug, entry.model, entry.backend_model]
                  .filter(Boolean)
                  .some((value: any) => desiredSlugs.has(String(value).trim().toLowerCase()));
              });

              for (const modelStr of selectedModels) {
                let slug = modelStr;
                let backendModel = modelStr;
                if (modelStr.includes("=")) {
                  const parts = modelStr.split("=");
                  slug = parts[0].trim();
                  backendModel = parts[1].trim();
                } else if (modelStr.includes("->")) {
                  const parts = modelStr.split("->");
                  slug = parts[0].trim();
                  backendModel = parts[1].trim();
                }
                upsertProviderCatalogModel(catalog, slug, backendModel, slug, resolvedProviderName);
              }

              preserveOfficialModels(catalog);
              fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");

              // Ensure opencodex managed block is enabled in config.toml
              const configPath = path.join(os.homedir(), ".codex", "config.toml");
              if (fs.existsSync(configPath)) {
                let content = fs.readFileSync(configPath, "utf-8");
                if (!content.includes("opencodex managed")) {
                  const managedBlock = `\n# >>> opencodex managed >>>\nmodel_catalog_json = "${catalogPath}"\n# <<< opencodex managed <<<\n`;
                  fs.writeFileSync(configPath, content + managedBlock, "utf-8");
                }
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", provider }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/cli-bridge/status") {
          const configPath = path.join(os.homedir(), ".codex", "config.toml");
          let isGatewayActive = false;
          if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            // A leftover model_catalog_json entry is harmless in native mode.
            // Only the managed block means the gateway is currently enabled.
            isGatewayActive = content.includes("opencodex managed");
          }

          let catalogModels: any[] = [];
          const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
          if (fs.existsSync(catalogPath)) {
            try {
              const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              catalogModels = Array.isArray(catalog.models) ? catalog.models : [];
            } catch {}
          }
          const hasAntigravity = hasAntigravityCredential();
          const hasGrok = hasGrokCredential();
          const hasClaude = hasClaudeCredential();
          const hasCursor = hasCursorCredential();

          const imports = readSubscriptionImports(this.dataDir);

          const status = {
            antigravity: {
              detected: hasAntigravity,
              active: isGatewayActive && hasCatalogModelsForProvider(catalogModels, "antigravity"),
              test_status: imports.antigravity?.last_test_status || "untested",
              test_message: imports.antigravity?.last_test_message || ""
            },
            grok: {
              detected: hasGrok,
              active: isGatewayActive && hasCatalogModelsForProvider(catalogModels, "grok"),
              test_status: imports.grok?.last_test_status || "untested",
              test_message: imports.grok?.last_test_message || ""
            },
            claude: {
              detected: hasClaude,
              active: hasClaude && isGatewayActive && hasCatalogModelsForProvider(catalogModels, "claude"),
              test_status: imports.claude?.last_test_status || "untested",
              test_message: imports.claude?.last_test_message || ""
            },
            cursor: {
              detected: hasCursor,
              active: hasCursor && isGatewayActive && hasCatalogModelsForProvider(catalogModels, "cursor"),
              test_status: imports.cursor?.last_test_status || "untested",
              test_message: imports.cursor?.last_test_message || ""
            }
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
          return;
        }


        if (req.method === "POST" && url.pathname === "/api/cli-bridge/activate") {
          try {
            const body = await this.parseJsonBody(req);
            const cli = body.cli || "antigravity";
            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            let catalog: any = { models: [] };
            if (fs.existsSync(catalogPath)) {
              try { catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")); } catch {}
            }
            if (!Array.isArray(catalog.models)) catalog.models = [];
            preserveOfficialModels(catalog);

            const addModel = (slug: string, name: string, providerName: string) => {
              upsertProviderCatalogModel(catalog, slug, slug, name, providerName);
            };

            if (cli === "antigravity") {
              const dynamicModels = await this.fetchAntigravityModelsDynamic();
              if (dynamicModels.length === 0) {
                throw new Error(this.antigravityModelFetchError || "Antigravity 没有返回实时可用模型，未执行导入；不会使用内置兜底模型");
              }
              catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "antigravity");
              for (const m of dynamicModels) {
                addModel(m.slug, m.name, "antigravity");
              }
            } else if (cli === "grok") {
              const dynamicGrokModels = await this.fetchGrokModelsDynamic();
              if (dynamicGrokModels.length === 0) {
                throw new Error("Grok 没有返回实时可用模型，未执行导入；不会使用内置兜底模型");
              }
              catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "grok");
              for (const m of dynamicGrokModels) {
                addModel(m.slug, m.name, "grok");
              }
            } else if (cli === "claude") {
              const dynamicClaudeModels = await this.fetchClaudeModelsDynamic();
              if (dynamicClaudeModels.length === 0) {
                throw new Error(this.claudeModelFetchError || "Claude 没有返回可用模型，未执行导入；请检查本机登录态");
              }
              catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "claude");
              for (const m of dynamicClaudeModels) {
                addModel(m.slug, m.name, "claude");
              }
            } else if (cli === "cursor") {
              const dynamicCursorModels = await this.fetchCursorModelsDynamic();
              if (dynamicCursorModels.length === 0) {
                throw new Error("Cursor 没有返回可用模型，未执行导入；请检查本机登录态");
              }
              catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "cursor");
              for (const m of dynamicCursorModels) {
                addModel(m.slug, m.name, "cursor");
              }
            }

            preserveOfficialModels(catalog);
            fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");

            // Also ensure opencodex block is enabled in config.toml
            const configPath = path.join(os.homedir(), ".codex", "config.toml");
            if (fs.existsSync(configPath)) {
              let content = fs.readFileSync(configPath, "utf-8");
              if (!content.includes("opencodex managed")) {
                const managedBlock = `\n# >>> opencodex managed >>>\nmodel_catalog_json = "${catalogPath}"\n# <<< opencodex managed <<<\n`;
                fs.writeFileSync(configPath, content + managedBlock, "utf-8");
              }
            }

            recordSubscriptionImport(this.dataDir, String(cli));

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", cli }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/providers/test") {
          try {
            const body = await this.parseJsonBody(req);
            const providerName = String(body.name || body.preset_id || "").trim().toLowerCase();
            let baseUrl = body.base_url || body.baseUrl;
            let apiKey = body.api_key || body.apiKey;

            const finishTest = (status: ProviderTestStatus, message: string) => {
              if (providerName === "antigravity" || providerName === "grok" || providerName === "claude" || providerName === "cursor") {
                recordSubscriptionTest(this.dataDir, providerName, status, message);
              } else {
                recordProviderTest(providerName, status, message);
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status, message }));
            };

            try {
              const found = CredentialStore.loadProviders().find((p: any) => p.name === providerName || p.preset_id === providerName);
              if (found) {
                baseUrl = baseUrl || (found as any).baseUrl || (found as any).base_url;
                apiKey = apiKey || CredentialStore.resolveApiKey(found);
              }
            } catch {}

            if (!providerName) {
              finishTest("failed", "缺少服务商名称");
              return;
            }

            if (providerName === "antigravity") {
              const liveModels = await this.fetchAntigravityModelsDynamic();
              finishTest(
                liveModels.length > 0 ? "connected" : "failed",
                liveModels.length > 0
                  ? `Google Antigravity 订阅正常，已获取 ${liveModels.length} 个实时模型`
                  : this.antigravityModelFetchError || (hasAntigravityCredential()
                    ? "检测到 Antigravity 登录态，但实时模型获取失败；登录态可能已过期或被撤销"
                    : "未检测到 Antigravity 登录凭证，请先完成登录")
              );
              return;
            }

            if (providerName === "grok") {
              const liveModels = await this.fetchGrokModelsDynamic();
              finishTest(
                liveModels.length > 0 ? "connected" : "failed",
                liveModels.length > 0
                  ? `x.AI Grok 订阅正常，已获取 ${liveModels.length} 个实时模型`
                  : hasGrokCredential()
                    ? "检测到 Grok 登录态，但实时模型获取失败；登录态可能已过期或被撤销"
                    : "未检测到 Grok 登录凭证，请在终端运行 grok login"
              );
              return;
            }

            if (providerName === "claude") {
              const liveModels = await this.fetchClaudeModelsDynamic();
              finishTest(
                liveModels.length > 0 ? "connected" : "failed",
                liveModels.length > 0
                  ? `Claude 订阅正常，已获取 ${liveModels.length} 个可用模型`
                  : this.claudeModelFetchError || (hasClaudeCredential()
                    ? "检测到 Claude 登录态，但可用模型获取失败"
                    : "Claude 本机登录态不存在或已失效，请先完成 Claude 登录")
              );
              return;
            }

            if (providerName === "cursor") {
              const liveModels = await this.fetchCursorModelsDynamic();
              finishTest(
                liveModels.length > 0 ? "connected" : "failed",
                liveModels.length > 0
                  ? `Cursor 订阅正常，已获取 ${liveModels.length} 个可用模型`
                  : hasCursorCredential()
                    ? "检测到 Cursor 登录态，但可用模型获取失败"
                    : "未检测到 Cursor 登录凭证，请先完成登录"
              );
              return;
            }


            if (!baseUrl) {
              finishTest("failed", "未配置 Endpoint / Base URL");
              return;
            }

            const cleanUrl = baseUrl.replace(/\/$/, "");
            const testTargetUrl = cleanUrl.endsWith("/models") ? cleanUrl : `${cleanUrl}/models`;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);

            try {
              const testRes = await fetch(testTargetUrl, {
                method: "GET",
                headers: {
                  ...(apiKey && apiKey !== "grok-cli-auto" && apiKey !== "antigravity-cli-auto" ? { Authorization: `Bearer ${apiKey}` } : {})
                },
                signal: controller.signal
              });
              clearTimeout(timer);

              if (testRes.status === 401 || testRes.status === 403) {
                finishTest("failed", `接口可连通，但 API Key 无效或未授权 (HTTP ${testRes.status})`);
                return;
              }

              finishTest("connected", "服务商网络与接口连接成功");
              return;
            } catch (netErr: any) {
              clearTimeout(timer);
              const isTimeout = netErr.name === "AbortError";
              const errMsg = isTimeout ? "连接超时 (6s)" : (netErr.message || "网络握手失败");
              finishTest("failed", `无法连接到服务商 Endpoint (${baseUrl}): ${errMsg}`);
              return;
            }
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "failed", message: err.message }));
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/voice-bar/status") {
          let running = false;
          try { running = Boolean(execFileSync("pgrep", ["-x", "OpenCodexBar"], { encoding: "utf-8" }).trim()); } catch {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ running, available: true, message: running ? "语音栏运行中" : "OpenCodexBar 已就绪" }));
          return;
        }

        const stopNativeVoiceResponseObserver = () => {
          this.nativeVoiceObserverRun += 1;
          if (this.nativeVoiceObserverTimer) {
            clearTimeout(this.nativeVoiceObserverTimer);
            this.nativeVoiceObserverTimer = null;
          }
          if (this.nativeVoiceObserverWs) {
            try { this.nativeVoiceObserverWs.close(); } catch {}
            this.nativeVoiceObserverWs = null;
          }
        };

        const broadcastNativeVoiceChunk = (text: string, run: number) => {
          if (run !== this.nativeVoiceObserverRun) return;
          const msg = JSON.stringify({ type: "model_chunk", text });
          if ((global as any).activeWsClients) {
            for (const ws of (global as any).activeWsClients) {
              try { if (ws.readyState === 1) ws.send(msg); } catch {}
            }
          }
        };

        const broadcastNativeVoiceDone = (text: string, run: number) => {
          if (run !== this.nativeVoiceObserverRun) return;
          const msg = JSON.stringify({ type: "model_done", text });
          if ((global as any).activeWsClients) {
            for (const ws of (global as any).activeWsClients) {
              try { if (ws.readyState === 1) ws.send(msg); } catch {}
            }
          }
        };

        const startNativeVoiceResponseObserver = async () => {
          stopNativeVoiceResponseObserver();
          const run = this.nativeVoiceObserverRun;

          try {
            const response = await fetch("http://127.0.0.1:8315/json");
            const targets: any[] = await response.json() as any[];
            const pageTarget = targets.find((t: any) =>
              t.type === "page" &&
              t.url.includes("index.html") &&
              !t.url.includes("avatar-overlay") &&
              !t.url.includes("initialRoute") &&
              t.webSocketDebuggerUrl
            );
            if (!pageTarget) return;
            if (run !== this.nativeVoiceObserverRun) return;

            const { WebSocket } = await import("ws");
            const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
            if (run !== this.nativeVoiceObserverRun) {
              try { ws.close(); } catch {}
              return;
            }
            this.nativeVoiceObserverWs = ws;

            const snapshotExpression = `(() => ({
              messages: [...document.querySelectorAll('[data-content-search-unit-key$=":assistant"]')].map((el) => ({
                key: el.getAttribute('data-content-search-unit-key') || '',
                text: [...el.querySelectorAll('[data-selected-text-overlay-target]')]
                  .map((node) => (node.innerText || node.textContent || '').trim())
                  .filter(Boolean).join('\\n').trim()
              })),
              generating: [...document.querySelectorAll('button')].some((button) => {
                const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.getAttribute('title') || '') + ' ' + (button.innerText || '')).toLowerCase();
                return label.includes('stop generating') || label.includes('停止生成') || label.includes('停止');
              })
            }))()`;

            let baselineKeys = new Set<string>();
            let baselineCaptured = false;
            let lastKey = "";
            let emittedText = "";
            let latestText = "";
            let stablePolls = 0;
            let queryId = 1;
            const deadline = Date.now() + 120_000;

            const sendSnapshot = () => {
              if (run !== this.nativeVoiceObserverRun || ws.readyState !== 1) return;
              const id = queryId++;
              ws.send(JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression: snapshotExpression, returnByValue: true }
              }));
              (ws as any).__nativeVoiceQueryId = id;
            };

            const poll = () => {
              if (run !== this.nativeVoiceObserverRun || Date.now() > deadline || ws.readyState !== 1) {
                if (run === this.nativeVoiceObserverRun) stopNativeVoiceResponseObserver();
                return;
              }
              this.nativeVoiceObserverTimer = setTimeout(sendSnapshot, 250);
            };

            ws.on("open", () => {
              if (run !== this.nativeVoiceObserverRun) {
                try { ws.close(); } catch {}
                return;
              }
              ws.send(JSON.stringify({
                id: 1,
                method: "Runtime.evaluate",
                params: { expression: snapshotExpression, returnByValue: true }
              }));
              (ws as any).__nativeVoiceQueryId = 1;
            });

            ws.on("message", (data: any) => {
              if (run !== this.nativeVoiceObserverRun) return;
              try {
                const message = JSON.parse(data.toString());
                if (message.id !== (ws as any).__nativeVoiceQueryId) return;
                const value = message.result?.result?.value;
                if (!value || !Array.isArray(value.messages)) {
                  poll();
                  return;
                }

                if (message.id === 1 && !baselineCaptured) {
                  baselineCaptured = true;
                  for (const item of value.messages) {
                    if (item.key) baselineKeys.add(item.key);
                  }
                  poll();
                  return;
                }

                const candidates = value.messages.filter((item: any) => item.key && !baselineKeys.has(item.key));
                const current = candidates[candidates.length - 1];
                if (!current) {
                  poll();
                  return;
                }

                const currentKey = String(current.key);
                const currentText = typeof current.text === "string" ? current.text : "";
                if (currentKey !== lastKey) {
                  lastKey = currentKey;
                  emittedText = "";
                  stablePolls = 0;
                }

                if (currentText === latestText) stablePolls += 1;
                else stablePolls = 0;
                latestText = currentText;

                if (currentText && currentText.startsWith(emittedText)) {
                  const delta = currentText.slice(emittedText.length);
                  if (delta) broadcastNativeVoiceChunk(delta, run);
                  emittedText = currentText;
                } else if (currentText && currentText !== emittedText) {
                  broadcastNativeVoiceChunk(currentText, run);
                  emittedText = currentText;
                }

                const generating = Boolean(value.generating);
                if (currentText && !generating && stablePolls >= 3) {
                  broadcastNativeVoiceDone(currentText, run);
                  stopNativeVoiceResponseObserver();
                  return;
                }
              } catch {}
              poll();
            });
          } catch {}
        };

        if (req.method === "POST" && url.pathname === "/api/voice/ask") {
          try {
            const body = await this.parseJsonBody(req);
            const prompt = String(body.prompt || "").trim();
            if (!prompt) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Prompt is empty" }));
              return;
            }

            const sessionId = body.session_id || "default";

            // 1. Resolve active thread ID from CDP page URL or SQLite fallback
            let activeThreadId = "";
            try {
              const cdRes = await fetch("http://127.0.0.1:8315/json");
              if (cdRes.ok) {
                const targets: any = await cdRes.json();
                const pageTarget = Array.isArray(targets) && targets.find((t: any) =>
                  t.type === "page" && t.url.includes("index.html") &&
                  !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute") &&
                  t.webSocketDebuggerUrl
                );
                if (pageTarget) {
                  const { WebSocket } = await import("ws");
                  activeThreadId = await new Promise<string>((resolve) => {
                    const tempWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
                    tempWs.on("open", () => {
                      tempWs.send(JSON.stringify({ id: 100, method: "Runtime.evaluate", params: { expression: "window.location.href", returnByValue: true } }));
                    });
                    tempWs.on("message", (d: any) => {
                      try {
                        const msg = JSON.parse(d.toString());
                        if (msg.id === 100 && msg.result?.result?.value) {
                          const match = msg.result.result.value.match(/[?&]thread_id=([^&]+)/);
                          resolve(match?.[1] || "");
                          tempWs.close();
                        }
                      } catch { resolve(""); }
                    });
                    tempWs.on("error", () => { resolve(""); });
                    setTimeout(() => { try { tempWs.close(); } catch {}; resolve(""); }, 3000);
                  });
                }
              }
            } catch {}
            if (!activeThreadId) {
              try {
                const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
                if (fs.existsSync(dbPath)) {
                  const cp = await import("node:child_process");
                  activeThreadId = cp.execFileSync("sqlite3", [dbPath, "SELECT id FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1;"], { encoding: "utf-8" }).trim();
                }
              } catch {}
            }
            if (activeThreadId) {
              this.voiceSessionThreadIds.set(sessionId, activeThreadId);
            }

            // Start native voice observer before prompt in native mode
            startNativeVoiceResponseObserver();

            // Perform CDP injection with retry
            const injectRes = await this.injectPromptViaCDP(prompt);
            if (injectRes !== "success") {
              // Relaunch Codex with CDP and retry once
              restartDesktopClients(true);

              let cdpReady = false;
              for (let i = 0; i < 40; i++) {
                await new Promise((r) => setTimeout(r, 250));
                try {
                  const checkRes = await fetch("http://127.0.0.1:8315/json");
                  if (checkRes.ok) {
                    const targets: any = await checkRes.json();
                    if (Array.isArray(targets) && targets.find((t: any) => t.type === "page" && typeof t.url === "string" && t.url.includes("index.html"))) {
                      cdpReady = true;
                      break;
                    }
                  }
                } catch {}
              }

              if (cdpReady) {
                startNativeVoiceResponseObserver();
                const retryRes = await this.injectPromptViaCDP(prompt);
                if (retryRes === "success") {
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ status: "injected", reply: "" }));
                  return;
                }
              }
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Failed to inject prompt via CDP: ${injectRes}` }));
              return;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "injected", reply: "" }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/voice/tts") {
          try {
            const body = await this.parseJsonBody(req);
            const text = String(body.text || "").replace(/[\(\uFF08][^\)\uFF09]*[\)\uFF09]/g, "").replace(/[\[\u3010][^\]\u3011]*[\]\u3011]/g, "").trim();
            if (!text) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Text is empty" }));
              return;
            }

            if (text) {
              this.currentSystemUtterance = text;
              const estimatedDuration = Math.max(2000, text.length * 250) + 2000;
              setTimeout(() => {
                if (this.currentSystemUtterance === text) {
                  this.currentSystemUtterance = "";
                }
              }, estimatedDuration);
            }

            const settingsPath = path.join(os.homedir(), ".opencodex", "voice_settings.json");
            let settings: any = {};
            if (fs.existsSync(settingsPath)) {
              try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
            }

            const engine = settings.tts_engine || "edge-tts";
            const apiKey = settings.tts_api_key || CredentialStore.readKeychainSecret("OpenCodex Voice Credential", settings.tts_credential_ref) || "";
            const baseUrl = settings.tts_base_url || "https://api.openai.com/v1";
            const model = settings.tts_model || "tts-1";
            const voice = settings.tts_voice || "zh-CN-XiaoxiaoNeural";

            let audioBuf: Buffer | null = null;
            const cp = await import("node:child_process");

            // 1. Doubao / Volcengine TTS
            if (engine === "doubao" || (settings.tts_base_url && settings.tts_base_url.includes("bytedance"))) {
              try {
                const appid = settings.tts_appid || "";
                const resourceId = settings.tts_resource || settings.tts_resource_id || "seed-tts-2.0";
                let doubaoUrl = settings.tts_base_url || "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
                if (!doubaoUrl.startsWith("http") || doubaoUrl.includes("api.openai.com")) {
                  doubaoUrl = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
                }
                const crypto = await import("node:crypto");
                const reqid = crypto.randomUUID();
                let headers: Record<string, string> = {};
                let bodyPayload: any = {};

                if (appid) {
                  headers = {
                    "Content-Type": "application/json",
                    "X-Api-App-Key": appid,
                    "X-Api-Access-Key": apiKey,
                    "X-Api-Resource-Id": resourceId,
                    "X-Api-Request-Id": reqid
                  };
                  bodyPayload = {
                    app: { appid, token: apiKey, cluster: resourceId.includes("icl") ? "volcano_icl" : "volcano_tts" },
                    user: { uid: "opencodex_user" },
                    audio: { voice_type: voice, encoding: "mp3" },
                    request: { reqid, text, text_type: "plain", operation: "submit" }
                  };
                } else {
                  headers = {
                    "Content-Type": "application/json",
                    "X-Api-Key": apiKey,
                    "X-Api-Resource-Id": resourceId,
                    "X-Api-Request-Id": reqid
                  };
                  let modelVal = settings.tts_model || "seed-tts-2.0-expressive";
                  if (modelVal === "tts-1" || modelVal === "seed-tts-2.0") modelVal = "seed-tts-2.0-expressive";
                  bodyPayload = { req_params: { text, model: modelVal, speaker: voice, encoding: "mp3" } };
                }

                const apiRes = await fetch(doubaoUrl, { method: "POST", headers, body: JSON.stringify(bodyPayload) });
                if (apiRes.ok) {
                  const resText = await apiRes.text();
                  const lines = resText.split("\n");
                  let chunks: Buffer[] = [];
                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                      const json = JSON.parse(trimmed);
                      if (json.data) chunks.push(Buffer.from(json.data, "base64"));
                    } catch {}
                  }
                  if (chunks.length > 0) audioBuf = Buffer.concat(chunks);
                } else {
                  console.error(`[Doubao TTS Err ${apiRes.status}] ${await apiRes.text()}`);
                }
              } catch (e: any) {
                console.error(`[Doubao TTS Exception] ${e.message}`);
              }
            } else if (engine === "openai-compatible" || engine === "openai") {
              try {
                const apiRes = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
                  method: "POST",
                  headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({ model, input: text, voice })
                });
                if (apiRes.ok) {
                  const arrBuf = await apiRes.arrayBuffer();
                  audioBuf = Buffer.from(arrBuf);
                }
              } catch {}
            } else if (engine === "edge-tts") {
              try {
                const tmpMp3 = path.join(os.tmpdir(), `tts-edge-${Date.now()}.mp3`);
                const speed = typeof settings.tts_speed === "number" ? settings.tts_speed : 1.2;
                const edgeArgs = ["edge-tts", "--voice", voice, "--text", text, "--write-media", tmpMp3];
                if (speed !== 1.0) {
                  const pct = Math.round((speed - 1.0) * 100);
                  const rateStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
                  edgeArgs.push("--rate", rateStr);
                }
                cp.execFileSync(resolveRuntimeBinary("uvx"), edgeArgs, { stdio: "ignore" });
                if (fs.existsSync(tmpMp3)) {
                  audioBuf = fs.readFileSync(tmpMp3);
                  try { fs.unlinkSync(tmpMp3); } catch {}
                }
              } catch {}
            } else if (engine === "minimax") {
              try {
                const { WebSocket: WsClient } = await import("ws");
                audioBuf = await new Promise<Buffer | null>((resolve) => {
                  const ws = new WsClient("wss://api.minimaxi.com/ws/v1/t2a_v2", {
                    headers: { "Authorization": `Bearer ${apiKey}` }
                  });
                  let audioData = Buffer.alloc(0);
                  const modelName = settings.tts_model || "speech-2.8-hd";
                  const finalModel = (modelName === "tts-1" || modelName === "tts-1-hd" || !modelName.startsWith("speech-"))
                    ? "speech-2.8-hd" : modelName;
                  const voiceId = voice || "presenter_female";
                  const wsSpeed = typeof settings.tts_speed === "number" ? settings.tts_speed : 1.2;

                  ws.on("open", () => {
                    ws.send(JSON.stringify({
                      event: "task_start",
                      model: finalModel,
                      voice_setting: { voice_id: voiceId, speed: wsSpeed },
                      audio_setting: { sample_rate: 24000, format: "mp3", channel: 1 }
                    }));
                  });
                  ws.on("message", (rawData: any) => {
                    try {
                      const msg = JSON.parse(rawData.toString());
                      if (msg.event === "task_started") {
                        ws.send(JSON.stringify({ event: "task_continue", text }));
                        return;
                      }
                      const audioHex = msg.data?.audio || "";
                      if (audioHex) audioData = Buffer.concat([audioData, Buffer.from(audioHex, "hex")]);
                      if (msg.is_final) {
                        ws.send(JSON.stringify({ event: "task_finish" }));
                        ws.close();
                        resolve(audioData);
                      }
                    } catch { ws.close(); resolve(null); }
                  });
                  ws.on("error", () => resolve(null));
                  setTimeout(() => { try { ws.close(); } catch {}; resolve(null); }, 30000);
                });
              } catch {}
            } else if (engine === "mimo") {
              try {
                const mimoHost = settings.tts_base_url || "https://api.xiaomimimo.com";
                const mimoVoice = voice || "Chloe";
                const stylePrompt = settings.voice_system_prompt || "Natural, clear and friendly tone, standard pace.";
                const apiRes = await fetch(`${mimoHost}/v1/chat/completions`, {
                  method: "POST",
                  headers: { "api-key": apiKey, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: "mimo-v2.5-tts",
                    messages: [{ role: "user", content: stylePrompt }, { role: "assistant", content: text }],
                    audio: { format: "mp3", voice: mimoVoice },
                    stream: false
                  })
                });
                if (apiRes.ok) {
                  const resJson: any = await apiRes.json();
                  const audioBase64 = resJson.choices?.[0]?.message?.audio?.data;
                  if (audioBase64) audioBuf = Buffer.from(audioBase64, "base64");
                }
              } catch {}
            }

            // Reliable Native Fallback if Cloud/Edge TTS didn't produce audio
            if (!audioBuf || audioBuf.length === 0) {
              const tmpAiff = path.join(os.tmpdir(), `tts-say-${Date.now()}.aiff`);
              try {
                cp.execFileSync(resolveRuntimeBinary("say"), ["-o", tmpAiff, text], { stdio: "ignore" });
                if (fs.existsSync(tmpAiff)) {
                  audioBuf = fs.readFileSync(tmpAiff);
                  try { fs.unlinkSync(tmpAiff); } catch {}
                }
              } catch {}
            }

            if (audioBuf && audioBuf.length > 0) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuf);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "TTS synthesis failed" }));
            }
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/voice/stt") {
          try {
            const chunks: Buffer[] = [];
            let bytes = 0;
            req.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_REQUEST_BYTES) {
                req.destroy();
                return;
              }
              chunks.push(chunk);
            });
            await new Promise<void>((resolve) => req.on("end", resolve));
            const rawBody = Buffer.concat(chunks);

            const settingsPath = path.join(os.homedir(), ".opencodex", "voice_settings.json");
            let settings: any = {
              stt_engine: "local-whisper",
              stt_api_key: "",
              stt_base_url: "https://api.openai.com/v1",
              stt_model: "whisper-1"
            };
            if (fs.existsSync(settingsPath)) {
              try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, "utf-8")) }; } catch {}
            }

            const audioPath = path.join(os.tmpdir(), `opencodex-stt-${randomUUID()}.wav`);
            fs.writeFileSync(audioPath, rawBody);

            const engine = settings.stt_engine || "local-whisper";
            try {
              if (engine === "openai-compatible" || engine === "groq") {
                const text = await this.transcribeAudioAPI(audioPath, settings);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ text }));
              } else {
                await new Promise<void>((resolve) => {
                  this.transcribeAudioLocal(audioPath, settings, (text) => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ text: text || "" }));
                    resolve();
                  });
                });
              }
            } finally {
              try { fs.unlinkSync(audioPath); } catch {}
            }
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message, text: "" }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/voice-bar/launch") {
          try {
            // 1. 冷重启 Codex Desktop 带 Remote Debugging Port 8315
            restartDesktopClients(true);

            // 2. 等待 CDP 8315 就绪
            let cdpReady = false;
            for (let i = 0; i < 40; i++) {
              await new Promise((r) => setTimeout(r, 250));
              try {
                const checkRes = await fetch("http://127.0.0.1:8315/json");
                if (checkRes.ok) {
                  const targets: any = await checkRes.json();
                  const pageTarget = Array.isArray(targets) && targets.find((t: any) => t.type === "page" && typeof t.url === "string" && t.url.includes("index.html"));
                  if (pageTarget) {
                    cdpReady = true;
                    break;
                  }
                }
              } catch {}
            }

            // 3. 启动 OpenCodexBar 语音条
            const sourceVoiceBarCandidates = [
              path.join(process.cwd(), "voice", "OpenCodexBar", ".build", "arm64-apple-macosx", "release", "OpenCodexBar"),
              path.join(process.cwd(), "voice", "OpenCodexBar", ".build", "release", "OpenCodexBar"),
              path.join(process.cwd(), "voice", "OpenCodexBar", ".build", "out", "Products", "Release", "OpenCodexBar")
            ];
            const sourceVoiceBar = sourceVoiceBarCandidates.find((candidate) => fs.existsSync(candidate)) || sourceVoiceBarCandidates[0];
            const barBinPath = process.env.OPENCODEX_VOICE_BAR_PATH || sourceVoiceBar;
            if (!fs.existsSync(barBinPath)) {
              throw new Error(`找不到内置 OpenCodexBar：${barBinPath}。请先运行 npm run build:all 或重新安装 DMG。`);
            }
            try { execFileSync("pkill", ["-x", "OpenCodexBar"], { stdio: "ignore" }); } catch {}
            const barProcess = spawn(barBinPath, [], {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, OPENCODEX_GATEWAY_PORT: String(this.port) }
            });
            barProcess.unref();

            // 4. 等待 OpenCodexBar 进程启动
            let voiceReady = false;
            for (let i = 0; i < 30; i++) {
              await new Promise((r) => setTimeout(r, 250));
              try {
                const pgrepOut = execFileSync("pgrep", ["-x", "OpenCodexBar"], { encoding: "utf-8" }).trim();
                if (pgrepOut.length > 0) {
                  voiceReady = true;
                  break;
                }
              } catch {}
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", method: "swift-run", codex_restarted: true, cdp_ready: cdpReady, voice_ready: voiceReady }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/voice-settings") {
          try {
            const data = await this.parseJsonBody(req);
            const settingsDir = path.join(os.homedir(), ".opencodex");
            if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
            const settingsPath = path.join(settingsDir, "voice_settings.json");
            let previous: any = {};
            if (fs.existsSync(settingsPath)) {
              try { previous = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
            }
            const incomingSttKey = typeof data.stt_api_key === "string" ? data.stt_api_key.trim() : "";
            const incomingTtsKey = typeof data.tts_api_key === "string" ? data.tts_api_key.trim() : "";
            const sttAccount = "voice:stt";
            const ttsAccount = "voice:tts";
            const voiceCredentialService = "OpenCodex Voice Credential";
            const sttCredentialRef = data.clear_stt_api_key
              ? ""
              : (incomingSttKey && incomingSttKey !== MASKED_CREDENTIAL
                ? `keychain:${voiceCredentialService}:${sttAccount}`
                : (previous.stt_credential_ref || ""));
            const ttsCredentialRef = data.clear_tts_api_key
              ? ""
              : (incomingTtsKey && incomingTtsKey !== MASKED_CREDENTIAL
                ? `keychain:${voiceCredentialService}:${ttsAccount}`
                : (previous.tts_credential_ref || ""));

            // Existing installations may still have plaintext voice keys. Migrate
            // them once, then never write them back to voice_settings.json.
            const sttSecret = data.clear_stt_api_key
              ? ""
              : (incomingSttKey && incomingSttKey !== MASKED_CREDENTIAL ? incomingSttKey : (previous.stt_api_key || ""));
            const ttsSecret = data.clear_tts_api_key
              ? ""
              : (incomingTtsKey && incomingTtsKey !== MASKED_CREDENTIAL ? incomingTtsKey : (previous.tts_api_key || ""));
            if (sttSecret) CredentialStore.writeKeychainSecret(voiceCredentialService, sttAccount, sttSecret);
            if (ttsSecret) CredentialStore.writeKeychainSecret(voiceCredentialService, ttsAccount, ttsSecret);
            if (data.clear_stt_api_key) CredentialStore.deleteKeychainSecret(voiceCredentialService, sttAccount);
            if (data.clear_tts_api_key) CredentialStore.deleteKeychainSecret(voiceCredentialService, ttsAccount);

            const settings = {
              stt_engine: data.stt_engine || "local-whisper",
              stt_api_key: "",
              stt_base_url: data.stt_base_url || "https://api.openai.com/v1",
              stt_model: data.stt_model || "whisper-1",
              tts_engine: data.tts_engine || "edge-tts",
              tts_api_key: "",
              tts_base_url: data.tts_base_url || "https://api.openai.com/v1",
              tts_model: data.tts_model || "tts-1",
              tts_voice: data.tts_voice || "zh-CN-XiaoxiaoNeural",
              tts_speed: typeof data.tts_speed === "number" ? data.tts_speed : 1.2,
              tts_appid: data.tts_appid || "",
              tts_resource: data.tts_resource || "",
              tts_resource_id: data.tts_resource || "",
              voice_system_prompt: data.voice_system_prompt || "",
              vad_threshold: typeof data.vad_threshold === "number" ? data.vad_threshold : -35.0,
              vad_duration: typeof data.vad_duration === "number" ? data.vad_duration : 2.0,
              voice_llm_model: data.voice_llm_model || "",
              live_model_picker_enabled: typeof data.live_model_picker_enabled === "boolean"
                ? data.live_model_picker_enabled
                : previous.live_model_picker_enabled === true,
              interaction_mode: data.interaction_mode === "push-to-talk" ? "push-to-talk" : (data.interaction_mode === "toggle" ? "toggle" : "toggle"),
              enable_wake_word: typeof data.enable_wake_word === "boolean" ? data.enable_wake_word : false,
              hud_theme: ["vortex", "siri"].includes(data.hud_theme) ? data.hud_theme : "vortex",
              stt_credential_ref: sttCredentialRef,
              tts_credential_ref: ttsCredentialRef
            };

            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
            fs.chmodSync(settingsPath, 0o600);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", settings: maskVoiceSettings(settings) }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/voice-settings") {
          const settingsPath = path.join(os.homedir(), ".opencodex", "voice_settings.json");
          let settings: any = {
            stt_engine: "local-whisper",
            stt_api_key: "",
            stt_base_url: "https://api.openai.com/v1",
            stt_model: "whisper-1",
            tts_engine: "edge-tts",
            tts_api_key: "",
            tts_base_url: "https://api.openai.com/v1",
            tts_model: "tts-1",
            tts_voice: "zh-CN-XiaoxiaoNeural",
            tts_speed: 1.2,
            tts_appid: "",
            tts_resource: "",
            tts_resource_id: "",
            voice_system_prompt: "",
            vad_threshold: -35.0,
            vad_duration: 2.0,
            voice_llm_model: "",
            live_model_picker_enabled: false,
            interaction_mode: "toggle",
            hud_theme: "vortex"
          };
          if (fs.existsSync(settingsPath)) {
            try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, "utf-8")) }; } catch {}
          }
          
          let available_models: string[] = [];
          try {
            const catalogPath = path.join(os.homedir(), ".codex", "models_catalog.json");
            if (fs.existsSync(catalogPath)) {
              const cat = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              available_models = (cat.models || []).map((m: any) => m.slug);
            }
          } catch {}

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...maskVoiceSettings(settings), available_models }));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/sessions") {
          const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
          const sessions: any[] = [];
          const registeredTitles = new Map<string, string>();
          try {
            const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
            if (fs.existsSync(dbPath)) {
              const cp = await import("node:child_process");
              const raw = cp.execFileSync("sqlite3", ["-json", dbPath, "SELECT rollout_path, title FROM threads WHERE archived = 0 AND title <> '';"], { maxBuffer: 10 * 1024 * 1024 }).toString("utf-8").trim();
              const rows = raw ? JSON.parse(raw) : [];
              if (Array.isArray(rows)) {
                for (const row of rows) {
                  if (typeof row?.rollout_path === "string" && typeof row?.title === "string" && row.title.trim()) {
                    registeredTitles.set(row.rollout_path, row.title.trim());
                  }
                }
              }
            }
          } catch {}
          if (fs.existsSync(sessionsDir)) {
            try {
              const files = fs.readdirSync(sessionsDir, { recursive: true });
              for (const f of files) {
                if (typeof f === "string" && (f.endsWith(".json") || f.endsWith(".jsonl"))) {
                  const fullPath = path.join(sessionsDir, f);
                  const stat = fs.statSync(fullPath);
                  const id = path.basename(f, f.endsWith(".jsonl") ? ".jsonl" : ".json");
                  
                  let title = `会话 ${id.slice(0, 8)}`;
                  let msgCount = 0;
                  let isAutoReview = false;
                  let isInternalSession = false;
                  try {
                    const lines = fs.readFileSync(fullPath, "utf-8").split("\n").filter(Boolean);
                    for (const line of lines) {
                      try {
                        const parsed = JSON.parse(line);
                        if (isInternalRolloutRecord(parsed)) {
                          isInternalSession = true;
                        }
                        if (parsed.type === "turn_context" && parsed.payload?.model === "codex-auto-review") {
                          isAutoReview = true;
                          break;
                        }
                        if (parsed.type === "event_msg" && parsed.payload?.title) {
                          title = parsed.payload.title;
                          break;
                        }
                        if (parsed.type === "event_msg" && parsed.payload?.type === "user_message" && parsed.payload?.message && !isSyntheticToolTrace(parsed.payload.message)) {
                          const msg = parsed.payload.message;
                          if (!msg.startsWith("The following is the Codex agent history") && !msg.startsWith("<")) {
                            title = msg.replace(/\s+/g, " ").slice(0, 50);
                            break;
                          }
                        }
                        if (parsed.type === "response_item" && parsed.payload?.role === "user") {
                          const text = parsed.payload?.content?.[0]?.text;
                          if (text && !isSyntheticToolTrace(text) && !text.startsWith("The following is the Codex agent history") && !text.startsWith("<")) {
                            title = text.replace(/\s+/g, " ").slice(0, 50);
                            break;
                          }
                        }
                      } catch {}
                    }

                    const transcriptPath = path.join(
                      os.homedir(),
                      ".gemini",
                      "antigravity",
                      extractSessionUuid(id),
                      ".system_generated",
                      "logs",
                      "transcript.jsonl"
                    );
                    if (fs.existsSync(transcriptPath)) {
                      const transcriptLines = fs.readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean);
                      msgCount = projectAntigravitySessionMessages(transcriptLines).length;
                    } else {
                      msgCount = projectCodexSessionMessages(lines).length;
                    }
                  } catch {}

                  if (title.startsWith("会话 ")) {
                    const transcriptPath = path.join(
                      os.homedir(),
                      ".gemini",
                      "antigravity",
                      "brain",
                      extractSessionUuid(id),
                      ".system_generated",
                      "logs",
                      "transcript.jsonl"
                    );
                    if (fs.existsSync(transcriptPath)) {
                      try {
                        for (const line of fs.readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean)) {
                          const transcript = JSON.parse(line);
                          if (transcript.type === "USER_INPUT") {
                            const transcriptText = extractTranscriptUserText(transcript.content);
                            if (transcriptText) {
                              title = transcriptText.replace(/\s+/g, " ").slice(0, 50);
                              break;
                            }
                          }
                        }
                      } catch {}
                    }
                  }

                  const registeredTitle = registeredTitles.get(fullPath);
                  if (registeredTitle && !isSyntheticToolTrace(registeredTitle)) title = registeredTitle;
                  if (!isAutoReview && !isInternalSession && !title.startsWith("The following is the Codex agent history")) {
                    sessions.push({
                      id,
                      text: title,
                      ts: stat.mtimeMs,
                      message_count: msgCount,
                      model: "Codex Session"
                    });
                  }
                }
              }
            } catch {}
          }
          sessions.sort((a, b) => b.ts - a.ts);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions: sessions.slice(0, 100) }));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/sessions/detail") {
          try {
            const body = await this.parseJsonBody(req);
            const id = String(body.id || "");
            const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
            const agLogPath = path.join(os.homedir(), ".gemini", "antigravity", "brain", extractSessionUuid(id), ".system_generated", "logs", "transcript.jsonl");

            const messages: any[] = [];
            let targetFile = "";
            if (!fs.existsSync(agLogPath) && fs.existsSync(sessionsDir)) {
              const files = fs.readdirSync(sessionsDir, { recursive: true });
              for (const f of files) {
                if (typeof f === "string" && f.includes(id)) {
                  targetFile = path.join(sessionsDir, f);
                  break;
                }
              }
            }

            if (targetFile && fs.existsSync(targetFile)) {
              try {
                const internal = fs.readFileSync(targetFile, "utf-8").split("\n").filter(Boolean)
                  .some((line) => {
                    try { return isInternalRolloutRecord(JSON.parse(line)); } catch { return false; }
                  });
                if (internal) {
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ metadata: { id, internal: true }, messages: [] }));
                  return;
                }
              } catch {}
            }

            if (fs.existsSync(agLogPath)) {
              const lines = fs.readFileSync(agLogPath, "utf-8").split("\n").filter(Boolean);
              messages.push(...projectAntigravitySessionMessages(lines));
            } else {
              if (targetFile && fs.existsSync(targetFile)) {
                const lines = fs.readFileSync(targetFile, "utf-8").split("\n").filter(Boolean);
                messages.push(...projectCodexSessionMessages(lines));
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ metadata: { id }, messages }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/memory-sources/scan") {
          const agents: any[] = [];

          // 1. Antigravity Brain Sessions
          const agDir = path.join(os.homedir(), ".gemini", "antigravity", "brain");
          if (fs.existsSync(agDir)) {
            try {
              const dirs = fs.readdirSync(agDir).filter(d => d.length > 20);
              const agSessions = dirs.map(d => {
                let title = `Antigravity Session ${d.slice(0, 8)}`;
                let msgCount = 0;
                const agLogPath = path.join(agDir, d, ".system_generated", "logs", "transcript.jsonl");
                const agDbPath = path.join(os.homedir(), ".gemini", "antigravity", "conversations", `${d}.db`);

                if (fs.existsSync(agDbPath)) {
                  try {
                    const out = execFileSync("sqlite3", [agDbPath, "SELECT COUNT(*) FROM steps WHERE step_type IN (14, 15) AND status = 3 AND length(step_payload) > 0;"], { encoding: "utf-8" }).trim();
                    msgCount = parseInt(out, 10) || 0;
                  } catch {}
                }

                if (fs.existsSync(agLogPath)) {
                  try {
                    const lines = fs.readFileSync(agLogPath, "utf-8").split("\n").filter(Boolean);
                    if (msgCount === 0) msgCount = lines.length;
                    for (const line of lines) {
                      try {
                        const parsed = JSON.parse(line);
                        if (parsed.type === "USER_INPUT") {
                          const match = (parsed.content || "").match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                          const text = match && match[1] ? match[1].trim() : parsed.content;
                          if (text && !text.includes("Checkpoint") && !text.includes("CHECKPOINT")) {
                            title = text.replace(/\s+/g, " ").slice(0, 60);
                            break;
                          }
                        }
                      } catch {}
                    }
                  } catch {}
                }
                return {
                  id: d,
                  title: title,
                  source: "antigravity",
                  message_count: msgCount > 0 ? msgCount : 12
                };
              });
              agents.push({
                name: "Antigravity Agent",
                session_count: agSessions.length,
                sources: [
                  {
                    source_id: "antigravity_brain",
                    display_path: "~/.gemini/antigravity/brain",
                    format: "json",
                    sessions: agSessions.slice(0, 30)
                  }
                ]
              });
            } catch {}
          }

          // 2. Cursor Agent transcripts (JSONL under ~/.cursor/projects)
          const cursorProjectsDir = path.join(os.homedir(), ".cursor", "projects");
          if (fs.existsSync(cursorProjectsDir)) {
            try {
              const cursorSessions: any[] = [];
              const scanCursorDir = (dir: string) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                  const fullPath = path.join(dir, entry.name);
                  if (entry.isDirectory()) {
                    scanCursorDir(fullPath);
                    continue;
                  }
                  if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !dir.includes(`${path.sep}agent-transcripts`)) continue;
                  try {
                    const lines = fs.readFileSync(fullPath, "utf-8").split("\n").filter(Boolean);
                    let title = `Cursor Session ${entry.name.slice(0, 8)}`;
                    let messageCount = 0;
                    for (const line of lines) {
                      const parsed = JSON.parse(line);
                      const content = Array.isArray(parsed.message?.content) ? parsed.message.content : [];
                      const text = content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim();
                      if (!text || !["user", "assistant"].includes(parsed.role)) continue;
                      messageCount += 1;
                      if (parsed.role === "user" && title.startsWith("Cursor Session ")) {
                        const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
                        const candidate = (match ? match[1] : text).replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "").trim();
                        if (candidate) title = candidate.replace(/\s+/g, " ").slice(0, 80);
                      }
                    }
                    cursorSessions.push({
                      id: entry.name.replace(/\.jsonl$/, ""),
                      title,
                      source: "cursor",
                      project: path.basename(path.dirname(path.dirname(dir))),
                      message_count: messageCount,
                      updated_at: fs.statSync(fullPath).mtimeMs
                    });
                  } catch {}
                }
              };
              scanCursorDir(cursorProjectsDir);
              cursorSessions.sort((a, b) => b.updated_at - a.updated_at);
              if (cursorSessions.length > 0) {
                agents.push({
                  name: "Cursor Agent",
                  session_count: cursorSessions.length,
                  sources: [{
                    source_id: "cursor_agent_transcripts",
                    display_path: "~/.cursor/projects/*/agent-transcripts",
                    format: "jsonl",
                    sessions: cursorSessions.slice(0, 100)
                  }]
                });
              }
            } catch {}
          }

          // 3. Grok CLI Agent
          const grokDir = path.join(os.homedir(), ".grok", "sessions");
          if (fs.existsSync(grokDir)) {
            try {
              const grokSessions: any[] = [];
              const scanGrokSubdirs = (dir: string) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory()) {
                    const subDir = path.join(dir, entry.name);
                    const summaryFile = path.join(subDir, "summary.json");
                    if (fs.existsSync(summaryFile)) {
                      try {
                        const info = JSON.parse(fs.readFileSync(summaryFile, "utf-8"));
                        const title = info.generated_title || info.session_summary || `Grok Session ${info.id?.slice(0, 8)}`;
                        grokSessions.push({
                          id: info.id || entry.name,
                          title,
                          source: "grok",
                          message_count: info.num_messages || 6
                        });
                      } catch {}
                    } else {
                      scanGrokSubdirs(subDir);
                    }
                  }
                }
              };
              scanGrokSubdirs(grokDir);
              if (grokSessions.length > 0) {
                agents.push({
                  name: "Grok CLI Agent",
                  session_count: grokSessions.length,
                  sources: [
                    {
                      source_id: "grok_sessions",
                      display_path: "~/.grok/sessions",
                      format: "json",
                      sessions: grokSessions
                    }
                  ]
                });
              }
            } catch {}
          }

          // 3. Claude Code CLI
          const claudeHistory = path.join(os.homedir(), ".claude", "history.jsonl");
          if (fs.existsSync(claudeHistory)) {
            try {
              const lines = fs.readFileSync(claudeHistory, "utf-8").split("\n").filter(Boolean);
              const sessionMap = new Map<string, { id: string; title: string; count: number }>();
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.sessionId) {
                    const existing = sessionMap.get(parsed.sessionId);
                    const title = parsed.display && !parsed.display.startsWith("[Image") ? parsed.display.slice(0, 40) : "";
                    if (!existing) {
                      sessionMap.set(parsed.sessionId, {
                        id: parsed.sessionId,
                        title: title || `Claude 会话 ${parsed.sessionId.slice(0, 8)}`,
                        count: 1
                      });
                    } else {
                      existing.count += 1;
                      if (title && existing.title.startsWith("Claude 会话")) {
                        existing.title = title;
                      }
                    }
                  }
                } catch {}
              }
              const claudeSessions = Array.from(sessionMap.values()).map(s => ({
                id: s.id,
                title: s.title,
                source: "claude",
                message_count: s.count
              }));
              agents.push({
                name: "Claude Code CLI",
                session_count: claudeSessions.length,
                sources: [
                  {
                    source_id: "claude_history",
                    display_path: "~/.claude/history.jsonl",
                    format: "jsonl",
                    sessions: claudeSessions
                  }
                ]
              });
            } catch {}
          }

          // 4. Hermes Agent (SQLite state.db)
          const hermesDb = path.join(os.homedir(), ".hermes", "state.db");
          if (fs.existsSync(hermesDb)) {
            try {
              const cp = await import("node:child_process");
              const out = cp.execFileSync("sqlite3", [hermesDb, "SELECT id, title, source FROM sessions ORDER BY started_at DESC LIMIT 20;"], { encoding: "utf-8" });
              const rows = out.split("\n").filter(Boolean);
              const hermesSessions = rows.map(row => {
                const parts = row.split("|");
                const id = parts[0] || "hermes";
                const title = parts[1] || `Hermes 会话 ${id.slice(0, 8)}`;
                const source = parts[2] || "telegram";
                return { id, title, source: `hermes (${source})`, message_count: 12 };
              });
              if (hermesSessions.length > 0) {
                agents.push({
                  name: "Hermes Agent",
                  session_count: hermesSessions.length,
                  sources: [
                    {
                      source_id: "hermes_state",
                      display_path: "~/.hermes/state.db",
                      format: "sqlite",
                      sessions: hermesSessions
                    }
                  ]
                });
              }
            } catch {}
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ agents }));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/memory-sources/import") {
          try {
            const body = await this.parseJsonBody(req);
            const sourceId = body.source_id;
            const sessionId = body.session_id;
            const requestedTitle = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
            if (typeof sourceId !== "string" || !sourceId || typeof sessionId !== "string" || !sessionId) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "缺少有效的导入来源或会话 ID" }));
              return;
            }
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            const targetDir = path.join(os.homedir(), ".codex", "sessions", String(year), month, day);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }

            const rolloutFilename = `rollout-${now.toISOString().replace(/[:.]/g, "-")}-${sessionId}.jsonl`;
            const targetFilePath = path.join(targetDir, rolloutFilename);

            let importedLines: string[] = [];
            let sourceMatched = false;

            // 1. Antigravity Brain / SQLite DB import
            const agDbPath = path.join(os.homedir(), ".gemini", "antigravity", "conversations", `${sessionId}.db`);
            const agLogPath = path.join(os.homedir(), ".gemini", "antigravity", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");

            const hasAntigravityTranscript = sourceId === "antigravity_brain" && fs.existsSync(agLogPath);
            if (sourceId === "antigravity_brain" && fs.existsSync(agDbPath) && !hasAntigravityTranscript) {
              sourceMatched = true;
              importedLines.push(JSON.stringify({
                timestamp: now.toISOString(),
                type: "session_meta",
                payload: {
                  session_id: sessionId,
                  id: sessionId,
                  timestamp: now.toISOString(),
                  cwd: os.homedir(),
                  originator: "Codex Desktop",
                  cli_version: "0.142.5",
                  source: "vscode",
                  thread_source: "user",
                  model_provider: "openai"
                }
              }));

              try {
                const cp = await import("node:child_process");
                const sql = `SELECT step_type, hex(step_payload) FROM steps WHERE step_type IN (14, 15) AND status = 3 AND length(step_payload) > 0 ORDER BY idx;`;
                const rawOut = cp.execFileSync("sqlite3", [agDbPath, sql], { maxBuffer: 50 * 1024 * 1024 }).toString("utf-8");
                const rows = rawOut.split("\n").filter(Boolean);

                const readVarint = (bytes: Buffer, offset: number) => {
                  let value = 0, shift = 0;
                  while (offset < bytes.length && shift < 53) {
                    const b = bytes[offset++];
                    value += (b & 0x7f) * Math.pow(2, shift);
                    if ((b & 0x80) === 0) return { value, offset };
                    shift += 7;
                  }
                  return null;
                };

                const extractProtobufStrings = (bytes: Buffer, depth = 0): string[] => {
                  if (depth > 5) return [];
                  const output: string[] = [];
                  let offset = 0;
                  while (offset < bytes.length) {
                    const key = readVarint(bytes, offset);
                    if (!key) break;
                    offset = key.offset;
                    const wireType = key.value & 7;
                    if (wireType === 0) {
                      const v = readVarint(bytes, offset);
                      if (!v) break;
                      offset = v.offset;
                      continue;
                    }
                    if (wireType === 1) { offset += 8; continue; }
                    if (wireType === 5) { offset += 4; continue; }
                    if (wireType !== 2) break;

                    const len = readVarint(bytes, offset);
                    if (!len) break;
                    offset = len.offset;
                    const length = len.value;
                    if (length < 0 || offset + length > bytes.length) break;
                    const part = bytes.subarray(offset, offset + length);
                    offset += length;

                    const text = part.toString("utf8").trim();
                    const replacementCount = (text.match(/\uFFFD/g) || []).length;
                    const controlCount = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
                    if (text.length >= 2 && replacementCount === 0 && controlCount <= Math.max(1, text.length * 0.01)) {
                      output.push(text);
                    }
                    output.push(...extractProtobufStrings(part, depth + 1));
                  }
                  return output;
                };

                const antigravityMessageText = (payload: Buffer): string => {
                  const candidates = Array.from(new Set(extractProtobufStrings(payload)))
                    .map((text) => {
                      let cleaned = text.replace(/^[\u0000-\u001F]+/, "").trim();
                      if (/^[^\p{Script=Han}][\p{Script=Han}]/u.test(cleaned)) {
                        cleaned = cleaned.slice(1).trim();
                      }
                      return cleaned;
                    })
                    .filter((text) => {
                      if (text.length < 2) return false;
                      if (/^[0-9a-f-]{32,}$/i.test(text)) return false;
                      if (/^[A-Za-z0-9_-]{18,30}$/.test(text)) return false;
                      if (/^[a-z0-9]{8}$/.test(text) || /^[a-z_]{4,32}$/.test(text)) return false;
                      if (text.length < 100 && /[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(text)) return false;
                      if (/^[^/\\]+\.(?:png|jpe?g|gif|webp|heic)$/i.test(text)) return false;
                      if (/^(bot-|sessionID|command\(|read_file\(|write_to_file|search_web|list_dir)/i.test(text)) return false;
                      if (text.startsWith("{") && /"(toolAction|CommandLine|DirectoryPath|ArtifactMetadata)"/.test(text)) return false;
                      if (/^2\([0-9a-f]{32,}\)$/i.test(text)) return false;
                      if (text.startsWith("$mcp(")) return false;
                      return /[\p{L}\p{N}]/u.test(text);
                    })
                    .sort((a, b) => b.length - a.length);
                  return candidates[0] || "";
                };

                for (const row of rows) {
                  const parts = row.split("|");
                  if (parts.length < 2) continue;
                  const stepType = parseInt(parts[0], 10);
                  const buf = Buffer.from(parts[1], "hex");
                  const validText = antigravityMessageText(buf);

                  if (validText && !/^image\/(?:png|jpe?g|gif|webp)$/i.test(validText.trim())) {
                    if (stepType === 14) {
                      importedLines.push(JSON.stringify({
                        timestamp: now.toISOString(),
                        type: "event_msg",
                        payload: { type: "user_message", message: validText }
                      }));
                    } else {
                      importedLines.push(JSON.stringify({
                        timestamp: now.toISOString(),
                        type: "event_msg",
                        payload: { type: "agent_message", message: validText }
                      }));
                      importedLines.push(JSON.stringify({
                        timestamp: now.toISOString(),
                        type: "response_item",
                        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: validText }] }
                      }));
                    }
                  }
                }
              } catch (e) {}
            } else if (sourceId === "antigravity_brain" && fs.existsSync(agLogPath)) {
              sourceMatched = true;
              const lines = fs.readFileSync(agLogPath, "utf-8").split("\n").filter(Boolean);
              importedLines.push(JSON.stringify({
                timestamp: now.toISOString(),
                type: "session_meta",
                payload: {
                  session_id: sessionId,
                  id: sessionId,
                  timestamp: now.toISOString(),
                  cwd: os.homedir(),
                  originator: "Codex Desktop",
                  cli_version: "0.142.5",
                  source: "vscode",
                  thread_source: "user",
                  model_provider: "openai"
                }
              }));
              let importedMessageIndex = 0;
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.type === "USER_INPUT") {
                    const match = (parsed.content || "").match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                    let text = match && match[1] ? match[1].trim() : (parsed.content || "").trim();
                    text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "").trim();
                    if (text && !text.includes("Checkpoint") && !text.includes("CHECKPOINT")) {
                      const messageId = `msg_import_${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}_${importedMessageIndex++}`;
                      importedLines.push(JSON.stringify({
                        timestamp: parsed.created_at || now.toISOString(),
                        type: "event_msg",
                        payload: {
                          type: "user_message",
                          client_id: randomUUID(),
                          message: text,
                          images: [],
                          local_images: [],
                          audio: [],
                          local_audio: [],
                          text_elements: []
                        }
                      }));
                      importedLines.push(JSON.stringify({
                        timestamp: parsed.created_at || now.toISOString(),
                        type: "response_item",
                        payload: { type: "message", id: messageId, role: "user", content: [{ type: "input_text", text }] }
                      }));
                    }
                  } else if (parsed.type === "PLANNER_RESPONSE" && parsed.content) {
                    const messageId = `msg_import_${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}_${importedMessageIndex++}`;
                    importedLines.push(JSON.stringify({
                      timestamp: parsed.created_at || now.toISOString(),
                      type: "event_msg",
                      payload: { type: "agent_message", message: parsed.content }
                    }));
                    importedLines.push(JSON.stringify({
                      timestamp: parsed.created_at || now.toISOString(),
                      type: "response_item",
                      payload: { type: "message", id: messageId, role: "assistant", content: [{ type: "output_text", text: parsed.content }] }
                    }));
                  }
                } catch {}
              }
            }

            // 2. Cursor Agent transcript import
            let cursorTranscriptPath = "";
            const cursorProjectsDir = path.join(os.homedir(), ".cursor", "projects");
            if (sourceId === "cursor_agent_transcripts" && fs.existsSync(cursorProjectsDir)) {
              const findCursorTranscript = (dir: string) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                  const fullPath = path.join(dir, entry.name);
                  if (entry.isDirectory()) {
                    findCursorTranscript(fullPath);
                    if (cursorTranscriptPath) return;
                  } else if (entry.isFile() && entry.name === `${sessionId}.jsonl` && dir.includes(`${path.sep}agent-transcripts`)) {
                    cursorTranscriptPath = fullPath;
                    return;
                  }
                }
              };
              findCursorTranscript(cursorProjectsDir);
            }
            if (sourceId === "cursor_agent_transcripts" && cursorTranscriptPath && fs.existsSync(cursorTranscriptPath)) {
              sourceMatched = true;
              importedLines.push(JSON.stringify({
                timestamp: now.toISOString(),
                type: "session_meta",
                payload: {
                  session_id: sessionId,
                  id: sessionId,
                  timestamp: now.toISOString(),
                  cwd: os.homedir(),
                  originator: "Cursor Agent",
                  cli_version: "unknown",
                  source: "cursor",
                  thread_source: "user",
                  model_provider: "cursor"
                }
              }));
              let cursorMessageIndex = 0;
              const cursorLines = fs.readFileSync(cursorTranscriptPath, "utf-8").split("\n").filter(Boolean);
              for (const line of cursorLines) {
                try {
                  const parsed = JSON.parse(line);
                  if (!(["user", "assistant"].includes(parsed.role))) continue;
                  const content = Array.isArray(parsed.message?.content) ? parsed.message.content : [];
                  const text = content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim();
                  if (!text || text === "[REDACTED]") continue;
                  const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
                  const cleaned = (match ? match[1] : text).replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "").replace(/\[REDACTED\]/g, "").trim();
                  if (!cleaned) continue;
                  const role = parsed.role === "user" ? "user" : "assistant";
                  const timestamp = now.toISOString();
                  const messageId = `msg_import_${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}_${cursorMessageIndex++}`;
                  importedLines.push(JSON.stringify({
                    timestamp,
                    type: "event_msg",
                    payload: { type: role === "user" ? "user_message" : "agent_message", message: cleaned }
                  }));
                  importedLines.push(JSON.stringify({
                    timestamp,
                    type: "response_item",
                    payload: { type: "message", id: messageId, role, content: [{ type: role === "user" ? "input_text" : "output_text", text: cleaned }] }
                  }));
                } catch {}
              }
            }

            // 3. Grok CLI import
            let grokSessionDir = "";
            const grokBaseDir = path.join(os.homedir(), ".grok", "sessions");
            if (fs.existsSync(grokBaseDir)) {
              const findGrokDir = (d: string) => {
                const entries = fs.readdirSync(d, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory()) {
                    if (entry.name === sessionId) {
                      grokSessionDir = path.join(d, entry.name);
                      return;
                    }
                    findGrokDir(path.join(d, entry.name));
                    if (grokSessionDir) return;
                  }
                }
              };
              findGrokDir(grokBaseDir);
            }

            if (sourceId === "grok_sessions" && grokSessionDir && fs.existsSync(grokSessionDir)) {
              sourceMatched = true;
              importedLines.push(JSON.stringify({
                timestamp: now.toISOString(),
                type: "session_meta",
                payload: {
                  session_id: sessionId,
                  id: sessionId,
                  timestamp: now.toISOString(),
                  cwd: os.homedir(),
                  originator: "Codex Desktop",
                  cli_version: "0.142.5",
                  source: "vscode",
                  thread_source: "user",
                  model_provider: "openai"
                }
              }));

              const updatesFile = path.join(grokSessionDir, "updates.jsonl");
              const historyFile = path.join(grokSessionDir, "chat_history.jsonl");

              if (fs.existsSync(updatesFile)) {
                const lines = fs.readFileSync(updatesFile, "utf-8").split("\n").filter(Boolean);
                for (const l of lines) {
                  try {
                    const p = JSON.parse(l);
                    if (p.method === "session/update" && p.params?.update) {
                      const u = p.params.update;
                      if (u.sessionUpdate === "user_message_chunk" && u.content?.text) {
                        const txt = u.content.text.trim();
                        if (txt && !txt.startsWith("<user_info>") && !txt.startsWith("<system-reminder>")) {
                          importedLines.push(JSON.stringify({
                            timestamp: now.toISOString(),
                            type: "event_msg",
                            payload: { type: "user_message", message: txt }
                          }));
                        }
                      } else if (u.sessionUpdate === "agent_message_chunk" && u.content?.text) {
                        const txt = u.content.text.trim();
                        if (txt) {
                          importedLines.push(JSON.stringify({
                            timestamp: now.toISOString(),
                            type: "event_msg",
                            payload: { type: "agent_message", message: txt }
                          }));
                          importedLines.push(JSON.stringify({
                            timestamp: now.toISOString(),
                            type: "response_item",
                            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: txt }] }
                          }));
                        }
                      }
                    }
                  } catch {}
                }
              }

              if (importedLines.length <= 1 && fs.existsSync(historyFile)) {
                const lines = fs.readFileSync(historyFile, "utf-8").split("\n").filter(Boolean);
                for (const l of lines) {
                  try {
                    const p = JSON.parse(l);
                    if (p.type === "user" && Array.isArray(p.content)) {
                      for (const c of p.content) {
                        if (c.type === "text" && c.text) {
                          const match = c.text.match(/<user_query>([\s\S]*?)<\/user_query>/);
                          const txt = match ? match[1].trim() : c.text.trim();
                          if (txt && !txt.startsWith("<user_info>") && !txt.startsWith("<system-reminder>")) {
                            importedLines.push(JSON.stringify({
                              timestamp: now.toISOString(),
                              type: "event_msg",
                              payload: { type: "user_message", message: txt }
                            }));
                          }
                        }
                      }
                    } else if (p.type === "assistant" && Array.isArray(p.content)) {
                      for (const c of p.content) {
                        if (c.type === "text" && c.text) {
                          importedLines.push(JSON.stringify({
                            timestamp: now.toISOString(),
                            type: "event_msg",
                            payload: { type: "agent_message", message: c.text }
                          }));
                          importedLines.push(JSON.stringify({
                            timestamp: now.toISOString(),
                            type: "response_item",
                            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: c.text }] }
                          }));
                        }
                      }
                    }
                  } catch {}
                }
              }
            }

            // 3. Claude Code import
            const claudeHistory = path.join(os.homedir(), ".claude", "history.jsonl");
            if (sourceId === "claude_history" && fs.existsSync(claudeHistory)) {
              sourceMatched = true;
              importedLines.push(JSON.stringify({
                timestamp: now.toISOString(),
                type: "session_meta",
                payload: {
                  session_id: sessionId,
                  id: sessionId,
                  timestamp: now.toISOString(),
                  cwd: os.homedir(),
                  originator: "Codex Desktop",
                  cli_version: "0.142.5",
                  source: "vscode",
                  thread_source: "user",
                  model_provider: "openai"
                }
              }));
              const lines = fs.readFileSync(claudeHistory, "utf-8").split("\n").filter(Boolean);
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.sessionId === sessionId && parsed.display) {
                    importedLines.push(JSON.stringify({
                      timestamp: now.toISOString(),
                      type: "response_item",
                      payload: { type: "message", role: "user", content: [{ type: "input_text", text: parsed.display }] }
                    }));
                  }
                } catch {}
              }
            }

            // 4. Hermes Agent import from its local SQLite state database.
            const hermesDb = path.join(os.homedir(), ".hermes", "state.db");
            if (sourceId === "hermes_state" && fs.existsSync(hermesDb)) {
              const cp = await import("node:child_process");
              const quoteSql = (value: string) => value.replace(/'/g, "''");
              const sql = `SELECT role, content, timestamp FROM messages WHERE session_id = '${quoteSql(sessionId)}' AND active = 1 ORDER BY timestamp, id;`;
              const raw = cp.execFileSync("sqlite3", ["-json", hermesDb, sql], { maxBuffer: 50 * 1024 * 1024 }).toString("utf-8").trim();
              const messages = raw ? JSON.parse(raw) : [];
              if (Array.isArray(messages)) {
                sourceMatched = true;
                importedLines.push(JSON.stringify({
                  timestamp: now.toISOString(),
                  type: "session_meta",
                  payload: {
                    session_id: sessionId,
                    id: sessionId,
                    timestamp: now.toISOString(),
                    cwd: os.homedir(),
                    originator: "Codex Desktop",
                    cli_version: "0.142.5",
                    source: "vscode",
                    thread_source: "user",
                    model_provider: "openai"
                  }
                }));
                for (const message of messages) {
                  const text = typeof message?.content === "string" ? message.content.trim() : "";
                  if (!text) continue;
                  const role = message.role === "user" ? "user" : "assistant";
                  importedLines.push(JSON.stringify({
                    timestamp: new Date(Number(message.timestamp || Date.now()) * 1000).toISOString(),
                    type: "event_msg",
                    payload: { type: role === "user" ? "user_message" : "agent_message", message: text }
                  }));
                }
              }
            }

            if (!sourceMatched) {
              throw new Error("没有找到所选的本机 Agent 会话，可能已被移动或删除");
            }
            if (importedLines.length <= 1) {
              throw new Error("找到了会话文件，但没有解析出可显示的消息，未执行导入");
            }

            if (importedLines.length > 1) {
              const taskStarted = JSON.stringify({
                timestamp: now.toISOString(),
                type: "event_msg",
                payload: {
                  type: "task_started",
                  turn_id: `turn_import_${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}`,
                  started_at: Math.floor(now.getTime() / 1000),
                  model_context_window: 258400,
                  collaboration_mode_kind: "default"
                }
              });
              importedLines.splice(1, 0, taskStarted);
              fs.writeFileSync(targetFilePath, importedLines.join("\n") + "\n", "utf-8");

              // Register into Codex desktop SQLite database (~/.codex/state_5.sqlite) so Codex UI presents it in the sidebar
              const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
              if (!fs.existsSync(dbPath)) {
                throw new Error("Codex 会话数据库不存在，无法注册到侧边栏");
              }
              const cp = await import("node:child_process");
              const quoteSql = (value: string) => value.replace(/'/g, "''");
              let firstPrompt = "";
              for (const line of importedLines) {
                try {
                  const p = JSON.parse(line);
                  if (p.type === "event_msg" && p.payload?.type === "user_message" && p.payload?.message && !isSyntheticToolTrace(p.payload.message)) {
                    firstPrompt = p.payload.message;
                    break;
                  }
                  if (p.type === "response_item" && p.payload?.role === "user") {
                    const txt = p.payload?.content?.[0]?.text || p.payload?.content?.[0]?.input_text;
                    if (txt && !isSyntheticToolTrace(txt)) { firstPrompt = txt; break; }
                  }
                } catch {}
              }
              if (!firstPrompt) firstPrompt = "Imported Session";
              const nowSec = Math.floor(Date.now() / 1000);
              const cleanTitle = (requestedTitle || firstPrompt || "Imported Session").replace(/\s+/g, " ").trim().slice(0, 200);
              const sandboxPolicy = JSON.stringify({
                type: "managed",
                file_system: {
                  type: "restricted",
                  entries: [
                    { path: { type: "special", value: { kind: "root" } }, access: "read" },
                    { path: { type: "path", path: os.homedir() }, access: "write" },
                    { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
                    { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" }
                  ]
                },
                network: "restricted"
              });
              const sql = `INSERT OR REPLACE INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, preview, first_user_message, has_user_event, recency_at, recency_at_ms, cli_version, thread_source, model, memory_mode, history_mode) VALUES ('${quoteSql(sessionId)}', '${quoteSql(targetFilePath)}', ${nowSec}, ${nowSec}, 'vscode', 'openai', '${quoteSql(os.homedir())}', '${quoteSql(cleanTitle)}', '${quoteSql(sandboxPolicy)}', 'on-request', '${quoteSql(cleanTitle)}', '${quoteSql(cleanTitle)}', 1, ${nowSec}, ${Date.now()}, '0.142.5', 'user', 'gpt-5.5', 'enabled', 'legacy');`;
              cp.execFileSync("sqlite3", [dbPath, sql], { stdio: "pipe" });
              const registeredId = cp.execFileSync("sqlite3", [dbPath, `SELECT id FROM threads WHERE id = '${quoteSql(sessionId)}' AND rollout_path = '${quoteSql(targetFilePath)}';`], { encoding: "utf-8" }).trim();
              if (registeredId !== sessionId) {
                throw new Error("Codex 会话数据库注册后未找到对应记录");
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", message: "Agent 会话已写入 Codex 会话库", id: sessionId, rollout_path: targetFilePath, imported_line_count: importedLines.length, registered: true, restarted: false }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/restart-codex") {
          if (this.gatewayRestartInProgress) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Gateway restart already in progress", retryable: true }));
            return;
          }
          this.gatewayRestartInProgress = true;
          try {
            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            const configPath = path.join(os.homedir(), ".codex", "config.toml");

            let hasModels = false;
            if (fs.existsSync(catalogPath)) {
              try {
                const cat = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
                hasModels = Array.isArray(cat.models) && cat.models.length > 0;
              } catch {}
            }

            if (hasModels && fs.existsSync(configPath)) {
              let content = fs.readFileSync(configPath, "utf-8");
              content = content.replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "").trim();

              const managedTop = `# >>> opencodex managed >>>\nmodel_catalog_json = "${catalogPath}"\nopenai_base_url = "http://127.0.0.1:${this.port}/v1"\n# <<< opencodex managed <<<\n`;

              const managedProvider = `\n# >>> opencodex managed >>>\n[model_providers.opencodex]\nname = "OpenCodex"\nbase_url = "http://127.0.0.1:${this.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nexperimental_bearer_token = "${this.adminToken}"\nrequest_max_retries = 3\nstream_max_retries = 3\nstream_idle_timeout_ms = 600000\n# <<< opencodex managed <<<\n`;

              fs.writeFileSync(configPath, managedTop + "\n" + content + "\n" + managedProvider, "utf-8");
              CatalogSyncService.syncCustomModelsToCodexCache();
              console.log("[OpenCodex Gateway] Applied gateway proxy and custom model catalog to config.toml before restart.");
            }

            restartDesktopClients(true);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", message: "桌面端与网关服务正在重新启动..." }));

            setTimeout(() => {
              try { execFileSync("/opt/homebrew/bin/pm2", ["restart", "opencodex"], { stdio: "ignore" }); } catch {
                this.gatewayRestartInProgress = false;
              }
            }, 300);
            return;
          } catch (err: any) {
            this.gatewayRestartInProgress = false;
            console.error("[OpenCodex Gateway] Restart error:", err?.message);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", message: "桌面端与网关服务正在重新启动..." }));
          return;
        }

        if (req.method === "GET" && (url.pathname === "/assets/opencodex-logo.png" || url.pathname === "/assets/opencodex-logo-compact.png")) {
          const logoFile = url.pathname.endsWith("-compact.png") ? "opencodex-logo-compact.png" : "opencodex-logo.png";
          const possiblePaths = [
            path.join(process.cwd(), "src_v2", "assets", logoFile),
            path.join(process.cwd(), "dist", "src_v2", "assets", logoFile),
            path.join(os.homedir(), "projects", "opencodex", "src_v2", "assets", logoFile)
          ];
          const found = possiblePaths.find((p) => fs.existsSync(p));
          if (found) {
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
            res.end(fs.readFileSync(found));
          } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Logo not found");
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/visualizer") {
          try {
            const { getVisualizerHtml } = await import("../services/visualizer.js");
            const isHud = url.searchParams.get("mode") === "hud";
            const settingsPath = path.join(os.homedir(), ".opencodex", "voice_settings.json");
            let hudTheme = "vortex";
            if (fs.existsSync(settingsPath)) {
              try {
                const s = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
                if (s.hud_theme) hudTheme = s.hud_theme;
              } catch {}
            }
            this.issueAdminCookie(res);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(getVisualizerHtml(isHud, hudTheme));
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Visualizer Error: ${e.message}`);
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/models") {
          const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
          let catalog: any[] = [];
          if (fs.existsSync(catalogPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              const before = JSON.stringify(data.models || []);
              preserveOfficialModels(data);
              if (before !== JSON.stringify(data.models || [])) {
                fs.writeFileSync(catalogPath, JSON.stringify(data, null, 2), "utf-8");
              }
              // Official native models are not web-managed models. They stay
              // in the desktop catalog, but only provider-owned entries are
              // exposed here for third-party management.
              catalog = (data.models || []).filter((m: any) => Boolean(catalogModelOwner(m)));
            } catch {}
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ catalog }));
          return;
        }

        if (req.method === "GET" && url.pathname.startsWith("/api/logs")) {
          const logFiles = [
            { path: path.join(os.homedir(), ".pm2", "logs", "opencodex-out.log"), level: "info", source: "gateway" },
            { path: path.join(os.homedir(), ".pm2", "logs", "opencodex-error.log"), level: "error", source: "gateway" }
          ];
          const entries: Array<{ time: string; level: string; text: string; source: string }> = [];
          for (const file of logFiles) {
            const lines = readLogTail(file.path, 192 * 1024);
            let time = new Date().toLocaleTimeString();
            try { time = new Date(fs.statSync(file.path).mtimeMs).toLocaleTimeString(); } catch {}
            for (const line of lines.slice(-160)) {
              const text = redactLogLine(line).slice(0, 4000);
              if (/Written helper python scripts to \/tmp successfully\.?$/i.test(text.trim())) continue;
              const level = /successfully|running|ready|listening|started|written helper/i.test(text) && !/error|failed|exception|syntax error/i.test(text)
                ? "info"
                : file.level;
              entries.push({ time, level, source: file.source, text });
            }
          }
          const compacted: Array<{ time: string; level: string; text: string; source: string }> = [];
          const counts = new Map<string, number>();
          for (const entry of entries.slice(-300)) {
            const key = `${entry.level}|${entry.text}`;
            const previous = counts.get(key) || 0;
            counts.set(key, previous + 1);
            if (previous === 0) compacted.push(entry);
          }
          for (const entry of compacted) {
            const count = counts.get(`${entry.level}|${entry.text}`) || 1;
            if (count > 1) entry.text = `${entry.text}（重复 ${count} 次）`;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ entries: compacted }));
          return;
        }

        // Delete model endpoint
        if (req.method === "POST" && url.pathname === "/api/models/delete") {
          try {
            const body = await this.parseJsonBody(req);
            const id = body.id;
            const ids: string[] = Array.isArray(body.ids) ? body.ids : (id ? [id] : []);

            const providers = CredentialStore.loadProviders();
            let providersChanged = false;
            for (const provider of providers as any[]) {
              const nextModels = (provider.models || []).filter((model: string) => {
                const raw = String(model);
                const alias = raw.includes("=") ? raw.split("=")[0] : raw.includes("->") ? raw.split("->")[0] : raw;
                const namespaced = namespaceModelSlug(provider.name, alias.trim());
                return !ids.includes(raw) && !ids.includes(alias.trim()) && !ids.includes(namespaced);
              });
              if (nextModels.length !== (provider.models || []).length) {
                provider.models = nextModels;
                providersChanged = true;
              }
            }
            if (providersChanged) CredentialStore.saveProviders(providers);

            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            if (fs.existsSync(catalogPath)) {
              const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              if (Array.isArray(data.models)) {
                preserveOfficialModels(data);
                data.models = data.models.filter((model: any) => {
                  // Native Codex models are immutable from the web manager.
                  if (!catalogModelOwner(model)) return true;
                  return ![model.id, model.slug, model.model, model.backend_model]
                    .filter(Boolean)
                    .some((value: any) => ids.includes(String(value)));
                });
                preserveOfficialModels(data);
                fs.writeFileSync(catalogPath, JSON.stringify(data, null, 2), "utf-8");
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", deleted: ids }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // Delete provider endpoint
        if (req.method === "POST" && url.pathname === "/api/providers/delete") {
          try {
            const body = await this.parseJsonBody(req);
            const providerName = body.name || body.id;
            let providers = CredentialStore.loadProviders();
            providers = providers.filter((p: any) => p.name !== providerName && p.id !== providerName);
            CredentialStore.saveProviders(providers);

            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            if (fs.existsSync(catalogPath)) {
              try {
                const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
                if (Array.isArray(catalog.models)) {
                  catalog.models = catalog.models.filter((model: any) =>
                    String(model.backend_provider || model.provider_name || "").toLowerCase() !== String(providerName).toLowerCase()
                  );
                  preserveOfficialModels(catalog);
                  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");
                }
              } catch {}
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", deleted: providerName }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // Delete session endpoint
        if (req.method === "POST" && url.pathname === "/api/sessions/delete") {
          try {
            const body = await this.parseJsonBody(req);
            const id = typeof body.id === "string" ? body.id.trim() : "";
            if (!id || path.basename(id) !== id) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid session id" }));
              return;
            }

            const deletedFiles: string[] = [];
            const rolloutRoots = [
              path.join(os.homedir(), ".codex", "sessions"),
              path.join(os.homedir(), ".codex", "archived_sessions")
            ];
            for (const root of rolloutRoots) {
              if (!fs.existsSync(root)) continue;
              const files = fs.readdirSync(root, { recursive: true });
              for (const file of files) {
                if (typeof file !== "string" || (!file.endsWith(".json") && !file.endsWith(".jsonl"))) continue;
                const fullPath = path.join(root, file);
                const extension = file.endsWith(".jsonl") ? ".jsonl" : ".json";
                const fileId = path.basename(file, extension);
                if (fileId !== id) continue;
                fs.unlinkSync(fullPath);
                deletedFiles.push(fullPath);
              }
            }

            if (!deletedFiles.length) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Session not found", id }));
              return;
            }

            const historyPath = path.join(os.homedir(), ".codex", "history.jsonl");
            if (fs.existsSync(historyPath)) {
              try {
                const remaining = fs.readFileSync(historyPath, "utf-8")
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .filter((line) => {
                    try { return JSON.parse(line).session_id !== id; } catch { return true; }
                  });
                fs.writeFileSync(historyPath, remaining.length ? `${remaining.join("\n")}\n` : "", "utf-8");
              } catch {}
            }

            const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
            if (fs.existsSync(dbPath)) {
              const escapedId = id.replace(/'/g, "''");
              const rolloutPredicates = deletedFiles
                .map((file) => `rollout_path = '${file.replace(/'/g, "''")}'`)
                .join(" OR ");
              const where = [`id = '${escapedId}'`, rolloutPredicates].filter(Boolean).join(" OR ");
              const cp = await import("node:child_process");
              cp.execFileSync("sqlite3", [dbPath, `DELETE FROM threads WHERE ${where};`], { stdio: "ignore" });
            }

            const stillPresent = deletedFiles.filter((file) => fs.existsSync(file));
            if (stillPresent.length > 0) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Session file could not be removed", id, files: stillPresent }));
              return;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", deleted: id, files: deletedFiles, deleted_count: deletedFiles.length }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // Import session file/JSON endpoint
        if (req.method === "POST" && url.pathname === "/api/sessions/import") {
          try {
            const body = await this.parseJsonBody(req);
            const fileName = body.file_name || "session.json";
            const sessionId = String(body.session_id || `imported-${Date.now()}`)
              .replace(/[^A-Za-z0-9._-]/g, "-")
              .slice(0, 120) || `imported-${Date.now()}`;
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            const targetDir = path.join(os.homedir(), ".codex", "sessions", String(year), month, day);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }

            const targetFilePath = path.join(targetDir, `rollout-${now.toISOString().replace(/[:.]/g, "-")}-${sessionId}.jsonl`);
            let importedLines: string[] = [];

            importedLines.push(JSON.stringify({
              timestamp: now.toISOString(),
              type: "session_meta",
              payload: {
                session_id: sessionId,
                id: sessionId,
                timestamp: now.toISOString(),
                cwd: os.homedir(),
                originator: "Codex Desktop",
                cli_version: "0.142.5",
                source: "vscode",
                thread_source: "user",
                model_provider: "openai"
              }
            }));

            if (body.file_base64) {
              const fileContent = Buffer.from(body.file_base64, "base64").toString("utf-8");
              const lines = fileContent.split("\n").filter(Boolean);
              for (const l of lines) {
                try {
                  const p = JSON.parse(l);
                  if (p.type === "event_msg" || p.type === "response_item") {
                    importedLines.push(JSON.stringify(p));
                  } else if (p.role && p.content) {
                    const role = p.role === "user" ? "user" : "assistant";
                    importedLines.push(JSON.stringify({
                      timestamp: now.toISOString(),
                      type: "response_item",
                      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: typeof p.content === "string" ? p.content : JSON.stringify(p.content) }] }
                    }));
                  }
                } catch {}
              }
            }

            if (importedLines.length > 1) {
              fs.writeFileSync(targetFilePath, importedLines.join("\n") + "\n", "utf-8");
              const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
              if (fs.existsSync(dbPath)) {
                const cp = await import("node:child_process");
                const nowSec = Math.floor(Date.now() / 1000);
                const title = String(fileName || "Imported Session").replace(/'/g, "''").replace(/[\r\n]/g, " ").slice(0, 200);
                const sandboxPolicy = JSON.stringify({ type: "managed", file_system: { type: "restricted", entries: [] }, network: "restricted" }).replace(/'/g, "''");
                const sql = `INSERT OR REPLACE INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, preview, first_user_message, has_user_event, recency_at, recency_at_ms, cli_version, thread_source, model, memory_mode, history_mode) VALUES ('${sessionId}', '${targetFilePath}', ${nowSec}, ${nowSec}, 'vscode', 'openai', '${os.homedir()}', '${title}', '${sandboxPolicy}', 'on-request', '${title}', '${title}', 1, ${nowSec}, ${Date.now()}, '0.142.5', 'user', 'gpt-5.5', 'enabled', 'legacy');`;
                cp.execFileSync("sqlite3", [dbPath, sql], { stdio: "pipe" });
              }
              const devDbPath = path.join(os.homedir(), ".codex", "sqlite", "codex-dev.db");
              if (fs.existsSync(devDbPath)) {
                const cp = await import("node:child_process");
                const nowSec = Math.floor(Date.now() / 1000);
                const title = String(fileName || "Imported Session").replace(/'/g, "''").replace(/[\r\n]/g, " ").slice(0, 200);
                const devSql = `INSERT OR REPLACE INTO local_thread_catalog (host_id, thread_id, display_title, source_created_at, source_updated_at, cwd, source_kind, source_detail, model_provider, git_branch, observation_sequence, missing_candidate, thread_source) VALUES ('local', '${sessionId}', '${title}', ${nowSec}, ${nowSec}, '${os.homedir()}', 'vscode', NULL, 'openai', NULL, 10, 0, 'user');`;
                try { cp.execFileSync("sqlite3", [devDbPath, devSql], { stdio: "pipe" }); } catch {}
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", id: sessionId, restarted: false }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/reset") {
          try {
            const configPath = path.join(os.homedir(), ".codex", "config.toml");
            if (fs.existsSync(configPath)) {
              let content = fs.readFileSync(configPath, "utf-8");
              content = content.replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "").trim();
              content = content.replace(/^model\s*=\s*".*?"/m, 'model = "gpt-5.5"');
              fs.writeFileSync(configPath, content + "\n", "utf-8");
            }
            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            if (fs.existsSync(catalogPath)) {
              fs.writeFileSync(catalogPath, JSON.stringify({ models: [] }), "utf-8");
            }

            // Third-party V2 responses used to emit local rs_* reasoning items.
            // Remove those persisted records before the native desktop client
            // sends this thread back to chatgpt.com.
            repairNativeRollouts();

            restartDesktopClients(true);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", gateway_active: false }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Endpoint not found" }));
      });

      const { WebSocketServer } = await import("ws");
      const wss = new WebSocketServer({ noServer: true });

      const activeWsClients = new Set<any>();
      // @ts-ignore
      global.activeWsClients = activeWsClients;

      wss.on("connection", (ws: any) => {
        activeWsClients.add(ws);
        let audioBuffer = Buffer.alloc(0);
        let isListening = false;
        let lastProcessedLength = 0;
        let lastVADCheckedLength = 0;
        let chunkInterval: NodeJS.Timeout | null = null;
        let isProcessingChunk = false;
        let lastSpeechActivityTime = Date.now();
        let hasSentFinal = false;
        let lastTranscribedText = "";
        let consecutiveSilenceCount = 0;
        let speechDetected = false;
        let manualStop = false;

        const clearChunkInterval = () => {
          if (chunkInterval) {
            clearInterval(chunkInterval);
            chunkInterval = null;
          }
        };

        const checkSemanticVAD = async (text: string) => {
          if (hasSentFinal) return;
          const trimmed = text.trim();
          if (trimmed.length < 2) return;

          // Semantic AEC: Check if this is an echo of the system's TTS
          if (this.currentSystemUtterance && this.currentSystemUtterance.length > 0) {
            if (trimmed.length <= 2 && /^[啊嗯哦哈呀啦呢罢了的得地吗？。！]+$/.test(trimmed)) {
              return;
            }
            const cleanTrimmed = trimmed.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
            const cleanUtterance = this.currentSystemUtterance.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
            let isEcho = false;
            if (cleanUtterance.includes(cleanTrimmed)) {
              isEcho = true;
            } else if (cleanTrimmed.includes(cleanUtterance) && cleanTrimmed.length <= cleanUtterance.length + 3) {
              isEcho = true;
            }
            if (isEcho) {
              console.error(`[Semantic AEC] Ignored echo text: "${trimmed}"`);
              audioBuffer = Buffer.alloc(0);
              lastVADCheckedLength = 0;
              return;
            }
            console.error(`[Semantic AEC] Interruption detected! User said: "${trimmed}" while system was saying: "${this.currentSystemUtterance}"`);
            this.currentSystemUtterance = "";
            triggerSpeechEnd(trimmed);
            return;
          }

          if (trimmed === lastTranscribedText) {
            consecutiveSilenceCount++;
          } else {
            consecutiveSilenceCount = 0;
            lastTranscribedText = trimmed;
          }

          // Push-to-talk must wait for the physical key release. Keep the
          // latest partial transcription for an immediate final handoff, but
          // never let semantic VAD submit the request by itself.
          if (manualStop) return;

          const endParticles = ["吗", "呢", "了", "吧", "哈", "呀", "啊", "啦", "吗？", "呢？", "吧？", "呀？", "谢谢", "就可以了", "怎么做", "办", "。", "？", "！"];
          const matchesEnd = endParticles.some(p => trimmed.endsWith(p));

          if (matchesEnd && consecutiveSilenceCount >= 2) {
            triggerSpeechEnd(trimmed);
          }
        };

        const triggerSpeechEnd = async (finalText: string) => {
          if (hasSentFinal) return;
          hasSentFinal = true;
          isListening = false;
          clearChunkInterval();

          ws.send(JSON.stringify({ type: "stop_recording", text: finalText }));
          ws.send(JSON.stringify({ type: "transcription_final", text: finalText }));
        };

        ws.on("message", async (data: any, isBinary: boolean) => {
          if (isBinary) {
            if (isListening) {
              const buf = data as Buffer;
              audioBuffer = Buffer.concat([audioBuffer, buf]);

              // Run Silero VAD check if we have enough accumulated audio buffer
              const checkSize = 10240;
              if (audioBuffer.length >= checkSize && (audioBuffer.length - lastVADCheckedLength) >= 5120) {
                lastVADCheckedLength = audioBuffer.length;
                const startIdx = audioBuffer.length - 10240;
                const newChunk = audioBuffer.slice(startIdx, audioBuffer.length);
                const b64Data = newChunk.toString("base64");

                this.sendVADRequest({ action: "chunk", data: b64Data }).then(async (vadResult) => {
                  if (vadResult.error) return;
                  if (vadResult.has_speech) {
                    speechDetected = true;

                    let silenceThreshold = 0.8;
                    const p = path.join(os.homedir(), ".opencodex", "voice_settings.json");
                    if (fs.existsSync(p)) {
                      try {
                        const settings = JSON.parse(fs.readFileSync(p, "utf-8"));
                        if (settings.vad_duration !== undefined) {
                          silenceThreshold = parseFloat(settings.vad_duration);
                        }
                      } catch {}
                    }

                    if (!manualStop && vadResult.silence_at_end >= silenceThreshold) {
                      isListening = false;
                      clearChunkInterval();
                      if (!hasSentFinal) {
                        hasSentFinal = true;
                        ws.send(JSON.stringify({
                          type: "stop_recording",
                          text: lastTranscribedText
                        }));
                        await this.processWebSocketSTT(ws, audioBuffer, lastTranscribedText);
                      }
                    }
                  }
                }).catch(() => {});
              }
            }
            return;
          }

          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "start_stt") {
              this.sendVADRequest({ action: "reset" });
              audioBuffer = Buffer.alloc(0);
              lastVADCheckedLength = 0;
              this.currentSystemUtterance = "";
              lastProcessedLength = 0;
              lastTranscribedText = "";
              consecutiveSilenceCount = 0;
              isListening = true;
              manualStop = Boolean(msg.manual_stop);
              isProcessingChunk = false;
              hasSentFinal = false;
              speechDetected = false;

              clearChunkInterval();
              chunkInterval = setInterval(async () => {
                if (!isListening || isProcessingChunk || hasSentFinal || !speechDetected) return;
                if (audioBuffer.length < 16000) return;

                if (audioBuffer.length > lastProcessedLength + 8000) {
                  isProcessingChunk = true;
                  try {
                    const currentBuffer = audioBuffer;
                    lastProcessedLength = currentBuffer.length;

                    const p = path.join(os.homedir(), ".opencodex", "voice_settings.json");
                    let settings: any = {
                      stt_engine: "local-whisper",
                      stt_api_key: "",
                      stt_base_url: "https://api.openai.com/v1",
                      stt_model: "whisper-1"
                    };
                    if (fs.existsSync(p)) {
                      try { settings = { ...settings, ...JSON.parse(fs.readFileSync(p, "utf-8")) }; } catch {}
                    }

                    const pcmToWav = (buf: Buffer, rate: number, channels: number, bits: number) => {
                        const wavHeader = Buffer.alloc(44);
                        wavHeader.write("RIFF", 0);
                        wavHeader.writeUInt32LE(36 + buf.length, 4);
                        wavHeader.write("WAVE", 8);
                        wavHeader.write("fmt ", 12);
                        wavHeader.writeUInt32LE(16, 16);
                        wavHeader.writeUInt16LE(1, 20);
                        wavHeader.writeUInt16LE(channels, 22);
                        wavHeader.writeUInt32LE(rate, 24);
                        wavHeader.writeUInt32LE(rate * channels * bits / 8, 28);
                        wavHeader.writeUInt16LE(channels * bits / 8, 32);
                        wavHeader.writeUInt16LE(bits, 34);
                        wavHeader.write("data", 36);
                        wavHeader.writeUInt32LE(buf.length, 40);
                        return Buffer.concat([wavHeader, buf]);
                    };

                    const wavBuffer = pcmToWav(currentBuffer, 16000, 1, 16);
                    const tmpWavPath = `/tmp/ws_chunk_${Date.now()}.wav`;
                    fs.writeFileSync(tmpWavPath, wavBuffer);

                    let text = "";
                    const isAPI = settings.stt_engine === "openai-compatible" || settings.stt_engine === "groq" || (settings.stt_api_key && settings.stt_api_key.startsWith("gsk_")) || settings.stt_base_url.includes("groq");
                    if (isAPI) {
                      text = await this.transcribeAudioAPI(tmpWavPath, settings);
                    } else {
                      text = await new Promise<string>((resolve) => {
                        this.transcribeAudioLocal(tmpWavPath, settings, (resText) => {
                          resolve(resText || "");
                        });
                      });
                    }

                    try { fs.unlinkSync(tmpWavPath); } catch {}

                    if (text && text.trim().length > 0) {
                      ws.send(JSON.stringify({
                        type: "transcription_partial",
                        text: text
                      }));

                      await checkSemanticVAD(text);
                    }
                  } catch (err: any) {
                    console.error(`[WebSocket STT Chunk Error] ${err.message}`);
                  } finally {
                    isProcessingChunk = false;
                  }
                }
              }, 400);
            } else if (msg.type === "stop_stt") {
              isListening = false;
              clearChunkInterval();
              if (!hasSentFinal) {
                hasSentFinal = true;
                // In push-to-talk mode the latest rolling chunk can still be
                // in flight when the key is released. Always transcribe the
                // complete buffered recording so the final words are not cut
                // off; the rolling result remains a fallback only.
                await this.processWebSocketSTT(ws, audioBuffer, lastTranscribedText);
              }
            } else if (msg.type === "active_session_changed") {
              const sid = msg.session_id;
              if (sid) {
                const settingsPath = path.join(os.homedir(), ".opencodex", "voice_settings.json");
                let settings: any = {};
                if (fs.existsSync(settingsPath)) {
                  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
                }
                settings.active_session_id = sid;
                try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8"); } catch {}
              }
            }
          } catch (err: any) {
            console.error(`[WebSocket message err] ${err.message}`);
          }
        });

        ws.on("close", () => {
          activeWsClients.delete(ws);
          isListening = false;
          clearChunkInterval();
          audioBuffer = Buffer.alloc(0);
        });
      });

      const proxyWebSocketToOpenAI = (req: http.IncomingMessage, socket: any, head: Buffer) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const targetHost = "api.openai.com";
        const targetPort = 443;

        console.log(`[CodexBridge V2] Proxying Realtime WebSocket to wss://${targetHost}${url.pathname}${url.search}`);

        const targetSocket = tls.connect(targetPort, targetHost, { servername: targetHost }, () => {
          let reqLines = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
          reqLines += `Host: ${targetHost}\r\n`;

          for (const [key, value] of Object.entries(req.headers)) {
            const k = key.toLowerCase();
            if (k === "host") continue;
            if (k === "origin") {
              reqLines += `Origin: https://chatgpt.com\r\n`;
              continue;
            }
            if (Array.isArray(value)) {
              for (const v of value) {
                reqLines += `${key}: ${v}\r\n`;
              }
            } else if (value) {
              reqLines += `${key}: ${value}\r\n`;
            }
          }
          reqLines += "\r\n";

          targetSocket.write(reqLines);
          if (head && head.length > 0) {
            targetSocket.write(head);
          }

          socket.pipe(targetSocket);
          targetSocket.pipe(socket);
        });

        targetSocket.on("error", (err) => {
          console.error(`[CodexBridge V2] Realtime WebSocket proxy error: ${err.message}`);
          socket.destroy();
        });

        socket.on("error", () => {
          targetSocket.destroy();
        });
      };

      this.server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (url.pathname.includes("realtime") || url.pathname.includes("audio") || url.pathname.includes("voice") || url.pathname.startsWith("/v1/live/") || url.pathname.startsWith("/backend-api/")) {
          if (url.pathname.startsWith("/v1/live/")) this.markRealtimeActive();
          handleWebRtcProxy(req, socket, head, { localAdminToken: this.adminToken });
          return;
        }

        if (url.pathname.includes("responses")) {
          socket.write("HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"Responses WebSocket transport is disabled; use HTTP\",\"type\":\"upgrade_required\"}}");
          socket.destroy();
          return;
        }

        // Handle voice bar & companion WebSockets
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });

      this.server.on("error", (err) => {
        console.error(`[CodexBridge V2] Server error: ${err.message}`);
        this.releaseServerLock();
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`[CodexBridge V2] Server listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  private async transcribeAudioAPI(filePath: string, settings: any): Promise<string> {
    let apiKey = settings.stt_api_key || "";
    if (!apiKey && settings.stt_credential_ref) {
      apiKey = CredentialStore.readKeychainSecret("OpenCodex Voice Credential", settings.stt_credential_ref) || "";
    }
    const baseUrl = settings.stt_base_url || "https://api.openai.com/v1";
    const model = settings.stt_model || "whisper-1";

    const url = baseUrl.endsWith("/audio/transcriptions")
      ? baseUrl
      : `${baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

    const audioData = fs.readFileSync(filePath);
    const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
    let payload = Buffer.alloc(0);

    const appendField = (name: string, value: string) => {
      let str = `--${boundary}\r\n`;
      str += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
      str += `${value}\r\n`;
      payload = Buffer.concat([payload, Buffer.from(str)]);
    };

    const appendFile = (name: string, filename: string, data: Buffer) => {
      let str = `--${boundary}\r\n`;
      str += `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`;
      str += `Content-Type: audio/wav\r\n\r\n`;
      payload = Buffer.concat([payload, Buffer.from(str), data, Buffer.from("\r\n")]);
    };

    appendField("model", model);
    appendField("language", "zh");
    appendFile("file", "speech.wav", audioData);
    payload = Buffer.concat([payload, Buffer.from(`--${boundary}--\r\n`)]);

    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: payload
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`STT API returned status ${response.status}: ${errText}`);
    }

    const resJson: any = await response.json();
    return resJson.text || "";
  }

  private transcribeAudioLocal(filePath: string, settings: any, cb: (text: string | null) => void) {
    const pythonCmd = resolveRuntimeBinary("python3");
    const localModel = typeof settings?.stt_model === "string" && settings.stt_model.trim()
      ? settings.stt_model.trim()
      : "base";
    const args = ["/tmp/ocb_transcribe.py", filePath, localModel];
    const uvxPath = resolveRuntimeBinary("uvx");

    const env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${os.homedir()}/Library/Python/3.9/bin:${os.homedir()}/.local/bin:${process.env.PATH || ""}`
    };

    const child = uvxPath !== "uvx" || fs.existsSync(uvxPath)
      ? spawn(uvxPath, ["--with", "openai-whisper", "python3", "/tmp/ocb_transcribe.py", filePath, localModel], { env })
      : spawn(pythonCmd, args, { env });

    let output = "";
    let errorOutput = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    child.on("close", (code: number) => {
      if (code === 0) {
        const text = output.trim();
        cb(text);
      } else {
        cb(null);
      }
    });
  }

  private injectPromptViaCDP(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      try {
        fetch("http://127.0.0.1:8315/json")
          .then(res => res.json())
          .then(async (targets: any) => {
            const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
            if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
              resolve("connection_failed");
              return;
            }

            const { WebSocket } = await import("ws");
            const cdpWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
            let completed = false;

            cdpWs.on("open", () => {
              const evalExpr = `
                (() => {
                  const el = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror, [contenteditable="true"]');
                  if (!el) return 'ProseMirror not found';
                  el.focus();
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
                  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return new Promise(resolve => setTimeout(() => {
                    const sendBtn = Array.from(document.querySelectorAll('button')).find(b => {
                      const className = typeof b.className === 'string' ? b.className : '';
                      const label = b.getAttribute('aria-label') || '';
                      return !b.disabled && (className.includes('size-token-button-composer') || /send|发送/i.test(label));
                    });
                    if (!sendBtn) { resolve('send_button_not_found'); return; }
                    sendBtn.click();
                    resolve('Sent');
                  }, 100));
                })()
              `;
              cdpWs.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: evalExpr, returnByValue: true, awaitPromise: true } }));
            });

            cdpWs.on("message", (data: any) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.id === 1) {
                  if (!completed) {
                    completed = true;
                    cdpWs.close();
                    const val = msg.result?.result?.value;
                    if (val === "Sent") resolve("success");
                    else if (val === "send_button_not_found") resolve("send_button_not_found");
                    else resolve("element_not_found");
                  }
                }
              } catch {}
            });

            cdpWs.on("error", () => {
              if (!completed) { completed = true; resolve("connection_failed"); }
            });
          })
          .catch(() => resolve("connection_failed"));
      } catch {
        resolve("connection_failed");
      }
    });
  }

  private initCodexMcp() {
    if (this.mcpProcess) return;
    console.error("[OpenCodex MCP Manager] Starting persistent codex mcp-server...");

    this.mcpProcess = spawn("/Applications/ChatGPT.app/Contents/Resources/codex", ["mcp-server"]);
    this.mcpStdoutBuffer = "";

    this.mcpProcess.stdout.on("data", (chunk: Buffer) => {
      this.mcpStdoutBuffer += chunk.toString("utf-8");
      let newlineIdx;
      while ((newlineIdx = this.mcpStdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.mcpStdoutBuffer.substring(0, newlineIdx).trim();
        this.mcpStdoutBuffer = this.mcpStdoutBuffer.substring(newlineIdx + 1);
        if (line) {
          try {
            const data = JSON.parse(line);
            if (data.method === "codex/event" && data.params && data.params.msg) {
              const msg = data.params.msg;
              const reqIdStr = data.params._meta?.requestId;
              const reqId = reqIdStr ? parseInt(reqIdStr, 10) : NaN;
              if (!isNaN(reqId) && this.mcpRequests.has(reqId)) {
                const req = this.mcpRequests.get(reqId)!;
                if (msg.type === "agent_message_content_delta" && typeof msg.delta === "string") {
                  req.accumulatedReply += msg.delta;
                  if (req.onDelta) req.onDelta(msg.delta);
                }
              }
            } else if (data.id !== undefined && this.mcpRequests.has(data.id)) {
              const req = this.mcpRequests.get(data.id)!;
              this.mcpRequests.delete(data.id);
              if (data.error) {
                req.reject(new Error(data.error.message || "MCP call failed"));
              } else {
                const content = data.result?.structuredContent?.content || req.accumulatedReply;
                req.resolve({ threadId: data.result?.structuredContent?.threadId || data.result?.threadId, reply: content });
              }
            }
          } catch {}
        }
      }
    });

    this.mcpProcess.stderr.on("data", (chunk: Buffer) => {
      console.error(`[OpenCodex MCP STDERR] ${chunk.toString().trim().split("\n")[0]}`);
    });

    this.mcpProcess.on("close", (code: number) => {
      console.error(`[OpenCodex MCP Manager] codex mcp-server exited with code ${code}`);
      this.mcpProcess = null;
      for (const [id, req] of this.mcpRequests.entries()) {
        req.reject(new Error("MCP process closed"));
      }
      this.mcpRequests.clear();
      setTimeout(() => this.initCodexMcp(), 2000);
    });

    setTimeout(() => {
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify({
          jsonrpc: "2.0", method: "initialize",
          params: { clientName: "opencodex-voice-bridge", clientVersion: "1.0.0", protocolVersion: "2024-11-05" },
          id: ++this.mcpRequestId
        }) + "\n");
      }
    }, 500);

    setTimeout(() => {
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      }
    }, 1000);
  }

  public askMcp(prompt: string, threadId?: string, onDelta?: (text: string) => void): Promise<{ threadId: string; reply: string }> {
    return new Promise((resolve, reject) => {
      if (!this.mcpProcess) this.initCodexMcp();
      const id = ++this.mcpRequestId;
      this.mcpRequests.set(id, { resolve, reject, onDelta, accumulatedReply: "" });
      const useThreadId = threadId && threadId !== "default" ? threadId : null;
      const toolName = useThreadId ? "codex-reply" : "codex";
      const args: any = { prompt };
      if (useThreadId) {
        args.threadId = useThreadId;
      } else {
        args.config = { approval_policy: "never" };
      }
      const request = { jsonrpc: "2.0", method: "tools/call", params: { name: toolName, arguments: args }, id };
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify(request) + "\n");
      } else {
        this.mcpRequests.delete(id);
        reject(new Error("MCP process not initialized"));
      }
    });
  }

  private async processWebSocketSTT(ws: any, pcmBuffer: Buffer, fallbackText: string = "") {
    try {
      const p = path.join(os.homedir(), ".opencodex", "voice_settings.json");
      let settings: any = {
        stt_engine: "local-whisper",
        stt_api_key: "",
        stt_base_url: "https://api.openai.com/v1",
        stt_model: "whisper-1"
      };
      if (fs.existsSync(p)) {
        try { settings = { ...settings, ...JSON.parse(fs.readFileSync(p, "utf-8")) }; } catch {}
      }

      const pcmToWav = (buf: Buffer, rate: number, channels: number, bits: number) => {
        const wavHeader = Buffer.alloc(44);
        wavHeader.write("RIFF", 0);
        wavHeader.writeUInt32LE(36 + buf.length, 4);
        wavHeader.write("WAVE", 8);
        wavHeader.write("fmt ", 12);
        wavHeader.writeUInt32LE(16, 16);
        wavHeader.writeUInt16LE(1, 20);
        wavHeader.writeUInt16LE(channels, 22);
        wavHeader.writeUInt32LE(rate, 24);
        wavHeader.writeUInt32LE(rate * channels * bits / 8, 28);
        wavHeader.writeUInt16LE(channels * bits / 8, 32);
        wavHeader.writeUInt16LE(bits, 34);
        wavHeader.write("data", 36);
        wavHeader.writeUInt32LE(buf.length, 40);
        return Buffer.concat([wavHeader, buf]);
      };

      const wavBuffer = pcmToWav(pcmBuffer, 16000, 1, 16);
      const tmpWavPath = `/tmp/ws_stt_${Date.now()}.wav`;
      fs.writeFileSync(tmpWavPath, wavBuffer);

      let text = "";
      const isAPI = settings.stt_engine === "openai-compatible" || settings.stt_engine === "groq" || (settings.stt_api_key && settings.stt_api_key.startsWith("gsk_")) || settings.stt_base_url.includes("groq");

      if (isAPI) {
        text = await this.transcribeAudioAPI(tmpWavPath, settings);
      } else {
        text = await new Promise<string>((resolve) => {
          this.transcribeAudioLocal(tmpWavPath, settings, (resText) => {
            resolve(resText || "");
          });
        });
      }

      try { fs.unlinkSync(tmpWavPath); } catch {}

      const cleanText = text.replace(/^[。！？\.\s]+|[。！？\.\s]+$/g, '');
      if (cleanText.length === 0 || text.includes('......') || text.includes('。。。') || text.includes('李宗盛') || text.includes('明镜') || text.includes('字幕由') || (text.length < fallbackText.length - 3 && fallbackText.length > 0)) {
        text = fallbackText;
      }

      ws.send(JSON.stringify({
        type: "transcription_final",
        text: text
      }));
    } catch (err: any) {
      ws.send(JSON.stringify({
        type: "transcription_final",
        text: ""
      }));
    }
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.releaseServerLock();
          void closeUpstreamDispatcher().finally(resolve);
        });
      } else {
        this.releaseServerLock();
        void closeUpstreamDispatcher().finally(resolve);
      }
    });
  }
}
