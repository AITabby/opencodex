/**
 * OpenCodex Proxy Server
 * Connects standard Codex requests to selected API providers (DeepSeek, SiliconFlow, OpenAI, Custom).
 * Hosts the local glassmorphic dashboard at http://localhost:8765/dashboard.
 * Broadcasts real-time terminal logs to dashboard sessions using SSE.
 */

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync, rmSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { exec, spawn, spawnSync, execSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
// @ts-ignore
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch } from "undici";
import zlib from "node:zlib";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { decompress as zstdDecompress } from "fzstd";

// Auto-detect and configure outbound proxy support
let proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;

const wsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
const fetchDispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : undefined;
const MAX_REQUEST_BODY_BYTES = 80 * 1024 * 1024;

class UpstreamError extends Error {
  constructor(public status: number, public text: string) {
    super(`Upstream error: ${status} - ${text}`);
    this.name = "UpstreamError";
  }
}
const REQUEST_DEBUG_ENABLED = process.env.OPENCODEX_DEBUG_REQUESTS === "1";
const NATIVE_MODE_PATH = join(homedir(), ".opencodex", "native_mode");

export function isNativeModeEnabled(): boolean {
  return existsSync(NATIVE_MODE_PATH);
}

function isTrustedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
      && parsed.port === "8765";
  } catch {
    return false;
  }
}

function redactSecrets<T extends Record<string, any>>(value: T): T {
  return {
    ...value,
    stt_api_key: value.stt_api_key ? `${String(value.stt_api_key).slice(0, 4)}...` : "",
    tts_api_key: value.tts_api_key ? `${String(value.tts_api_key).slice(0, 4)}...` : ""
  };
}

function keepExistingSecret(incoming: unknown, existing: unknown): string {
  if (incoming === undefined && typeof existing === "string") return existing;
  const next = typeof incoming === "string" ? incoming : "";
  if (next.includes("...") && typeof existing === "string") return existing;
  return next;
}

type VoiceEndpointProfile = {
  kind: "complete" | "neutral" | "incomplete";
  silenceSeconds: number;
  hardSilenceSeconds: number;
};

function getVoiceEndpointProfile(text: string, configuredSilence: number): VoiceEndpointProfile {
  const trimmed = text.trim();
  const base = Number.isFinite(configuredSilence)
    ? Math.min(4, Math.max(0.8, configuredSilence))
    : 1.5;

  const incompleteEnding = /(?:，|、|：|:|的|和|与|或|但|但是|不过|然后|因为|所以|如果|虽然|而且|还有|就是|那个|这个|比如|例如|我觉得|我认为|我的意思|开始|源于|包括|关于|至于|以及)$/;
  const explicitEnding = /(?:[。？！?!]|谢谢|就这样|就可以了|怎么做|怎么办|什么意思|可以吗|行不行)$/;

  if (incompleteEnding.test(trimmed) && !/(?:好的|可以的|没问题的)$/.test(trimmed)) {
    return {
      kind: "incomplete",
      silenceSeconds: Math.max(2.5, base + 0.9),
      hardSilenceSeconds: Math.max(3.4, base + 1.8)
    };
  }

  if (explicitEnding.test(trimmed)) {
    return {
      kind: "complete",
      silenceSeconds: Math.min(base, 1.0),
      hardSilenceSeconds: Math.max(1.8, base + 0.4)
    };
  }

  return {
    kind: "neutral",
    silenceSeconds: Math.max(1.6, base),
    hardSilenceSeconds: Math.max(2.6, base + 1.0)
  };
}

if (proxyUrl) {
  console.log(`[OpenCodex Proxy] Configured outbound proxy agent with: ${proxyUrl}`);
}

import {
  responsesToChat,
  responsesToChatWin,
  chatCompletionToResponse,
  extractNamespaceMap,
  ensureComputerUseResponsesTools,
  ResponsesStreamState,
  processVisionBridge,
  runToolLocally,
  pendingToolCallsMap,
  pendingToolArgumentsAccumulator,
  itemIdToCallIdMap
} from "./translator.js";

import { getDashboardHtml } from "./dashboard.js";
import { getVisualizerHtml } from "./visualizer.js";
import { getOrbHtml } from "./orb_view.js";
import { withCodexAppServer } from "./codex_app_server.js";
import {
  memoryPackageFromMessages,
  memoryPackageFromThread,
  normalizeImportedMemory,
  OPENCODEX_MEMORY_TURN_ID,
  toAnthropicPayload,
  toMarkdown,
  toOpenAiMessages,
  toResponsesItems,
  type OpenCodexMemoryPackage
} from "./memory_bridge.js";
import { parseMemoryFile, parseMemoryFilePath } from "./memory_file_import.js";
import {
  scanLocalMemorySources,
  type ScannedMemorySource
} from "./memory_source_scanner.js";

interface ProviderConfig {
  name: string;
  base_url: string;
  api_key: string;
  api_keys?: string[];
  vision_model?: string;
}

interface ProxyConfig {
  providers: ProviderConfig[];
}

// In-Memory Live Logs Buffer & SSE broadcaster
const activeSseClients = new Set<(payload: any) => void>();
const logBuffer: any[] = [];
const MAX_LOG_BUFFER = 200;

export function addLog(tag: string, text: string, level: string = "info") {
  const timeStr = new Date().toLocaleTimeString();
  const payload = { time: timeStr, tag, text, level };
  logBuffer.push(payload);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.shift();
  }
    for (const send of activeSseClients) {
    try {
      send(payload);
    } catch {
      // ignore
    }
  }
}

export function broadcastSessionUpdate(sessionId: string, tokens: number, contextWindow: number, model: string, isEstimated: boolean) {
  const payload = {
    type: "session_update",
    sessionId,
    tokens,
    context_window: contextWindow,
    model,
    is_estimated: isEstimated,
    timestamp: Date.now()
  };
  for (const send of activeSseClients) {
    try {
      send(payload);
    } catch {}
  }
}

// Intercept all system logs so they stream seamlessly to the Web Dashboard!
const originalLog = console.log;
const originalError = console.error;

console.log = (...args: any[]) => {
  originalLog(...args);
  const txt = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  addLog("INFO", txt, "info");
};

console.error = (...args: any[]) => {
  originalError(...args);
  const txt = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  addLog("PROXY", txt, "warn");
};

function isSameMessage(m1: any, m2: any): boolean {
  if (m1.role !== m2.role) return false;
  const c1 = (typeof m1.content === "string" ? m1.content : "").trim();
  const c2 = (typeof m2.content === "string" ? m2.content : "").trim();
  if (m1.role === "tool") {
    return m1.tool_call_id === m2.tool_call_id && c1 === c2;
  }
  if (m1.role === "assistant") {
    const contentMatch = c1 === c2;
    if (!contentMatch) return false;
    const tc1 = m1.tool_calls || [];
    const tc2 = m2.tool_calls || [];
    if (tc1.length !== tc2.length) return false;
    for (let i = 0; i < tc1.length; i++) {
      if (tc1[i].function?.name !== tc2[i].function?.name) return false;
      if (tc1[i].function?.arguments !== tc2[i].function?.arguments) return false;
    }
    return true;
  }
  return c1 === c2;
}

function mergeHistory(history: any[], incoming: any[]): any[] {
  let overlapLength = 0;
  for (let i = 1; i <= Math.min(history.length, incoming.length); i++) {
    let match = true;
    for (let j = 0; j < i; j++) {
      const historyIndex = history.length - i + j;
      const incomingIndex = j;
      if (!isSameMessage(history[historyIndex], incoming[incomingIndex])) {
        match = false;
        break;
      }
    }
    if (match) {
      overlapLength = i;
    }
  }
  return history.concat(incoming.slice(overlapLength));
}

function isCustomCatalogModel(model: any): boolean {
  const slug = String(model?.slug || model?.model || "").toLowerCase();
  return model?.provider === "opencodex"
    || !!model?.backend_provider
    || slug.includes("deepseek")
    || slug.includes("minimax")
    || slug.includes("qwen")
    || slug.startsWith("mimo");
}

function hasThirdPartyModels(catalog: any): boolean {
  return !!catalog
    && Array.isArray(catalog.models)
    && catalog.models.some((model: any) => isCustomCatalogModel(model));
}

/**
 * Codex decides whether to expose MCP/Computer Use from the catalog entry,
 * before the request reaches this proxy.  Keep every BYOK/custom entry
 * usable with the local computer-use bridge, including older entries that
 * were saved without these fields.
 */
function normalizeCustomModelCapabilities(catalog: any): boolean {
  if (!catalog || !Array.isArray(catalog.models)) return false;

  let changed = false;
  for (const model of catalog.models) {
    if (!isCustomCatalogModel(model)) continue;

    const supportedTools = Array.isArray(model.experimental_supported_tools)
      ? [...model.experimental_supported_tools]
      : [];
    for (const tool of ["computer_use", "mcp"]) {
      if (!supportedTools.includes(tool)) {
        supportedTools.push(tool);
        changed = true;
      }
    }
    if (JSON.stringify(model.experimental_supported_tools) !== JSON.stringify(supportedTools)) {
      model.experimental_supported_tools = supportedTools;
      changed = true;
    }
    if (model.supports_computer_use !== true) {
      model.supports_computer_use = true;
      changed = true;
    }
    if (model.supports_mcp !== true) {
      model.supports_mcp = true;
      changed = true;
    }
    if (model.supported_in_api !== true) {
      model.supported_in_api = true;
      changed = true;
    }
  }
  return changed;
}

function loadHistoryFromRollout(sessionId: string): any[] {
  if (!sessionId || sessionId === "default" || sessionId.length < 10) {
    return [];
  }
  const codexDir = join(homedir(), ".codex", "sessions");
  if (!existsSync(codexDir)) return [];

  let filePath: string | null = null;
  try {
    const years = readdirSync(codexDir)
      .filter(f => /^\d{4}$/.test(f))
      .sort((a, b) => b.localeCompare(a));

    for (const year of years) {
      if (filePath) break;
      const yearDir = join(codexDir, year);
      try {
        const months = readdirSync(yearDir)
          .filter(f => /^\d{2}$/.test(f))
          .sort((a, b) => b.localeCompare(a));

        for (const month of months) {
          if (filePath) break;
          const monthDir = join(yearDir, month);
          try {
            const days = readdirSync(monthDir)
              .filter(f => /^\d{2}$/.test(f))
              .sort((a, b) => b.localeCompare(a));

            for (const day of days) {
              if (filePath) break;
              const dayDir = join(monthDir, day);
              try {
                const files = readdirSync(dayDir);
                const matched = files.find(f => f.endsWith(`${sessionId}.jsonl`));
                if (matched) {
                  filePath = join(dayDir, matched);
                  break;
                }
              } catch (e) {
                // ignore dayDir read error
              }
            }
          } catch (e) {
            // ignore monthDir read error
          }
        }
      } catch (e) {
        // ignore yearDir read error
      }
    }
  } catch (err) {
    console.error(`[OpenCodex] Error searching rollout file:`, err);
  }

  if (!filePath) {
    return [];
  }

  const messages: any[] = [];
  try {
    let content = readFileSync(filePath, "utf-8");
    if (content.includes("anthropic-thinking-v1:")) {
      console.log(`[OpenCodex] Sanitizing encrypted thinking block in rollout file: ${filePath}`);
      content = content.replace(/"encrypted_content":"anthropic-thinking-v1:[^"]*"/g, '"encrypted_content":null');
      try {
        writeFileSync(filePath, content, "utf-8");
      } catch (err: any) {
        console.error(`[OpenCodex] Failed to write sanitized rollout file: ${err.message}`);
      }
    }
    const lines = content.split("\n");
    let detectedModel = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "turn_context" && parsed.payload?.model) {
        detectedModel = String(parsed.payload.model);
      }
      if (parsed.type === "response_item" && parsed.payload && parsed.payload.type === "message") {
        const payload = parsed.payload;
        const role = payload.role;
        if (role !== "user" && role !== "assistant") continue;

        let textContent = "";
        if (typeof payload.content === "string") {
          textContent = payload.content;
        } else if (Array.isArray(payload.content)) {
          for (const part of payload.content) {
            if (typeof part === "string") {
              textContent += part;
            } else if (part && typeof part === "object") {
              if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
                textContent += part.text || "";
              }
            }
          }
        }

        textContent = textContent.trim();
        if (textContent) {
          // Ignore background JSON title messages to prevent chat history contamination
          if (textContent.startsWith("{") && textContent.includes('"title"')) {
            continue;
          }
          messages.push({
            role,
            content: textContent,
            id: payload.id || payload.messageItemId
          });
        }
      }
    }
    if (detectedModel) {
      (messages as any).model = detectedModel;
    }
  } catch (err) {
    // ignore
  }

  return messages;
}

function loadImportedMemoryFromRollout(sessionId: string): any[] {
  if (!sessionId || sessionId === "default" || sessionId.length < 10) return [];
  const rolloutFile = findRolloutFileById(join(homedir(), ".codex", "sessions"), sessionId);
  if (!rolloutFile || !existsSync(rolloutFile)) return [];

  const messages: any[] = [];
  let importedMemoryStarted = false;
  try {
    const lines = readFileSync(rolloutFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const item = JSON.parse(trimmed);
      const payload = item.type === "response_item" ? item.payload : null;
      if (payload?.type !== "message") continue;
      const isImportedMessage =
        payload.internal_chat_message_metadata_passthrough?.turn_id === OPENCODEX_MEMORY_TURN_ID;
      if (isImportedMessage) importedMemoryStarted = true;
      if (!isImportedMessage && (!importedMemoryStarted || !["user", "assistant"].includes(payload.role))) {
        continue;
      }
      if (!["system", "developer", "user", "assistant"].includes(payload.role)) continue;

      let text = "";
      if (typeof payload.content === "string") {
        text = payload.content;
      } else if (Array.isArray(payload.content)) {
        for (const part of payload.content) {
          if (typeof part === "string") {
            text += part;
          } else if (part && typeof part.text === "string") {
            text += part.text;
          }
        }
      }
      const normalizedText = text.trim();
      if (normalizedText && !(normalizedText.startsWith("{") && normalizedText.includes('"title"'))) {
        messages.push({
          role: payload.role,
          content: normalizedText
        });
      }
    }
  } catch {}
  return messages;
}

function getSessionTitle(sessionId: string): string {
  const sessionIndexPath = join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(sessionIndexPath)) return `Codex conversation ${sessionId}`;

  let title = "";
  try {
    for (const line of readFileSync(sessionIndexPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const item = JSON.parse(trimmed);
      if (item.id === sessionId && typeof item.thread_name === "string") {
        title = item.thread_name;
      }
    }
  } catch {}
  return title || `Codex conversation ${sessionId}`;
}

function getPreferredCodexCwd(): string {
  try {
    const sessionsDir = join(homedir(), ".codex", "sessions");
    const recentFiles = findRolloutFiles(sessionsDir)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 20);
    for (const file of recentFiles) {
      const content = readFileSync(file, "utf-8");
      if (content.includes(OPENCODEX_MEMORY_TURN_ID)) continue;
      const firstLine = content.split("\n", 1)[0];
      const metadata = JSON.parse(firstLine);
      const cwd = metadata.type === "session_meta" ? metadata.payload?.cwd : "";
      if (typeof cwd === "string" && cwd && existsSync(cwd) && statSync(cwd).isDirectory()) {
        return cwd;
      }
    }
  } catch {}
  return homedir();
}

function appendImportedSessionProjection(
  rolloutPath: string,
  title: string,
  messageCount: number,
  cwd: string,
  model: string
): void {
  if (!rolloutPath || !existsSync(rolloutPath)) {
    throw new Error("Codex did not create a readable rollout file");
  }

  const timestamp = new Date().toISOString();
  const turnId = randomUUID();
  const userMessage = `Imported memory: ${title} (${messageCount} messages)`;
  const assistantMessage = "The imported conversation is available as model-visible history. Continue normally from this thread.";
  const projection = [
    {
      timestamp,
      type: "turn_context",
      payload: {
        turn_id: turnId,
        cwd,
        workspace_roots: [cwd],
        model
      }
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: userMessage,
        images: [],
        local_images: [],
        text_elements: []
      }
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: assistantMessage,
        phase: "final_answer"
      }
    }
  ];
  appendFileSync(rolloutPath, "\n" + projection.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf-8");
}

async function updateImportedThreadState(threadId: string, preview: string): Promise<void> {
  const databasePath = join(homedir(), ".codex", "state_5.sqlite");
  if (!existsSync(databasePath)) return;

  try {
    // node:sqlite is available on current Node releases and updates the live DB without rewriting it.
    // @ts-ignore
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.prepare(`
        UPDATE threads
        SET thread_source = 'user',
            preview = ?,
            first_user_message = ?
        WHERE id = ?
      `).run(preview, preview, threadId);
    } finally {
      database.close();
    }
    return;
  } catch {}

  const escapeSql = (value: string) => value.replace(/'/g, "''");
  const result = spawnSync("sqlite3", [
    databasePath,
    `PRAGMA busy_timeout=5000; UPDATE threads SET thread_source='user', preview='${escapeSql(preview)}', first_user_message='${escapeSql(preview)}' WHERE id='${escapeSql(threadId)}';`
  ], { encoding: "utf-8" });
  if (result.status !== 0) {
    console.error(`[OpenCodex Memory Bridge] Unable to update Codex thread index: ${result.stderr || result.error?.message || "unknown error"}`);
  }
}

async function importMemoryIntoCodex(memory: OpenCodexMemoryPackage): Promise<{
  id: string;
  name: string;
  message_count: number;
  event_count: number;
}> {
  const fallbackTitle = `Imported conversation ${new Date().toLocaleDateString()}`;
  const threadName = String(memory.title || fallbackTitle).slice(0, 200);
  const sourceCwd = memory.source?.cwd;
  let importCwd = getPreferredCodexCwd();
  if (sourceCwd && existsSync(sourceCwd)) {
    try {
      if (statSync(sourceCwd).isDirectory()) importCwd = sourceCwd;
    } catch {}
  }
  const responseItems = toResponsesItems(memory);

  const newSid = await withCodexAppServer(async (client) => {
    let createdThreadId = "";
    try {
      const startResult = await client.call("thread/start", {
        cwd: importCwd,
        threadSource: "user"
      }, 60000);
      createdThreadId = String(startResult.thread?.id || "");
      if (!createdThreadId) throw new Error("Codex did not return a thread id");

      for (let index = 0; index < responseItems.length; index += 200) {
        await client.call("thread/inject_items", {
          threadId: createdThreadId,
          items: responseItems.slice(index, index + 200)
        }, 60000);
      }

      await client.call("thread/name/set", {
        threadId: createdThreadId,
        name: threadName
      });
      const readResult = await client.call("thread/read", {
        threadId: createdThreadId,
        includeTurns: false
      });
      appendImportedSessionProjection(
        String(readResult.thread?.path || ""),
        threadName,
        memory.messages.length,
        importCwd,
        String(startResult.model || "gpt-5.5")
      );
      await client.call("thread/list", { limit: 20, sourceKinds: [] });
      return createdThreadId;
    } catch (error) {
      if (createdThreadId) {
        try {
          await client.call("thread/archive", { threadId: createdThreadId });
        } catch {}
      }
      throw error;
    }
  });

  await updateImportedThreadState(
    newSid,
    `Imported memory: ${threadName} (${memory.messages.length} messages)`
  );
  return {
    id: newSid,
    name: threadName,
    message_count: memory.messages.length,
    event_count: memory.events?.length || 0
  };
}

function alignToolMessages(msgs: any[]): any[] {
  const toolMessagesMap = new Map<string, any>();
  const otherMessages: any[] = [];
  
  for (const m of msgs) {
    if (m.role === "tool" && m.tool_call_id) {
      toolMessagesMap.set(m.tool_call_id, m);
    } else {
      otherMessages.push(m);
    }
  }
  
  const result: any[] = [];
  const processedToolCallIds = new Set<string>();
  
  for (const m of otherMessages) {
    result.push(m);
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        if (tc.id) {
          processedToolCallIds.add(tc.id);
          const toolMsg = toolMessagesMap.get(tc.id);
          if (toolMsg) {
            result.push(toolMsg);
          } else {
            result.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Tool execution completed (no output returned)."
            });
          }
        }
      }
    }
  }
  
  for (const [id, toolMsg] of toolMessagesMap.entries()) {
    if (!processedToolCallIds.has(id)) {
      console.warn(`[OpenCodex WS Proxy] Discarding orphaned tool message for tool_call_id: ${id}`);
    }
  }
  
  return result;
}

/**
 * DeepSeek is stricter than MiniMax about Chat Completions tool history. Keep
 * system messages at the front, give assistant tool-call messages non-empty
 * content, and ensure tool outputs are never sent as null/empty values.
 */
function normalizeDeepSeekToolHistory(messages: any[], model: string): any[] {
  if (!/deepseek/i.test(model)) return messages;

  const systemMessages: any[] = [];
  const conversationMessages: any[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemMessages.push(message);
    } else {
      conversationMessages.push(message);
    }
  }

  for (const message of conversationMessages) {
    if (message.role === "assistant" && message.tool_calls?.length > 0
      && (message.content === null || message.content === undefined || message.content === "")) {
      message.content = " ";
    }
    if (message.role === "tool"
      && (message.content === null || message.content === undefined || message.content === "")) {
      message.content = " ";
    }
  }

  return [...systemMessages, ...conversationMessages];
}


type LocalTokenSource = "model_tokenizer" | "model_estimate" | "generic_estimate";

interface LocalTokenEstimate {
  tokens: number;
  source: LocalTokenSource;
  tokenizer: string;
}

let o200kEncoding: Tiktoken | undefined;
let cl100kEncoding: Tiktoken | undefined;

function serializeTokenizableRequest(body: any): string {
  return JSON.stringify({
    messages: Array.isArray(body?.messages) ? body.messages : [],
    tools: Array.isArray(body?.tools) ? body.tools : []
  });
}

function estimateTokensForMessages(
  messages: any[],
  weights: { cjk: number; whitespace: number; other: number } = { cjk: 1.2, whitespace: 0.5, other: 0.25 }
): number {
  let tokens = 0;
  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) {
        tokens += weights.cjk;
      } else if (text[i] === " " || text[i] === "\n") {
        tokens += weights.whitespace;
      } else {
        tokens += weights.other;
      }
    }
    tokens += 4; // overhead
  }
  return Math.ceil(tokens);
}

function estimateTokensForRequest(body: any, model: string): LocalTokenEstimate {
  const normalizedModel = String(model || "").toLowerCase();
  const serialized = serializeTokenizableRequest(body);

  // OpenAI's recent model families use o200k_base; older GPT-3.5/4 models use cl100k_base.
  // Tokenizing the complete serialized request also includes tool schemas, calls and results.
  if (/(?:^|[\/:_.-])(gpt-5|gpt-4\.1|gpt-4o|o[134](?:-|$))/.test(normalizedModel)) {
    o200kEncoding ||= getEncoding("o200k_base");
    return {
      tokens: o200kEncoding.encode(serialized).length,
      source: "model_tokenizer",
      tokenizer: "o200k_base"
    };
  }
  if (/(?:^|[\/:_.-])(gpt-4(?:-|$)|gpt-3\.5)/.test(normalizedModel)) {
    cl100kEncoding ||= getEncoding("cl100k_base");
    return {
      tokens: cl100kEncoding.encode(serialized).length,
      source: "model_tokenizer",
      tokenizer: "cl100k_base"
    };
  }

  const profiles: Array<{
    pattern: RegExp;
    name: string;
    weights: { cjk: number; whitespace: number; other: number };
  }> = [
    { pattern: /qwen|qwq/, name: "qwen_family", weights: { cjk: 1.0, whitespace: 0.35, other: 0.28 } },
    { pattern: /deepseek/, name: "deepseek_family", weights: { cjk: 1.05, whitespace: 0.4, other: 0.28 } },
    { pattern: /glm|chatglm/, name: "glm_family", weights: { cjk: 1.1, whitespace: 0.4, other: 0.3 } },
    { pattern: /minimax|abab/, name: "minimax_family", weights: { cjk: 1.05, whitespace: 0.4, other: 0.29 } },
    { pattern: /mimo/, name: "mimo_family", weights: { cjk: 1.05, whitespace: 0.4, other: 0.29 } }
  ];
  const profile = profiles.find(item => item.pattern.test(normalizedModel));
  if (profile) {
    return {
      tokens: estimateTokensForMessages([{ role: "request", content: serialized }], profile.weights),
      source: "model_estimate",
      tokenizer: profile.name
    };
  }

  return {
    tokens: estimateTokensForMessages([{ role: "request", content: serialized }]),
    source: "generic_estimate",
    tokenizer: "generic"
  };
}

type ContextUsageSource = "provider" | "rollout_actual" | LocalTokenSource;

interface SessionContextSnapshot {
  tokens: number;
  is_estimated: boolean;
  model?: string;
  context_window?: number;
  estimated_tokens?: number;
  provider_prompt_tokens?: number;
  provider_completion_tokens?: number;
  source?: ContextUsageSource;
  tokenizer?: string;
}

interface SessionCumulativeUsage {
  input_tokens: number;
  output_tokens: number;
}


function pruneMessagesToLimit(messages: any[], limit: number, model: string, tools: any[] = []): any[] {
  let estimated = estimateTokensForRequest({ messages, tools }, model).tokens;
  if (estimated <= limit) return messages;

  console.log(`[OpenCodex WS Proxy] Context limit reached (${estimated} > ${limit}). Pruning oldest messages...`);
  
  // Separate system messages and chat messages
  const systemMessages = messages.filter(m => m.role === "system");
  let chatMessages = messages.filter(m => m.role !== "system");

  // Keep pruning oldest chat messages until we are under the limit
  while (chatMessages.length > 2 && estimated > limit) {
    chatMessages.shift();
    estimated = estimateTokensForRequest({ messages: [...systemMessages, ...chatMessages], tools }, model).tokens;
  }

  return [...systemMessages, ...chatMessages];
}


export class ProxyServer {
  private server: http.Server | null = null;
  public config!: ProxyConfig;
  private configDir = join(homedir(), ".opencodex");
  private initializedSessions = new Set<string>();
  private customConversationHistory = new Map<string, any[]>();
  private customModelSessions = new Set<string>();
  private sessionModelMap = new Map<string, string>();
  private sessionThreadMap = new Map<string, string>();
  private sessionPrevResponseIdFailed = new Map<string, boolean>();
  private sessionSequenceNumberMap = new Map<string, number>();
  private lastCompletedSequenceNumberMap = new Map<string, number>();
  private lastWsMap = new Map<string, any>();
  private sessionLastModelWasOfficial = new Map<string, boolean>();
  private sessionActiveWs = new Map<string, WebSocket>();
  private forcedErrorSessions = new Set<string>();
  private customSessionQueues = new Map<any, Promise<void>>();
  private activeAbortControllers = new Map<string, AbortController>();
  private sessionContextMap = new Map<string, SessionContextSnapshot>();
  private sessionModelContextMap = new Map<string, SessionContextSnapshot>();
  private sessionCumulativeUsage = new Map<string, SessionCumulativeUsage>();
  private currentActiveSessionId: string = "";
  private titleSessionHashes = new Set<string>();
  private currentSystemUtterance: string = "";
  private voiceSessionThreadIds = new Map<string, string>();
  public codexMcpClient: any = null;
  private mcpProcess: any = null;
  private mcpRequestId = 0;
  private mcpRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void; onDelta?: (text: string) => void; accumulatedReply: string }>();
  private mcpStdoutBuffer = "";
  private vadProcess: any = null;
  private vadStdoutBuffer = "";
  private vadCallbackQueue: ((res: any) => void)[] = [];
  private orbProcess: any = null;
  private antigravityTokenCache = "";
  private antigravityTokenCacheTime = 0;
  private memorySourceFiles = new Map<string, ScannedMemorySource>();
  private providerRotationIndices = new Map<string, number>();

  private getNextKeyForProvider(provider: ProviderConfig): string {
    const keys = provider.api_keys && provider.api_keys.length > 0 ? provider.api_keys : [provider.api_key];
    if (keys.length <= 1) {
      return this.resolveKey(keys[0] || "");
    }
    let idx = this.providerRotationIndices.get(provider.name) || 0;
    const key = keys[idx];
    idx = (idx + 1) % keys.length;
    this.providerRotationIndices.set(provider.name, idx);
    console.log(`[OpenCodex Key Rotation] Rotating key for provider ${provider.name} (index: ${idx}, total keys: ${keys.length})`);
    return this.resolveKey(key);
  }

  private loginStatus = { status: "idle", error: "" };
  private loginBrowserProcess: any = null;

  private getLoginStatus() {
    return this.loginStatus;
  }

  private async launchLoginBrowser(platform: string, providerName: string) {
    if (this.loginBrowserProcess) {
      try { this.loginBrowserProcess.kill(); } catch {}
      this.loginBrowserProcess = null;
    }

    this.loginStatus = { status: "logging_in", error: "" };
    console.log(`[OpenCodex Web Login] Launching login window for ${platform}...`);

    const loginUrl = platform === "grok-web" ? "https://x.com/login" : "https://chatgpt.com/auth/login";
    const port = 9222;
    const profileDir = join(this.configDir, `login-profile-${platform}`);

    const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (!existsSync(chromePath)) {
      this.loginStatus = { status: "failed", error: "Google Chrome not found in /Applications" };
      return;
    }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      loginUrl
    ];

    try {
      this.loginBrowserProcess = spawn(chromePath, args);
      this.loginBrowserProcess.on("exit", () => {
        console.log(`[OpenCodex Web Login] Browser window closed.`);
        if (this.loginStatus.status === "logging_in") {
          this.loginStatus = { status: "failed", error: "User closed the browser window before completing login" };
        }
        this.loginBrowserProcess = null;
      });

      setTimeout(async () => {
        try {
          await this.monitorLoginCookies(platform, providerName, port, profileDir);
        } catch (err: any) {
          console.error(`[OpenCodex Web Login Error]`, err);
          this.loginStatus = { status: "failed", error: err.message };
        }
      }, 2500);

    } catch (err: any) {
      this.loginStatus = { status: "failed", error: err.message };
    }
  }

  private async monitorLoginCookies(platform: string, providerName: string, port: number, profileDir: string) {
    let wsUrl = "";
    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`, { dispatcher: fetchDispatcher });
      const pages = (await listRes.json()) as any[];
      const targetPage = pages.find((p: any) => p.type === "page");
      if (targetPage && targetPage.webSocketDebuggerUrl) {
        wsUrl = targetPage.webSocketDebuggerUrl;
      }
    } catch (e: any) {
      console.log(`[OpenCodex Web Login] Retrying CDP connection...`);
      await new Promise(r => setTimeout(r, 2000));
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`, { dispatcher: fetchDispatcher });
      const pages = (await listRes.json()) as any[];
      const targetPage = pages.find((p: any) => p.type === "page");
      if (targetPage && targetPage.webSocketDebuggerUrl) {
        wsUrl = targetPage.webSocketDebuggerUrl;
      }
    }

    if (!wsUrl) {
      throw new Error("Could not find Chrome debugger WebSocket URL");
    }

    console.log(`[OpenCodex Web Login] Connected to CDP: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
    });

    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 2, method: "Network.getCookies" }));
      }
    }, 1500);

    ws.on("message", (dataStr) => {
      try {
        const msg = JSON.parse(dataStr.toString());
        if (msg.id === 2 && msg.result && Array.isArray(msg.result.cookies)) {
          const cookies = msg.result.cookies;
          
          if (platform === "grok-web") {
            const authToken = cookies.find((c: any) => c.name === "auth_token");
            const ct0 = cookies.find((c: any) => c.name === "ct0");
            if (authToken && ct0) {
              clearInterval(interval);
              ws.close();
              const cookieStr = `auth_token=${authToken.value}; ct0=${ct0.value}`;
              console.log(`[OpenCodex Web Login] Successfully captured Grok cookies!`);
              this.saveCapturedCookieToProvider(providerName, cookieStr, "grok-web");
              this.cleanupLoginCapture(profileDir);
            }
          } else if (platform === "chatgpt-web") {
            const sessionToken = cookies.find((c: any) => c.name === "__Secure-next-auth.session-token");
            if (sessionToken) {
              clearInterval(interval);
              ws.close();
              const cookieStr = `__Secure-next-auth.session-token=${sessionToken.value}`;
              console.log(`[OpenCodex Web Login] Successfully captured ChatGPT session token!`);
              this.saveCapturedCookieToProvider(providerName, cookieStr, "chatgpt-web");
              this.cleanupLoginCapture(profileDir);
            }
          }
        }
      } catch (err) {
        console.error("[OpenCodex Web Login CDP Msg Error]", err);
      }
    });

    ws.on("close", () => {
      clearInterval(interval);
    });
  }

  private saveCapturedCookieToProvider(providerName: string, cookieStr: string, platformType: string) {
    let provider = this.config.providers.find(p => p.name === providerName);
    if (!provider) {
      provider = {
        name: providerName,
        base_url: platformType,
        api_key: cookieStr
      };
      this.config.providers.push(provider);
    } else {
      provider.base_url = platformType;
      provider.api_key = cookieStr;
    }
    this.saveConfig();
    this.loginStatus = { status: "success", error: "" };
    console.log(`[OpenCodex Config] Auto-updated provider config for ${providerName}`);
  }

  private cleanupLoginCapture(profileDir: string) {
    if (this.loginBrowserProcess) {
      try { this.loginBrowserProcess.kill(); } catch {}
      this.loginBrowserProcess = null;
    }
  }

  private async fetchWithWebBridge(url: string, options: any): Promise<any> {
    try {
      if (options.body) {
        const reqBody = JSON.parse(options.body);
        const catalog = this.getModelCatalog();
        const catalogEntry = catalog?.models?.find((m: any) => m.backend_model === reqBody.model && m.backend_provider === "antigravity");
        if (catalogEntry) {
          const token = this.resolveKey("antigravity-cli-auto");
          let originalModel = catalogEntry.slug || options.requestedModel || reqBody.model;
          if (originalModel.includes("flash")) originalModel = "gemini-3.5-flash-low";
          else if (originalModel.includes("pro") || originalModel.includes("claude") || originalModel.includes("sonnet") || originalModel.includes("opus") || originalModel === "gpt-5.5" || originalModel === "gpt-5.6-terra") originalModel = "gemini-3.1-pro-low";
          else if (originalModel === "gpt-5.4-mini") originalModel = "gemini-3.5-flash-low";
          else originalModel = "gemini-3.5-flash-low";
          console.log(`[OpenCodex Antigravity Bridge] Intercepted native model ${reqBody.model}. Mapped to original model ${originalModel}. Routing to daily-cloudcode-pa.googleapis.com`);
          return this.handleAntigravityBridge(options.body, token, originalModel);
        }
      }
    } catch {}

    const isGrokWeb = url.includes("grok-web");
    const isChatGPTWeb = url.includes("chatgpt-web");

    if (!isGrokWeb && !isChatGPTWeb) {
      return fetch(url, options);
    }

    const cookieStr = (options.headers["Authorization"] || "").replace("Bearer ", "");
    let finalCookie = cookieStr;
    if (!finalCookie || finalCookie === "...") {
      const targetProviderName = isChatGPTWeb ? "chatgpt" : "grok";
      const p = this.config.providers.find((prov: any) => prov.name === targetProviderName);
      if (p && p.api_key) {
        finalCookie = this.resolveKey(p.api_key);
        console.log(`[OpenCodex Web Bridge] Fallback to auto-captured cookies for ${targetProviderName}`);
      }
    }
    
    if (isChatGPTWeb) {
      return this.handleChatGPTWebBridge(options.body, finalCookie);
    } else {
      return this.handleGrokWebBridge(options.body, finalCookie);
    }
  }

  private async handleAntigravityBridge(requestBodyStr: string, token: string, model: string): Promise<any> {
    console.log(`[OpenCodex Antigravity Bridge] Initializing conversation...`);
    const reqBody = JSON.parse(requestBodyStr);
    const contents: any[] = [];
    for (const m of reqBody.messages) {
      if (m.role === "system") continue;
      const role = m.role === "assistant" ? "model" : "user";
      const text = m.content || "";
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += "\n" + text;
      } else {
        contents.push({
          role,
          parts: [{ text }]
        });
      }
    }
    if (contents.length > 0 && contents[0].role === "model") {
      contents.unshift({
        role: "user",
        parts: [{ text: "Hello" }]
      });
    }

    const antigravityPayload = {
      project: "default-cli-project",
      model: model,
      request: {
        contents: contents,
        generationConfig: {}
      }
    };

    const response = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "antigravity/hub/2.2.1 darwin/arm64",
        "Accept-Encoding": "gzip"
      },
      body: JSON.stringify(antigravityPayload),
      dispatcher: fetchDispatcher
    });

    if (!response.ok) {
      const errorText = await response.text();
      let userFriendlyMsg = `Antigravity API Error: ${response.status} - ${errorText}`;
      if (response.status === 401) {
        userFriendlyMsg = `[OpenCodex Proxy Error] Antigravity 登录凭证已过期/无效，请在终端（PowerShell 或 CMD）运行 "agy login" 重新登录激活权限！`;
      }
      return new Response(JSON.stringify({ error: userFriendlyMsg }), { status: response.status });
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const simulatedStream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]" || !trimmed.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(trimmed.slice(6));
              const part = data.response?.candidates?.[0]?.content?.parts?.[0]?.text || data.candidates?.[0]?.content?.parts?.[0]?.text || "";
              if (part) {
                const choices = [{
                  delta: { content: part }
                }];
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices })}\n\n`));
              }
            } catch {}
          }
        }
      }
    });

    return new Response(simulatedStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  private async handleChatGPTWebBridge(requestBodyStr: string, sessionToken: string): Promise<any> {
    console.log(`[OpenCodex ChatGPT Web Bridge] Initializing conversation...`);
    const reqBody = JSON.parse(requestBodyStr);
    const prompt = reqBody.messages?.[reqBody.messages.length - 1]?.content || "Hello";

    let accessToken = "";
    try {
      const sessionRes = await fetch("https://chatgpt.com/api/auth/session", {
        headers: {
          "Cookie": `__Secure-next-auth.session-token=${sessionToken}`,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        dispatcher: fetchDispatcher
      });
      if (!sessionRes.ok) {
        throw new Error(`Failed to fetch session: ${sessionRes.status}`);
      }
      const sessionData = await sessionRes.json() as any;
      accessToken = sessionData.accessToken;
    } catch (err: any) {
      console.error(`[OpenCodex ChatGPT Web Bridge Auth Error]`, err);
      return new Response(JSON.stringify({ error: `Authentication failed: ${err.message}` }), { status: 401 });
    }

    const chatGptWebPayload = {
      action: "next",
      messages: [
        {
          id: randomUUID(),
          author: { role: "user" },
          content: { content_type: "text", parts: [prompt] },
          metadata: {}
        }
      ],
      parent_message_id: randomUUID(),
      model: "auto",
      timezone_offset_min: -480,
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" }
    };

    const response = await fetch("https://chatgpt.com/backend-api/conversation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(chatGptWebPayload),
      dispatcher: fetchDispatcher
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(JSON.stringify({ error: `ChatGPT Web API Error: ${response.status} - ${errorText}` }), { status: response.status });
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const simulatedStream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]" || !trimmed.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(trimmed.slice(6));
              const part = data.message?.content?.parts?.[0] || "";
              const choices = [{
                delta: { content: part }
              }];
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices })}\n\n`));
            } catch {}
          }
        }
      }
    });

    return new Response(simulatedStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  private async handleGrokWebBridge(requestBodyStr: string, cookieStr: string): Promise<any> {
    console.log(`[OpenCodex Grok Web Bridge] Initializing conversation...`);
    const reqBody = JSON.parse(requestBodyStr);
    const prompt = reqBody.messages?.[reqBody.messages.length - 1]?.content || "Hello";

    const ct0Match = cookieStr.match(/ct0=([^;]+)/);
    const ct0 = ct0Match ? ct0Match[1] : "";

    let conversationId = "";
    try {
      const convoRes = await fetch("https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation", {
        method: "POST",
        headers: {
          "Cookie": cookieStr,
          "authorization": "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
          "x-csrf-token": ct0,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        body: JSON.stringify({ variables: {}, queryId: "vvC5uy7pWWHXS2aDi1FZeA" }),
        dispatcher: fetchDispatcher
      });
      if (convoRes.ok) {
        const convoData = (await convoRes.json()) as any;
        conversationId = convoData?.data?.create_grok_conversation?.conversation_id || "";
      } else {
        const errText = await convoRes.text();
        return new Response(JSON.stringify({ error: `CreateGrokConversation failed: ${convoRes.status} - ${errText}` }), { status: convoRes.status });
      }
    } catch (e: any) {
      console.error("[OpenCodex Grok Web Bridge] Failed to initialize conversation:", e);
      return new Response(JSON.stringify({ error: `CreateGrokConversation exception: ${e.message}` }), { status: 500 });
    }

    if (!conversationId) {
      return new Response(JSON.stringify({ error: `Could not obtain conversationId from CreateGrokConversation` }), { status: 500 });
    }

    const grokWebPayload = {
      responses: [{ message: prompt, sender: 1, promptSource: "", fileAttachments: [] }],
      systemPromptName: "",
      grokModelOptionId: "grok-3",
      conversationId: conversationId,
      returnSearchResults: true,
      returnCitations: true,
      promptMetadata: { promptSource: "NATURAL", action: "INPUT" },
      imageGenerationCount: 4,
      requestFeatures: { eagerTweets: true, serverHistory: true },
      enableCustomization: true,
      enableSideBySide: true,
      toolOverrides: {},
      isDeepsearch: false,
      isReasoning: false
    };

    const response = await fetch("https://x.com/i/api/2/grok/add_response.json", {
      method: "POST",
      headers: {
        "Cookie": cookieStr,
        "authorization": "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
        "x-csrf-token": ct0,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(grokWebPayload),
      dispatcher: fetchDispatcher
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(JSON.stringify({ error: `Grok Web API Error: ${response.status} - ${errorText}` }), { status: response.status });
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const simulatedStream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            try {
              const cleanLine = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
              const data = JSON.parse(cleanLine);
              const text = data.result?.message || data.grokResponseToken || "";
              if (text) {
                const choices = [{
                  delta: { content: text }
                }];
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices })}\n\n`));
              }
            } catch {}
          }
        }
      }
    });

    return new Response(simulatedStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  constructor() {
    this.ensureConfigDir();
    this.ensureCheckPermsHelper();
    this.loadConfig();
    if (!isNativeModeEnabled()) {
      this.autoPatchCodexConfig();
    }
    this.mergeNativeModelsIntoCatalog();
    this.upgradeReasoningLevelsInCatalog();
    if (!isNativeModeEnabled()) {
      this.autoPatchPlugins();
    }
    this.ensurePythonScripts();
    this.startVADDaemon();
  }

  private contextKey(sessionId: string, model: string): string {
    return `${sessionId}\u0000${model}`;
  }

  private getModelContextWindow(model: string): number {
    const catalog = this.getModelCatalog();
    const entry = catalog.models?.find((item: any) => item.slug === model);
    return entry?.context_window || 200000;
  }

  private clearSessionUsage(sessionId: string): void {
    this.sessionContextMap.delete(sessionId);
    const prefix = `${sessionId}\u0000`;
    for (const key of this.sessionModelContextMap.keys()) {
      if (key.startsWith(prefix)) this.sessionModelContextMap.delete(key);
    }
    for (const key of this.sessionCumulativeUsage.keys()) {
      if (key.startsWith(prefix)) this.sessionCumulativeUsage.delete(key);
    }
  }

  private updateContextUsage(
    sessionId: string,
    model: string,
    requestBody: any,
    contextWindow: number,
    providerUsage?: any
  ): SessionContextSnapshot {
    const localEstimate = estimateTokensForRequest(requestBody, model);
    const estimatedTokens = localEstimate.tokens;
    const providerPromptTokens = Number.isFinite(providerUsage?.prompt_tokens)
      ? Number(providerUsage.prompt_tokens)
      : Number.isFinite(providerUsage?.input_tokens)
        ? Number(providerUsage.input_tokens)
        : undefined;
    const providerCompletionTokens = Number.isFinite(providerUsage?.completion_tokens)
      ? Number(providerUsage.completion_tokens)
      : Number.isFinite(providerUsage?.output_tokens)
        ? Number(providerUsage.output_tokens)
        : undefined;
    const providerContextTokens = providerPromptTokens === undefined
      ? undefined
      : providerPromptTokens + (providerCompletionTokens || 0);
    const tokens = providerContextTokens ?? estimatedTokens;
    const source: ContextUsageSource = providerContextTokens === undefined
      ? localEstimate.source
      : "provider";
    const snapshot: SessionContextSnapshot = {
      tokens,
      is_estimated: source !== "provider",
      model,
      context_window: contextWindow,
      estimated_tokens: estimatedTokens,
      provider_prompt_tokens: providerPromptTokens,
      provider_completion_tokens: providerCompletionTokens,
      source,
      tokenizer: localEstimate.tokenizer
    };
    this.sessionModelContextMap.set(this.contextKey(sessionId, model), snapshot);
    this.sessionContextMap.set(sessionId, snapshot);

    if (providerPromptTokens !== undefined || providerCompletionTokens !== undefined) {
      const cumulativeKey = this.contextKey(sessionId, model);
      const cumulative = this.sessionCumulativeUsage.get(cumulativeKey) || { input_tokens: 0, output_tokens: 0 };
      cumulative.input_tokens += providerPromptTokens || 0;
      cumulative.output_tokens += providerCompletionTokens || 0;
      this.sessionCumulativeUsage.set(cumulativeKey, cumulative);
    }

    broadcastSessionUpdate(sessionId, tokens, contextWindow, model, snapshot.is_estimated);
    console.log(`[OpenCodex Context] session=${sessionId} model=${model} effective=${tokens} estimated=${estimatedTokens} provider=${providerContextTokens ?? "n/a"} source=${source} tokenizer=${localEstimate.tokenizer}`);

    if (tokens > contextWindow * 0.85) {
      console.log(`[AutoCompact] Custom model session ${sessionId} token count ${tokens} exceeds 85% of limit ${contextWindow}. Triggering /compact.`);
      setTimeout(() => {
        this.triggerAutoCompact(sessionId);
      }, 2000);
    }

    return snapshot;
  }

  private triggerAutoCompact(sid: string) {
    console.log(`[AutoCompact] Triggering automatic /compact for session ${sid}...`);
    this.clearSessionUsage(sid);
    this.customConversationHistory.delete(sid);

    fetch("http://127.0.0.1:8315/json")
      .then(res => res.json())
      .then((targets: any) => {
        const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
        if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
          console.error("[AutoCompact] Main Codex window page target not found via CDP");
          return;
        }

        const tempWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
        tempWs.on("open", () => {
          const evalScript = `
            (() => {
              const editor = document.querySelector('.ProseMirror');
              if (!editor) return { status: 'failed', reason: 'ProseMirror editor not found' };
              editor.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
              document.execCommand('insertText', false, '/compact');

              const createEnterEvent = (type) => new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
              });
              editor.dispatchEvent(createEnterEvent('keydown'));
              editor.dispatchEvent(createEnterEvent('keypress'));
              editor.dispatchEvent(createEnterEvent('keyup'));
              return { status: 'success' };
            })()
          `;
          tempWs.send(JSON.stringify({
            id: 300,
            method: "Runtime.evaluate",
            params: { expression: evalScript, returnByValue: true }
          }));
        });
        tempWs.on("message", (msgData) => {
          try {
            const resObj = JSON.parse(msgData.toString());
            if (resObj.id === 300) {
              console.log("[AutoCompact] CDP evaluate result:", resObj.result);
              tempWs.close();
            }
          } catch {}
        });
      })
      .catch((err: any) => {
        console.error("[AutoCompact] Error querying CDP for compaction:", err.message);
      });
  }

  private startVADDaemon() {
    if (this.vadProcess) return;

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(moduleDir, "silero_vad_daemon.py"),
      join(moduleDir, "..", "..", "src", "proxy", "silero_vad_daemon.py"),
      join(process.cwd(), "src", "proxy", "silero_vad_daemon.py")
    ];
    const scriptPath = candidates.find((p) => existsSync(p));
    if (!scriptPath) {
      console.error("[OpenCodex VAD] silero_vad_daemon.py not found. Voice VAD is disabled for this session.");
      return;
    }
    console.error(`[OpenCodex VAD] Starting persistent VAD daemon from: ${scriptPath}`);

    const python = "python3";
    this.vadProcess = spawn(python, [scriptPath]);
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

    this.vadProcess.on("error", (err: Error) => {
      console.error(`[OpenCodex VAD] Could not start ${python}: ${err.message}`);
      this.vadProcess = null;
      this.vadCallbackQueue = [];
    });

    this.vadProcess.on("close", (code: number) => {
      console.error(`[OpenCodex VAD Daemon Closed] Exit code: ${code}`);
      this.vadProcess = null;
      this.vadCallbackQueue = [];
    });
  }

  private sendVADRequest(req: any): Promise<any> {
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

  private ensureConfigDir() {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  private ensureCheckPermsHelper() {
    if (process.platform !== "darwin") return;
    const helperPath = join(this.configDir, "check_perms");
    if (!existsSync(helperPath)) {
      console.log("[OpenCodex] Building permission checker helper...");
      const swiftCode = `import Foundation
import ApplicationServices
import CoreGraphics

print(AXIsProcessTrusted())
if #available(macOS 10.15, *) {
    print(CGPreflightScreenCaptureAccess())
} else {
    print(true)
}
`;
      const tempSwiftFile = join(this.configDir, "temp_check_perms.swift");
      try {
        writeFileSync(tempSwiftFile, swiftCode, "utf-8");
        const compileRes = spawnSync("swiftc", [tempSwiftFile, "-o", helperPath], { encoding: "utf-8" });
        if (compileRes.status !== 0) {
          console.error(`[OpenCodex] Failed to compile check_perms helper: ${compileRes.stderr}`);
        } else {
          console.log("[OpenCodex] Successfully compiled check_perms helper.");
        }
      } catch (err: any) {
        console.error(`[OpenCodex] Error creating check_perms helper: ${err.message}`);
      } finally {
        if (existsSync(tempSwiftFile)) {
          try { unlinkSync(tempSwiftFile); } catch {}
        }
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
        req = urllib.request.Request(
            url, 
            data=json.dumps(payload).encode("utf-8"), 
            headers=headers, 
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            res_data = response.read().decode("utf-8")
            res_json = json.loads(res_data)
            
            if "base_resp" in res_json and res_json["base_resp"].get("status_code") != 0:
                msg = res_json["base_resp"].get("status_msg", "Unknown error")
                print(f"ERROR: MiniMax API Error: {msg}")
                sys.exit(1)
                
            audio_data = res_json.get("data")
            if not audio_data:
                print("ERROR: No audio data returned from MiniMax")
                sys.exit(1)
            audio_hex = audio_data.get("audio") if isinstance(audio_data, dict) else audio_data
            if not audio_hex:
                print("ERROR: No audio hex string found")
                sys.exit(1)
                
            audio_bytes = binascii.unhexlify(audio_hex)
            
            with open(output_path, "wb") as f:
                f.write(audio_bytes)
                
            print("SUCCESS")
    except Exception as e:
        print(f"ERROR: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()`;

    const transcribeScript = `import sys
import os
import warnings

# Suppress warnings (like the FP16 CPU warning) to keep stdout clean
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
        
    # Load model (cached locally in ~/.cache/whisper)
    model = whisper.load_model("base")
    
    # Transcribe (fp16=False avoids CPU warning)
    result = model.transcribe(audio_path, fp16=False)
    
    # Output the transcribed text
    print(result.get("text", "").strip())
except Exception as e:
    print(f"ERROR: {str(e)}")
    sys.exit(1)`;

    try {
      writeFileSync(join(tmpdir(), "ocb_minimax_tts.py"), minimaxScript, "utf-8");
      writeFileSync(join(tmpdir(), "ocb_transcribe.py"), transcribeScript, "utf-8");
      console.error(`[OpenCodex] Written helper python scripts to ${tmpdir()} successfully.`);
    } catch (err: any) {
      console.error("[OpenCodex] Failed to write helper python scripts: " + err.message);
    }
  }


  private loadConfig() {
    const p = join(this.configDir, "providers.json");
    if (existsSync(p)) {
      try {
        this.config = JSON.parse(readFileSync(p, "utf-8"));
        console.error(`[OpenCodex] Loaded providers configuration: ${p}`);

        if (this.config.providers && Array.isArray(this.config.providers)) {
          for (const prov of this.config.providers) {
            if (prov.base_url === "claude-cli-auto-url") {
              try {
                const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
                if (existsSync(claudeSettingsPath)) {
                  const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
                  prov.base_url = settings?.env?.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
                } else {
                  prov.base_url = "https://api.anthropic.com/v1";
                }
              } catch {
                prov.base_url = "https://api.anthropic.com/v1";
              }
            }
          }
        }

        // Clean up unused blank providers on startup
        const catalog = this.getModelCatalog();
        const activeProviders = new Set<string>();
        activeProviders.add("opencode");
        if (catalog && Array.isArray(catalog.models)) {
          for (const m of catalog.models) {
            if (m.provider) {
              activeProviders.add(m.provider);
            }
          }
        }
        if (this.config.providers && Array.isArray(this.config.providers)) {
          const originalCount = this.config.providers.length;
          this.config.providers = this.config.providers.filter((prov: any) => {
            if (prov.name === "opencode" || prov.name === "") return true;
            const hasCredentials = (prov.base_url && prov.base_url.trim() !== "") || (prov.api_key && prov.api_key.trim() !== "");
            return hasCredentials || activeProviders.has(prov.name);
          });
          if (this.config.providers.length < originalCount) {
            console.error(`[OpenCodex] Startup cleanup: removed ${originalCount - this.config.providers.length} unused blank provider(s).`);
            this.saveConfig();
          }
        }
        return;
      } catch (err: any) {
        console.error(`[OpenCodex] Error reading providers.json: ${err.message}`);
      }
    }

    this.config = {
      providers: [
        { name: "", base_url: "", api_key: "" },
        { name: "opencode", base_url: "https://opencode.ai/zen/go/v1", api_key: "" }
      ]
    };
    console.error(`[OpenCodex] Config file not found. Created default config.`);
    this.saveConfig();
  }

  private saveConfig() {
    const p = join(this.configDir, "providers.json");
    try {
      writeFileSync(p, JSON.stringify(this.config, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to save config: ${err.message}`);
    }
  }

  private getModelCatalog(): any {
    const p = join(this.configDir, "custom_model_catalog.json");
    if (existsSync(p)) {
      try {
        const catalog = JSON.parse(readFileSync(p, "utf-8"));
        // Older catalog entries (especially manually added DeepSeek entries)
        // often lack the capability flags that make Codex send MCP tools.
        // Normalize them at read time so the running proxy and Codex see the
        // same capabilities, even before the dashboard is opened.
        if (normalizeCustomModelCapabilities(catalog)) {
          try {
            writeFileSync(p, JSON.stringify(catalog, null, 2), "utf-8");
          } catch (writeErr: any) {
            console.warn(`[OpenCodex] Failed to persist model capabilities: ${writeErr.message}`);
          }
        }
        return catalog;
      } catch (err: any) {
        console.error(`[OpenCodex] Failed to read model catalog: ${err.message}`);
      }
    }
    return { models: [] };
  }

  private saveModelCatalog(catalog: any) {
    const p = join(this.configDir, "custom_model_catalog.json");
    try {
      normalizeCustomModelCapabilities(catalog);
      if (catalog && Array.isArray(catalog.models)) {
        for (const model of catalog.models) {
          const isCustomModel = model.provider === "opencodex" || !!model.backend_provider || model.slug.startsWith("mimo") || model.slug.includes("deepseek") || model.slug.includes("qwen");
          if (isCustomModel) {
            if (model.default_reasoning_level === undefined) model.default_reasoning_level = "medium";
            if (!model.supported_reasoning_levels || model.supported_reasoning_levels.length === 0) {
              model.supported_reasoning_levels = [
                { effort: "low", description: "Lighter reasoning" },
                { effort: "medium", description: "Balanced reasoning" },
                { effort: "high", description: "Greater reasoning depth" },
                { effort: "xhigh", description: "Extra high reasoning depth" }
              ];
            }
            if (model.default_reasoning_summary === undefined) model.default_reasoning_summary = "none";
            if (model.reasoning_summary_format === undefined) model.reasoning_summary_format = "none";
            if (model.supports_reasoning_summaries === undefined) model.supports_reasoning_summaries = false;
            if (model.default_verbosity === undefined) model.default_verbosity = "low";
            if (model.support_verbosity === undefined) model.support_verbosity = false;
            if (model.apply_patch_tool_type === undefined) model.apply_patch_tool_type = "freeform";
            if (model.web_search_tool_type === undefined) model.web_search_tool_type = "text_and_image";
            if (model.supports_search_tool === undefined) model.supports_search_tool = false;
            if (model.supports_parallel_tool_calls === undefined) model.supports_parallel_tool_calls = true;
            if (!model.experimental_supported_tools) model.experimental_supported_tools = ["computer_use", "mcp"];
            if (!model.input_modalities) model.input_modalities = ["text", "image"];
            if (model.supports_image_detail_original === undefined) model.supports_image_detail_original = true;
            if (model.shell_type === undefined) model.shell_type = "shell_command";
            if (model.visibility === undefined) model.visibility = "list";
            if (model.minimal_client_version === undefined) model.minimal_client_version = "0.0.1";
            if (model.supported_in_api === undefined) model.supported_in_api = true;
            if (model.availability_nux === undefined) model.availability_nux = null;
            if (model.upgrade === undefined) model.upgrade = null;
            if (model.priority === undefined) model.priority = 100;
            if (model.prefer_websockets === undefined) model.prefer_websockets = false;
            if (!model.available_in_plans) model.available_in_plans = ["free", "plus", "pro", "team", "business", "enterprise"];
            if (model.base_instructions === undefined) model.base_instructions = "You are a coding agent running in Codex through a local BYOK shim.";
            if (!model.additional_speed_tiers) model.additional_speed_tiers = ["fast"];
          }
        }
      }
      const jsonStr = JSON.stringify(catalog, null, 2);
      writeFileSync(p, jsonStr, "utf-8");
      console.error(`[OpenCodex] Saved custom model catalog to ${p}`);
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to save custom model catalog: ${err.message}`);
    }
  }

  private upgradeReasoningLevelsInCatalog() {
    const catalog = this.getModelCatalog();
    if (!catalog || !Array.isArray(catalog.models)) return;
    this.saveModelCatalog(catalog);
  }

  private mergeNativeModelsIntoCatalog() {
    const cachePath = join(homedir(), ".codex", "models_cache.json");
    if (!existsSync(cachePath)) {
      console.log(`[OpenCodex] Native models cache not found at ${cachePath}. Skipping merge.`);
      return;
    }

    try {
      const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
      const nativeModels = cacheData.models || [];
      if (!Array.isArray(nativeModels) || nativeModels.length === 0) {
        return;
      }

      const catalog = this.getModelCatalog();
      if (!catalog.models) {
        catalog.models = [];
      }

      let updated = false;

      for (const native of nativeModels) {
        if (!native.slug) continue;
        
        const isCustomSlug = native.slug.startsWith("grok-") || 
                             native.slug.startsWith("deepseek-") || 
                             native.slug.startsWith("gemini-") || 
                             native.slug.startsWith("claude-") ||
                             native.slug.startsWith("mimo-") ||
                             native.slug === "MiniMax-M3";
        if (isCustomSlug) continue;

        const idx = catalog.models.findIndex((m: any) => m.slug === native.slug);
        
        if (idx === -1) {
          catalog.models.push({
            ...native,
            provider: "openai",
            visibility: "list"
          });
          updated = true;
        } else {
          // If this is a custom model, keep its provider as opencodex
          const isCustomModel = !!catalog.models[idx].backend_provider || catalog.models[idx].slug.startsWith("mimo");
          const expectedProvider = isCustomModel ? "opencodex" : "openai";
          if (catalog.models[idx].provider !== expectedProvider) {
            catalog.models[idx].provider = expectedProvider;
            updated = true;
          }
        }
      }

      if (updated) {
        this.saveModelCatalog(catalog);
        console.log(`[OpenCodex] Successfully merged native OpenAI models into custom model catalog.`);
      }
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to merge native models: ${err.message}`);
    }
  }

  private buildCatalogFromModelNames(names: string[], existingModels: any[] = []): any {
    const providers = new Map<string, ProviderConfig>();
    for (const p of this.config.providers) providers.set(p.name, p);

    const models: any[] = [];
    for (const entry of names) {
      let provider = "";
      let modelName = entry;
      if (entry.includes(":")) {
        const parts = entry.split(":");
        provider = parts[0].trim();
        modelName = parts.slice(1).join(":").trim();
      }
      if (provider && !providers.has(provider)) {
        this.config.providers.push({ name: provider, base_url: "", api_key: "" });
        providers.set(provider, { name: provider, base_url: "", api_key: "" });
        this.saveConfig();
      }

      let backendModel = modelName;
      let slug = modelName;
      let separator = "";
      if (modelName.includes("->")) separator = "->";
      else if (modelName.includes("=")) separator = "=";

      if (separator) {
        const parts = modelName.split(separator);
        slug = parts[0].trim();
        backendModel = parts[1].trim();
      }

      // Prevent duplicate slugs in the newly built array
      const existingInNew = models.find((m: any) => m.slug === slug);
      if (existingInNew) {
        if (backendModel !== slug) {
          existingInNew.backend_model = backendModel;
        }
        continue;
      }

      const existing = existingModels.find((m: any) => m.slug === slug || m.model === slug);
      if (existing) {
        const isNative = existing.slug === "gpt-5.5" || existing.slug === "gpt-5.4-mini" || (existing.provider === "openai" && !existing.backend_provider);
        if (isNative) {
          models.push({
            ...existing,
            provider: "openai",
            backend_provider: undefined
          });
        } else {
          models.push({
            ...existing,
            slug: slug,
            model: slug,
            backend_model: backendModel,
            provider: "opencodex",
            backend_provider: provider || existing.backend_provider || existing.provider
          });
        }
      } else {
        const contextWindow = 200000;
        const maxContextWindow = 1000000;
        const autoCompact = 160000;
        const truncationLimit = 150000;

        models.push({
          slug: slug,
          model: slug,
          display_name: slug,
          backend_model: backendModel,
          provider: "opencodex",
          backend_provider: provider,
          description: `Custom model: ${slug}${provider ? ` (${provider})` : ""}`,
          context_window: contextWindow,
          max_context_window: maxContextWindow,
          auto_compact_token_limit: autoCompact,
          truncation_policy: { mode: "tokens", limit: truncationLimit },
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Lighter reasoning" },
            { effort: "medium", description: "Balanced reasoning" },
            { effort: "high", description: "Greater reasoning depth" },
            { effort: "xhigh", description: "Extra high reasoning depth" }
          ],
          default_reasoning_summary: "none",
          reasoning_summary_format: "none",
          supports_reasoning_summaries: false,
          default_verbosity: "low",
          support_verbosity: false,
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text_and_image",
          supports_search_tool: false,
          supports_parallel_tool_calls: true,
          experimental_supported_tools: ["computer_use", "mcp"],
          input_modalities: ["text", "image"],
          supports_image_detail_original: true,
          shell_type: "shell_command",
          visibility: "list",
          minimal_client_version: "0.0.1",
          supported_in_api: true,
          availability_nux: null,
          upgrade: null,
          priority: 100,
          prefer_websockets: false,
          available_in_plans: ["free", "plus", "pro", "team", "business", "enterprise"],
          base_instructions: "You are a coding agent running in Codex through a local BYOK shim.",
          model_messages: {
            instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
            instructions_variables: { model_name: modelName }
          },
          supports_computer_use: true,
          supports_mcp: true,
          vision_bridge_enabled: false
        });
      }
    }
    return { models };
  }

  private findProvider(model: string, catalogEntry?: any): ProviderConfig | null {
    const providerName = catalogEntry?.backend_provider || catalogEntry?.provider;
    if (providerName === "antigravity") {
      if (model.includes("claude")) {
        const found = this.config.providers.find(p => p.name === "claude");
        if (found) return found;
      }
      if (model.includes("gpt-oss")) {
        const found = this.config.providers.find(p => p.name === "opencode");
        if (found) return found;
      }
    }
    if (providerName && providerName !== "opencodex") {
      const found = this.config.providers.find(p => p.name === providerName);
      if (found) return found;
    }
    if (model.startsWith("mimo") || (catalogEntry && catalogEntry.backend_model && catalogEntry.backend_model.startsWith("mimo"))) {
      return this.config.providers.find(p => p.name === "opencode" || p.name === catalogEntry?.backend_provider) || this.config.providers.find(p => p.name === "opencode") || null;
    }
    return this.config.providers[0] || null;
  }

  private resolveKey(raw: string): string {
    if (raw === "grok-cli-auto") {
      try {
        const cachePath = join(this.configDir, "grok_auth_cache.json");
        let session: any = null;
        if (existsSync(cachePath)) {
          try {
            session = JSON.parse(readFileSync(cachePath, "utf-8"));
          } catch (e) {
            console.error("[OpenCodex] Failed to parse grok_auth_cache.json:", e);
          }
        }
        if (!session) {
          const authPath = join(homedir(), ".grok", "auth.json");
          if (existsSync(authPath)) {
            const authData = JSON.parse(readFileSync(authPath, "utf-8"));
            const sessionKey = Object.keys(authData).find(k => k.startsWith("https://auth.x.ai::"));
            if (sessionKey) {
              session = authData[sessionKey];
              console.log("[OpenCodex] Bootstrapped Grok CLI session into independent cache.");
            }
          }
        }
        if (session) {
          const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : 0;
          const now = Date.now();
          if (session.key && expiresAt && (expiresAt - now > 300000)) {
            return session.key;
          }
          console.log("[OpenCodex] Grok independent session is expired or expiring soon. Refreshing...");
          const issuer = session.oidc_issuer || "https://auth.x.ai";
          const clientId = session.oidc_client_id;
          const refreshToken = session.refresh_token;
          if (refreshToken && clientId) {
            try {
              const curlCmd = `curl -s -X POST ${issuer}/oauth2/token -d "grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${clientId}"`;
              const resStr = execSync(curlCmd, { encoding: "utf-8" });
              const tokenData = JSON.parse(resStr);
              if (tokenData && tokenData.access_token) {
                session.key = tokenData.access_token;
                if (tokenData.refresh_token) {
                  session.refresh_token = tokenData.refresh_token;
                }
                if (tokenData.expires_in) {
                  session.expires_at = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
                }
                writeFileSync(cachePath, JSON.stringify(session, null, 2), "utf-8");
                console.log("[OpenCodex] Grok independent session successfully refreshed and saved.");
                return tokenData.access_token;
              } else {
                console.error("[OpenCodex] Grok token refresh response invalid, clearing cache:", resStr);
                try { unlinkSync(cachePath); } catch {}
              }
            } catch (refreshErr: any) {
              console.error("[OpenCodex] Failed to refresh Grok token synchronously, clearing cache:", refreshErr.message);
              try { unlinkSync(cachePath); } catch {}
            }
          }
          if (session.key) return session.key;
        }
      } catch (e: any) {
        console.error("[OpenCodex] Failed to auto-resolve Grok CLI token:", e);
      }
    }
    if (raw === "claude-cli-auto") {
      try {
        const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
        if (existsSync(claudeSettingsPath)) {
          const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
          return settings?.env?.ANTHROPIC_API_KEY || "";
        }
      } catch (e: any) {
        console.error("[OpenCodex] Failed to auto-resolve Claude CLI token:", e);
      }
    }
    if (raw === "antigravity-cli-auto") {
      const now = Date.now();
      if (this.antigravityTokenCache && (now - this.antigravityTokenCacheTime) < 300000) {
        return this.antigravityTokenCache;
      }
      try {
        if (process.platform === "darwin") {
          const stdout = execSync('security find-generic-password -a "antigravity" -s "gemini" -w', { encoding: "utf-8" }).trim();
          if (stdout.startsWith("go-keyring-base64:")) {
            const base64Data = stdout.substring("go-keyring-base64:".length);
            const jsonStr = Buffer.from(base64Data, "base64").toString("utf-8");
            const data = JSON.parse(jsonStr);
            if (data?.token?.access_token) {
              this.antigravityTokenCache = data.token.access_token;
              this.antigravityTokenCacheTime = now;
              return data.token.access_token;
            }
          }
        }
      } catch (e: any) {
        console.error("[OpenCodex] Failed to auto-resolve Antigravity token:", e);
      }
      const op = this.config.providers.find((p: any) => p.name === "opencode");
      return op ? op.api_key : "dummy";
    }
    if (raw.startsWith("$")) {
      return process.env[raw.slice(1)] || "";
    }
    return raw;
  }

  private autoPatchCodexConfig() {
    if (isNativeModeEnabled()) return;
    if (!hasThirdPartyModels(this.getModelCatalog())) return;
    const tomlPath = join(homedir(), ".codex", "config.toml");

    const catalogPath = join(this.configDir, "custom_model_catalog.json");
    if (!existsSync(catalogPath)) {
      const emptyCatalog = { models: [] };
      writeFileSync(catalogPath, JSON.stringify(emptyCatalog, null, 2), "utf-8");
      console.log(`[OpenCodex] Created empty model catalog at ${catalogPath}`);
    }

    if (!existsSync(tomlPath)) {
      console.error(`[OpenCodex] Codex config.toml not found at ${tomlPath}. Skipped auto-patching.`);
      return;
    }

    try {
      const tomlContent = readFileSync(tomlPath, "utf-8");

      if (tomlContent.includes("# >>> opencodex managed >>>")) {
        return;
      }

      console.log(`[OpenCodex] Detecting unpatched config.toml. Performing surgical auto-patch...`);

      const tomlBackupPath = tomlPath + ".bak_" + Date.now();
      writeFileSync(tomlBackupPath, tomlContent, "utf-8");
      console.log(`[OpenCodex] Created backup of config.toml at ${tomlBackupPath}`);

      let patchedToml = stripManagedBlocks(tomlContent);

      const managedTop = `# >>> opencodex managed >>>
model_catalog_json = "${catalogPath.replace(/\\/g, '\\\\')}"
openai_base_url = "http://127.0.0.1:8765/v1"
# <<< opencodex managed <<<
`;

      const managedProvider = `# >>> opencodex managed >>>
[model_providers.opencodex]
name = "OpenCodex"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 600000
# <<< opencodex managed <<<
`;

      patchedToml = managedTop + "\n" + patchedToml + "\n\n" + managedProvider;
      writeFileSync(tomlPath, patchedToml, "utf-8");
      console.log(`[OpenCodex] Successfully patched config.toml to route via OpenCodex!`);

      this.restartCodexDesktop();
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to auto-patch config.toml: ${err.message}`);
    }
  }

  public patchCodexConfig() {
    if (isNativeModeEnabled() || !hasThirdPartyModels(this.getModelCatalog())) return;
    const tomlPath = join(homedir(), ".codex", "config.toml");
    const catalogPath = join(this.configDir, "custom_model_catalog.json");
    if (!existsSync(tomlPath)) return;
    try {
      const content = readFileSync(tomlPath, "utf-8");
      let patched = stripManagedBlocks(content);
      const managedTop = `# >>> opencodex managed >>>
model_catalog_json = "${catalogPath.replace(/\\/g, '\\\\')}"
openai_base_url = "http://127.0.0.1:8765/v1"
# <<< opencodex managed <<<
`;
      const managedProvider = `# >>> opencodex managed >>>
[model_providers.opencodex]
name = "OpenCodex"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 3
stream_max_retries = 3
stream_idle_timeout_ms = 600000
# <<< opencodex managed <<<
`;
      patched = managedTop + "\n" + patched + "\n\n" + managedProvider;
      writeFileSync(tomlPath, patched, "utf-8");
      console.log(`[OpenCodex] Patched config.toml with opencodex provider.`);
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to patch config.toml: ${err.message}`);
    }
  }

  private autoPatchPlugins() {
    if (isNativeModeEnabled() || !hasThirdPartyModels(this.getModelCatalog())) return;
    const tomlPath = join(homedir(), ".codex", "config.toml");
    if (!existsSync(tomlPath)) return;
    try {
      let content = readFileSync(tomlPath, "utf-8");
      let changed = false;
      if (!content.includes('computer-use@openai-bundled')) {
        console.log("[OpenCodex] Enabling computer-use@openai-bundled plugin...");
        let lines = content.split(/\r?\n/);
        let idx = lines.findIndex(l => l.includes("[plugins.") || l.includes("[features]"));
        if (idx !== -1) {
          lines.splice(idx, 0, '[plugins."computer-use@openai-bundled"]', "enabled = true", "");
          content = lines.join("\n");
          changed = true;
        } else {
          content += '\n\n[plugins."computer-use@openai-bundled"]\nenabled = true\n';
          changed = true;
        }
      }

      const pluginHeader = '[plugins."computer-use@openai-bundled"]';
      const pluginStart = content.indexOf(pluginHeader);
      if (pluginStart >= 0) {
        const nextSection = content.indexOf("\n[", pluginStart + pluginHeader.length);
        const sectionEnd = nextSection >= 0 ? nextSection : content.length;
        const section = content.slice(pluginStart, sectionEnd);
        if (/^\s*enabled\s*=\s*false\s*$/m.test(section)) {
          const enabledSection = section.replace(/(^\s*enabled\s*=\s*)false(\s*$)/m, "$1true$2");
          content = content.slice(0, pluginStart) + enabledSection + content.slice(sectionEnd);
          changed = true;
        } else if (!/^\s*enabled\s*=/m.test(section)) {
          content = content.slice(0, sectionEnd) + "\nenabled = true\n" + content.slice(sectionEnd);
          changed = true;
        }
      }

      // The plugin and its MCP server are separate switches. The native
      // config may keep the server disabled, so explicitly enable it only
      // after a third-party model activates gateway mode.
      const computerUseClientCandidates = [
        join(homedir(), ".codex", "computer-use", "Codex Computer Use.app", "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient")
      ];
      const pluginCacheRoot = join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "computer-use");
      if (existsSync(pluginCacheRoot)) {
        for (const version of readdirSync(pluginCacheRoot).sort().reverse()) {
          computerUseClientCandidates.push(join(pluginCacheRoot, version, "Codex Computer Use.app", "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"));
        }
      }
      const computerUseClient = computerUseClientCandidates.find(candidate => existsSync(candidate));
      const tomlCommand = computerUseClient
        ? computerUseClient.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        : "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
      const mcpHeader = "[mcp_servers.computer-use]";
      const mcpStart = content.indexOf(mcpHeader);
      if (mcpStart >= 0) {
        const nextSection = content.indexOf("\n[", mcpStart + mcpHeader.length);
        const sectionEnd = nextSection >= 0 ? nextSection : content.length;
        let section = content.slice(mcpStart, sectionEnd);
        if (/^\s*command\s*=/m.test(section)) {
          const normalizedSection = section.replace(/^\s*command\s*=.*$/m, `command = "${tomlCommand}"`);
          if (normalizedSection !== section) {
            section = normalizedSection;
            changed = true;
          }
        } else {
          section = `${section.trimEnd()}\ncommand = "${tomlCommand}"\n`;
          changed = true;
        }
        if (/^\s*enabled\s*=\s*false\s*$/m.test(section)) {
          const enabledSection = section.replace(/(^\s*enabled\s*=\s*)false(\s*$)/m, "$1true$2");
          section = enabledSection;
          changed = true;
        } else if (!/^\s*enabled\s*=/m.test(section)) {
          section = `${section.trimEnd()}\nenabled = true\n`;
          changed = true;
        }
        content = content.slice(0, mcpStart) + section + content.slice(sectionEnd);
      } else {
        content += `\n\n[mcp_servers.computer-use]\ncommand = "${tomlCommand}"\nargs = ["mcp"]\ncwd = "."\nenabled = true\n`;
        changed = true;
      }

      if (changed) {
        writeFileSync(tomlPath, content, "utf-8");
        console.log("[OpenCodex] Enabled computer-use plugin and MCP server in config.toml.");
      }

      const cacheDir = join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "computer-use");
      if (!existsSync(cacheDir)) {
        console.log("[OpenCodex] computer-use plugin assets not found. Installing via codex plugin add...");
        const codexPath = join(homedir(), ".local", "bin", "codex");
        const execPath = existsSync(codexPath) ? codexPath : "codex";

        exec(`"${execPath}" plugin add computer-use@openai-bundled`, {
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/Library/Python/3.9/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`
          }
        }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[OpenCodex] Failed to install computer-use plugin: ${err.message}`);
          } else {
            console.log(`[OpenCodex] Successfully installed computer-use plugin: ${stdout.trim()}`);
          }
        });
      }
    } catch (err: any) {
      console.error(`[OpenCodex] Failed to patch plugins: ${err.message}`);
    }
  }

  private restoreNativeConfigFiles(): void {
    const tomlPath = join(homedir(), ".codex", "config.toml");
    const codexConfigDir = join(homedir(), ".codex");
    let restoredFromBackup = false;
    const currentToml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf-8") : "";
    const hasGatewayConfig = /opencodex managed|model_catalog_json\s*=|openai_base_url\s*=\s*["']http:\/\/127\.0\.0\.1:8765\/v1/i.test(currentToml);

    if (hasGatewayConfig && existsSync(codexConfigDir)) {
      const backups = readdirSync(codexConfigDir)
        .filter(f => f.startsWith("config.toml.bak_"))
        .map(f => ({ name: f, time: parseInt(f.split("_")[1]) || 0 }))
        .sort((a, b) => a.time - b.time);

      if (backups.length > 0) {
        const originalBackup = join(codexConfigDir, backups[0].name);
        writeFileSync(tomlPath, readFileSync(originalBackup));
        restoredFromBackup = true;
        console.log(`[OpenCodex] Restored native config from ${originalBackup}`);
      }
    }

    if (!restoredFromBackup && hasGatewayConfig && existsSync(tomlPath)) {
      let content = currentToml;
      content = content
        .replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "")
        .replace(/^\s*model_catalog_json\s*=.*\r?\n?/gim, "")
        .replace(/^\s*openai_base_url\s*=\s*["']http:\/\/127\.0\.0\.1:8765\/v1["']\s*\r?\n?/gim, "")
        .trim();
      writeFileSync(tomlPath, content + "\n", "utf-8");
    }

    const catalogPath = join(this.configDir, "custom_model_catalog.json");
    if (existsSync(catalogPath)) {
      writeFileSync(catalogPath, JSON.stringify({ models: [] }, null, 2), "utf-8");
    }

    const cachePath = join(homedir(), ".codex", "models_cache.json");
    if (existsSync(cachePath)) {
      try { unlinkSync(cachePath); } catch {}
    }
  }

  private gatewayIsActive(catalog = this.getModelCatalog()): boolean {
    return !isNativeModeEnabled() && hasThirdPartyModels(catalog);
  }

  private activateGatewayMode(): void {
    if (existsSync(NATIVE_MODE_PATH)) {
      unlinkSync(NATIVE_MODE_PATH);
    }
  }

  private deactivateGatewayMode(): void {
    writeFileSync(NATIVE_MODE_PATH, "native\n", { encoding: "utf-8", mode: 0o600 });
    this.restoreNativeConfigFiles();
  }

  public getGatewayStatus(): { native_mode: boolean; third_party_models: boolean; gateway_active: boolean } {
    const catalog = this.getModelCatalog();
    return {
      native_mode: isNativeModeEnabled(),
      third_party_models: hasThirdPartyModels(catalog),
      gateway_active: this.gatewayIsActive(catalog)
    };
  }

  public restoreOriginalConfig(): void {
    this.deactivateGatewayMode();
    console.log("[OpenCodex] Native mode enabled. Gateway ownership released.");
    this.restartCodexDesktop(true);
  }

  public restartCodexDesktop(allowNative = false) {
    if (!allowNative && !this.gatewayIsActive()) {
      console.warn("[OpenCodex] Ignoring Codex restart while no third-party gateway model is active.");
      return;
    }
    this.restartCodexForCdp();
  }

  /**
   * Restart Codex with its local CDP endpoint. This is a voice-control
   * operation and does not modify routing or enable the third-party gateway.
   */
  public restartCodexForCdp() {
    console.log("[OpenCodex] Executing background cold-restart of Codex Desktop...");
    const killCmd = 'killall ChatGPT Codex "Codex Helper" "Codex Helper (Renderer)" "Codex Helper (GPU)" SkyComputerUseClient SkyComputerUseService bare-modifier-monitor 2>/dev/null; kill -9 $(ps aux | grep -i "codex app-server" | grep -v "grep" | awk \'{print $2}\') 2>/dev/null';
    exec(killCmd, () => {
      setTimeout(() => {
        const candidates = process.platform === "darwin"
          ? ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", "/Applications/Codex.app/Contents/MacOS/Codex"]
          : ["codex"];
        const executable = candidates.find(candidate => candidate === "codex" || existsSync(candidate));
        if (!executable) {
          console.error("[OpenCodex] Cannot find a Codex desktop executable for CDP launch.");
          return;
        }
        try {
          const child = spawn(executable, ["--remote-debugging-port=8315"], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
          console.log(`[OpenCodex] Codex Desktop launched with CDP on 8315: ${executable}`);
        } catch (err: any) {
          console.error(`[OpenCodex] Failed to launch Codex with CDP: ${err.message}`);
        }
      }, 1500);
    });
  }

  public restartVoiceBar(method: "swift-run" | "app" = "swift-run") {
    if (process.platform !== "darwin") {
      console.error("[OpenCodex] OpenCodexBar is currently available on macOS only.");
      return;
    }
    console.log(`[OpenCodex] Restarting Voice Bar using method: ${method}`);
    
    // Resolve opencodex-bar directory path dynamically and portably
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(moduleDir, "..", "..", "..", "opencodex-bar"), // relative to compiled dist/proxy/index.js
      join(moduleDir, "..", "..", "opencodex-bar"),      // relative to src/proxy/index.ts
      join(process.cwd(), "..", "opencodex-bar"),
      join(process.cwd(), "opencodex-bar"),
      join(homedir(), "projects", "opencodex-bar"),
      join(homedir(), "opencodex-bar")
    ];

    let barDir = "";
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        barDir = candidate;
        break;
      }
    }
    if (!barDir) {
      barDir = join(process.cwd(), "..", "opencodex-bar"); // default fallback
    }
    console.log(`[OpenCodex] Resolved Voice Bar directory: ${barDir}`);

    // Thaw native apps in case OpenCodexBar was killed/resigned in a frozen state
    const nativeApps = [
      "抖音.app", "TikTok.app", 
      "NeteaseMusic.app", "QQMusic.app", 
      "TencentVideo.app", "腾讯视频.app", 
      "Youku.app", "优酷.app", 
      "iQIYI.app", "爱奇艺.app"
    ];
    const thawCmd = nativeApps.map(app => `pkill -CONT -f "${app}"`).join(" ; ");
    const killCmd = `${thawCmd} ; killall OpenCodexBar 2>/dev/null || true`;
    exec(killCmd, (err) => {
      setTimeout(() => {
        let startCmd = `open ${join(barDir, "OpenCodexBar.app")}`;
        if (method === "swift-run") {
          let binPath = join(barDir, ".build/arm64-apple-macosx/release/OpenCodexBar");
          if (!existsSync(binPath)) {
            const debugPath = join(barDir, ".build/arm64-apple-macosx/debug/OpenCodexBar");
            if (existsSync(debugPath)) {
              binPath = debugPath;
            } else {
              binPath = "swift run";
            }
          }
          // Create a temporary launcher script that runs the binary and exits to close the Terminal window natively.
          // set -m enables job control in non-interactive scripts so & disown works correctly without killing the child process.
          const scriptPath = join(barDir, "launch_opencodex_bar.sh");
          const scriptContent = `#!/bin/bash\nset -m\ncd "${barDir}"\n"${binPath}" &\ndisown\nexit\n`;
          writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
          startCmd = `open -a Terminal "${scriptPath}"`;
        }
        exec(startCmd, (startErr) => {
          if (startErr) {
            console.error(`[OpenCodex] Failed to start Voice Bar via ${method}: ${startErr.message}`);
          } else {
            console.log(`[OpenCodex] Voice Bar start command initiated successfully via ${method}.`);
          }
        });
      }, 500);
    });
  }

  private async fetchActualTokensFromCodex(): Promise<Map<string, { tokens: number, context_window: number }>> {
    return new Promise((resolve) => {
      const tokenMap = new Map<string, { tokens: number, context_window: number }>();
      let settled = false;
      let tempWs: WebSocket | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { tempWs?.close(); } catch {}
        resolve(tokenMap);
      };
      const timeout = setTimeout(finish, 2000);
      fetch("http://127.0.0.1:8315/json")
        .then(res => res.json())
        .then((targets: any) => {
          const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
          if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
            finish();
            return;
          }
          const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
          tempWs = ws;
          ws.on("open", () => {
            const evalScript = `
              (() => {
                const root = window.__codexRoot;
                if (!root || !root._internalRoot) return [];
                const startNode = root._internalRoot.current;
                let foundConvs = null;
                
                function traverse(node) {
                  if (foundConvs) return;
                  let s = node.memoizedState;
                  while (s) {
                    const val = s.memoizedState;
                    if (val && typeof val === 'object' && val.conversations instanceof Map) {
                      foundConvs = val.conversations;
                      return;
                    }
                    s = s.next;
                  }
                  if (node.child) traverse(node.child);
                  if (node.sibling) traverse(node.sibling);
                }
                traverse(startNode);
                if (!foundConvs) return [];
                
                const list = [];
                for (const [id, conv] of foundConvs.entries()) {
                  if (conv.latestTokenUsageInfo) {
                    list.push({
                      id,
                      total: conv.latestTokenUsageInfo.total?.totalTokens || 0,
                      last: conv.latestTokenUsageInfo.last?.totalTokens || 0,
                      limit: conv.latestTokenUsageInfo.modelContextWindow || 200000
                    });
                  }
                }
                return list;
              })()
            `;
            ws.send(JSON.stringify({
              id: 400,
              method: "Runtime.evaluate",
              params: {
                expression: evalScript,
                returnByValue: true
              }
            }));
          });
          ws.on("message", (msgData) => {
            try {
              const resObj = JSON.parse(msgData.toString());
              if (resObj.id === 400 && resObj.result?.result?.value) {
                const list = resObj.result.result.value;
                for (const item of list) {
                  tokenMap.set(item.id, {
                    tokens: item.last || item.total,
                    context_window: item.limit
                  });
                }
              }
            } catch {}
            finish();
          });
          ws.on("error", finish);
          ws.on("close", finish);
        })
        .catch(finish);
    });
  }

  start(port: number) {
    if (!isNativeModeEnabled()) {
      this.initCodexMcp();
    }
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let rejected = false;
      req.on("data", (chunk: Buffer) => {
        if (rejected) return;
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
          rejected = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (rejected) return;
        const buffer = Buffer.concat(chunks);
        this.handle(req, res, buffer);
      });
    });

    const wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      if (!isTrustedBrowserOrigin(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const isResponsesWs = url.pathname.startsWith("/v1/responses") || url.pathname.includes("responses");

      if (isResponsesWs) {
        console.log(`[OpenCodex WS Proxy] Intercepting responses WebSocket upgrade: ${url.pathname}${url.search}`);
        wss.handleUpgrade(request, socket, head, (clientWs) => {
          this.desktopWsClients.add(clientWs);
          (clientWs as any).sequenceNumber = 1;
          const sidHeader = request.headers["x-session-id"] || request.headers["session-id"] || "";
          const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : (sidHeader || "default");
          const sessionIdStr = sessionId ? String(sessionId) : "default";
          (clientWs as any).sessionId = sessionIdStr;

          const threadIdHeader = request.headers["x-thread-id"] || request.headers["thread-id"] || "";
          const threadIdStr = Array.isArray(threadIdHeader) ? threadIdHeader[0] : (threadIdHeader || "");
          (clientWs as any).threadId = threadIdStr;

          const subagentHeader = request.headers["x-openai-subagent"] || "";
          const subagentStr = Array.isArray(subagentHeader) ? subagentHeader[0] : (subagentHeader || "");
          (clientWs as any).subagent = subagentStr;

          this.sessionActiveWs.set(sessionIdStr, clientWs);
          const connInfo = { 
            clientWs, 
            targetWs: null as WebSocket | null, 
            headers: request.headers, 
            lastMsg: null as any,
            isCustomMode: false,
            activeSessionId: sessionIdStr,
            isGeneratingTitle: false,
            sequenceNumber: 1
          };
          if (sessionId && sessionId !== "default") {
            this.activeConnectionsBySession.set(sessionId, connInfo);
            this.currentActiveSessionId = sessionIdStr;
          }
          this.lastActiveConnection = connInfo;

          let clientClosed = false;
          let targetClosed = false;
          let isLocal = false;
          let routedToOfficial = false;
          const pendingBuffer: { data: any; isBinary: boolean }[] = [];

          // Establish connection to official server immediately on upgrade to ensure fresh handshake headers
          const isChatGptAccount = Object.keys(request.headers).some(k => k.toLowerCase() === "chatgpt-account-id");
          let targetUrl = "";
          if (isChatGptAccount) {
            let subPath = url.pathname;
            if (url.pathname.startsWith("/v1/")) {
              subPath = url.pathname.substring(4);
            }
            if (!subPath.startsWith("codex/")) {
              subPath = "codex/" + subPath;
            }
            targetUrl = `wss://chatgpt.com/backend-api/${subPath}${url.search}`;
          } else {
            targetUrl = url.pathname.startsWith("/v1/") 
              ? `wss://api.openai.com${url.pathname}${url.search}` 
              : `wss://chatgpt.com${url.pathname}${url.search}`;
          }

          let realToken = "";
          const authPath = join(homedir(), ".codex", "auth.json");
          if (existsSync(authPath)) {
            try {
              const authData = JSON.parse(readFileSync(authPath, "utf-8"));
              if (authData.tokens && authData.tokens.access_token) {
                realToken = authData.tokens.access_token;
              }
            } catch (e: any) {
              console.error(`[OpenCodex WS Proxy] Failed to read auth.json for WS auth: ${e.message}`);
            }
          }

          const headers: Record<string, string> = {};
          let hasIncomingAuth = false;
          for (const [key, val] of Object.entries(request.headers)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "upgrade" || lowerKey.startsWith("sec-websocket-")) {
              continue;
            }
            if (lowerKey === "authorization") {
              const valStr = Array.isArray(val) ? val[0] : (val || "");
              if (valStr && !valStr.includes("dummy") && !valStr.includes("opencodex")) {
                hasIncomingAuth = true;
              }
            }
            headers[key] = Array.isArray(val) ? val[0] : (val || "");
          }

          if (!hasIncomingAuth && realToken) {
            headers["authorization"] = `Bearer ${realToken}`;
          }

          const loggedHeaders: any = {};
          for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === "authorization") {
              loggedHeaders[k] = `${v.slice(0, 15)}... (len: ${v.length})`;
            } else if (k.toLowerCase() === "cookie") {
              loggedHeaders[k] = `${v.slice(0, 30)}... (len: ${v.length})`;
            } else {
              loggedHeaders[k] = v;
            }
          }
          const protocols = request.headers["sec-websocket-protocol"];
          console.log(`[OpenCodex WS Proxy] Protocols:`, protocols);
          console.log(`[OpenCodex WS Proxy] Connecting to official server immediately: ${targetUrl}`);
          console.log(`[OpenCodex WS Proxy Upgrade Headers]:`, JSON.stringify(loggedHeaders, null, 2));
          const targetWs = new WebSocket(targetUrl, { 
            headers,
            agent: wsAgent
          });
          connInfo.targetWs = targetWs;

          targetWs.on("open", () => {
            console.log(`[OpenCodex WS Proxy] Official target connection opened for ${url.pathname}`);
            const activeSid = connInfo.activeSessionId || sessionIdStr;
            if (isLocal || connInfo.isCustomMode || this.customModelSessions.has(activeSid)) {
              console.log(`[OpenCodex WS Proxy] Custom model session detected on connection open. Sending instant connection handshake.`);
              clientWs.send(JSON.stringify({
                type: "codex.rate_limits",
                plan_type: "plus",
                rate_limits: {
                  allowed: true,
                  limit_reached: false,
                  primary: {
                    used_percent: 0,
                    window_minutes: 300,
                    reset_after_seconds: 3600,
                    reset_at: Math.floor(Date.now() / 1000) + 3600,
                    limit_reached: false
                  }
                }
              }));
              clientWs.send(JSON.stringify({
                type: "codex.response.metadata",
                headers: {
                  "x-codex-safety-buffering-enabled": "true",
                  "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"
                }
              }));
              return;
            }
            if (targetWs.readyState === WebSocket.OPEN) {
              for (const p of pendingBuffer) {
                targetWs.send(p.data, { binary: p.isBinary });
              }
              pendingBuffer.length = 0;
            }
          });

          let inJsonStream = false;

          targetWs.on("message", (tData, tIsBinary) => {
            const activeSid = connInfo.activeSessionId || sessionIdStr;
            if (isLocal || connInfo.isCustomMode || this.customModelSessions.has(activeSid)) {
              return;
            }
            this.sessionLastModelWasOfficial.set(activeSid, true);

            let processedTData = tData;
            if (!tIsBinary) {
              try {
                const payload = JSON.parse(tData.toString());
                if (payload.type === "codex.rate_limits") {
                  if (payload.rate_limits) {
                    payload.rate_limits.allowed = true;
                    payload.rate_limits.limit_reached = false;
                    if (payload.rate_limits.primary) {
                      payload.rate_limits.primary.used_percent = 0;
                      payload.rate_limits.primary.limit_reached = false;
                    }
                  }
                  processedTData = Buffer.from(JSON.stringify(payload), "utf-8");
                }
                if (payload.type === "error" && payload.error?.type === "usage_limit_reached") {
                  return; // Ignore official rate limit block
                }
                if (payload.type === "error" && payload.error?.message?.includes("Responses-Lite")) {
                  console.log(`[OpenCodex WS Proxy] Intercepted Responses-Lite error. Translating to invalid_token to trigger client-side token refresh.`);
                  payload.error.code = "invalid_token";
                  payload.error.type = "invalid_request_error";
                  payload.error.message = "The client token is expired or invalid.";
                  processedTData = Buffer.from(JSON.stringify(payload), "utf-8");
                }
                if (payload.type === "error" && payload.error?.message?.includes("Previous response with id") && payload.error?.message?.includes("not found")) {
                  const activeSid = connInfo.activeSessionId || sessionIdStr;
                  this.sessionPrevResponseIdFailed.set(activeSid, true);
                  console.log(`[OpenCodex WS Proxy] Intercepted Previous response not found error. Flagged session ${activeSid} for ID stripping on retry.`);
                }
                if (payload.type === "event_msg" && payload.payload?.type === "token_count") {
                  const activeSid = connInfo.activeSessionId || sessionIdStr;
                  let existing = this.sessionContextMap.get(activeSid);
                  if (!existing || existing.tokens <= 0) {
                    try {
                      const history = loadHistoryFromRollout(activeSid);
                      const detectedModel = (history as any).model || "";
                      const estimated = estimateTokensForRequest({ messages: history }, detectedModel).tokens;
                      existing = {
                        tokens: estimated,
                        is_estimated: true,
                        model: payload.payload.info.model || detectedModel || "official",
                        context_window: payload.payload.info.model_context_window || 1000000
                      };
                      this.sessionContextMap.set(activeSid, existing);
                      console.log(`[OpenCodex WS Proxy] Restored session token baseline from rollout: ${estimated} tokens`);
                    } catch (err: any) {
                      console.error(`[OpenCodex WS Proxy] Failed to restore token baseline: ${err.message}`);
                    }
                  }
                  if (existing && existing.tokens > 0) {
                    console.log(`[OpenCodex WS Proxy] Sanitizing official token_count frame. Replacing ${payload.payload.info.total_token_usage.total_tokens} with unified session tokens: ${existing.tokens}`);
                    payload.payload.info.total_token_usage.total_tokens = existing.tokens;
                    payload.payload.info.total_token_usage.input_tokens = Math.max(0, existing.tokens - (payload.payload.info.total_token_usage.output_tokens || 0));
                    if (payload.payload.info.last_token_usage) {
                      payload.payload.info.last_token_usage.total_tokens = existing.tokens;
                      payload.payload.info.last_token_usage.input_tokens = Math.max(0, existing.tokens - (payload.payload.info.last_token_usage.output_tokens || 0));
                    }
                    processedTData = Buffer.from(JSON.stringify(payload), "utf-8");

                    const totalTokens = existing.tokens;
                    const contextLimit = payload.payload.info.model_context_window || existing.context_window || 200000;
                    if (totalTokens > contextLimit * 0.85) {
                      console.log(`[AutoCompact] Official session ${activeSid} token count ${totalTokens} exceeds 85% of limit ${contextLimit}. Triggering /compact.`);
                      setTimeout(() => {
                        this.triggerAutoCompact(activeSid);
                      }, 2000);
                    }
                  }
                }
              } catch {}
            }

            const msgStr = processedTData.toString();
            if (!tIsBinary && (msgStr.includes("response.created") || msgStr.includes("response.completed"))) {
              console.log(`[OpenCodex WS Proxy] Message from official server (FULL): ${msgStr}`);
            } else {
              console.log(`[OpenCodex WS Proxy] Message from official server: ${tIsBinary ? "Binary" : msgStr.slice(0, 300)}`);
            }
            
            let isTitleOrBackground = connInfo.isGeneratingTitle || inJsonStream || (msgStr.includes("gpt-5.4-mini") || msgStr.includes("{\"title\"") || msgStr.includes("\"title\""));

            if (!tIsBinary) {
              try {
                const payload = JSON.parse(msgStr);
                if (payload) {
                  if (payload.type === "response.output_item.added" && payload.item && payload.item.type === "function_call") {
                    const itemId = payload.item.id;
                    const callId = payload.item.call_id;
                    const name = payload.item.name || "";
                    if (callId) {
                      itemIdToCallIdMap.set(itemId, callId);
                      pendingToolCallsMap.set(callId, { name, arguments: payload.item.arguments || "" });
                    }
                    if (itemId) {
                      pendingToolArgumentsAccumulator.set(itemId, payload.item.arguments || "");
                    }
                    console.log(`[OpenCodex WS Proxy] Recorded official model tool call: ${name} (item_id: ${itemId}, call_id: ${callId})`);
                  }
                  if (payload.type === "response.function_call_arguments.delta") {
                    const itemId = payload.item_id;
                    const delta = payload.delta || "";
                    if (itemId) {
                      const current = pendingToolArgumentsAccumulator.get(itemId) || "";
                      const updated = current + delta;
                      pendingToolArgumentsAccumulator.set(itemId, updated);
                      const callId = itemIdToCallIdMap.get(itemId);
                      if (callId) {
                        const existing = pendingToolCallsMap.get(callId);
                        if (existing) {
                          existing.arguments = updated;
                        }
                      }
                    }
                  }
                  if (payload.type === "response.output_item.done" && payload.item && payload.item.type === "function_call") {
                    const itemId = payload.item.id;
                    const callId = payload.item.call_id;
                    const name = payload.item.name || "";
                    const finalArgs = pendingToolArgumentsAccumulator.get(itemId) || payload.item.arguments || "";
                    if (callId) {
                      pendingToolCallsMap.set(callId, { name, arguments: finalArgs });
                      console.log(`[OpenCodex WS Proxy] Finalized official model tool call: ${name} (call_id: ${callId}) with arguments: ${finalArgs}`);
                    }
                  }
                }
                if (payload && payload.sequence_number !== undefined) {
                  const currentSeq = this.sessionSequenceNumberMap.get(sessionIdStr) || 1;
                  const newSeq = Math.max(currentSeq, Number(payload.sequence_number) + 1);
                  this.sessionSequenceNumberMap.set(sessionIdStr, newSeq);
                  if (payload.type === "response.done" || payload.type === "response.completed" || payload.type === "response.output_text.done") {
                    this.lastCompletedSequenceNumberMap.set(sessionIdStr, Number(payload.sequence_number));
                  }
                }
                
                const getSessionHash = (id: string): string | null => {
                  if (!id) return null;
                  const match = id.match(/^(resp|rs|msg|ctc)_([a-f0-9]{24})/);
                  return match ? match[2] : null;
                };

                // Detect title responses and register their session hashes
                if (payload.type === "response.created" && payload.response) {
                  const model = payload.response.model || "";
                  if (model.includes("mini") || model.includes("title")) {
                    const hash = getSessionHash(payload.response.id);
                    if (hash) {
                      this.titleSessionHashes.add(hash);
                    }
                  }
                }
                
                // Precise check if this payload belongs to a title session hash
                const checkId = payload.item_id || payload.response_id || payload.response?.id || payload.item?.id;
                if (checkId) {
                  const hash = getSessionHash(checkId);
                  if (hash && this.titleSessionHashes.has(hash)) {
                    isTitleOrBackground = true;
                  }
                }
                
                // Broadcast streaming text delta to active voice clients
                if (payload.type === "response.output_text.delta" && payload.delta) {
                  const text = payload.delta;
                  if (text.trim().startsWith("{")) {
                    inJsonStream = true;
                  }
                  if (!inJsonStream && connInfo.lastMsg) {
                    const msg = JSON.stringify({ type: "model_chunk", text });
                    for (const voiceClient of this.activeWsClients) {
                      try { voiceClient.send(msg); } catch {}
                    }
                  }
                  if (inJsonStream && text.includes("}")) {
                    inJsonStream = false;
                  }
                } 
                
                // Broadcast completion
                else if (payload.type === "response.completed" || payload.type === "response.output_item.done") {
                  inJsonStream = false;
                  if (payload.type === "response.completed") {
                    connInfo.isGeneratingTitle = false;
                    const msg = JSON.stringify({ type: "model_done", text: "" });
                    for (const voiceClient of this.activeWsClients) {
                      try { voiceClient.send(msg); } catch {}
                    }
                    
                    const usage = payload.response?.usage;
                    if (usage && typeof usage.input_tokens === "number") {
                      const activeSid = connInfo.activeSessionId || sessionIdStr;
                      const totalTokens = usage.input_tokens + (usage.output_tokens || 0);
                      
                      const existing = this.sessionContextMap.get(activeSid);
                      const modelSlug = payload.response?.model || "gpt-5.5";
                      const catalog = this.getModelCatalog();
                      const catalogEntry = catalog.models?.find((m: any) => m.slug === modelSlug);
                      const contextWindow = catalogEntry?.context_window || 1000000;

                      if (!existing || totalTokens > existing.tokens || Math.abs(totalTokens - existing.tokens) < existing.tokens * 0.15 || totalTokens < 2000) {
                        this.sessionContextMap.set(activeSid, {
                          tokens: totalTokens,
                          is_estimated: false,
                          model: modelSlug,
                          context_window: contextWindow,
                          provider_prompt_tokens: usage.input_tokens,
                          provider_completion_tokens: usage.output_tokens || 0,
                          source: "provider"
                        });
                        console.log(`[OpenCodex WS Proxy] Official model usage intercepted for ${modelSlug}: input=${usage.input_tokens}, output=${usage.output_tokens || 0}, total=${totalTokens}, limit=${contextWindow}`);
                        broadcastSessionUpdate(activeSid, totalTokens, contextWindow, modelSlug, false);
                      }
                    }
                  }
                }
              } catch {}
            }

            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(processedTData, { binary: tIsBinary });
            }
            if (!isTitleOrBackground) {
              for (const otherWs of this.desktopWsClients) {
                if (
                  otherWs !== clientWs && 
                  (otherWs as any).sessionId === activeSid && 
                  (otherWs as any).threadId === (clientWs as any).threadId &&
                  (otherWs as any).subagent === (clientWs as any).subagent &&
                  otherWs.readyState === WebSocket.OPEN
                ) {
                  otherWs.send(processedTData, { binary: tIsBinary });
                }
              }
            }
          });

          // Heartbeat keepalive for the connection to the official server
          const heartbeatInterval = setInterval(() => {
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              try { targetWs.ping(); } catch {}
            }
          }, 15000); // 15 seconds

          targetWs.on("ping", () => {
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
              try { clientWs.ping(); } catch {}
            }
          });

          clientWs.on("ping", () => {
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              try { targetWs.ping(); } catch {}
            }
          });

          targetWs.on("close", (code, reason) => {
            console.log(`[OpenCodex WS Proxy] Official target connection closed: ${code} - ${reason.toString()}`);
            targetClosed = true;
            clearInterval(heartbeatInterval);
            if (!clientClosed && routedToOfficial && !isLocal && !connInfo.isCustomMode) {
              clientWs.close();
            }
          });

          targetWs.on("error", (err) => {
            console.error("[OpenCodex WS Proxy Target Error]", err);
            clearInterval(heartbeatInterval);
            if (!clientClosed && routedToOfficial && !isLocal && !connInfo.isCustomMode) {
              clientWs.close();
            }
          });

          clientWs.on("message", async (data, isBinary) => {
            let processedData = data;
            if (!isBinary) {
              try {
                const msg = JSON.parse(data.toString());
                if (msg && msg.client_metadata?.session_id) {
                  connInfo.activeSessionId = String(msg.client_metadata.session_id);
                }
                if (msg && msg.type === "response.create") {
                  console.log("[OpenCodex WS Proxy] Client response.create:", JSON.stringify(msg));
                  const activeSid = connInfo.activeSessionId || sessionIdStr;
                  const history = loadHistoryFromRollout(activeSid);
                  const requestCatalog = this.getModelCatalog();
                  const requestCatalogEntry = requestCatalog.models?.find((m: any) => m.slug === msg.model);
                  const isCustomRequest = !!requestCatalogEntry?.backend_provider;
                  const hasToolItems = Array.isArray(msg.input) && msg.input.some((item: any) => {
                    return item && ["function_call", "function_call_output", "reasoning"].includes(item.type);
                  });

                  // Never rewrite a custom-model request into plain message
                  // items. That conversion drops function_call/tool output
                  // records and makes DeepSeek repeat the same text forever.
                  // Official requests can still use the rollout-history
                  // reconstruction, but only when the turn has no tool items.
                  if (!isCustomRequest && !hasToolItems && history.length > 0 && msg.input && Array.isArray(msg.input)) {
                    const incomingSimple = msg.input.map((item: any) => {
                      let text = "";
                      if (typeof item.content === "string") {
                        text = item.content;
                      } else if (Array.isArray(item.content)) {
                        text = item.content.map((c: any) => c.text || c.content || "").join("");
                      }
                      return { role: item.role, content: text.trim() };
                    }).filter((m: any) => m.role === "user" || m.role === "assistant");

                    const merged = mergeHistory(history, incomingSimple);
                    msg.input = merged.map((m: any) => ({
                      type: "message",
                      role: m.role,
                      content: [{
                        type: m.role === "assistant" ? "output_text" : "input_text",
                        text: m.content
                      }]
                    }));
                    processedData = Buffer.from(JSON.stringify(msg), "utf-8");
                    console.log(`[OpenCodex WS Proxy] Reconstructed response.create input array with full merged history (${merged.length} messages) for session ${activeSid}`);
                  }
                }
                if (msg && msg.type === "response.cancel") {
                  const activeSid = connInfo.activeSessionId || sessionIdStr;
                  const controller = this.activeAbortControllers.get(activeSid);
                  if (controller) {
                    console.log(`[OpenCodex WS Proxy] Intercepted response.cancel for session ${activeSid}, aborting active request.`);
                    controller.abort();
                    this.activeAbortControllers.delete(activeSid);
                  }
                }
                if (msg && msg.type === "response.create") {
                  connInfo.lastMsg = msg;
                  const activeSid = connInfo.activeSessionId || sessionIdStr;
                  if (msg.response && msg.response.reasoning_effort === "xhigh") {
                    console.log(`[OpenCodex WS Proxy] Mapping official reasoning_effort 'xhigh' to 'high' for session ${activeSid}`);
                    msg.response.reasoning_effort = "high";
                    processedData = Buffer.from(JSON.stringify(msg), "utf-8");
                  }
                  const shouldStripPrevId = this.sessionPrevResponseIdFailed.get(activeSid);
                  const clientPrevId = msg.previous_response_id || (msg.response && msg.response.previous_response_id);
                  if (shouldStripPrevId && clientPrevId) {
                    console.log(`[OpenCodex WS Proxy] Stripping previous_response_id (${clientPrevId}) from retry request in session ${activeSid} to recover from desync.`);
                    delete msg.previous_response_id;
                    if (msg.response) {
                      delete msg.response.previous_response_id;
                    }
                    processedData = Buffer.from(JSON.stringify(msg), "utf-8");
                    this.sessionPrevResponseIdFailed.delete(activeSid);
                  }
                  const model = msg.model || "";
                  if (model) {
                    const catalog = this.getModelCatalog();
                    const catalogEntry = catalog.models?.find((m: any) => m.slug === model);
                    connInfo.isCustomMode = !!catalogEntry?.backend_provider;
                    connInfo.isGeneratingTitle = model.includes("mini") || model.includes("title");
                  }
                }
                const model = msg.model || "";
                if (msg.type === "response.create" && model) {
                  const catalog = this.getModelCatalog();
                  const catalogEntry = catalog.models?.find((m: any) => m.slug === model);
                  const isCustomModel = !!catalogEntry?.backend_provider;
                  const activeSid = connInfo.activeSessionId || sessionIdStr;

                  const lastModel = this.sessionModelMap.get(activeSid);
                  if (lastModel && lastModel !== model) {
                    console.log(`[OpenCodex WS Proxy] Model changed from ${lastModel} to ${model}. Clearing stale history for session ${activeSid} to ensure alignment.`);
                    this.customConversationHistory.delete(activeSid);
                  }
                  this.sessionModelMap.set(activeSid, model);

                  const threadId = msg.client_metadata?.thread_id || "";
                  const lastThreadId = this.sessionThreadMap.get(activeSid);
                  if (threadId && lastThreadId && lastThreadId !== threadId) {
                    console.log(`[OpenCodex WS Proxy] Thread changed from ${lastThreadId} to ${threadId}. Clearing stale history for session ${activeSid}.`);
                    this.customConversationHistory.delete(activeSid);
                  }
                  if (threadId) {
                    this.sessionThreadMap.set(activeSid, threadId);
                  }

                  if (isCustomModel) {
                    isLocal = true;
                    connInfo.isCustomMode = true;
                    this.customModelSessions.add(activeSid);
                    console.log(`[OpenCodex WS Proxy] Intercepted custom model ${model} over WebSocket, handling locally.`);
                    await this.handleLocalResponsesWebSocketInline(clientWs, msg, connInfo);
                    return;
                  } else {
                    isLocal = false;
                    routedToOfficial = true;
                    connInfo.isCustomMode = false;
                    this.customModelSessions.delete(activeSid);
                  }
                }

                // If forwarding to official server, strip any non-text components (images, files) from incoming client inputs to prevent OpenAI server payload crashes
                if (msg && msg.type === "conversation.item.create" && msg.item && Array.isArray(msg.item.content)) {
                  const originalLength = msg.item.content.length;
                  msg.item.content = msg.item.content.filter((part: any) => {
                    if (!part) return false;
                    const type = String(part.type || "").toLowerCase();
                    return type === "text" || type === "input_text" || type === "output_text" || type === "text_text" || type === "text_delta";
                  });
                  if (msg.item.content.length !== originalLength) {
                    console.log(`[OpenCodex WS Proxy] Intercepted conversation.item.create. Stripped non-text parts from client payload to prevent official server crash.`);
                    processedData = Buffer.from(JSON.stringify(msg), "utf-8");
                  }
                }



                // If forwarding to official server, sanitize encrypted_content from client inputs
                if (msg && Array.isArray(msg.input)) {
                  let mutated = false;
                  for (const item of msg.input) {
                    if (item && item.type === "message" && Array.isArray(item.content)) {
                      const originalLength = item.content.length;
                      item.content = item.content.filter((part: any) => {
                        if (!part) return false;
                        const type = String(part.type || "").toLowerCase();
                        return type === "text" || type === "input_text" || type === "output_text" || type === "text_text" || type === "text_delta";
                      });
                      if (item.content.length !== originalLength) {
                        mutated = true;
                        console.log(`[OpenCodex WS Proxy] Stripped non-text parts from message item in response.create input array.`);
                      }
                    }
                    if (item && item.type === "reasoning" && typeof item.encrypted_content === "string") {
                      if (item.encrypted_content.startsWith("anthropic-thinking-v1:")) {
                        const prefix = "anthropic-thinking-v1:";
                        try {
                          const blob = item.encrypted_content.slice(prefix.length);
                          const raw = Buffer.from(blob, "base64url").toString("utf-8");
                          const decoded = JSON.parse(raw);
                          if (decoded && decoded.thinking) {
                            item.summary = [{ type: "summary_text", text: decoded.thinking }];
                          }
                        } catch {}
                        delete item.encrypted_content;
                        mutated = true;
                      }
                    }
                  }
                  if (mutated) {
                    processedData = Buffer.from(JSON.stringify(msg), "utf-8");
                  }
                }
              } catch (err) {
                // Not JSON or parsing failed, fallback
              }
            }

            const activeSidForLocalCheck = connInfo.activeSessionId || sessionIdStr;
            const isSessionLocal = isLocal || this.customModelSessions.has(activeSidForLocalCheck) || connInfo.isCustomMode;
            if (isSessionLocal) {
              return;
            }

            if (targetWs) {
              console.log(`[OpenCodex WS Proxy] Forwarding message to official server: ${isBinary ? "Binary" : processedData.toString().slice(0, 300)}`);
              routedToOfficial = true;
              if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(processedData, { binary: isBinary });
              } else if (targetWs.readyState === WebSocket.CONNECTING) {
                pendingBuffer.push({ data: processedData, isBinary });
              } else {
                clientWs.close();
              }
            }
          });

          clientWs.on("close", () => {
            clientClosed = true;
            clearInterval(heartbeatInterval);
            this.desktopWsClients.delete(clientWs);
            if (sessionId && sessionId !== "default") {
              this.activeConnectionsBySession.delete(sessionId);
            }
            if (this.lastActiveConnection === connInfo) {
              this.lastActiveConnection = null;
            }
            if (targetWs && !targetClosed) {
              targetWs.close();
            }
          });

          clientWs.on("error", (err) => {
            console.error("[OpenCodex WS Proxy Client Error]", err);
            clearInterval(heartbeatInterval);
            this.desktopWsClients.delete(clientWs);
            if (sessionId && sessionId !== "default") {
              this.activeConnectionsBySession.delete(sessionId);
            }
            if (this.lastActiveConnection === connInfo) {
              this.lastActiveConnection = null;
            }
            if (targetWs) {
              targetWs.close();
            }
          });
        });
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws) => {
      this.handleWebSocketConnection(ws);
    });

    this.server.on("error", (err: any) => {
      console.error(`[OpenCodex] Proxy server port conflict: ${err.message}`);
    });

    this.server.listen(port, "127.0.0.1");
    console.error(`[OpenCodex] Unified HTTP server listening on port ${port}`);
    console.error(`[OpenCodex] Web Dashboard UI → http://localhost:${port}/dashboard`);
  }

  stop() {
    this.server?.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer) {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isTrustedBrowserOrigin(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Untrusted browser origin" }));
      return;
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, session_id");
    
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let decompressedBody = rawBody;
    const contentEncoding = req.headers["content-encoding"];

    const isDiagnostic = req.url && (
      req.url.startsWith("/api/logs") ||
      req.url.startsWith("/api/permissions") ||
      req.url.startsWith("/api/voice-bar") ||
      req.url.startsWith("/api/orb") ||
      (req.url.startsWith("/api/sessions") && !req.url.includes("import") && !req.url.includes("export"))
    );
    if (!isDiagnostic) {
      console.log("[OpenCodex] Request path:", req.url, "Content-Encoding:", contentEncoding, "rawBody signature:", rawBody.slice(0, 4));
    }
    if (contentEncoding === "gzip") {
      try {
        decompressedBody = zlib.gunzipSync(rawBody);
      } catch (err: any) {
        console.error("[OpenCodex] Failed to gunzip body:", err.message);
      }
    } else if (contentEncoding === "deflate") {
      try {
        decompressedBody = zlib.inflateSync(rawBody);
      } catch (err: any) {
        console.error("[OpenCodex] Failed to inflate body:", err.message);
      }
    } else if (contentEncoding === "br") {
      try {
        decompressedBody = zlib.brotliDecompressSync(rawBody);
      } catch (err: any) {
        console.error("[OpenCodex] Failed to brotli decompress body:", err.message);
      }
    } else if (contentEncoding === "zstd") {
      try {
        decompressedBody = Buffer.from(zstdDecompress(rawBody));
      } catch (err: any) {
        console.error("[OpenCodex] Failed to zstd decompress body using fzstd:", err.message);
      }
    }

    const body = decompressedBody.toString("utf-8");

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // ─── Web Dashboard Routes ───
    if (path === "/dashboard" || path === "/dashboard/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getDashboardHtml());
      return;
    }

    if (path === "/orb-view" || path === "/orb-view/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getOrbHtml());
      return;
    }

    if (path === "/visualizer" || path === "/visualizer/") {
      const parsedUrl = new URL(req.url || "", "http://localhost");
      const isHud = parsedUrl.searchParams.get("mode") === "hud";
      
      const p = join(this.configDir, "voice_settings.json");
      let hudTheme = "vortex";
      if (existsSync(p)) {
        try {
          const settings = JSON.parse(readFileSync(p, "utf-8"));
          hudTheme = settings.hud_theme || "vortex";
          if (hudTheme !== "vortex" && hudTheme !== "siri") {
            hudTheme = "vortex";
          }
        } catch {}
      }

      res.writeHead(200, { 
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });
      res.end(getVisualizerHtml(isHud, hudTheme));
      return;
    }

    if (path === "/api/logs/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.flushHeaders();
      
      // Send initial backlog
      for (const line of logBuffer) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }

      const sender = (payload: any) => {
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
      };

      activeSseClients.add(sender);

      const keepalive = setInterval(() => {
        try { res.write(`:keepalive\n\n`); } catch { clearInterval(keepalive); }
      }, 15000);

      req.on("close", () => {
        activeSseClients.delete(sender);
        clearInterval(keepalive);
      });
      return;
    }

    if (path === "/api/config" && req.method === "POST") {
      try {
        const data = JSON.parse(body);

        if (data.providers && Array.isArray(data.providers)) {
          const updatedProviders = data.providers.map((newP: any) => {
            if (newP.api_key && (newP.api_key.includes("...") || newP.api_key.endsWith("..."))) {
              const oldP = this.config.providers.find((p: any) => p.name === newP.name);
              if (oldP && oldP.api_key) {
                return { ...newP, api_key: oldP.api_key, api_keys: oldP.api_keys };
              }
            }
            return newP;
          });
          this.config.providers = updatedProviders;
        } else {
          this.config.providers = [
            { name: data.primary.name, base_url: data.primary.base_url, api_key: data.primary.api_key },
            { name: "opencode", base_url: data.opencode.base_url || "https://opencode.ai/zen/go/v1", api_key: data.opencode.api_key || "", vision_model: data.opencode.model || "mimo-v2.5" }
          ];
        }

        if (data.models && Array.isArray(data.models)) {
          const existing = this.getModelCatalog();
          const catalog = this.buildCatalogFromModelNames(data.models, existing.models || []);
          this.saveModelCatalog(catalog);
          this.mergeNativeModelsIntoCatalog();
          console.log(`[OpenCodex] Saved models from input: ${data.models.length} total.`);
        }

        // Clean up unused blank providers
        const catalog = this.getModelCatalog();
        const activeProviders = new Set<string>();
        activeProviders.add("opencode");
        if (catalog && Array.isArray(catalog.models)) {
          for (const m of catalog.models) {
            if (m.provider) {
              activeProviders.add(m.provider);
            }
          }
        }
        if (this.config.providers && Array.isArray(this.config.providers)) {
          this.config.providers = this.config.providers.filter((prov: any) => {
            if (prov.name === "opencode" || prov.name === "") return true;
            const hasCredentials = (prov.base_url && prov.base_url.trim() !== "") || (prov.api_key && prov.api_key.trim() !== "");
            return hasCredentials || activeProviders.has(prov.name);
          });
        }
        this.saveConfig();

        const hasThirdParty = hasThirdPartyModels(catalog);
        if (hasThirdParty) {
          this.activateGatewayMode();
          this.patchCodexConfig();
          this.autoPatchPlugins();
        } else if (!isNativeModeEnabled()) {
          this.deactivateGatewayMode();
        }
        const shouldRestart = data.restart === true && hasThirdParty;
        if (shouldRestart) {
          this.restartCodexDesktop();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "success",
          restarted: shouldRestart,
          gateway_active: this.gatewayIsActive(catalog)
        }));
      } catch (err: any) {
        const isInputError = String(err.message || "").includes("No supported conversation messages");
        res.writeHead(isInputError ? 400 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/cli-bridge/status" && req.method === "GET") {
      let grokDetected = false;
      let grokEmail = "";
      let grokExpiresAt = "";
      let grokActive = false;

      try {
        const grokAuthPath = join(homedir(), ".grok", "auth.json");
        if (existsSync(grokAuthPath)) {
          const authData = JSON.parse(readFileSync(grokAuthPath, "utf-8"));
          const sessionKey = Object.keys(authData).find(k => k.startsWith("https://auth.x.ai::"));
          if (sessionKey && authData[sessionKey]?.key) {
            grokDetected = true;
            grokEmail = authData[sessionKey].email || "";
            grokExpiresAt = authData[sessionKey].expires_at || "";
          }
        }
      } catch {}

      let claudeDetected = false;
      let claudeBaseUrl = "";
      let claudeActive = false;

      try {
        const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
        if (existsSync(claudeSettingsPath)) {
          const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
          if (settings?.env?.ANTHROPIC_API_KEY) {
            claudeDetected = true;
            claudeBaseUrl = settings?.env?.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
          }
        }
      } catch {}

      const catalog = this.getModelCatalog();
      const hasGrokModel = catalog?.models?.some((m: any) => m.backend_provider === "grok");
      const hasClaudeModel = catalog?.models?.some((m: any) => m.backend_provider === "claude");
      const hasAntigravityModel = catalog?.models?.some((m: any) => m.backend_provider === "antigravity");

      let antigravityActive = false;

      if (this.config && Array.isArray(this.config.providers)) {
        const gp = this.config.providers.find((p: any) => p.name === "grok");
        if (gp && gp.api_key === "grok-cli-auto" && hasGrokModel) {
          grokActive = true;
        }
        const cp = this.config.providers.find((p: any) => p.name === "claude");
        if (cp && cp.api_key === "claude-cli-auto" && hasClaudeModel) {
          claudeActive = true;
        }
        const ap = this.config.providers.find((p: any) => p.name === "antigravity");
        if (ap && ap.api_key === "antigravity-cli-auto" && hasAntigravityModel) {
          antigravityActive = true;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        grok: { detected: grokDetected, email: grokEmail, expiresAt: grokExpiresAt, active: grokActive },
        claude: { detected: claudeDetected, baseUrl: claudeBaseUrl, active: claudeActive },
        antigravity: { detected: true, active: antigravityActive }
      }));
      return;
    }

    if (path === "/api/cli-bridge/activate" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const cliName = data.cli;

        if (cliName === "grok") {
          let providers = this.config.providers || [];
          providers = providers.filter((p: any) => p.name !== "grok");
          providers.push({
            name: "grok",
            base_url: "https://api.x.ai/v1",
            api_key: "grok-cli-auto"
          });
          this.config.providers = providers;
          this.saveConfig();

          const catalog = this.getModelCatalog();
          const baseModel = catalog?.models?.find((m: any) => m.slug === "deepseek-v4-pro") || catalog?.models?.[0] || {};
          
          if (catalog && Array.isArray(catalog.models)) {
            catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "grok");
            
            const modelsToAdd = [
              { slug: "grok-4.5", model: "grok-4.5", display_name: "grok-4.5", backend_model: "grok-4.5", context_window: 500000, max_context_window: 500000 },
              { slug: "grok-4.3", model: "grok-4.3", display_name: "grok-4.3", backend_model: "grok-4.3", context_window: 1000000, max_context_window: 1000000 },
              { slug: "grok-4.20-reasoning", model: "grok-4.20-0309-reasoning", display_name: "grok-4.20-reasoning", backend_model: "grok-4.20-0309-reasoning", context_window: 1000000, max_context_window: 1000000 }
            ];

            for (const item of modelsToAdd) {
              catalog.models.push({
                ...baseModel,
                ...item,
                context_window: 200000,
                max_context_window: 200000,
                vision_bridge_enabled: false,
                provider: "opencodex",
                backend_provider: "grok",
                description: `Custom model: ${item.display_name} (grok)`,
                visibility: "list",
                model_messages: {
                  instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
                  instructions_variables: {
                    model_name: item.slug
                  }
                }
              });
            }
            this.saveModelCatalog(catalog);
          }
        } else if (cliName === "claude") {
          let providers = this.config.providers || [];
          providers = providers.filter((p: any) => p.name !== "claude");
          providers.push({
            name: "claude",
            base_url: "claude-cli-auto-url",
            api_key: "claude-cli-auto"
          });
          this.config.providers = providers;
          this.saveConfig();

          const catalog = this.getModelCatalog();
          const baseModel = catalog?.models?.find((m: any) => m.slug === "deepseek-v4-pro") || catalog?.models?.[0] || {};
          
          if (catalog && Array.isArray(catalog.models)) {
            catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "claude");
            
            const modelsToAdd = [
              { slug: "claude-3-5-sonnet", model: "claude-3-5-sonnet", display_name: "claude-3-5-sonnet", backend_model: "claude-3-5-sonnet-20241022", context_window: 200000, max_context_window: 200000 },
              { slug: "claude-3-5-haiku", model: "claude-3-5-haiku", display_name: "claude-3-5-haiku", backend_model: "claude-3-5-haiku-20241022", context_window: 200000, max_context_window: 200000 }
            ];

            for (const item of modelsToAdd) {
              catalog.models.push({
                ...baseModel,
                ...item,
                context_window: 200000,
                max_context_window: 200000,
                vision_bridge_enabled: false,
                provider: "opencodex",
                backend_provider: "claude",
                description: `Custom model: ${item.display_name} (claude)`,
                visibility: "list",
                model_messages: {
                  instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
                  instructions_variables: {
                    model_name: item.slug
                  }
                }
              });
            }
            this.saveModelCatalog(catalog);
          }
        } else if (cliName === "antigravity") {
          let providers = this.config.providers || [];
          providers = providers.filter((p: any) => p.name !== "antigravity");
          providers.push({
            name: "antigravity",
            base_url: "https://opencode.ai/zen/go/v1",
            api_key: "antigravity-cli-auto"
          });
          this.config.providers = providers;
          this.saveConfig();

          const catalog = this.getModelCatalog();
          const baseModel = catalog?.models?.find((m: any) => m.slug === "deepseek-v4-pro") || catalog?.models?.[0] || {};
          
          if (catalog && Array.isArray(catalog.models)) {
            catalog.models = catalog.models.filter((m: any) => m.backend_provider !== "antigravity");
            
            const modelsToAdd = [
              { slug: "gemini-3.5-flash-medium", model: "gemini-3.5-flash-medium", display_name: "Gemini 3.5 Flash (Medium)", backend_model: "gpt-5.4-mini" },
              { slug: "gemini-3.5-flash-high", model: "gemini-3.5-flash-high", display_name: "Gemini 3.5 Flash (High)", backend_model: "gpt-5.4-mini" },
              { slug: "gemini-3.5-flash-low", model: "gemini-3.5-flash-low", display_name: "Gemini 3.5 Flash (Low)", backend_model: "gpt-5.4-mini" },
              { slug: "gemini-3.1-pro-low", model: "gemini-3.1-pro-low", display_name: "Gemini 3.1 Pro (Low)", backend_model: "gpt-5.5" },
              { slug: "gemini-3.1-pro-high", model: "gemini-3.1-pro-high", display_name: "Gemini 3.1 Pro (High)", backend_model: "gpt-5.5" },
              { slug: "claude-sonnet-4.6-thinking", model: "claude-sonnet-4.6-thinking", display_name: "Claude Sonnet 4.6 (Thinking)", backend_model: "gpt-5.5" },
              { slug: "claude-opus-4.6-thinking", model: "claude-opus-4.6-thinking", display_name: "Claude Opus 4.6 (Thinking)", backend_model: "gpt-5.6-terra" },
              { slug: "gpt-oss-120b-medium", model: "gpt-oss-120b-medium", display_name: "GPT-OSS 120B (Medium)", backend_model: "deepseek-v4-pro" }
            ];

            for (const item of modelsToAdd) {
              catalog.models.push({
                ...baseModel,
                ...item,
                context_window: 200000,
                max_context_window: 200000,
                vision_bridge_enabled: false,
                provider: "opencodex",
                backend_provider: "antigravity",
                description: `Antigravity model: ${item.display_name}`,
                visibility: "list",
                model_messages: {
                  instructions_template: "You are Codex running on {model_name} through a local all-model shim. Be a helpful, direct coding collaborator.",
                  instructions_variables: {
                    model_name: item.slug
                  }
                }
              });
            }
            this.saveModelCatalog(catalog);
          }
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid CLI name" }));
          return;
        }

        this.loadConfig();
        this.patchCodexConfig();
        this.autoPatchPlugins();
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/cli-bridge/deactivate" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const cliName = data.cli;

        let providers = this.config.providers || [];
        providers = providers.filter((p: any) => p.name !== cliName);
        this.config.providers = providers;
        this.saveConfig();

        const catalog = this.getModelCatalog();
        if (catalog && Array.isArray(catalog.models)) {
          catalog.models = catalog.models.filter((m: any) => m.backend_provider !== cliName);
          this.saveModelCatalog(catalog);
        }

        this.loadConfig();
        this.patchCodexConfig();
        this.autoPatchPlugins();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/models" && req.method === "GET") {
      // Returns complete model catalog & enabled models
      this.mergeNativeModelsIntoCatalog();
      const catalog = this.getModelCatalog();
      // The dashboard is the custom-model manager. Native Codex models are
      // owned by Codex itself and must never appear in this dropdown.
      const customModels = (catalog.models || []).filter((m: any) => isCustomCatalogModel(m));
      const active = customModels.filter((m: any) => m.visibility === "list").map((m: any) => m.slug);
      
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(JSON.stringify({
        catalog: customModels.map((m: any) => ({
          id: m.slug,
          model: m.model,
          provider: m.provider || "",
          display_name: m.display_name,
          no_image_support: m.input_modalities ? !m.input_modalities.includes("image") : true,
          vision_bridge_enabled: !!m.vision_bridge_enabled,
          context_window: m.context_window
        })) || [],
        active,
        ...this.getGatewayStatus()
      }));
      return;
    }

    if (path === "/api/models" && req.method === "POST") {
      try {
        this.mergeNativeModelsIntoCatalog();
        const data = JSON.parse(body);
        console.log("[OpenCodex] Received POST /api/models data:", data);
        const activeIds = data.active || [];
        const visionBridgeIds = data.vision_bridge || [];
        const context1mIds = data.context_1m || [];
        const catalog = this.getModelCatalog();
        const wasGatewayActive = this.gatewayIsActive(catalog);
        
        if (catalog.models) {
          catalog.models.filter((m: any) => isCustomCatalogModel(m)).forEach((m: any) => {
            m.visibility = activeIds.includes(m.slug) ? "list" : "hide";
            m.vision_bridge_enabled = visionBridgeIds.includes(m.slug);
            
            const is1m = context1mIds.includes(m.slug);
            if (is1m) {
              m.context_window = 1000000;
              m.auto_compact_token_limit = 800000;
              m.truncation_policy = { mode: "tokens", limit: 750000 };
            } else {
              m.context_window = 200000;
              m.auto_compact_token_limit = 160000;
              m.truncation_policy = { mode: "tokens", limit: 150000 };
            }
          });
          this.saveModelCatalog(catalog);
        }
        
        const hasThirdParty = hasThirdPartyModels(catalog);
        if (hasThirdParty) {
          this.activateGatewayMode();
          this.patchCodexConfig();
          this.autoPatchPlugins();
        } else if (wasGatewayActive) {
          this.deactivateGatewayMode();
        }
        const shouldRestart = (data.restart === true && hasThirdParty) || (wasGatewayActive && !hasThirdParty);
        if (shouldRestart) {
          this.restartCodexDesktop(!hasThirdParty && wasGatewayActive);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", restarted: shouldRestart, gateway_active: hasThirdParty && !isNativeModeEnabled() }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/models/delete" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const slug = data.id;
        const catalog = this.getModelCatalog();
        const wasGatewayActive = this.gatewayIsActive(catalog);
        if (catalog.models) {
          catalog.models = catalog.models.filter((m: any) => !isCustomCatalogModel(m) || (m.slug !== slug && m.model !== slug));
          this.saveModelCatalog(catalog);
          console.log(`[OpenCodex] Deleted model: ${slug}`);
        }
        const hasThirdParty = hasThirdPartyModels(catalog);
        if (!hasThirdParty && wasGatewayActive) {
          this.deactivateGatewayMode();
          this.restartCodexDesktop(true);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", gateway_active: hasThirdParty && !isNativeModeEnabled() }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/logs/poll" && req.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0");
      const entries = logBuffer.slice(since > 0 ? Math.max(0, logBuffer.length - (logBuffer.length - since)) : 0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries, total: logBuffer.length }));
      return;
    }

    if (path === "/api/sessions" && req.method === "GET") {
      try {
        const actualTokens = await this.fetchActualTokensFromCodex();
        const sessionsMap = new Map<string, { id: string, text: string, ts: number }>();
        const rolloutContextMap = new Map<string, SessionContextSnapshot>();
        
        // 1. Scan session_index.jsonl
        const sessionIndexPath = join(homedir(), ".codex", "session_index.jsonl");
        if (existsSync(sessionIndexPath)) {
          const lines = readFileSync(sessionIndexPath, "utf-8").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.id) {
                sessionsMap.set(item.id, {
                  id: item.id,
                  text: item.thread_name || `会话 ${item.id}`,
                  ts: Date.parse(item.updated_at) || Date.now()
                });
              }
            } catch {}
          }
        }

        // 2. Scan history.jsonl
        const historyPath = join(homedir(), ".codex", "history.jsonl");
        if (existsSync(historyPath)) {
          const lines = readFileSync(historyPath, "utf-8").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.session_id && !sessionsMap.has(item.session_id)) {
                sessionsMap.set(item.session_id, {
                  id: item.session_id,
                  text: item.text,
                  ts: item.ts * 1000
                });
              }
            } catch {}
          }
        }

        // Load voice settings to get the system prompt and active session
        const p = join(this.configDir, "voice_settings.json");
        let voiceSystemPrompt = "";
        let fileActiveSessionId = "";
        if (existsSync(p)) {
          try {
            const settings = JSON.parse(readFileSync(p, "utf-8"));
            voiceSystemPrompt = settings.voice_system_prompt || "";
            fileActiveSessionId = settings.active_session_id || "";
          } catch {}
        }
        if (fileActiveSessionId) {
          this.currentActiveSessionId = fileActiveSessionId;
        }
        const prefixUtf = voiceSystemPrompt + "\n\n用户说：";
        const prefixUtfClean = voiceSystemPrompt + "\n\n\u7528\u623f\u8bf4\uff1a"; // clean alternative

        // 2. Scan rollout files for complete context and timestamps
        const sessionsDir = join(homedir(), ".codex", "sessions");
        let mostRecentlyActiveSessionId = "";
        let mostRecentActivityTs = 0;
        if (existsSync(sessionsDir)) {
          const files = findRolloutFiles(sessionsDir);
          for (const file of files) {
            try {
              const content = readFileSync(file, "utf-8");
              const lines = content.split("\n");
              let session_id = "";
              let ts = 0;
              let lastActivityTs = 0;
              let firstUserMsg = "";
              let latestModel = "";
              let rolloutContext: SessionContextSnapshot | undefined;
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const item = JSON.parse(trimmed);
                if (item.timestamp) {
                  const itemTs = typeof item.timestamp === "number"
                    ? (item.timestamp < 9999999999 ? item.timestamp * 1000 : item.timestamp)
                    : Date.parse(item.timestamp) || 0;
                  lastActivityTs = Math.max(lastActivityTs, itemTs);
                }
                if (item.type === "session_meta") {
                  if (item.payload?.id) {
                    session_id = item.payload.id;
                  }
                  if (item.payload?.timestamp) {
                    const rawTs = item.payload.timestamp;
                    if (typeof rawTs === "number") {
                      ts = rawTs < 9999999999 ? rawTs * 1000 : rawTs;
                    } else if (typeof rawTs === "string") {
                      ts = Date.parse(rawTs) || 0;
                    }
                  }
                } else if (item.type === "turn_context" && item.payload?.model) {
                  latestModel = String(item.payload.model);
                } else if (item.type === "event_msg") {
                  if (item.payload?.type === "token_count" && item.payload?.info) {
                    const info = item.payload.info;
                    const lastUsage = info.last_token_usage;
                    const lastTokens = Number(lastUsage?.total_tokens);
                    const contextWindow = Number(info.model_context_window);
                    if (Number.isFinite(lastTokens) && lastTokens >= 0) {
                      rolloutContext = {
                        tokens: lastTokens,
                        is_estimated: false,
                        model: latestModel || undefined,
                        context_window: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 200000,
                        provider_prompt_tokens: Number.isFinite(lastUsage?.input_tokens) ? Number(lastUsage.input_tokens) : undefined,
                        provider_completion_tokens: Number.isFinite(lastUsage?.output_tokens) ? Number(lastUsage.output_tokens) : undefined,
                        source: "rollout_actual"
                      };
                    }
                  } else if (item.payload?.type === "user_message" && !firstUserMsg && item.payload.message) {
                    let uMsg = item.payload.message;
                    if (voiceSystemPrompt) {
                      if (uMsg.startsWith(prefixUtf)) {
                        uMsg = uMsg.slice(prefixUtf.length);
                      } else if (uMsg.startsWith(prefixUtfClean)) {
                        uMsg = uMsg.slice(prefixUtfClean.length);
                      }
                    }
                    firstUserMsg = uMsg;
                  }
                }
              }
              if (session_id) {
                const existing = sessionsMap.get(session_id);
                const activityTs = Math.max(ts, lastActivityTs, existing?.ts || 0);
                sessionsMap.set(session_id, {
                  id: session_id,
                  text: (existing && existing.text && !existing.text.startsWith("会话 ")) ? existing.text : (firstUserMsg || (existing ? existing.text : `会话 ${session_id}`)),
                  ts: activityTs || Date.now()
                });
                if (rolloutContext) rolloutContextMap.set(session_id, rolloutContext);
                if (activityTs > mostRecentActivityTs) {
                  mostRecentActivityTs = activityTs;
                  mostRecentlyActiveSessionId = session_id;
                }
              }
            } catch {}
          }
        }
        if (!fileActiveSessionId && mostRecentlyActiveSessionId) {
          this.currentActiveSessionId = mostRecentlyActiveSessionId;
        }

        const archivedPath = join(this.configDir, "archived_sessions.json");
        let archivedIds = new Set<string>();
        if (existsSync(archivedPath)) {
          try {
            archivedIds = new Set(JSON.parse(readFileSync(archivedPath, "utf-8")));
          } catch {}
        }

        const sessions = Array.from(sessionsMap.values()).map(s => {
          const actual = actualTokens.get(s.id);
          const rolloutContext = rolloutContextMap.get(s.id);
          let ctx = this.sessionContextMap.get(s.id);
          
          if (actual) {
            ctx = {
              ...ctx,
              tokens: actual.tokens,
              is_estimated: false,
              model: ctx?.model || "",
              context_window: actual.context_window,
              source: "provider"
            };
            this.sessionContextMap.set(s.id, ctx);
          } else if (rolloutContext) {
            ctx = {
              ...ctx,
              ...rolloutContext,
              model: rolloutContext.model || ctx?.model || ""
            };
            this.sessionContextMap.set(s.id, ctx);
          } else if (!ctx) {
            try {
              const history = loadHistoryFromRollout(s.id);
              const detectedModel = (history as any).model || "";
              const catalog = this.getModelCatalog();
              const catalogEntry = catalog.models?.find((m: any) => m.slug === detectedModel);
              const contextWindow = catalogEntry?.context_window || 200000;
              const localEstimate = estimateTokensForRequest({ messages: history }, detectedModel);
              ctx = {
                tokens: localEstimate.tokens,
                is_estimated: true,
                model: detectedModel,
                context_window: contextWindow,
                estimated_tokens: localEstimate.tokens,
                source: localEstimate.source,
                tokenizer: localEstimate.tokenizer
              };
              this.sessionContextMap.set(s.id, ctx);
            } catch {}
          }

          if (!ctx) {
            ctx = { tokens: 0, is_estimated: true, context_window: 200000 };
          }

          return {
            ...s,
            archived: archivedIds.has(s.id),
            tokens: ctx.tokens,
            is_estimated: ctx.is_estimated,
            model: ctx.model || "",
            context_window: ctx.context_window || 200000,
            estimated_tokens: ctx.estimated_tokens,
            provider_prompt_tokens: ctx.provider_prompt_tokens,
            provider_completion_tokens: ctx.provider_completion_tokens,
            token_source: ctx.source || (ctx.is_estimated ? "estimated" : "provider"),
            tokenizer: ctx.tokenizer,
            cumulative_usage: ctx.model
              ? this.sessionCumulativeUsage.get(this.contextKey(s.id, ctx.model))
              : undefined
          };
        })
        .sort((a, b) => {
          if (a.id === this.currentActiveSessionId) return -1;
          if (b.id === this.currentActiveSessionId) return 1;
          return b.ts - a.ts;
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sessions));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/detail" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        
        // Load voice settings to get the system prompt
        const p = join(this.configDir, "voice_settings.json");
        let voiceSystemPrompt = "";
        if (existsSync(p)) {
          try {
            const settings = JSON.parse(readFileSync(p, "utf-8"));
            voiceSystemPrompt = settings.voice_system_prompt || "";
          } catch {}
        }
        const prefixUtf = voiceSystemPrompt + "\n\n用户说：";
        const prefixUtfClean = voiceSystemPrompt + "\n\n\u7528\u623f\u8bf4\uff1a"; // clean alternative

        const sessionsDir = join(homedir(), ".codex", "sessions");
        const rolloutFile = findRolloutFileById(sessionsDir, sid);
        
        const messages: any[] = [];
        if (rolloutFile && existsSync(rolloutFile)) {
          const lines = readFileSync(rolloutFile, "utf-8").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.type === "event_msg") {
                const pType = item.payload?.type;
                if (pType === "user_message") {
                  let uMsg = item.payload.message || "";
                  if (voiceSystemPrompt) {
                    if (uMsg.startsWith(prefixUtf)) {
                      uMsg = uMsg.slice(prefixUtf.length);
                    } else if (uMsg.startsWith(prefixUtfClean)) {
                      uMsg = uMsg.slice(prefixUtfClean.length);
                    }
                  }
                  messages.push({
                    role: "user",
                    text: uMsg
                  });
                } else if (pType === "agent_message") {
                  messages.push({
                    role: "assistant",
                    text: item.payload.message
                  });
                }
              }
            } catch {}
          }
          const importedHistory = loadImportedMemoryFromRollout(sid);
          if (importedHistory.length > 0) {
            messages.length = 0;
            for (const message of importedHistory) {
              if (message.role !== "user" && message.role !== "assistant") continue;
              messages.push({
                role: message.role,
                text: message.content
              });
            }
          }
        } else {
          // Fallback to history.jsonl
          const historyPath = join(homedir(), ".codex", "history.jsonl");
          if (existsSync(historyPath)) {
            const lines = readFileSync(historyPath, "utf-8").split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const item = JSON.parse(trimmed);
                if (item.session_id === sid) {
                  messages.push({
                    role: "user",
                    text: item.text
                  });
                }
              } catch {}
            }
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/enter" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {};
        if (existsSync(p)) {
          try { settings = JSON.parse(readFileSync(p, "utf-8")); } catch {}
        }
        settings.active_session_id = sid;
        writeFileSync(p, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });

        this.broadcastSession(sid);

        console.error(`[Sessions] Switched active session to: ${sid}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", session_id: sid }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/new" && req.method === "POST") {
      try {
        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {};
        if (existsSync(p)) {
          try { settings = JSON.parse(readFileSync(p, "utf-8")); } catch {}
        }
        settings.active_session_id = "";
        writeFileSync(p, JSON.stringify(settings, null, 2), "utf-8");

        this.broadcastSession("");

        console.error("[Sessions] Reset active session to start a new conversation.");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", session_id: "" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/clear-all" && req.method === "POST") {
      try {
        const historyPath = join(homedir(), ".codex", "history.jsonl");
        if (existsSync(historyPath)) {
          writeFileSync(historyPath, "", "utf-8");
        }
        const sessionIndexPath = join(homedir(), ".codex", "session_index.jsonl");
        if (existsSync(sessionIndexPath)) {
          writeFileSync(sessionIndexPath, "", "utf-8");
        }
        const sessionsDir = join(homedir(), ".codex", "sessions");
        deleteSessionFiles(sessionsDir);

        console.error(`[Sessions] Cleared all sessions.`);
        this.customModelSessions.clear();
        this.forcedErrorSessions.clear();
        this.sessionContextMap.clear();
        this.sessionModelContextMap.clear();
        this.sessionCumulativeUsage.clear();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/delete" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        this.clearSessionUsage(sid);
        
        // 1. Delete from history.jsonl
        const historyPath = join(homedir(), ".codex", "history.jsonl");
        if (existsSync(historyPath)) {
          const lines = readFileSync(historyPath, "utf-8").split("\n");
          const remainingLines: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.session_id !== sid) {
                remainingLines.push(line);
              }
            } catch {
              remainingLines.push(line);
            }
          }
          writeFileSync(historyPath, remainingLines.join("\n") + "\n", "utf-8");
        }

        // 2. Delete from session_index.jsonl
        const sessionIndexPath = join(homedir(), ".codex", "session_index.jsonl");
        if (existsSync(sessionIndexPath)) {
          const lines = readFileSync(sessionIndexPath, "utf-8").split("\n");
          const remainingLines: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const item = JSON.parse(trimmed);
              if (item.id !== sid) {
                remainingLines.push(line);
              }
            } catch {
              remainingLines.push(line);
            }
          }
          writeFileSync(sessionIndexPath, remainingLines.join("\n") + "\n", "utf-8");
        }

        // 3. Delete rollout file
        const sessionsDir = join(homedir(), ".codex", "sessions");
        const rolloutFile = findRolloutFileById(sessionsDir, sid);
        if (rolloutFile && existsSync(rolloutFile)) {
          try {
            unlinkSync(rolloutFile);
          } catch {}
        }

        console.error(`[Sessions] Deleted session: ${sid}`);
        this.customModelSessions.delete(sid);
        this.forcedErrorSessions.delete(sid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/archive" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        const archived = !!data.archived;
        const archivedPath = join(this.configDir, "archived_sessions.json");
        let archivedIds: string[] = [];
        if (existsSync(archivedPath)) {
          try {
            archivedIds = JSON.parse(readFileSync(archivedPath, "utf-8"));
          } catch {}
        }
        if (archived) {
          if (!archivedIds.includes(sid)) {
            archivedIds.push(sid);
          }
        } else {
          archivedIds = archivedIds.filter(id => id !== sid);
        }
        writeFileSync(archivedPath, JSON.stringify(archivedIds, null, 2), "utf-8");
        console.error(`[Sessions] Session ${sid} archive status set to ${archived}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/export" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = String(data.id || "");
        const format = data.format || "openai";
        if (!sid) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing session id" }));
          return;
        }

        let memory: ReturnType<typeof memoryPackageFromThread>;
        const importedHistory = loadImportedMemoryFromRollout(sid);
        if (importedHistory.length > 0) {
          memory = memoryPackageFromMessages(
            importedHistory,
            getSessionTitle(sid),
            sid
          );
        } else {
          try {
            memory = await withCodexAppServer(async (client) => {
              const result = await client.call("thread/read", {
                threadId: sid,
                includeTurns: true
              });
              return memoryPackageFromThread(result.thread);
            });
          } catch (appServerError: any) {
            const history = loadHistoryFromRollout(sid);
            if (!history || history.length === 0) {
              throw new Error(`No history found for session: ${appServerError.message}`);
            }
            memory = memoryPackageFromMessages(
              history.map((message: any) => ({
                role: message.role === "assistant" ? "assistant" : "user",
                content: String(message.content || ""),
                source_id: message.id
              })),
              getSessionTitle(sid),
              sid
            );
          }
        }

        let outputContent = "";
        let filename = `session_${sid}`;

        if (format === "markdown") {
          outputContent = toMarkdown(memory);
          filename += ".md";
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`
          });
          res.end(outputContent);
        } else if (format === "anthropic") {
          filename += "_anthropic.json";
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`
          });
          res.end(JSON.stringify(toAnthropicPayload(memory), null, 2));
        } else if (format === "memory") {
          filename += "_memory.json";
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`
          });
          res.end(JSON.stringify(memory, null, 2));
        } else {
          filename += "_openai.json";
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`
          });
          res.end(JSON.stringify(toOpenAiMessages(memory), null, 2));
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/memory-sources/scan" && req.method === "GET") {
      try {
        const groups = await scanLocalMemorySources();
        this.memorySourceFiles.clear();
        for (const group of groups) {
          for (const source of group.sources) {
            this.memorySourceFiles.set(source.source_id, source);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          agents: groups.map((group) => ({
            name: group.name,
            session_count: group.session_count,
            sources: group.sources.map((source) => ({
              source_id: source.source_id,
              display_path: source.display_path,
              format: source.format,
              modified_at: source.modified_at,
              sessions: source.sessions
            }))
          }))
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/memory-sources/import" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const source = this.memorySourceFiles.get(String(data.source_id || ""));
        if (!source) {
          res.writeHead(410, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Scan result expired. Scan local agents again." }));
          return;
        }
        const selectedSessionId = data.session_id === "__default__"
          ? undefined
          : String(data.session_id || "");
        const parsed = await parseMemoryFilePath(source.path, selectedSessionId);
        if (!parsed.memory) throw new Error("The selected session could not be read");
        const imported = await importMemoryIntoCodex(parsed.memory);
        const shouldRestart = data.restart !== false;
        console.log(`[OpenCodex Memory Bridge] Imported scanned source ${source.display_path} into ${imported.id}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "success",
          ...imported,
          detected_format: parsed.detected_format,
          model_visible: true,
          restarted: shouldRestart
        }));
        if (shouldRestart) {
          setTimeout(() => this.restartCodexDesktop(), 350);
        }
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/import" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const fallbackTitle = String(data.name || `Imported conversation ${new Date().toLocaleDateString()}`);
        let memory;
        let detectedFormat = "json";
        if (typeof data.file_name === "string" && typeof data.file_base64 === "string") {
          const fileBytes = Buffer.from(data.file_base64, "base64");
          if (fileBytes.length === 0) throw new Error("The selected file is empty");
          if (fileBytes.length > 48 * 1024 * 1024) {
            throw new Error("Import file is too large. Maximum size is 48 MB");
          }
          const parsedFile = await parseMemoryFile(
            data.file_name,
            new Uint8Array(fileBytes),
            typeof data.session_id === "string" ? data.session_id : undefined
          );
          detectedFormat = parsedFile.detected_format;
          if (parsedFile.sessions?.length && !parsedFile.memory) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              requires_session_selection: true,
              detected_format: parsedFile.detected_format,
              sessions: parsedFile.sessions
            }));
            return;
          }
          if (!parsedFile.memory) throw new Error("No conversation was selected");
          memory = parsedFile.memory;
        } else {
          const rawImport = data.payload ?? (Array.isArray(data.messages) ? data.messages : data);
          memory = normalizeImportedMemory(rawImport, fallbackTitle);
        }
        const imported = await importMemoryIntoCodex(memory);
        const shouldRestart = data.restart !== false;
        console.log(`[OpenCodex Memory Bridge] Imported ${memory.messages.length} messages into Codex thread ${imported.id}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "success",
          ...imported,
          detected_format: detectedFormat,
          model_visible: true,
          restarted: shouldRestart
        }));
        if (shouldRestart) {
          setTimeout(() => this.restartCodexDesktop(), 350);
        }
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/sessions/compact" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const sid = data.id;
        this.clearSessionUsage(sid);
        this.customConversationHistory.delete(sid);

        fetch("http://127.0.0.1:8315/json")
          .then(res => res.json())
          .then((targets: any) => {
            const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
            if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
              console.error("[Compact] Main Codex window page target not found via CDP");
              return;
            }
            
            const tempWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
            tempWs.on("open", () => {
              const evalScript = `
                (() => {
                  const editor = document.querySelector('.ProseMirror');
                  if (!editor) {
                    return { status: 'failed', reason: 'ProseMirror editor not found' };
                  }

                  editor.focus();
                  
                  // Use document.execCommand to safely insert text into ProseMirror's state
                  document.execCommand('selectAll', false, null);
                  document.execCommand('delete', false, null);
                  document.execCommand('insertText', false, '/compact');

                  // Dispatch Enter key events to trigger Codex slash command execution
                  const createEnterEvent = (type) => new KeyboardEvent(type, {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                  });

                  editor.dispatchEvent(createEnterEvent('keydown'));
                  editor.dispatchEvent(createEnterEvent('keypress'));
                  editor.dispatchEvent(createEnterEvent('keyup'));

                  return { status: 'success', detail: 'Sent native /compact slash command to Codex' };
                })()
              `;
              tempWs.send(JSON.stringify({
                id: 300,
                method: "Runtime.evaluate",
                params: {
                  expression: evalScript,
                  returnByValue: true
                }
              }));
            });
            tempWs.on("message", (msgData) => {
              try {
                const resObj = JSON.parse(msgData.toString());
                if (resObj.id === 300) {
                  console.log("[Compact] CDP evaluate result:", resObj.result);
                  tempWs.close();
                }
              } catch {}
            });
          })
          .catch((err) => {
            console.error("[Compact] Error querying CDP for compaction:", err.message);
          });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/test-log" && req.method === "POST") {
      console.log("[OpenCodex] Test log from dashboard at " + new Date().toLocaleTimeString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (path === "/api/platform" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ platform: process.platform }));
      return;
    }

    if (path === "/api/permissions" && req.method === "GET") {
      if (process.platform !== "darwin") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "unsupported", platform: process.platform }));
        return;
      }
      try {
        const helperPath = join(this.configDir, "check_perms");
        if (!existsSync(helperPath)) {
          this.ensureCheckPermsHelper();
        }
        const result = spawnSync(helperPath, [], { encoding: "utf-8" });
        if (result.status === 0) {
          const lines = result.stdout.trim().split("\n");
          const permissions = {
            accessibility: lines[0] === "true",
            screenRecording: lines[1] === "true"
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", permissions }));
        } else {
          throw new Error(result.stderr || "Helper execution failed");
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/permissions/fix" && req.method === "POST") {
      if (process.platform !== "darwin") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "unsupported", platform: process.platform }));
        return;
      }
      try {
        const appPath1 = join(homedir(), ".codex", "computer-use", "Codex Computer Use.app");
        const appPath2 = join(appPath1, "Contents", "SharedSupport", "SkyComputerUseClient.app");
        
        if (existsSync(appPath1)) {
          // Launch/open the real signed app bundle so that macOS triggers the stable permission prompt
          exec(`open "${appPath1}"`);
        }

        exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
        exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"');

        if (existsSync(appPath1)) {
          exec(`open -R "${appPath1}"`);
        }
        if (existsSync(appPath2)) {
          setTimeout(() => {
            exec(`open -R "${appPath2}"`);
          }, 800);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", message: "Prompts triggered and folders opened." }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/restart-codex" && req.method === "POST") {
      try {
        if (!this.gatewayIsActive()) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Codex is in native mode; no third-party gateway model is active." }));
          return;
        }
        this.restartCodexDesktop();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/reset" && req.method === "POST") {
      try {
        if (!this.gatewayIsActive()) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Native mode is already active." }));
          return;
        }
        this.restoreOriginalConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", native_mode: true, gateway_active: false }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/voice-settings" && req.method === "GET") {
      const p = join(this.configDir, "voice_settings.json");
      let settings = {
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
        hud_theme: "vortex"
      };
      if (existsSync(p)) {
        try {
          settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
        } catch {}
      }

      const catalog = this.getModelCatalog();
      const available_models = (catalog.models || []).map((m: any) => m.slug);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...redactSecrets(settings), available_models }));
      return;
    }

    if (path === "/api/voice-settings" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const p = join(this.configDir, "voice_settings.json");
        let existingSettings: Record<string, any> = {};
        if (existsSync(p)) {
          try { existingSettings = JSON.parse(readFileSync(p, "utf-8")); } catch {}
        }
        const settings = {
          stt_engine: data.stt_engine || "local-whisper",
          stt_api_key: keepExistingSecret(data.stt_api_key, existingSettings.stt_api_key),
          stt_base_url: data.stt_base_url || "https://api.openai.com/v1",
          stt_model: data.stt_model || "whisper-1",
          tts_engine: data.tts_engine || "edge-tts",
          tts_api_key: keepExistingSecret(data.tts_api_key, existingSettings.tts_api_key),
          tts_base_url: data.tts_base_url || "https://api.openai.com/v1",
          tts_model: data.tts_model || "tts-1",
          tts_voice: data.tts_voice || "zh-CN-XiaoxiaoNeural",
          tts_speed: typeof data.tts_speed === "number" ? data.tts_speed : 1.2,
          tts_appid: data.tts_appid || "",
          tts_resource: data.tts_resource || "",
          tts_resource_id: data.tts_resource || "", // Alias for compatibility
          voice_system_prompt: data.voice_system_prompt || "",
          vad_threshold: typeof data.vad_threshold === "number" ? data.vad_threshold : -35.0,
          vad_duration: typeof data.vad_duration === "number" ? data.vad_duration : 2.0,
          voice_llm_model: data.voice_llm_model || "",
          enable_wake_word: typeof data.enable_wake_word === "boolean" ? data.enable_wake_word : false,
          hud_theme: ["vortex", "siri"].includes(data.hud_theme) ? data.hud_theme : "vortex"
        };
        writeFileSync(p, JSON.stringify(settings, null, 2), "utf-8");
        console.error("[OpenCodex] Saved voice settings to " + p);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", settings: redactSecrets(settings) }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/voice/stt" && req.method === "POST") {
      try {
        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {
          stt_engine: "local-whisper",
          stt_api_key: "",
          stt_base_url: "https://api.openai.com/v1",
          stt_model: "whisper-1"
        };
        if (existsSync(p)) {
          try {
            settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
          } catch {}
        }

        const audioPath = join(tmpdir(), "stt_web_input.wav");
        writeFileSync(audioPath, rawBody);
        console.error(`[OpenCodex Voice API] Received audio data for STT, size = ${rawBody.length} bytes`);

        const engine = settings.stt_engine || "local-whisper";
        if (engine === "openai-compatible" || engine === "groq") {
          console.error(`[OpenCodex Voice API] Transcribing via API endpoint (${engine}): ${settings.stt_base_url}`);
          this.transcribeAudioAPI(audioPath, settings)
            .then((text) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ text }));
            })
            .catch((err) => {
              console.error(`[OpenCodex Voice API STT API Err] ${err.message}`);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message, text: "" }));
            });
        } else {
          // Default to local-whisper
          console.error(`[OpenCodex Voice API] Transcribing locally via local-whisper...`);
          this.transcribeAudioLocal(audioPath, (text) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ text: text || "" }));
          });
        }
      } catch (err: any) {
        console.error(`[OpenCodex Voice API STT Err] ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, text: "" }));
      }
      return;
    }

    if (path === "/api/voice/tts" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const text = data.text;
        if (text) {
          this.currentSystemUtterance = text;
          // Clear it after roughly the duration it takes to speak it (assuming ~250ms per character + 2s buffer)
          const estimatedDuration = Math.max(2000, text.length * 250) + 2000;
          setTimeout(() => {
            if (this.currentSystemUtterance === text) {
              this.currentSystemUtterance = "";
            }
          }, estimatedDuration);
        }
        if (!text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Text is empty" }));
          return;
        }

        const p = join(this.configDir, "voice_settings.json");
        let settings: any = {
          tts_engine: "edge-tts",
          tts_api_key: "",
          tts_base_url: "https://api.openai.com/v1",
          tts_model: "tts-1",
          tts_voice: "zh-CN-XiaoxiaoNeural"
        };
        if (existsSync(p)) {
          try {
            settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
          } catch {}
        }

        let engine = settings.tts_engine || "";
        if (engine === "" && settings.tts_base_url && settings.tts_base_url.includes("bytedance")) {
          engine = "doubao";
        }
        if (engine === "") {
          engine = "edge-tts";
        }

        // Clean all emotional expressions in parentheses & brackets before sending to TTS (e.g. （挥手）, (笑), [微笑])
        let cleanText = text
          .replace(/[\(\uFF08][^\)\uFF09]*[\)\uFF09]/g, "")
          .replace(/[\[\u3010][^\]\u3011]*[\]\u3011]/g, "")
          .trim();

        console.error(`[OpenCodex Voice API] Synthesizing speech via ${engine} for text: '${cleanText.substring(0, 30)}...'`);

        if (engine === "openai-compatible") {
          this.synthesizeSpeechAPI(cleanText, settings)
            .then((audioBuffer) => {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            })
            .catch((err) => {
              console.error(`[OpenCodex Voice API TTS API Err] ${err.message}`);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            });
        } else if (engine === "doubao") {
          this.synthesizeSpeechDoubao(cleanText, settings)
            .then((audioBuffer) => {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            })
            .catch((err) => {
              console.error(`[OpenCodex Voice API Doubao TTS Err] ${err.message}`);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            });
        } else if (engine === "minimax") {
          this.synthesizeSpeechMiniMax(cleanText, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "MiniMax synthesis failed" }));
            }
          });
        } else if (engine === "mimo") {
          this.synthesizeSpeechMiMo(cleanText, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Xiaomi MiMo synthesis failed" }));
            }
          });
        } else if (engine === "kokoro") {
          this.synthesizeSpeechKokoro(cleanText, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/wav" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Kokoro synthesis failed" }));
            }
          });
        } else {
          // Default to edge-tts
          this.synthesizeSpeechEdge(text, settings, (audioBuffer) => {
            if (audioBuffer) {
              res.writeHead(200, { "Content-Type": "audio/mpeg" });
              res.end(audioBuffer);
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "EdgeTTS synthesis failed" }));
            }
          });
        }
      } catch (err: any) {
        console.error(`[OpenCodex Voice API TTS Err] ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/voice/ask" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const prompt = data.prompt;
        const sessionId = data.session_id || "default";
        const startTime = Date.now() - 1000;

        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Prompt is empty" }));
          return;
        }

        // 1. Query Electron page URL via CDP to get the exact active thread ID
        let activeThreadId = "";
        const getThreadIdFromCDP = (): Promise<string> => {
          return new Promise((resolve) => {
            try {
              fetch("http://127.0.0.1:8315/json")
                .then(res => res.json())
                .then((targets: any) => {
                  const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
                  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
                    resolve("");
                    return;
                  }
                  
                  const tempWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
                  tempWs.on("open", () => {
                    tempWs.send(JSON.stringify({
                      id: 100,
                      method: "Runtime.evaluate",
                      params: {
                        expression: "window.location.href",
                        returnByValue: true
                      }
                    }));
                  });
                  tempWs.on("message", (data) => {
                    try {
                      const resObj = JSON.parse(data.toString());
                      if (resObj.id === 100) {
                        if (resObj.result?.result?.value) {
                          const href = resObj.result.result.value;
                          const match = href.match(/[?&]thread_id=([^&]+)/);
                          if (match && match[1]) {
                            console.error(`[OpenCodex Voice API] Resolved Thread ID via CDP URL: ${match[1]}`);
                            resolve(match[1]);
                            tempWs.close();
                            return;
                          }
                        }
                        resolve("");
                        tempWs.close();
                      }
                    } catch {
                      // Only close/resolve on parse error if we want to fail-safe, but let's be safe
                    }
                  });
                  tempWs.on("error", () => {
                    resolve("");
                  });
                })
                .catch(() => resolve(""));
            } catch {
              resolve("");
            }
          });
        };

        getThreadIdFromCDP().then(async (resolvedId) => {
          activeThreadId = resolvedId;
          
          // Fallback to SQLite if CDP fails to read URL
          if (!activeThreadId) {
            try {
              const dbPath = join(homedir(), ".codex", "state_5.sqlite");
              if (existsSync(dbPath)) {
                const cmd = `sqlite3 "${dbPath}" "SELECT id FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1;"`;
                const dbThreadId = execSync(cmd, { encoding: "utf-8" }).trim();
                if (dbThreadId) {
                  activeThreadId = dbThreadId;
                }
              }
            } catch {}
          }

          // Native Codex does not send its response stream through the gateway
          // WebSocket. Observe the rendered assistant message through CDP so
          // the voice bar still receives model_chunk/model_done events.
          let nativeMonitorStop: (() => void) | null = null;
          if (isNativeModeEnabled()) {
            nativeMonitorStop = await this.startNativeCdpResponseMonitor();
          }

          let result = await this.injectPromptViaCDP(prompt);
          if (result === "connection_failed") {
            console.warn("[OpenCodex Voice API] CDP connection failed. Attempting to relaunch Codex with debugging enabled...");
            nativeMonitorStop?.();
            this.restartCodexForCdp();
            // Wait 5 seconds for Codex to restart and open
            await new Promise((resolve) => setTimeout(resolve, 5000));
            if (isNativeModeEnabled()) {
              nativeMonitorStop = await this.startNativeCdpResponseMonitor();
            }
            // Retry injection
            result = await this.injectPromptViaCDP(prompt);
          }

          if (result === "success") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "injected", reply: "" }));
          } else {
            nativeMonitorStop?.();
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Failed to inject prompt via CDP: ${result}` }));
          }
        });
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/execute-command" && req.method === "POST") {
      try {
        const data = JSON.parse(body);
        const command = data.command;
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Command is empty" }));
          return;
        }

        console.error(`[OpenCodex Command Console] Executing: ${command}`);
        const cmdPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
        const child = spawn(cmdPath, ["--dangerously-bypass-approvals-and-sandbox", "exec", "--skip-git-repo-check", "-"]);
        
        let output = "";
        let errorOutput = "";

        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
          errorOutput += chunk.toString();
        });

        child.on("close", (code) => {
          const cleanOutput = output.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "").trim();
          const cleanError = errorOutput.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "").trim();
          
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            code,
            output: cleanOutput,
            error: cleanError
          }));
        });

        child.stdin.write(command + "\n");
        child.stdin.end();

      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/voice-bar/status" && req.method === "GET") {
      if (process.platform !== "darwin") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ running: false, supported: false }));
        return;
      }
      exec('pgrep -x OpenCodexBar', (err, stdout) => {
        const running = !err && stdout.trim().length > 0;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ running, pid: running ? stdout.trim() : null }));
      });
      return;
    }

    if (path === "/api/voice-bar/launch" && req.method === "POST") {
      try {
        const data = JSON.parse(body || "{}");
        const method = data.method === "app" ? "app" : "swift-run";
        
        const checkAndLaunch = async () => {
          let isCDPOpen = false;
          try {
            const cdpRes = await fetch("http://127.0.0.1:8315/json");
            if (cdpRes.ok) {
              isCDPOpen = true;
            }
          } catch (e) {}

          if (!isCDPOpen) {
            console.log("[OpenCodex] Proactively relaunching Codex with debugging enabled since port 8315 is closed...");
            this.restartCodexForCdp();
            // Wait 3.5 seconds for Codex to restart cleanly
            await new Promise((resolve) => setTimeout(resolve, 3500));
          }

          this.restartVoiceBar(method);
        };

        checkAndLaunch().then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", method }));
        }).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (path === "/api/orb/reset" && req.method === "POST") {
      console.log(`[OpenCodex] Resetting active streams and unlocking client UI...`);
      for (const controller of this.activeAbortControllers.values()) {
        try { controller.abort(); } catch {}
      }
      this.activeAbortControllers.clear();
      
      const payload = {
        type: "event_msg",
        payload: {
          type: "task_complete",
          completed_at: Math.floor(Date.now() / 1000),
          duration_ms: 1000
        }
      };
      
      for (const client of this.desktopWsClients) {
        try {
          client.send(JSON.stringify(payload));
        } catch {}
      }
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success", message: "Client unlocked successfully" }));
      return;
    }

    if (path === "/api/orb/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: this.orbProcess !== null }));
      return;
    }

    if (path === "/api/orb/launch" && req.method === "POST") {
      try {
        const data = JSON.parse(body || "{}");
        const enable = !!data.enable;

        if (enable) {
          try {
            execSync("pkill -f 'dist/proxy/orb.js' || true");
          } catch {}
          if (this.orbProcess) {
            try { this.orbProcess.kill(); } catch {}
            this.orbProcess = null;
          }
          console.log("[Orb Manager] Spawning Electron Orb Widget...");
          const moduleDir = dirname(fileURLToPath(import.meta.url));
          const orbScript = join(moduleDir, "orb.js");
          
          const electronPath = join(moduleDir, "..", "..", "node_modules", ".bin", "electron");
          
          this.orbProcess = spawn(electronPath, [orbScript], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env }
          });
          
          this.orbProcess.unref();

          this.orbProcess.on("exit", () => {
            console.log("[Orb Manager] Electron Orb process exited.");
            this.orbProcess = null;
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", launched: true }));
        } else {
          if (this.orbProcess) {
            console.log("[Orb Manager] Killing Electron Orb process...");
            this.orbProcess.kill();
            this.orbProcess = null;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", killed: true }));
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── Standard Gateway Routes ───

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "1.0.0", opencodex: true }));
      return;
    }

    if (path === "/v1/config") {
      const safe = {
        providers: this.config.providers.map(p => ({
          ...p,
          api_key: p.api_key ? p.api_key.slice(0, 8) + "..." : ""
        }))
      };
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(JSON.stringify(safe, null, 2));
      return;
    }

    if (path === "/v1/models" || path === "/v1/models/") {
      const catalog = this.getModelCatalog();
      const list = catalog.models || [];
      
      // Filter list based on visibility === "list"
      const data = list
        .filter((m: any) => m.visibility === "list")
        .map((m: any) => ({
          id: m.slug,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "opencodex"
        }));

      // Always inject native Computer Use pass-through model id
      data.push({ id: "opencodex/cu", object: "model", owned_by: "local" });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }

    if (path === "/v1/responses" && req.method === "POST") {
      const sidHeader = req.headers["x-session-id"] || req.headers["session-id"] || "";
      const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
      this.handleResponses(body, res, sessionId, req, rawBody);
      return;
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      this.handleChat(body, res);
      return;
    }

    if (path.startsWith("/v1/")) {
      console.log(`[OpenCodex Proxy] Transparently proxying unhandled API route ${path} to api.openai.com`);
      try {
        const headers: Record<string, string> = {};
        for (const [key, val] of Object.entries(req.headers)) {
          if (key.toLowerCase() === "host") continue;
          headers[key] = Array.isArray(val) ? val[0] : (val || "");
        }
        
        const response = await fetch(`https://api.openai.com${req.url}`, {
          method: req.method,
          headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? rawBody : undefined,
          dispatcher: fetchDispatcher
        });

        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(response.headers)) {
          resHeaders[k] = Array.isArray(v) ? v.join(", ") : v || "";
        }

        res.writeHead(response.status, resHeaders);
        const resBody = await response.arrayBuffer();
        res.end(Buffer.from(resBody));
      } catch (err: any) {
        console.error(`[OpenCodex Proxy] Failed to proxy unhandled route ${path}: ${err.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy failed: ${err.message}` }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  }

  // ══════════════════════════════════════════════
  //  Responses API Gateway (Used by Codex UI)
  // ══════════════════════════════════════════════

  private async handleResponses(body: string, res: http.ServerResponse, sessionId?: string, req?: http.IncomingMessage, rawBody?: Buffer) {
    let reqBody: any;
    try {
      reqBody = JSON.parse(body);
      if (REQUEST_DEBUG_ENABLED) {
        writeFileSync(join(tmpdir(), "responses_request_debug.json"), JSON.stringify(reqBody, null, 2), { encoding: "utf-8", mode: 0o600 });
      }
    } catch (e: any) {
      console.error("[OpenCodex] Failed to parse responses JSON body:", e.message, "Length:", body.length, "First 200 chars:", body.slice(0, 200));
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    if (body.includes("image_url") || body.includes("input_image") || body.includes("file_data")) {
      console.error("[OpenCodex-DEBUG] Incoming request contains image/file data. Structure:", JSON.stringify(reqBody, (k, v) => {
        if (typeof v === "string" && v.length > 200) return v.slice(0, 100) + "... (truncated)";
        return v;
      }, 2));
    }

    // Detect get_app_state output to inject delay and allow CUA session initialization (check only the most recent tool outputs at the end of history)
    let hasGetAppStateOutput = false;
    if (reqBody.input && Array.isArray(reqBody.input)) {
      for (let i = reqBody.input.length - 1; i >= 0; i--) {
        const item = reqBody.input[i];
        if (item && item.type === "function_call_output") {
          const outStr = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
          if (outStr.includes("<app_specific_instructions>") || outStr.includes("CUA App Version:")) {
            hasGetAppStateOutput = true;
            break;
          }
        } else {
          // Once we encounter a non-tool-output item, we stop checking as we've processed the latest turn's outputs
          break;
        }
      }
    }
    const finalSessionId = sessionId || reqBody.client_metadata?.session_id;

    if (hasGetAppStateOutput && finalSessionId) {
      if (!this.initializedSessions.has(finalSessionId)) {
        this.initializedSessions.add(finalSessionId);
        console.log(`[OpenCodex Proxy] Detected cold-start get_app_state output for session ${finalSessionId}. Injecting 1500ms delay to allow CUA session to stabilize...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    const requestedModel = reqBody.model || "";
    
    // Resolve which actual model and provider we route to
    const catalog = this.getModelCatalog();
    let catalogEntry = catalog.models?.find((m: any) => m.slug === requestedModel);
    
    if (!catalogEntry && catalog.models && catalog.models.length > 0) {
      catalogEntry = catalog.models[0];
      console.log(`[OpenCodex Proxy] Unknown model requested in handleResponses: ${requestedModel}. Falling back to default catalog model: ${catalogEntry.slug}`);
      reqBody.model = catalogEntry.slug;
    }

    const isCustomModel = !!catalogEntry?.backend_provider;
    if (!isCustomModel && req && rawBody) {
      const isChatGptAccount = Object.keys(req.headers).some(k => k.toLowerCase() === "chatgpt-account-id");
      let targetUrl = "";
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathStr = urlObj.pathname;
      if (isChatGptAccount) {
        let subPath = pathStr;
        if (pathStr.startsWith("/v1/")) {
          subPath = pathStr.substring(4);
        }
        if (!subPath.startsWith("codex/")) {
          subPath = "codex/" + subPath;
        }
        targetUrl = `https://chatgpt.com/backend-api/${subPath}${urlObj.search}`;
      } else {
        targetUrl = pathStr.startsWith("/v1/")
          ? `https://api.openai.com${pathStr}${urlObj.search}`
          : `https://chatgpt.com${pathStr}${urlObj.search}`;
      }

      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length" || key.toLowerCase() === "accept-encoding") {
          continue;
        }
        headers[key] = Array.isArray(val) ? val[0] : (val || "");
      }
      
      let realToken = "";
      const authPath = join(homedir(), ".codex", "auth.json");
      if (existsSync(authPath)) {
        try {
          const authData = JSON.parse(readFileSync(authPath, "utf-8"));
          if (authData.tokens && authData.tokens.access_token) {
            realToken = authData.tokens.access_token;
          }
        } catch {}
      }
      if (realToken && !headers["authorization"]) {
        headers["authorization"] = `Bearer ${realToken}`;
      }

      let forwardedBody: any = rawBody;
      if (reqBody && Array.isArray(reqBody.input)) {
        let mutated = false;
        for (const item of reqBody.input) {
          if (item && item.type === "message" && Array.isArray(item.content)) {
            const originalLength = item.content.length;
            item.content = item.content.filter((part: any) => {
              if (!part) return false;
              const type = String(part.type || "").toLowerCase();
              return type === "text" || type === "input_text" || type === "output_text" || type === "text_text" || type === "text_delta";
            });
            if (item.content.length !== originalLength) {
              mutated = true;
              console.log(`[OpenCodex Proxy] Stripped non-text parts from message item in official model HTTP request.`);
            }
          }
        }
        if (mutated) {
          forwardedBody = JSON.stringify(reqBody);
          delete headers["content-encoding"];
        }
      }

      try {
        console.log(`[OpenCodex Proxy] Forwarding HTTP ${req.method} for official model to: ${targetUrl}`);
        const officialRes = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: forwardedBody,
          dispatcher: fetchDispatcher
        });

        console.log(`[OpenCodex Proxy] Official server HTTP response status: ${officialRes.status}`);
        if (officialRes.status === 400 || officialRes.status === 403 || officialRes.status === 401) {
          const errText = await officialRes.text();
          if (errText.includes("Responses-Lite")) {
            console.log(`[OpenCodex Proxy] Intercepted HTTP Responses-Lite error. Translating to 401 Unauthorized token expired.`);
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: {
                message: "The client token is expired or invalid.",
                type: "invalid_request_error",
                param: null,
                code: "invalid_token"
              }
            }));
            return;
          }
          res.writeHead(officialRes.status, {
            "Content-Type": officialRes.headers.get("content-type") || "application/json"
          });
          res.end(errText);
          return;
        }

        res.writeHead(officialRes.status, {
          "Content-Type": officialRes.headers.get("content-type") || "application/json"
        });
        const bodyReader = officialRes.body;
        if (bodyReader) {
          // @ts-ignore
          for await (const chunk of bodyReader) {
            res.write(chunk);
          }
        }
        res.end();
        return;
      } catch (err: any) {
        console.error(`[OpenCodex Proxy] Failed to forward HTTP request to official server: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to forward request to official server: ${err.message}` }));
        return;
      }
    }

    const mappedModelName = (catalogEntry && catalogEntry.backend_model) ? catalogEntry.backend_model : ((catalogEntry && catalogEntry.model) ? catalogEntry.model : requestedModel);

    const provider = this.findProvider(mappedModelName, catalogEntry);
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown model: ${requestedModel}` }));
      return;
    }

    const hasKeys = (provider.api_keys && provider.api_keys.length > 0) || provider.api_key;
    if (!hasKeys) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `API Key is missing. Configure keys via http://localhost:8765/dashboard` }));
      return;
    }

    // Always compress images; describe with MiMo if vision bridge enabled
    const callVisionBridge = catalogEntry ? !!catalogEntry.vision_bridge_enabled : false;
    const providerReqBody = isCustomModel
      ? { ...reqBody, tools: ensureComputerUseResponsesTools(reqBody.tools) }
      : reqBody;
    const processedReqBody = await processVisionBridge(providerReqBody, callVisionBridge ? this.config : undefined);

    const upstreamModel = mappedModelName;
    const isStream = processedReqBody.stream ?? false;

    console.log(`[Responses] Routing ${requestedModel} → ${provider.name}/${upstreamModel} (stream=${isStream}, visionBridge=${callVisionBridge})`);

    const chatBody = process.platform === "win32"
      ? await responsesToChatWin(processedReqBody, upstreamModel, finalSessionId)
      : await responsesToChat(processedReqBody, upstreamModel, finalSessionId);
    
    // Maintain conversation history locally in the proxy as the client does not send full history in input.
    const sessionIdStr = finalSessionId ? String(finalSessionId) : "default";
    
    if (isCustomModel) {
      this.customModelSessions.add(sessionIdStr);
    } else {
      this.customModelSessions.delete(sessionIdStr);
    }

    const prevResponseId = processedReqBody.previous_response_id;
    // Prefer memory cache to avoid async disk I/O race conditions, reload from rollout if empty or desynced
    let existingHistory = this.customConversationHistory.get(sessionIdStr) || [];
    const incomingMessages = chatBody.messages.filter((m: any) => m.role !== "system");

    if (existingHistory.length > 0 && incomingMessages.length > 1) {
      const prevIncoming = incomingMessages[incomingMessages.length - 2];
      const found = existingHistory.some((m: any) => isSameMessage(m, prevIncoming));
      if (!found) {
        console.log(`[Responses] Cache desync detected for session ${sessionIdStr}. Reloading from rollout...`);
        existingHistory = loadHistoryFromRollout(sessionIdStr);
        this.sessionContextMap.delete(sessionIdStr);
      }
    } else if (existingHistory.length === 0) {
      existingHistory = loadHistoryFromRollout(sessionIdStr);
      this.sessionContextMap.delete(sessionIdStr);
      if (existingHistory.length === 0) {
        console.log(`[Responses] Stale history empty. Waiting 350ms for client to write rollout file...`);
        await new Promise(resolve => setTimeout(resolve, 350));
        existingHistory = loadHistoryFromRollout(sessionIdStr);
      }
    }

    if (existingHistory.length === 0) {
      this.customConversationHistory.set(sessionIdStr, chatBody.messages);
    } else {
      let alignedHistory = existingHistory;
      if (prevResponseId) {
        const index = existingHistory.findIndex((m: any) => m.role === "assistant" && (m.id === prevResponseId || m.response_id === prevResponseId));
        if (index !== -1) {
          alignedHistory = existingHistory.slice(0, index + 1);
        }
      }
      const updatedHistory = mergeHistory(alignedHistory, incomingMessages);
      this.customConversationHistory.set(sessionIdStr, updatedHistory);
    }
    // Preserve assistant tool_calls and their role=tool results.  Removing
    // these messages makes the next turn look like a fresh conversation to
    // third-party models and breaks Computer Use continuation.
    chatBody.messages = normalizeDeepSeekToolHistory(
      alignToolMessages(this.customConversationHistory.get(sessionIdStr) || []),
      mappedModelName
    );

    const contextWindow = catalogEntry?.context_window || 200000;
    this.currentActiveSessionId = sessionIdStr;
    this.updateContextUsage(sessionIdStr, requestedModel, chatBody, contextWindow);
    const namespaceMap = extractNamespaceMap(processedReqBody.tools);

    let maxRetries = provider.api_keys && provider.api_keys.length > 0 ? provider.api_keys.length : 1;
    let attempt = 0;
    let success = false;
    let lastError: any = null;

    while (attempt < maxRetries) {
      attempt++;
      const currentApiKey = this.getNextKeyForProvider(provider);
      try {
        if (isStream) {
          await this.streamResponses(chatBody, provider, requestedModel, currentApiKey, namespaceMap, res, finalSessionId, !!processedReqBody.background);
        } else {
          await this.nonStreamResponses(chatBody, provider, requestedModel, currentApiKey, namespaceMap, res, finalSessionId);
        }
        success = true;
        break;
      } catch (err: any) {
        lastError = err;
        console.error(`[Responses] Attempt ${attempt} failed with error: ${err.message}`);
        if (res.headersSent) {
          break;
        }
        if (err instanceof UpstreamError && ![429, 401, 403, 502, 503, 504].includes(err.status)) {
          break;
        }
      }
    }

    if (!success && lastError) {
      console.error(`[Responses] All ${attempt} attempts failed. Final error: ${lastError.message}`);
      if (!res.headersSent) {
        if (isStream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.writeHead(200);

          const streamState = new ResponsesStreamState(
            requestedModel,
            namespaceMap,
            finalSessionId,
            (textChunk) => {
              const msg = JSON.stringify({ type: "model_chunk", text: textChunk });
              for (const wsClient of this.activeWsClients) {
                try { wsClient.send(msg); } catch {}
              }
            },
            (fullText) => {
              const msg = JSON.stringify({ type: "model_done", text: fullText });
              for (const wsClient of this.activeWsClients) {
                try { wsClient.send(msg); } catch {}
              }
            },
            undefined,
            !!processedReqBody.background || requestedModel.includes("mini") || requestedModel.includes("title")
          );
          await streamState.start(async (payload) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          });
          const fakeChunk = {
            choices: [{
              delta: {
                content: `\n[OpenCodex Proxy Error] Failed to fetch from upstream after ${attempt} attempts. Last error: ${lastError.message}\n`
              }
            }]
          };
          await streamState.writeChatDelta(async (payload) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }, fakeChunk);
          await streamState.finish(async (payload) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          });
          res.end();
        } else {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: lastError.message }));
        }
      }
    }
  }

  private async streamResponses(
    body: any,
    provider: ProviderConfig,
    requestedModel: string,
    apiKey: string,
    namespaceMap: Record<string, string>,
    res: http.ServerResponse,
    sessionId?: string,
    isBackground?: boolean
  ) {
    const response = await this.fetchWithWebBridge(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher,
      requestedModel: requestedModel
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new UpstreamError(response.status, errorText);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.writeHead(200);

    const streamState = new ResponsesStreamState(
      requestedModel,
      namespaceMap,
      sessionId,
      (textChunk) => {
        // Broadcast streaming text chunk to all client apps
        const msg = JSON.stringify({ type: "model_chunk", text: textChunk });
        for (const wsClient of this.activeWsClients) {
          try { wsClient.send(msg); } catch {}
        }
      },
      (fullText) => {
        // Broadcast completion message to all client apps
        const msg = JSON.stringify({ type: "model_done", text: fullText });
        for (const wsClient of this.activeWsClients) {
          try { wsClient.send(msg); } catch {}
        }
      },
      undefined,
      isBackground || requestedModel.includes("mini") || requestedModel.includes("title")
    );
    await streamState.start(async (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    try {

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalUsage: any = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;
            try {
              const chunk = JSON.parse(trimmed.slice(6));
              if (chunk.usage) finalUsage = chunk.usage;
              await streamState.writeChatDelta(async (payload) => {
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
              }, chunk);
            } catch {
              // ignore JSON parsing chunks error
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const assistantMsg = streamState.getAssistantMessage();
      let responseUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
      if (assistantMsg) {
        assistantMsg.id = streamState.responseId;
        const sessionIdStr = sessionId ? String(sessionId) : "default";
        const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
        const updatedHistory = currentHistory.concat(assistantMsg);
        this.customConversationHistory.set(sessionIdStr, updatedHistory);
        const snapshot = this.updateContextUsage(
          sessionIdStr,
          requestedModel,
          { ...body, messages: updatedHistory },
          this.getModelContextWindow(requestedModel),
          finalUsage
        );
        responseUsage = {
          input_tokens: snapshot.provider_prompt_tokens ?? estimateTokensForRequest(body, requestedModel).tokens,
          output_tokens: snapshot.provider_completion_tokens ?? estimateTokensForRequest({ messages: [assistantMsg] }, requestedModel).tokens,
          total_tokens: snapshot.tokens
        };
      }
      await streamState.finish(async (payload) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }, responseUsage);
      res.end();
    } catch (err: any) {
      console.error(`[Responses] Streaming error: ${err.message}`);
      try {
        const fakeChunk = {
          choices: [{
            delta: {
              content: `\n[OpenCodex Proxy Error] Request failed: ${err.message}\n`
            }
          }]
        };
        await streamState.writeChatDelta(async (payload) => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }, fakeChunk);
        await streamState.finish(async (payload) => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        });
      } catch {}
      try { res.end(); } catch {}
    }
  }

  private async nonStreamResponses(
    body: any,
    provider: ProviderConfig,
    requestedModel: string,
    apiKey: string,
    namespaceMap: Record<string, string>,
    res: http.ServerResponse,
    sessionId?: string
  ) {
    const r = await this.fetchWithWebBridge(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher,
      requestedModel: requestedModel
    });

    const rawText = await r.text();
    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: rawText.slice(0, 250) };
    }

    if (!r.ok) {
      throw new UpstreamError(r.status, rawText);
    }

    const responseBody = chatCompletionToResponse(data, requestedModel, namespaceMap);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseBody));

    const choice = (data.choices || [{}])[0];
    const message = choice.message;
    if (message) {
      message.id = responseBody.id;
      const sessionIdStr = sessionId ? String(sessionId) : "default";
      const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
      const updatedHistory = currentHistory.concat(message);
      this.customConversationHistory.set(sessionIdStr, updatedHistory);
      this.updateContextUsage(
        sessionIdStr,
        requestedModel,
        { ...body, messages: updatedHistory },
        this.getModelContextWindow(requestedModel),
        data.usage
      );
    }
  }

  // ══════════════════════════════════════════════
  //  Standard OpenAI Chat completions routing
  // ══════════════════════════════════════════════

  private async handleChat(body: string, res: http.ServerResponse) {
    let reqBody: any;
    try {
      reqBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    const model = reqBody.model || "";
    const catalog = this.getModelCatalog();
    let catalogEntry = catalog.models?.find((m: any) => m.slug === model);
    
    if (!catalogEntry && catalog.models && catalog.models.length > 0) {
      catalogEntry = catalog.models[0];
      console.log(`[OpenCodex Proxy] Unknown model requested in handleChat: ${model}. Falling back to default catalog model: ${catalogEntry.slug}`);
      reqBody.model = catalogEntry.slug;
    }

    const provider = this.findProvider(reqBody.model, catalogEntry);
    
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown model: ${model}` }));
      return;
    }

    const hasKeys = (provider.api_keys && provider.api_keys.length > 0) || provider.api_key;
    if (!hasKeys) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `API Key missing.` }));
      return;
    }

    const upstreamModel = (catalogEntry && catalogEntry.model) ? catalogEntry.model : model;
    const isStream = reqBody.stream ?? false;
    
    console.log(`[Chat] Routing ${model} → ${provider.name}/${upstreamModel} (stream=${isStream})`);

    const upstreamBody = {
      model: upstreamModel,
      messages: this.translateMessages(reqBody.messages || [], model),
      temperature: reqBody.temperature ?? 0.7,
      max_tokens: reqBody.max_output_tokens ?? 8192,
      stream: isStream
    };

    let maxRetries = provider.api_keys && provider.api_keys.length > 0 ? provider.api_keys.length : 1;
    let attempt = 0;
    let success = false;
    let lastError: any = null;

    while (attempt < maxRetries) {
      attempt++;
      const currentApiKey = this.getNextKeyForProvider(provider);
      try {
        if (isStream) {
          await this.streamChat(upstreamBody, provider, model, currentApiKey, res);
        } else {
          await this.nonStreamChat(upstreamBody, provider, model, currentApiKey, res);
        }
        success = true;
        break;
      } catch (err: any) {
        lastError = err;
        console.error(`[Chat] Attempt ${attempt} failed with error: ${err.message}`);
        if (res.headersSent) {
          break;
        }
        if (err instanceof UpstreamError && ![429, 401, 403, 502, 503, 504].includes(err.status)) {
          break;
        }
      }
    }

    if (!success && lastError) {
      console.error(`[Chat] All ${attempt} attempts failed. Final error: ${lastError.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: lastError.message }));
      }
    }
  }

  private translateMessages(messages: any[], model: string): any[] {
    const hasNativeVision = ["mimo-v2.5", "mimo-v2-omni"].includes(model);

    return messages.map((msg: any) => {
      if (msg.role === "tool") {
        return {
          role: "tool",
          tool_call_id: msg.tool_call_id || "",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
        };
      }

      if (msg.role === "assistant" && msg.tool_calls) {
        return {
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function?.name || tc.name || "",
              arguments: tc.function?.arguments
                ? typeof tc.function.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments)
                : "{}"
            }
          }))
        };
      }

      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map((part: any) => {
          if (part.type === "image_url" || part.type === "image") {
            if (hasNativeVision) {
              return { type: "image_url", image_url: { url: part.image_url?.url || part.source?.url || "" } };
            }
            return { type: "text", text: "[Visual Screenshot description omitted by OpenCodex]" };
          }
          return part;
        })
      };
    });
  }

  private async nonStreamChat(body: any, provider: ProviderConfig, model: string, apiKey: string, res: http.ServerResponse) {
    const r = await this.fetchWithWebBridge(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher,
      requestedModel: model
    });
    
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
    
    if (!r.ok) {
      throw new UpstreamError(r.status, text);
    }

    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private async streamChat(body: any, provider: ProviderConfig, model: string, apiKey: string, res: http.ServerResponse) {
    const r = await this.fetchWithWebBridge(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      dispatcher: fetchDispatcher,
      requestedModel: model
    });

    if (!r.ok) {
      const errorText = await r.text();
      throw new UpstreamError(r.status, errorText);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.writeHead(200);

    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let accumulatedText = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const rawChunk = trimmed.slice(6);
            res.write(`data: ${rawChunk}\n\n`);
            
            const parsed = JSON.parse(rawChunk);
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              accumulatedText += content;
              const msg = JSON.stringify({ type: "model_chunk", text: content });
              for (const wsClient of this.activeWsClients) {
                try { wsClient.send(msg); } catch {}
              }
            }
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Broadcast done signal to APP
    const doneMsg = JSON.stringify({ type: "model_done", text: accumulatedText });
    for (const wsClient of this.activeWsClients) {
      try { wsClient.send(doneMsg); } catch {}
    }

    res.write("data: [DONE]\n\n");
    res.end();
  }

  private transcribeAudioLocal(filePath: string, cb: (text: string | null) => void) {
    const pythonCmd = "python3";
    const transcribeHelper = join(tmpdir(), "ocb_transcribe.py");
    const args = [transcribeHelper, filePath];
    const uvxPath = join(homedir(), ".local", "bin", "uvx");
    
    const env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/Library/Python/3.9/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`
    };

    const child = existsSync(uvxPath)
      ? spawn(uvxPath, ["--with", "openai-whisper", "python3", transcribeHelper, filePath], { env })
      : spawn(pythonCmd, args, { env });

    let output = "";
    let errorOutput = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const text = output.trim();
        console.error(`[OpenCodex Local Whisper] Transcribed text: '${text}'`);
        cb(text);
      } else {
        console.error(`[OpenCodex Local Whisper Err] Exit code ${code}. Error: ${errorOutput}`);
        cb(null);
      }
    });
  }

  private async transcribeAudioAPI(filePath: string, settings: any): Promise<string> {
    const apiKey = settings.stt_api_key || "";
    const baseUrl = settings.stt_base_url || "https://api.openai.com/v1";
    const model = settings.stt_model || "whisper-1";

    const url = baseUrl.endsWith("/audio/transcriptions")
      ? baseUrl
      : `${baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

    const audioData = readFileSync(filePath);
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
    appendField("prompt", "简体中文");
    appendFile("file", "speech.wav", audioData);
    payload = Buffer.concat([payload, Buffer.from(`--${boundary}--\r\n`)]);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body: payload,
      dispatcher: fetchDispatcher
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`STT API returned status ${response.status}: ${errText}`);
    }

    const resJson: any = await response.json();
    return resJson.text || "";
  }

  private async synthesizeSpeechAPI(text: string, settings: any): Promise<Buffer> {
    const apiKey = settings.tts_api_key || "";
    const baseUrl = settings.tts_base_url || "https://api.openai.com/v1";
    const model = settings.tts_model || "tts-1";
    let voice = settings.tts_voice || "alloy";

    const validVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    if (!validVoices.includes(voice.toLowerCase())) {
      voice = "alloy";
    }

    const url = baseUrl.endsWith("/audio/speech")
      ? baseUrl
      : `${baseUrl.replace(/\/$/, "")}/audio/speech`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, input: text, voice }),
      dispatcher: fetchDispatcher
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`TTS API returned status ${response.status}: ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private synthesizeSpeechMiniMax(text: string, settings: any, cb: (data: Buffer | null) => void) {
    const apiKey = settings.tts_api_key || "";
    const voiceId = settings.tts_voice || "presenter_female";
    
    let modelName = settings.tts_model || "speech-2.8-hd";
    if (modelName === "tts-1" || modelName === "tts-1-hd" || !modelName.startsWith("speech-")) {
      modelName = "speech-2.8-hd";
    }

    const speed = (settings.tts_speed !== undefined) ? parseFloat(settings.tts_speed.toString()) : 
                  (settings.speed !== undefined) ? parseFloat(settings.speed.toString()) : 1.2;

    const wsUrl = "wss://api.minimaxi.com/ws/v1/t2a_v2";
    const wsClient = new WebSocket(wsUrl, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });

    let audioBuffer = Buffer.alloc(0);

    wsClient.on("open", () => {
      const startPayload = {
        event: "task_start",
        model: modelName,
        voice_setting: {
          voice_id: voiceId,
          speed: speed,
        },
        audio_setting: {
          sample_rate: 24000,
          format: "mp3", // OpenCodexBar expects mp3 format
          channel: 1,
        },
      };
      wsClient.send(JSON.stringify(startPayload));
    });

    wsClient.on("message", (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        if (msg.event === "task_started") {
          const continuePayload = {
            event: "task_continue",
            text: text
          };
          wsClient.send(JSON.stringify(continuePayload));
          return;
        }

        const audioHex = msg.data?.audio || "";
        if (audioHex) {
          const chunk = Buffer.from(audioHex, "hex");
          audioBuffer = Buffer.concat([audioBuffer, chunk]);
        }

        if (msg.is_final) {
          wsClient.send(JSON.stringify({ event: "task_finish" }));
          wsClient.close();
          cb(audioBuffer);
        }
      } catch (err: any) {
        console.error(`[OpenCodex MiniMax WS Msg Err] ${err.message}`);
        wsClient.close();
        cb(null);
      }
    });

    wsClient.on("error", (err) => {
      console.error(`[OpenCodex MiniMax WS Client Err] ${err.message}`);
      cb(null);
    });
  }

  private async synthesizeSpeechMiMo(text: string, settings: any, cb: (data: Buffer | null) => void) {
    const apiKey = settings.tts_api_key || "";
    const apiHost = settings.tts_base_url || "https://api.xiaomimimo.com";
    const voiceId = settings.tts_voice || "Chloe";
    
    // We can allow users to inject tone style via assistant personality prompt or default to a standard one
    const stylePrompt = settings.voice_system_prompt || "Natural, clear and friendly tone, standard pace.";

    try {
      const response = await fetch(`${apiHost}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "mimo-v2.5-tts",
          messages: [
            {
              role: "user",
              content: stylePrompt
            },
            {
              role: "assistant",
              content: text
            }
          ],
          audio: {
            format: "mp3", // OpenCodex-bar handles mp3 natively
            voice: voiceId
          },
          stream: false
        }),
        dispatcher: fetchDispatcher
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[MiMo TTS Err] Http Status ${response.status}: ${errText}`);
        return cb(null);
      }

      const resJson: any = await response.json();
      const audioBase64 = resJson.choices?.[0]?.message?.audio?.data;
      if (!audioBase64) {
        console.error(`[MiMo TTS Err] No audio data found in response: ${JSON.stringify(resJson)}`);
        return cb(null);
      }

      const audioBuffer = Buffer.from(audioBase64, "base64");
      cb(audioBuffer);
    } catch (err: any) {
      console.error(`[MiMo TTS Err] Exception: ${err.message}`);
      cb(null);
    }
  }

  private synthesizeSpeechEdge(text: string, settings: any, cb: (data: Buffer | null) => void) {
    let voice = settings.tts_voice || "zh-CN-XiaoxiaoNeural";
    if (!voice.includes("-") || voice.length < 5) {
      const hasChinese = /[\u4e00-\u9fa5]/.test(text);
      voice = hasChinese ? "zh-CN-XiaoxiaoNeural" : "en-US-AvaNeural";
    }
    const tempOutput = join(tmpdir(), "tts_edge_web_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".mp3");
    const uvxPath = join(homedir(), ".local", "bin", "uvx");
    const homebrewPath = "/opt/homebrew/bin/edge-tts";
    const localBinPath = "/usr/local/bin/edge-tts";
    
    const env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/Library/Python/3.9/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`
    };

    const speed = (settings.tts_speed !== undefined) ? parseFloat(settings.tts_speed.toString()) : 1.2;
    let edgeTtsCmd = "edge-tts";
    let args = ["--voice", voice, "--text", text, "--write-media", tempOutput];
    if (speed !== 1.0) {
      const pct = Math.round((speed - 1.0) * 100);
      const rateStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
      args.push("--rate", rateStr);
    }
    
    if (existsSync(homebrewPath)) {
      edgeTtsCmd = homebrewPath;
    } else if (existsSync(localBinPath)) {
      edgeTtsCmd = localBinPath;
    } else if (existsSync(uvxPath)) {
      edgeTtsCmd = uvxPath;
      args = ["edge-tts", ...args];
    }
    
    const child = spawn(edgeTtsCmd, args, { env });

    let errOutput = "";
    child.stderr.on("data", (chunk) => {
      errOutput += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0 && existsSync(tempOutput)) {
        try {
          const data = readFileSync(tempOutput);
          cb(data);
        } catch (err: any) {
          console.error(`[OpenCodex Voice API EdgeTTS Err] Failed to read output file: ${err.message}`);
          cb(null);
        } finally {
          try {
            unlinkSync(tempOutput);
          } catch {}
        }
      } else {
        console.error(`[OpenCodex Voice API EdgeTTS Err] Exit code ${code}. Error: ${errOutput}`);
        cb(null);
        try {
          unlinkSync(tempOutput);
        } catch {}
      }
    });
  }

  private async synthesizeSpeechDoubao(text: string, settings: any): Promise<Buffer> {
    const apiKey = settings.tts_api_key || "";
    let baseUrl = settings.tts_base_url || "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
    if (baseUrl.includes("api.openai.com")) {
      baseUrl = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
    }
    const voice = settings.tts_voice || "zh_female_xiaohe_uranus_bigtts";
    const appid = settings.tts_appid || "";
    const resourceId = settings.tts_resource || settings.tts_resource_id || "seed-tts-2.0";

    const crypto = await import("node:crypto");
    const reqid = crypto.randomUUID();

    let headers: Record<string, string> = {};
    let bodyPayload: any = {};

    // If AppID is provided, we use the legacy V1/V2 AppID + Access Key authentication format.
    // Otherwise, we use the new V3 API Key authentication format.
    if (appid) {
      headers = {
        "Content-Type": "application/json",
        "X-Api-App-Key": appid,
        "X-Api-Access-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": reqid
      };

      bodyPayload = {
        app: {
          appid: appid,
          token: apiKey,
          cluster: resourceId.includes("icl") ? "volcano_icl" : "volcano_tts"
        },
        user: {
          uid: "opencodex_user"
        },
        audio: {
          voice_type: voice,
          encoding: "mp3"
        },
        request: {
          reqid: reqid,
          text: text,
          text_type: "plain",
          operation: "submit"
        }
      };
    } else {
      headers = {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": reqid
      };

      let modelVal = settings.tts_model || "seed-tts-2.0-expressive";
      if (modelVal === "tts-1" || modelVal === "seed-tts-2.0") {
        modelVal = "seed-tts-2.0-expressive";
      }

      bodyPayload = {
        req_params: {
          text: text,
          model: modelVal,
          speaker: voice,
          encoding: "mp3"
        }
      };
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
      dispatcher: fetchDispatcher
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Doubao TTS API returned status ${response.status}: ${errText}`);
    }

    const resText = await response.text();
    const lines = resText.split("\n");
    let audioBuffer = Buffer.alloc(0);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        if (json.data) {
          const chunk = Buffer.from(json.data, "base64");
          audioBuffer = Buffer.concat([audioBuffer, chunk]);
        }
      } catch (e) {
        // ignore
      }
    }

    if (audioBuffer.length === 0) {
      throw new Error(`Doubao TTS synthesis returned no audio. Response was: ${resText.slice(0, 300)}`);
    }

    return audioBuffer;
  }

  private activeWsClients = new Set<WebSocket>();
  private desktopWsClients = new Set<WebSocket>();
  private activeConnectionsBySession = new Map<string, {
    clientWs: WebSocket;
    targetWs: WebSocket | null;
    headers: http.IncomingHttpHeaders;
    lastMsg: any;
  }>();
  private lastActiveConnection: {
    clientWs: WebSocket;
    targetWs: WebSocket | null;
    headers: http.IncomingHttpHeaders;
    lastMsg: any;
  } | null = null;

  public simulateMessagePushToDesktop(sessionId: string, prompt: string, reply: string) {
    console.error(`[OpenCodex Sync] Simulating Responses protocol push to Desktop Webview for session: ${sessionId}`);
    
    // Format conforming to standard responses protocol events
    const respId = `resp_${Date.now()}`;
    const userMsgId = `msg_user_${Date.now()}`;
    const assistantMsgId = `msg_ast_${Date.now()}`;

    const payloads = [
      // 1. Response created
      {
        type: "response.created",
        response: {
          id: respId,
          status: "in_progress",
          model: "opencodex-voice-bridge",
          output: []
        }
      },
      // 2. User prompt message item added
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: userMsgId,
          type: "message",
          status: "completed",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      },
      // 3. User message done
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: userMsgId,
          type: "message",
          status: "completed",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      },
      // 4. Assistant reply message item added
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: assistantMsgId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: []
        }
      },
      // 5. Assistant part added
      {
        type: "response.content_part.added",
        item_id: assistantMsgId,
        output_index: 1,
        content_index: 0,
        part: { type: "output_text", text: reply, annotations: [] }
      },
      // 6. Assistant text done
      {
        type: "response.output_text.done",
        item_id: assistantMsgId,
        output_index: 1,
        content_index: 0,
        text: reply
      },
      // 7. Assistant output item done
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: assistantMsgId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: reply, annotations: [] }]
        }
      },
      // 8. Response completed
      {
        type: "response.completed",
        response: {
          id: respId,
          status: "completed",
          model: "opencodex-voice-bridge",
          output: [
            {
              id: assistantMsgId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: reply, annotations: [] }]
            }
          ]
        }
      }
    ];

    try {
      const allWs = new Set([...this.activeWsClients, ...this.desktopWsClients]);
      for (const ws of allWs) {
        if (ws.readyState === 1 /* OPEN */) {
          for (const payload of payloads) {
            ws.send(JSON.stringify(payload));
          }
        }
      }
    } catch (err: any) {
      console.error(`[OpenCodex Sync Err] Failed to send simulated responses: ${err.message}`);
    }
  }

  public broadcastSession(sessionId: string) {
    const payload = JSON.stringify({
      type: "activate_session",
      session_id: sessionId
    });
    const allWs = new Set([...this.activeWsClients, ...this.desktopWsClients]);
    for (const ws of allWs) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  public handleWebSocketConnection(ws: WebSocket) {
    this.activeWsClients.add(ws);
    let audioBuffer = Buffer.alloc(0);
    let isListening = false;
    let lastProcessedLength = 0;
    let lastVADCheckedLength = 0;
    let isVADProcessing = false;
    let chunkInterval: NodeJS.Timeout | null = null;
    let isProcessingChunk = false;
    let hasSentFinal = false;
    let lastTranscribedText = "";
    let speechDetected = false;

    // Helper to clear timer
    const clearChunkInterval = () => {
      if (chunkInterval) {
        clearInterval(chunkInterval);
        chunkInterval = null;
      }
    };

    const finishSpeech = async (previewText: string, reason: string) => {
      if (hasSentFinal) return;
      hasSentFinal = true;
      isListening = false;
      clearChunkInterval();

      console.error(`[Voice Endpoint] ${reason}. Preview: "${previewText}"`);
      ws.send(JSON.stringify({
        type: "stop_recording",
        text: previewText
      }));
      await this.processWebSocketSTT(ws, audioBuffer, previewText);
    };

    // Semantic checks supplement physical VAD; they never treat repeated partial
    // transcripts as silence because API response timing is not speech timing.
    const checkSemanticVAD = async (text: string) => {
      if (hasSentFinal) return;
      const trimmed = text.trim();
      if (trimmed.length < 2) return;

      // Semantic AEC: Check if this is an echo of the system's TTS
      if (this.currentSystemUtterance && this.currentSystemUtterance.length > 0) {
        if (trimmed.length <= 2 && trimmed.match(/^[啊嗯哦哈呀啦呢罢了的得地吗？。！]+$/)) {
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
          audioBuffer = Buffer.alloc(0); // clear buffer to drop the echo
          lastVADCheckedLength = 0;
          return;
        }
        
        console.error(`[Semantic AEC] Interruption detected! User said: "${trimmed}" while system was saying: "${this.currentSystemUtterance}"`);
        this.currentSystemUtterance = "";
        await finishSpeech(trimmed, "user interrupted TTS");
        return;
      }

      lastTranscribedText = trimmed;
    };

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        if (isListening) {
          const buf = data as Buffer;
          audioBuffer = Buffer.concat([audioBuffer, buf]);

          // Submit only new PCM bytes. The previous implementation resent an
          // overlapping window, which inflated silence timings inside the daemon.
          const checkSize = 10240;
          if (!isVADProcessing && audioBuffer.length >= checkSize && (audioBuffer.length - lastVADCheckedLength) >= 5120) {
            const endIdx = audioBuffer.length;
            const newChunk = audioBuffer.slice(lastVADCheckedLength, endIdx);
            lastVADCheckedLength = endIdx;
            isVADProcessing = true;
            const b64Data = newChunk.toString("base64");
            
            this.sendVADRequest({ action: "chunk", data: b64Data }).then(async (vadResult) => {
              if (vadResult.error) {
                console.error(`[Silero VAD Daemon Error] ${vadResult.error}`);
                return;
              }
              if (vadResult.has_speech && vadResult.speech_duration >= 0.30) {
                speechDetected = true;
                
                let configuredSilence = 1.5;
                const p = join(this.configDir, "voice_settings.json");
                if (existsSync(p)) {
                  try {
                    const settings = JSON.parse(readFileSync(p, "utf-8"));
                    if (settings.vad_duration !== undefined) {
                      configuredSilence = parseFloat(settings.vad_duration);
                    }
                  } catch {}
                }

                const profile = getVoiceEndpointProfile(lastTranscribedText, configuredSilence);
                const hasUsableTranscript = lastTranscribedText.replace(/[^\p{L}\p{N}]/gu, "").length >= 2;
                const reachedSemanticSilence = hasUsableTranscript && vadResult.silence_at_end >= profile.silenceSeconds;
                const reachedHardSilence = hasUsableTranscript && vadResult.silence_at_end >= profile.hardSilenceSeconds;

                if (reachedSemanticSilence || reachedHardSilence) {
                  await finishSpeech(
                    lastTranscribedText,
                    `${profile.kind} utterance, ${vadResult.silence_at_end.toFixed(2)}s silence`
                  );
                }
              }
            }).catch(err => {
              console.error(`[Silero VAD Daemon Promise Err] ${err.message}`);
            }).finally(() => {
              isVADProcessing = false;
            });
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
          isVADProcessing = false;
          this.currentSystemUtterance = "";
          lastProcessedLength = 0;
          lastTranscribedText = "";
          isListening = true;
          isProcessingChunk = false;
          hasSentFinal = false;
          speechDetected = false;
          console.error("[WebSocket STT] Listening started...");

          // Periodically check/transcribe current buffer
          clearChunkInterval();
          chunkInterval = setInterval(async () => {
            if (!isListening || isProcessingChunk || hasSentFinal || !speechDetected) return;
            // Wait for at least 0.5 second of audio to start slicing
            if (audioBuffer.length < 16000) return; 

            // Only transcribe if we have new data
            if (audioBuffer.length > lastProcessedLength + 8000) {
              isProcessingChunk = true;
              try {
                const currentBuffer = audioBuffer; // Capture snapshot
                lastProcessedLength = currentBuffer.length;
                
                const p = join(this.configDir, "voice_settings.json");
                let settings: any = {
                  stt_engine: "local-whisper",
                  stt_api_key: "",
                  stt_base_url: "https://api.openai.com/v1",
                  stt_model: "whisper-1"
                };
                if (existsSync(p)) {
                  try { settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) }; } catch {}
                }

                const wavBuffer = pcmToWav(currentBuffer, 16000, 1, 16);
                const tmpWavPath = join(tmpdir(), `ws_chunk_${Date.now()}.wav`);
                writeFileSync(tmpWavPath, wavBuffer);

                let text = "";
                const isAPI = settings.stt_engine === "openai-compatible" || settings.stt_engine === "groq" || (settings.stt_api_key && settings.stt_api_key.startsWith("gsk_")) || settings.stt_base_url.includes("groq");
                if (isAPI) {
                  text = await this.transcribeAudioAPI(tmpWavPath, settings);
                } else {
                  text = await new Promise<string>((resolve) => {
                    this.transcribeAudioLocal(tmpWavPath, (resText) => {
                      resolve(resText || "");
                    });
                  });
                }

                try { unlinkSync(tmpWavPath); } catch {}

                if (text && text.trim().length > 0) {
                  console.error(`[WebSocket STT Chunk] Current transcript: "${text}"`);
                  // Notify visualizer or dashboard about progress
                  ws.send(JSON.stringify({
                    type: "transcription_partial",
                    text: text
                  }));

                  // Check if this text meets the finality criteria
                  await checkSemanticVAD(text);
                }
              } catch (err: any) {
                console.error(`[WebSocket STT Chunk Error] ${err.message}`);
              } finally {
                isProcessingChunk = false;
              }
            }
          }, 400); // Check every 400ms

        } else if (msg.type === "stop_stt") {
          isListening = false;
          clearChunkInterval();
          if (!hasSentFinal) {
            console.error(`[WebSocket STT] Listening stopped. Final processing. Audio size: ${audioBuffer.length} bytes`);
            await this.processWebSocketSTT(ws, audioBuffer, lastTranscribedText);
            hasSentFinal = true;
          }
        } else if (msg.type === "active_session_changed") {
          const sid = msg.session_id;
          if (sid) {
            const p = join(this.configDir, "voice_settings.json");
            let settings: any = {};
            if (existsSync(p)) {
              try { settings = JSON.parse(readFileSync(p, "utf-8")); } catch {}
            }
            settings.active_session_id = sid;
            writeFileSync(p, JSON.stringify(settings, null, 2), "utf-8");
            console.error(`[WebSocket] Client updated active_session_id to: ${sid}`);
          }
        }
      } catch (err: any) {
        console.error(`[WebSocket message err] ${err.message}`);
      }
    });

    ws.on("close", () => {
      this.activeWsClients.delete(ws);
      isListening = false;
      clearChunkInterval();
      audioBuffer = Buffer.alloc(0);
    });
  }

  private async processWebSocketSTT(ws: WebSocket, pcmBuffer: Buffer, fallbackText: string = "") {
    try {
      const p = join(this.configDir, "voice_settings.json");
      let settings: any = {
        stt_engine: "local-whisper",
        stt_api_key: "",
        stt_base_url: "https://api.openai.com/v1",
        stt_model: "whisper-1"
      };
      if (existsSync(p)) {
        try {
          settings = { ...settings, ...JSON.parse(readFileSync(p, "utf-8")) };
        } catch {}
      }

      const wavBuffer = pcmToWav(pcmBuffer, 16000, 1, 16);
      const tmpWavPath = join(tmpdir(), `ws_stt_${Date.now()}.wav`);
      writeFileSync(tmpWavPath, wavBuffer);

      let text = "";
      const isAPI = settings.stt_engine === "openai-compatible" || settings.stt_engine === "groq" || (settings.stt_api_key && settings.stt_api_key.startsWith("gsk_")) || settings.stt_base_url.includes("groq");

      if (isAPI) {
        text = await this.transcribeAudioAPI(tmpWavPath, settings);
      } else {
        text = await new Promise<string>((resolve) => {
          this.transcribeAudioLocal(tmpWavPath, (resText) => {
            resolve(resText || "");
          });
        });
      }

      try {
        unlinkSync(tmpWavPath);
      } catch {}

      // Prevent Whisper hallucinations (e.g. "......", dropping words) on abrupt cutoffs
      const cleanText = text.replace(/^[。！？\.\s]+|[。！？\.\s]+$/g, '');
      if (cleanText.length === 0 || text.includes('......') || text.includes('。。。') || (text.length < fallbackText.length - 3 && fallbackText.length > 0)) {
        console.error(`[WebSocket STT] Hallucination/Drop detected ("${text}"), using fallback: "${fallbackText}"`);
        text = fallbackText;
      }

      console.error(`[WebSocket STT] Final text: "${text}"`);
      ws.send(JSON.stringify({
        type: "transcription_final",
        text: text
      }));
    } catch (err: any) {
      console.error(`[WebSocket STT err] ${err.message}`);
      ws.send(JSON.stringify({
        type: "transcription_final",
        text: ""
      }));
    }
  }

  private async synthesizeSpeechKokoro(text: string, settings: any, cb: (data: Buffer | null) => void) {
    try {
      const response = await fetch("http://127.0.0.1:8766/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: text,
          voice: settings.tts_voice || "zf_xiaoxiao",
          speed: 1.0
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[OpenCodex Voice API Kokoro Err] Server returned status ${response.status}: ${errText}`);
        cb(null);
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      cb(Buffer.from(arrayBuffer));
    } catch (err: any) {
      console.error(`[OpenCodex Voice API Kokoro Err] Failed to fetch Kokoro server: ${err.message}`);
      cb(null);
    }
  }

  private async handleLocalResponsesWebSocketInline(ws: WebSocket, reqBody: any, connInfo: any) {
    const clientHeaders = connInfo.headers;
    const sidHeader = clientHeaders["x-session-id"] || clientHeaders["session-id"] || "";
    const sessionId = reqBody.client_metadata?.session_id || connInfo.activeSessionId || (Array.isArray(sidHeader) ? sidHeader[0] : sidHeader);
    const sessionIdStr = sessionId ? String(sessionId) : "default";

    const activeController = this.activeAbortControllers.get(sessionIdStr);
    if (activeController) {
      console.log(`[OpenCodex WS Proxy] Aborting active stale request for session ${sessionIdStr} before queueing new request`);
      activeController.abort();
    }

    const previous = this.customSessionQueues.get(ws) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.handleLocalResponsesWebSocketInlineQueued(ws, reqBody, connInfo, sessionId, sessionIdStr));
    this.customSessionQueues.set(ws, current);
    try {
      await current;
    } finally {
      if (this.customSessionQueues.get(ws) === current) {
        this.customSessionQueues.delete(ws);
      }
    }
  }

  private async handleLocalResponsesWebSocketInlineQueued(ws: WebSocket, reqBody: any, connInfo: any, sessionId: any, sessionIdStr: string) {
    const turnMetadataStr = reqBody.client_metadata?.["x-codex-turn-metadata"];
    let isPrewarm = false;
    if (turnMetadataStr) {
      try {
        const parsed = JSON.parse(turnMetadataStr);
        if (parsed.request_kind === "prewarm") {
          isPrewarm = true;
        }
      } catch {}
    }
    if (!isPrewarm && (!reqBody.input || reqBody.input.length === 0)) {
      isPrewarm = true;
    }

    if (!isPrewarm) {
      const lastWs = this.lastWsMap.get(sessionIdStr);
      if (!lastWs || lastWs !== ws) {
        this.sessionSequenceNumberMap.set(sessionIdStr, 1);
        this.lastCompletedSequenceNumberMap.set(sessionIdStr, 0);
        console.log(`[OpenCodex WS Proxy] New custom WS connection detected for session ${sessionIdStr}. Resetting sequence number to 1.`);
      }
      this.lastWsMap.set(sessionIdStr, ws);
    }

    const clientHeaders = connInfo.headers;
    const startTime = Date.now();
    let onWsClose: (() => void) | null = null;
    const requestedModel = reqBody.model || "";
    try {
      if (REQUEST_DEBUG_ENABLED) {
        writeFileSync(join(this.configDir, "debug_req.json"), JSON.stringify(reqBody, null, 2), { encoding: "utf-8", mode: 0o600 });
      }
    } catch (e) {}
    const catalog = this.getModelCatalog();
    let catalogEntry = catalog.models?.find((m: any) => m.slug === requestedModel);
    
    if (!catalogEntry && catalog.models && catalog.models.length > 0) {
      catalogEntry = catalog.models[0];
      reqBody.model = catalogEntry.slug;
    }

    if (!catalogEntry?.backend_provider) {
      ws.send(JSON.stringify({ error: { message: `Native model requested locally: ${requestedModel}` } }));
      return;
    }

    const mappedModelName = (catalogEntry && catalogEntry.backend_model) ? catalogEntry.backend_model : ((catalogEntry && catalogEntry.model) ? catalogEntry.model : requestedModel);
    const provider = this.findProvider(mappedModelName, catalogEntry);
    if (!provider) {
      ws.send(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}` } }));
      return;
    }

    const apiKey = this.resolveKey(provider.api_key);
    if (!apiKey) {
      ws.send(JSON.stringify({ error: { message: `API Key is missing. Configure keys via http://localhost:8765/dashboard` } }));
      return;
    }

    const isStream = reqBody.stream ?? true;

    const callVisionBridge = catalogEntry ? !!catalogEntry.vision_bridge_enabled : false;
    const providerReqBody = { ...reqBody, tools: ensureComputerUseResponsesTools(reqBody.tools) };
    const processedReqBody = await processVisionBridge(providerReqBody, callVisionBridge ? this.config : undefined);

    // isPrewarm is already computed at the top of the function

    if (isPrewarm) {
      console.log(`[OpenCodex WS Proxy] Handling prewarm request locally and instantly.`);
      const namespaceMap = extractNamespaceMap(processedReqBody.tools);
      const responseMetadata = {
        session_id: reqBody.client_metadata?.session_id || sessionIdStr,
        thread_id: reqBody.client_metadata?.thread_id,
        turn_id: reqBody.client_metadata?.turn_id,
        "x-codex-turn-metadata": reqBody.client_metadata?.["x-codex-turn-metadata"],
      };
      const now = Math.floor(Date.now() / 1000);
      const prewarmResponseId = `resp_prewarm_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

      if (isStream) {
        ws.send(JSON.stringify({
          type: "codex.rate_limits",
          plan_type: "plus",
          rate_limits: {
            allowed: true,
            limit_reached: false,
            primary: {
              used_percent: 0,
              window_minutes: 300,
              reset_after_seconds: 3600,
              reset_at: now + 3600,
              limit_reached: false
            }
          }
        }));
        ws.send(JSON.stringify({
          type: "codex.response.metadata",
          headers: {
            "x-codex-safety-buffering-enabled": "true",
            "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"
          }
        }));
        ws.send(JSON.stringify({
          type: "response.created",
          sequence_number: 1,
          response: {
            id: prewarmResponseId,
            object: "response",
            created_at: now,
            status: "in_progress",
            model: requestedModel,
            output: [],
            metadata: responseMetadata
          }
        }));
        ws.send(JSON.stringify({
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: prewarmResponseId,
            object: "response",
            created_at: now,
            completed_at: now,
            status: "completed",
            model: requestedModel,
            output: [],
            metadata: responseMetadata
          }
        }));
        ws.send(JSON.stringify({
          type: "response.done",
          sequence_number: 3,
          response: {
            id: prewarmResponseId,
            object: "response",
            created_at: now,
            completed_at: now,
            status: "completed",
            model: requestedModel,
            output: [],
            metadata: responseMetadata
          }
        }));
      } else {
        const responseBody = chatCompletionToResponse({
          choices: [{ message: { role: "assistant", content: "" } }]
        }, requestedModel, namespaceMap);
        ws.send(JSON.stringify(responseBody));
      }
      return;
    }

    const controller = new AbortController();
    this.activeAbortControllers.set(sessionIdStr, controller);
    const signal = controller.signal;
    onWsClose = () => {
      console.log(`[OpenCodex WS Proxy] Client WebSocket closed. Aborting upstream request.`);
      controller.abort();
    };
    ws.on("close", onWsClose);

    const isResponsesApi = provider.base_url.includes("/responses");
    if (isResponsesApi) {
      console.log(`[OpenCodex WS Proxy] Upstream supports Responses API directly. Forwarding to: ${provider.base_url}`);
      try {
        // Send initial metadata similar to official responses
        ws.send(JSON.stringify({
          type: "codex.rate_limits",
          plan_type: "plus",
          rate_limits: {
            allowed: true,
            limit_reached: false,
            primary: {
              used_percent: 0,
              window_minutes: 300,
              reset_after_seconds: 3600,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
              limit_reached: false
            }
          }
        }));
        ws.send(JSON.stringify({
          type: "codex.response.metadata",
          headers: {
            "x-codex-safety-buffering-enabled": "true",
            "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"
          }
        }));

        const response = await fetch(provider.base_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Accept": "text/event-stream"
          },
          body: JSON.stringify(processedReqBody),
          dispatcher: fetchDispatcher,
          signal
        });

        console.log(`[OpenCodex WS Proxy] Upstream Responses response status: ${response.status}`);
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[OpenCodex WS Proxy] Upstream Responses error: ${errorText}`);
          ws.send(JSON.stringify({ error: { message: errorText } }));
          return;
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let seqOffset: number | null = null;
        try {
          while (true) {
            if (ws.readyState !== WebSocket.OPEN) {
              console.log(`[OpenCodex WS Proxy] Client WebSocket closed during streaming. Aborting Responses request.`);
              controller.abort();
              break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === "data: [DONE]") continue;
              if (!trimmed.startsWith("data: ")) continue;
              try {
                const chunk = JSON.parse(trimmed.slice(6));
                if (chunk && chunk.sequence_number !== undefined) {
                  const upstreamSeq = Number(chunk.sequence_number);
                  if (seqOffset === null) {
                    const expectedSeq = this.sessionSequenceNumberMap.get(sessionIdStr) || 1;
                    seqOffset = expectedSeq - upstreamSeq;
                    console.log(`[OpenCodex WS Proxy] Responses API sequence offset calculated: ${seqOffset} (expected ${expectedSeq}, upstream ${upstreamSeq})`);
                  }
                  const rewrittenSeq = upstreamSeq + seqOffset;
                  chunk.sequence_number = rewrittenSeq;
                  
                  // Update sequence number maps with rewritten values
                  this.sessionSequenceNumberMap.set(sessionIdStr, rewrittenSeq + 1);
                  if (chunk.type === "response.done" || chunk.type === "response.completed" || chunk.type === "response.output_text.done") {
                    this.lastCompletedSequenceNumberMap.set(sessionIdStr, rewrittenSeq);
                  }
                }
                ws.send(JSON.stringify(chunk));
              } catch (parseErr: any) {
                console.error(`[OpenCodex WS Proxy] Error parsing Responses chunk: ${parseErr.message}`);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err: any) {
        if (err.name === "AbortError" || err.message?.includes("aborted")) {
          console.log(`[OpenCodex WS Proxy] Upstream Responses request aborted successfully.`);
          return;
        }
        console.error(`[OpenCodex WS Proxy Responses Handler Error]`, err);
        try {
          ws.send(JSON.stringify({ error: { message: err.message, stack: err.stack } }));
        } catch (wsErr) {}
      } finally {
        ws.off("close", onWsClose);
        this.activeAbortControllers.delete(sessionIdStr);
      }
      return;
    }





    const chatBody = process.platform === "win32"
      ? await responsesToChatWin(processedReqBody, mappedModelName, sessionId)
      : await responsesToChat(processedReqBody, mappedModelName, sessionId);
    
    // Maintain conversation history locally in the proxy as the client does not send full history in input.
    this.customModelSessions.add(sessionIdStr);

    const namespaceMap = extractNamespaceMap(processedReqBody.tools);
    const responseMetadata = {
      session_id: reqBody.client_metadata?.session_id || sessionIdStr,
      thread_id: reqBody.client_metadata?.thread_id,
      turn_id: reqBody.client_metadata?.turn_id,
      "x-codex-turn-metadata": reqBody.client_metadata?.["x-codex-turn-metadata"],
    };
    const streamState = isStream ? new ResponsesStreamState(
      requestedModel,
      namespaceMap,
      sessionId,
      (textChunk) => {
        const msg = JSON.stringify({ type: "model_chunk", text: textChunk });
        for (const wsClient of this.activeWsClients) {
          try { wsClient.send(msg); } catch {}
        }
      },
      (fullText) => {
        const msg = JSON.stringify({ type: "model_done", text: fullText });
        for (const wsClient of this.activeWsClients) {
          try { wsClient.send(msg); } catch {}
        }
      },
      responseMetadata,
      requestedModel.includes("mini") || requestedModel.includes("title") || !!reqBody.background,
      {
        get: () => this.sessionSequenceNumberMap.get(sessionIdStr) || 1,
        set: (seq: number) => this.sessionSequenceNumberMap.set(sessionIdStr, seq)
      }
    ) : null;

    const broadcastToClients = (payload: any) => {
      const payloadStr = JSON.stringify(payload);
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payloadStr); } catch {}
      }
      for (const otherWs of this.desktopWsClients) {
        if (otherWs !== ws && (otherWs as any).sessionId === sessionIdStr && otherWs.readyState === WebSocket.OPEN) {
          try { otherWs.send(payloadStr); } catch {}
        }
      }
    };

    if (streamState) {
      broadcastToClients({
        type: "codex.rate_limits",
        plan_type: "plus",
        rate_limits: {
          allowed: true,
          limit_reached: false,
          primary: {
            used_percent: 0,
            window_minutes: 300,
            reset_after_seconds: 3600,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
            limit_reached: false
          }
        }
      });
      broadcastToClients({
        type: "codex.response.metadata",
        headers: {
          "x-codex-safety-buffering-enabled": "true",
          "x-codex-safety-buffering-faster-model": "gpt-5.6-luna"
        }
      });
      await streamState.start(async (payload) => {
        broadcastToClients(payload);
      });
    }

    const prevResponseId = processedReqBody.previous_response_id;
    // Prefer memory cache to avoid async disk I/O race conditions, reload from rollout if empty or desynced
    let existingHistory = this.customConversationHistory.get(sessionIdStr) || [];
    const incomingMessages = chatBody.messages.filter((m: any) => m.role !== "system");

    if (existingHistory.length > 0 && incomingMessages.length > 1) {
      const prevIncoming = incomingMessages[incomingMessages.length - 2];
      const found = existingHistory.some((m: any) => isSameMessage(m, prevIncoming));
      if (!found) {
        console.log(`[OpenCodex WS Proxy] Cache desync detected for session ${sessionIdStr}. Reloading from rollout...`);
        existingHistory = loadHistoryFromRollout(sessionIdStr);
        this.sessionContextMap.delete(sessionIdStr);
      }
    } else if (existingHistory.length === 0) {
      existingHistory = loadHistoryFromRollout(sessionIdStr);
      this.sessionContextMap.delete(sessionIdStr);
      if (existingHistory.length === 0) {
        console.log(`[OpenCodex WS Proxy] Stale history empty. Waiting 350ms for client to write rollout file...`);
        await new Promise(resolve => setTimeout(resolve, 350));
        existingHistory = loadHistoryFromRollout(sessionIdStr);
      }
    }

    if (existingHistory.length === 0) {
      this.customConversationHistory.set(sessionIdStr, chatBody.messages);
    } else {
      let alignedHistory = existingHistory;
      if (prevResponseId) {
        const index = existingHistory.findIndex((m: any) => m.role === "assistant" && (m.id === prevResponseId || m.response_id === prevResponseId));
        if (index !== -1) {
          alignedHistory = existingHistory.slice(0, index + 1);
        }
      }
      const incomingMessages = chatBody.messages.filter((m: any) => m.role !== "system");
      const updatedHistory = mergeHistory(alignedHistory, incomingMessages);
      this.customConversationHistory.set(sessionIdStr, updatedHistory);
    }
    // Keep the complete tool-call exchange in the upstream history so a
    // custom model can continue after Computer Use instead of losing state.
    chatBody.messages = normalizeDeepSeekToolHistory(
      alignToolMessages(this.customConversationHistory.get(sessionIdStr) || []),
      mappedModelName
    );


    // Sanitize empty/null content fields for MiniMax model
    if (mappedModelName.toLowerCase().includes("minimax")) {
      for (const m of chatBody.messages) {
        if (m.content === null || m.content === undefined || m.content === "") {
          m.content = " ";
        }
      }
      const hasUser = chatBody.messages.some((m: any) => m.role === "user");
      if (!hasUser) {
        chatBody.messages.push({ role: "user", content: " " });
      }
    }

    const contextWindow = catalogEntry ? (catalogEntry.context_window || 200000) : 200000;
    const safetyLimit = Math.floor(contextWindow * 0.95);
    chatBody.messages = pruneMessagesToLimit(chatBody.messages, safetyLimit, requestedModel, chatBody.tools);
    this.customConversationHistory.set(sessionIdStr, chatBody.messages);
    this.currentActiveSessionId = sessionIdStr;

    this.updateContextUsage(sessionIdStr, requestedModel, chatBody, contextWindow);

    try {
      console.log(`[OpenCodex WS Proxy] Sending request to upstream: ${provider.base_url}/chat/completions`, JSON.stringify(chatBody.messages));
      const response = await this.fetchWithWebBridge(`${provider.base_url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(chatBody),
        dispatcher: fetchDispatcher,
        signal,
        requestedModel: requestedModel
      });

      console.log(`[OpenCodex WS Proxy] Upstream response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[OpenCodex WS Proxy] Upstream error response: ${errorText}`);
        if (streamState) {
          const fakeChunk = {
            choices: [{
              delta: {
                content: `\n[OpenCodex Proxy Error] Failed to fetch from upstream: ${response.status} - ${errorText}\n`
              }
            }]
          };
          await streamState.writeChatDelta(async (payload) => {
            broadcastToClients(payload);
          }, fakeChunk);
          await streamState.finish(async (payload) => {
            broadcastToClients(payload);
          });
        } else {
          broadcastToClients({ error: { message: errorText } });
        }
        return;
      }

      if (isStream) {
        const activeStreamState = streamState!;
        console.log(`[OpenCodex WS Proxy] Starting stream response...`);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let chunkCount = 0;
        let finalUsage: any = null;

        try {
          while (true) {
            if (ws.readyState !== WebSocket.OPEN) {
              console.log(`[OpenCodex WS Proxy] Client WebSocket closed during streaming. Aborting upstream request.`);
              controller.abort();
              break;
            }
            const { done, value } = await reader.read();
            if (done) {
              console.log(`[OpenCodex WS Proxy] Upstream stream reader finished. Total chunks: ${chunkCount}`);
              break;
            }
            chunkCount++;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === "data: [DONE]") continue;
              if (!trimmed.startsWith("data: ")) continue;
              try {
                const chunk = JSON.parse(trimmed.slice(6));
                if (chunk.usage) {
                  finalUsage = chunk.usage;
                }
                await activeStreamState.writeChatDelta(async (payload) => {
                  broadcastToClients(payload);
                }, chunk);
              } catch (parseErr: any) {
                console.error(`[OpenCodex WS Proxy] Error parsing or writing delta: ${parseErr.message}`);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        const elapsed = Date.now() - startTime;
        if (elapsed < 1500) {
          console.log(`[OpenCodex WS Proxy] Stream finished too fast (${elapsed}ms). Delaying completion by ${1500 - elapsed}ms to align client turn state.`);
          await new Promise(resolve => setTimeout(resolve, 1500 - elapsed));
        }

        const assistantMsg = activeStreamState.getAssistantMessage();
        let totalTokens = 0;
        let inputTokens = 0;
        let outputTokens = 0;

        if (assistantMsg) {
          assistantMsg.id = activeStreamState.responseId;
          const sessionIdStr = sessionId ? String(sessionId) : "default";
          const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
          const updatedHistory = currentHistory.concat(assistantMsg);
          this.customConversationHistory.set(sessionIdStr, updatedHistory);
          const snapshot = this.updateContextUsage(
            sessionIdStr,
            requestedModel,
            { ...chatBody, messages: updatedHistory },
            contextWindow,
            finalUsage
          );
          totalTokens = snapshot.tokens;
          inputTokens = snapshot.provider_prompt_tokens ?? estimateTokensForRequest(chatBody, requestedModel).tokens;
          outputTokens = snapshot.provider_completion_tokens ?? estimateTokensForRequest({ messages: [assistantMsg] }, requestedModel).tokens;
        }

        console.log(`[OpenCodex WS Proxy] Finalizing stream...`);
        await activeStreamState.finish(async (payload) => {
          broadcastToClients(payload);
        }, assistantMsg ? { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens } : undefined);
        const lastCompletedSeq = this.sessionSequenceNumberMap.get(sessionIdStr) || 1;
        this.lastCompletedSequenceNumberMap.set(sessionIdStr, lastCompletedSeq - 1);
        console.log(`[OpenCodex WS Proxy] Stream processing completely finished. Committed last completed sequence number ${lastCompletedSeq - 1}`);
      } else {
        const rawText = await response.text();
        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch {
          data = { error: rawText.slice(0, 250) };
        }
        const responseBody = chatCompletionToResponse(data, requestedModel, namespaceMap);
        broadcastToClients(responseBody);

        const choice = (data.choices || [{}])[0];
        const message = choice.message;
        if (message) {
          message.id = responseBody.id;
          const currentHistory = this.customConversationHistory.get(sessionIdStr) || [];
          const updatedHistory = currentHistory.concat(message);
          this.customConversationHistory.set(sessionIdStr, updatedHistory);
          this.updateContextUsage(
            sessionIdStr,
            requestedModel,
            { ...chatBody, messages: updatedHistory },
            contextWindow,
            data.usage
          );
        }
        const lastCompletedSeq = this.sessionSequenceNumberMap.get(sessionIdStr) || 1;
        this.lastCompletedSequenceNumberMap.set(sessionIdStr, lastCompletedSeq - 1);
      }
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        console.log(`[OpenCodex WS Proxy] Upstream request aborted successfully.`);
        return;
      }
      console.error(`[OpenCodex WS Proxy Local Handler Error]`, err);
      try {
        broadcastToClients({ error: { message: err.message, stack: err.stack } });
      } catch (wsErr) {}
    } finally {
      ws.off("close", onWsClose);
      this.activeAbortControllers.delete(sessionIdStr);
    }
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
            
            // Check for streamed events/notifications
            if (data.method === "codex/event" && data.params && data.params.msg) {
              const msg = data.params.msg;
              const reqIdStr = data.params._meta?.requestId;
              const reqId = reqIdStr ? parseInt(reqIdStr, 10) : NaN;
              
              if (!isNaN(reqId) && this.mcpRequests.has(reqId)) {
                const req = this.mcpRequests.get(reqId)!;
                if (msg.type === "agent_message_content_delta" && typeof msg.delta === "string") {
                  req.accumulatedReply += msg.delta;
                  if (req.onDelta) {
                    req.onDelta(msg.delta);
                  }
                }
              }
            } 
            // Check for responses to tools/call requests
            else if (data.id !== undefined && this.mcpRequests.has(data.id)) {
              const req = this.mcpRequests.get(data.id)!;
              this.mcpRequests.delete(data.id);
              
              if (data.error) {
                req.reject(new Error(data.error.message || "MCP call failed"));
              } else {
                const threadId = data.result?.structuredContent?.threadId || data.result?.threadId;
                const content = data.result?.structuredContent?.content || req.accumulatedReply;
                req.resolve({ threadId, reply: content });
              }
            }
          } catch (e) {
            // Not valid JSON
          }
        }
      }
    });

    this.mcpProcess.on("error", (err: Error) => {
      console.error(`[OpenCodex MCP Manager] Failed to start: ${err.message}`);
      this.mcpProcess = null;
    });

    this.mcpProcess.stderr.on("data", (chunk: Buffer) => {
      console.error(`[OpenCodex MCP STDERR] ${chunk.toString().trim().split("\n")[0]}`);
    });

    this.mcpProcess.on("close", (code: number) => {
      console.error(`[OpenCodex MCP Manager] codex mcp-server exited with code ${code}`);
      this.mcpProcess = null;
      // Reject any pending requests
      for (const [id, req] of this.mcpRequests.entries()) {
        req.reject(new Error("MCP process closed"));
      }
      this.mcpRequests.clear();
      
      // Auto-restart after a brief delay
      setTimeout(() => {
        if (!isNativeModeEnabled()) this.initCodexMcp();
      }, 2000);
    });

    // Send initialization
    setTimeout(() => {
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            clientName: "opencodex-voice-bridge",
            clientVersion: "1.0.0",
            protocolVersion: "2024-11-05"
          },
          id: ++this.mcpRequestId
        }) + "\n");
      }
    }, 500);

    setTimeout(() => {
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        }) + "\n");
      }
    }, 1000);
  }

  public askMcp(prompt: string, threadId?: string, onDelta?: (text: string) => void): Promise<{ threadId: string; reply: string }> {
    return new Promise((resolve, reject) => {
      if (isNativeModeEnabled()) {
        reject(new Error("Codex MCP control is disabled while native mode is active."));
        return;
      }
      if (!this.mcpProcess) {
        this.initCodexMcp();
      }
      
      const id = ++this.mcpRequestId;
      this.mcpRequests.set(id, { resolve, reject, onDelta, accumulatedReply: "" });

      const useThreadId = threadId && threadId !== "default" ? threadId : null;
      const toolName = useThreadId ? "codex-reply" : "codex";
      
      const args: any = { prompt };
      if (useThreadId) {
        args.threadId = useThreadId;
      } else {
        // First message configuration override
        args.config = {
          approval_policy: "never"
        };
      }

      const request = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args
        },
        id
      };

      console.error(`[OpenCodex MCP Manager] Sending request ${id} (tool: ${toolName}, thread: ${useThreadId || "new"})`);
      if (this.mcpProcess) {
        this.mcpProcess.stdin.write(JSON.stringify(request) + "\n");
      } else {
        this.mcpRequests.delete(id);
        reject(new Error("MCP process not initialized"));
      }
    });
  }

  public injectPromptViaCDP(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      try {
        // Query Electron page URL via CDP to find the correct debugger URL
        fetch("http://127.0.0.1:8315/json")
          .then(res => res.json())
          .then((targets: any) => {
            const pageTarget = targets.find((t: any) => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
            if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
              console.error("[OpenCodex CDP] Page target or debugger URL not found.");
              resolve("connection_failed");
              return;
            }
            
            const cdpWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
            let completed = false;
            
            cdpWs.on("open", () => {
              const evalExpr = `
                (() => {
                  const el = document.querySelector('.ProseMirror');
                  if (!el) return 'ProseMirror not found';
                  el.focus();
                  
                  // Select all
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  
                  // Type text
                  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
                  
                  // Dispatch events
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
                  
                  setTimeout(() => {
                    const sendBtn = Array.from(document.querySelectorAll('button')).find(b => b.className.includes('size-token-button-composer'));
                    if (sendBtn) {
                      sendBtn.click();
                      console.log('Send button clicked via CDP!');
                    }
                  }, 50);
                  
                  return 'Injected';
                })()
              `;
              cdpWs.send(JSON.stringify({
                id: 1,
                method: "Runtime.evaluate",
                params: {
                  expression: evalExpr,
                  returnByValue: true
                }
              }));
            });
            
            cdpWs.on("message", (data) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.id === 1) {
                  if (!completed) {
                    completed = true;
                    cdpWs.close();
                    const val = msg.result?.result?.value;
                    console.log(`[OpenCodex CDP] Evaluation result: ${val}`);
                    if (val === "Injected") {
                      resolve("success");
                    } else {
                      resolve("element_not_found");
                    }
                  }
                }
              } catch {}
            });
            
            cdpWs.on("error", (err) => {
              console.error("[OpenCodex CDP WS Err]", err);
              if (!completed) {
                completed = true;
                resolve("connection_failed");
              }
            });
          })
          .catch(err => {
            console.error("[OpenCodex CDP JSON Err]", err.message);
            resolve("connection_failed");
          });
      } catch (err: any) {
        console.error("[OpenCodex CDP Fail]", err.message);
        resolve("connection_failed");
      }
    });
  }

  private async startNativeCdpResponseMonitor(): Promise<() => void> {
    const noop = () => {};
    try {
      const targetsResponse = await fetch("http://127.0.0.1:8315/json");
      const targets = await targetsResponse.json() as any[];
      const pageTarget = targets.find((target: any) =>
        target.type === "page" &&
        target.url.includes("index.html") &&
        !target.url.includes("avatar-overlay") &&
        !target.url.includes("initialRoute")
      );
      if (!pageTarget?.webSocketDebuggerUrl) return noop;

      const cdpWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
      let nextCommandId = 1;
      let stopped = false;
      let polling = false;
      let interval: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;
      let previousText = "";
      let responseId = "";
      let stableSince = 0;
      const pending = new Map<number, (value: any) => void>();

      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
        for (const resolve of pending.values()) resolve(null);
        pending.clear();
        try { cdpWs.close(); } catch {}
      };

      cdpWs.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (typeof message.id === "number") {
            pending.get(message.id)?.(message.result?.result?.value ?? null);
            pending.delete(message.id);
          }
        } catch {}
      });
      cdpWs.on("error", () => stop());
      cdpWs.on("close", () => stop());

      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cdpWs.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          cdpWs.off("open", onOpen);
          reject(error);
        };
        cdpWs.once("open", onOpen);
        cdpWs.once("error", onError);
      });

      const evaluate = (expression: string): Promise<any> => new Promise((resolve) => {
        if (stopped || cdpWs.readyState !== WebSocket.OPEN) {
          resolve(null);
          return;
        }
        const id = nextCommandId++;
        pending.set(id, resolve);
        cdpWs.send(JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true }
        }));
      });

      const snapshotExpression = `
        (() => {
          const groups = Array.from(document.querySelectorAll('[data-response-annotation-target]'));
          const last = groups[groups.length - 1];
          if (!last) return { count: 0, id: '', text: '' };
          const content = last.querySelector('[data-selected-text-overlay-target]');
          return {
            count: groups.length,
            id: last.getAttribute('data-response-annotation-target') || '',
            text: (content ? content.innerText : last.innerText || '').trim()
          };
        })()
      `;
      const baseline = await evaluate(snapshotExpression);
      if (!baseline) {
        stop();
        return noop;
      }
      const baselineId = String(baseline.id || "");
      const baselineCount = Number(baseline.count || 0);

      const broadcast = (payload: Record<string, unknown>) => {
        const message = JSON.stringify(payload);
        for (const voiceClient of this.activeWsClients) {
          if (voiceClient.readyState === WebSocket.OPEN) {
            try { voiceClient.send(message); } catch {}
          }
        }
      };

      const poll = async () => {
        if (stopped || polling) return;
        polling = true;
        try {
          const snapshot = await evaluate(snapshotExpression);
          if (!snapshot) return;
          const currentId = String(snapshot.id || "");
          const text = String(snapshot.text || "").trim();
          const isNewAssistantMessage = currentId && (currentId !== baselineId || Number(snapshot.count || 0) > baselineCount);
          if (!isNewAssistantMessage || !text) return;

          if (currentId !== responseId) {
            responseId = currentId;
            previousText = "";
            stableSince = Date.now();
          }

          if (text !== previousText) {
            const delta = previousText && text.startsWith(previousText)
              ? text.slice(previousText.length)
              : text;
            if (delta) broadcast({ type: "model_chunk", text: delta });
            previousText = text;
            stableSince = Date.now();
          } else if (previousText && Date.now() - stableSince >= 1800) {
            broadcast({ type: "model_done", text: previousText });
            stop();
          }
        } finally {
          polling = false;
        }
      };

      interval = setInterval(() => { void poll(); }, 300);
      timeout = setTimeout(() => {
        if (previousText) broadcast({ type: "model_done", text: previousText });
        stop();
      }, 120000);
      void poll();
      console.log("[OpenCodex Voice API] Native CDP response monitor started.");
      return stop;
    } catch (error: any) {
      console.warn(`[OpenCodex Voice API] Native CDP response monitor unavailable: ${error.message}`);
      return noop;
    }
  }
}

function findRolloutFiles(dir: string, filesList: string[] = []): string[] {
  if (!existsSync(dir)) return filesList;
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        findRolloutFiles(fullPath, filesList);
      } else if (file.startsWith("rollout-") && file.endsWith(".jsonl")) {
        filesList.push(fullPath);
      }
    } catch {}
  }
  return filesList;
}

function findRolloutFileById(dir: string, sessionId: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const res = findRolloutFileById(fullPath, sessionId);
        if (res) return res;
      } else if (file.endsWith(`-${sessionId}.jsonl`)) {
        return fullPath;
      }
    } catch {}
  }
  return null;
}

function deleteSessionFiles(dir: string) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        deleteSessionFiles(fullPath);
        rmSync(fullPath, { recursive: true, force: true });
      } else if (file.endsWith(".jsonl")) {
        unlinkSync(fullPath);
      }
    } catch {}
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function stripManagedBlocks(content: string): string {
  return content.replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed <<<\n?/gi, "").trim();
}

function getDefaultCatalog() {
  return { models: [] };
}
