import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Codex-native Computer Use contract for third-party models.
 *
 * The gateway does not execute desktop actions.  It forwards the native
 * node-repl executor back to the Codex desktop client, where the installed
 * Computer Use runtime (`@oai/sky`) owns screenshots, permissions, and UI
 * actions.  The gateway presents the executor as a Chat function to a
 * third-party provider, then restores it to the same Responses
 * `function_call` name that Codex registered for the local MCP namespace.
 */

export const NATIVE_COMPUTER_USE_EXECUTOR_NAMES = new Set([
  "mcp__node_repl_js",
  "mcp__node_repl__js",
]);

// Chat providers receive flattened function names. The old working gateway
// used one separator after the namespace, then restored the Responses
// namespace fields on the way back to Codex.
export const CANONICAL_NATIVE_COMPUTER_USE_EXECUTOR_NAME = "mcp__node_repl_js";

/**
 * Every native Computer Use call is executed by a persistent node-repl
 * session.  The provider is not required to know that implementation detail,
 * so the gateway supplies a small, idempotent bootstrap and isolates the
 * provider's snippet in an async function scope.  This prevents a perfectly
 * valid second call such as `const lines = ...` from colliding with a const
 * declared by the previous call.
 */
const NATIVE_COMPUTER_USE_BOOTSTRAP = [
  "if (!globalThis.sky) {",
  "  globalThis.sky = (await import('@oai/sky')).sky;",
  "  if (!globalThis.sky) throw new Error('Computer Use native runtime is unavailable');",
  "}",
].join("\n");

const NATIVE_COMPUTER_USE_WRAPPER_MARKER = "/* opencodex-native-computer-use-call */";
const NATIVE_COMPUTER_USE_RESULT_TTL_MS = 2 * 60 * 1000;
const MAX_NATIVE_COMPUTER_USE_RESULTS = 512;
const MAX_NATIVE_COMPUTER_USE_RESULT_TEXT = 500_000;
const MAX_NATIVE_COMPUTER_USE_RESULT_IMAGE = 8_000_000;

type NativeComputerUseResult = {
  output: string | Array<Record<string, any>>;
  expiresAt: number;
};

const nativeComputerUseResultTokens = new Map<string, { token: string; expiresAt: number }>();
const nativeComputerUseResults = new Map<string, NativeComputerUseResult>();

function pruneNativeComputerUseResults(now = Date.now()): void {
  for (const [callId, pending] of nativeComputerUseResultTokens) {
    if (pending.expiresAt <= now) {
      nativeComputerUseResultTokens.delete(callId);
      try { unlinkSync(nativeComputerUseResultFilePath(pending.token)); } catch {}
    }
  }
  for (const [token, result] of nativeComputerUseResults) {
    if (result.expiresAt <= now) nativeComputerUseResults.delete(token);
  }
  while (nativeComputerUseResultTokens.size > MAX_NATIVE_COMPUTER_USE_RESULTS) {
    const oldest = nativeComputerUseResultTokens.keys().next().value;
    if (!oldest) break;
    nativeComputerUseResultTokens.delete(oldest);
  }
  while (nativeComputerUseResults.size > MAX_NATIVE_COMPUTER_USE_RESULTS) {
    const oldest = nativeComputerUseResults.keys().next().value;
    if (!oldest) break;
    nativeComputerUseResults.delete(oldest);
  }
}

/**
 * The desktop MCP bridge currently puts `execution_duration_ms` in
 * structuredContent and drops the MCP content when it serializes a
 * function_call_output continuation. Keep a short-lived sideband keyed by
 * the native call id so the gateway can restore the actual output without
 * touching ~/.codex, ~/.opencodex, or the desktop executor. The native
 * node-repl cannot reliably call the gateway over localhost, so the payload
 * crosses the process boundary through /private/tmp.
 */
export function beginNativeComputerUseResultBridge(callId: unknown, ...aliases: unknown[]): string {
  const normalizedIds = [callId, ...aliases]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (normalizedIds.length === 0) return "";
  pruneNativeComputerUseResults();
  const token = randomBytes(24).toString("base64url");
  const pending = { token, expiresAt: Date.now() + NATIVE_COMPUTER_USE_RESULT_TTL_MS };
  for (const normalizedId of new Set(normalizedIds)) {
    nativeComputerUseResultTokens.set(normalizedId, pending);
  }
  return token;
}

function nativeComputerUseResultFilePath(token: string): string {
  return `${tmpdir()}/opencodex-native-computer-use-${token}.json`;
}

function nativeComputerUseResultTokenFromValue(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (!text) return "";
  const match = text.match(/opencodex-native-computer-use-([A-Za-z0-9_-]+)\.json/);
  return match?.[1] || "";
}

/**
 * Recover the bridge token from the persisted Responses function-call item.
 * This keeps a gateway restart from orphaning the native result: the token is
 * already embedded in the wrapper code sent to the desktop executor, while
 * the user session and provider history remain untouched.
 */
function nativeComputerUseBridgeTokensFromRequest(reqBody: any): Map<string, string> {
  const byId = new Map<string, string>();
  if (!reqBody || !Array.isArray(reqBody.input)) return byId;
  for (const item of reqBody.input) {
    if (!item || typeof item !== "object") continue;
    const token = nativeComputerUseResultTokenFromValue(
      item.arguments
      || item.input
      || item.action
      || item.function?.arguments,
    );
    if (!token) continue;
    for (const id of [item.call_id, item.id, item.item_id]) {
      const normalizedId = String(id || "").trim();
      if (normalizedId) byId.set(normalizedId, token);
    }
  }
  return byId;
}

function nativeComputerUseOutputFromPayload(payload: any): string | Array<Record<string, any>> | undefined {
  const text = typeof payload?.text === "string"
    ? payload.text.slice(0, MAX_NATIVE_COMPUTER_USE_RESULT_TEXT)
    : "";
  const imageParts = Array.isArray(payload?.images)
    ? payload.images
      .filter((image: any) => typeof image === "string" && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(image))
      .map((image: string) => ({ type: "image_url", image_url: image.slice(0, MAX_NATIVE_COMPUTER_USE_RESULT_IMAGE) }))
    : [];
  const error = typeof payload?.error === "string" ? payload.error.slice(0, 4000) : "";
  if (imageParts.length > 0) {
    return [
      ...(text ? [{ type: "text", text }] : []),
      ...imageParts,
      ...(error ? [{ type: "text", text: `Computer Use execution error: ${error}` }] : []),
    ];
  }
  if (text) return error ? `${text}\nComputer Use execution error: ${error}` : text;
  if (error) return `Computer Use execution error: ${error}`;
  return undefined;
}

/** Accept an already-decoded sideband payload. This is used by focused tests. */
export function acceptNativeComputerUseResult(token: unknown, payload: any): boolean {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken || normalizedToken.length > 200) return false;
  const pending = Array.from(nativeComputerUseResultTokens.values()).find((entry) => entry.token === normalizedToken);
  if (!pending || pending.expiresAt <= Date.now()) return false;
  const output = nativeComputerUseOutputFromPayload(payload);
  if (output === undefined) return false;
  pruneNativeComputerUseResults();
  nativeComputerUseResults.set(normalizedToken, {
    output,
    expiresAt: Date.now() + NATIVE_COMPUTER_USE_RESULT_TTL_MS,
  });
  return true;
}

function responseOutputToText(output: any): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => part?.type === "input_text" || part?.type === "output_text" || part?.type === "text" ? String(part.text || "") : "")
      .join("\n");
  }
  try { return JSON.stringify(output); } catch { return String(output || ""); }
}

function nativeComputerUseResultFromFile(token: string, directory = tmpdir()): NativeComputerUseResult | undefined {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) return undefined;
  try {
    const filePath = `${directory}/opencodex-native-computer-use-${normalizedToken}.json`;
    if (!existsSync(filePath)) return undefined;
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    if (String(payload?.token || "").trim() !== normalizedToken) return undefined;
    const output = nativeComputerUseOutputFromPayload(payload);
    if (output === undefined) return undefined;
    return { output, expiresAt: Date.now() + NATIVE_COMPUTER_USE_RESULT_TTL_MS };
  } catch {
    return undefined;
  }
}

function nativeComputerUseResultForToken(token: string): NativeComputerUseResult | undefined {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) return undefined;
  const cached = nativeComputerUseResults.get(normalizedToken);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const fromFile = nativeComputerUseResultFromFile(normalizedToken);
  if (fromFile) nativeComputerUseResults.set(normalizedToken, fromFile);
  return fromFile;
}

function uniquePendingNativeComputerUseResults(): Array<{ token: string; expiresAt: number }> {
  const unique = new Map<string, { token: string; expiresAt: number }>();
  for (const pending of nativeComputerUseResultTokens.values()) {
    if (!unique.has(pending.token)) unique.set(pending.token, pending);
  }
  return [...unique.values()];
}

function nativeComputerUseResultFromOrphanedFile(): { token: string; result: NativeComputerUseResult; filePath: string } | undefined {
  const now = Date.now();
  const directories = [...new Set([tmpdir(), "/private/tmp"])];
  const candidates: Array<{ token: string; result: NativeComputerUseResult; mtimeMs: number; filePath: string }> = [];
  for (const directory of directories) {
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const match = name.match(/^opencodex-native-computer-use-([A-Za-z0-9_-]+)\.json$/);
      if (!match) continue;
      const filePath = `${directory}/${name}`;
      let mtimeMs = 0;
      try { mtimeMs = statSync(filePath).mtimeMs; } catch { continue; }
      if (now - mtimeMs > NATIVE_COMPUTER_USE_RESULT_TTL_MS) continue;
      const result = nativeComputerUseResultFromFile(match[1], directory);
      if (result) candidates.push({ token: match[1], result, mtimeMs, filePath });
    }
  }
  // An unmatched output is safe to recover from the filesystem only when it
  // is unambiguous. Multiple active native calls must use their correlation
  // ids; guessing across them could attach one screenshot to another call.
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}

function isDurationOnlyNativeComputerUseOutput(output: any): boolean {
  const text = responseOutputToText(output).trim();
  if (!text) return false;
  return /(?:^|\n)Output:\s*\{\s*["']?execution_duration_ms["']?\s*:/i.test(text)
    || /^\{\s*["']?execution_duration_ms["']?\s*:/i.test(text);
}

/**
 * Restore sideband output only when the client sent the known duration-only
 * placeholder. Real function output, if a future client preserves it, wins.
 */
export function restoreNativeComputerUseResultOutputs(reqBody: any): { body: any; recovered: number } {
  if (!reqBody || !Array.isArray(reqBody.input)) return { body: reqBody, recovered: 0 };
  pruneNativeComputerUseResults();
  const requestBridgeTokens = nativeComputerUseBridgeTokensFromRequest(reqBody);
  const uniquePending = uniquePendingNativeComputerUseResults();
  let orphanedFile: { token: string; result: NativeComputerUseResult; filePath: string } | undefined;
  let recovered = 0;
  const input = reqBody.input.map((item: any) => {
    if (!item || typeof item !== "object" || ![
      "function_call_output",
      "mcp_call_output",
      "custom_tool_call_output",
      "computer_call_output",
    ].includes(item.type)) return item;
    const candidateIds = [item.call_id, item.id]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    const pendingEntry = candidateIds
      .map((candidateId) => nativeComputerUseResultTokens.get(candidateId))
      .find(Boolean);
    if (!isDurationOnlyNativeComputerUseOutput(item.output)) return item;

    let token = pendingEntry?.token || candidateIds.map((id) => requestBridgeTokens.get(id)).find(Boolean) || "";
    // Some Codex continuations expose neither the provider call_id nor the
    // Responses item id. If there is exactly one active native call, its
    // result is the only safe correlation candidate.
    if (!token && uniquePending.length === 1) token = uniquePending[0].token;

    let result = token ? nativeComputerUseResultForToken(token) : undefined;
    if (!result && !token) {
      orphanedFile = orphanedFile || nativeComputerUseResultFromOrphanedFile();
      if (orphanedFile) {
        const candidate = orphanedFile;
        orphanedFile = undefined;
        token = candidate.token;
        result = candidate.result;
      }
    }
    if (!result) return item;
    const filePath = orphanedFile?.token === token
      ? orphanedFile.filePath
      : nativeComputerUseResultFilePath(token);
    try { unlinkSync(filePath); } catch {}
    recovered += 1;
    return { ...item, output: result.output };
  });
  return recovered > 0 ? { body: { ...reqBody, input }, recovered } : { body: reqBody, recovered: 0 };
}

export interface NativeComputerUseToolArgumentOptions {
  resultToken?: string;
}

export const NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS = [
  "Codex native Computer Use is available through the provided native node-repl executor (the provider-facing tool name is `mcp__node_repl_js`).",
  "When the user asks you to operate the desktop, browser, or an app, call that executor directly with JavaScript and inspect fresh state after each action.",
  "Use the native `@oai/sky` runtime: the gateway bootstraps it before every executor call when `globalThis.sky` is absent. If you need to bootstrap it yourself, run `globalThis.sky = (await import('@oai/sky')).sky`; do not search for a plugin script or construct a versioned computer-use path.",
  "Every direct action must include the target `app` as a plain data property: this includes `click`, `scroll`, `type_text`, `set_value`, `select_text`, `drag`, and `press_key`.",
  "Use exact API shapes: click uses `{ app, element_index }`; scroll uses `{ app, element_index, direction: 'up'|'down'|'left'|'right', pages?: number }` and normally needs `direction: 'down', pages: 1`; the Enter key is `Return`; modifier combinations are one string such as `super+t`, `super+l`, or `super+a` (the compatible spelling `meta+t` is also a string), never an array and never a `modifiers` field.",
  "There is no `sky.open_app` in this runtime, and no shell `open -a` fallback is needed: `sky.get_app_state({ app: 'com.google.Chrome' })` launches or attaches to the app transparently. Do not inspect a presumed `windows` field; the state shape is `{ app, screenshot, text }`, and the accessibility tree is in `state.text`.",
  "Initialize with `sky.get_app_state({ app: 'com.google.Chrome', disableDiff: true })`; an empty object or empty `text` immediately after launch/navigation means the accessibility snapshot is still loading, not that Chrome is unavailable. Retry `get_app_state` with `disableDiff: true` up to two more times before acting. After every click, scroll, type, key, or value action, call `get_app_state` and use only fresh element indices; never reuse an element index from an older state.",
  "When starting a separate web task, prefer a new tab. After opening it, focus the address bar with `press_key({ app, key: 'super+l' })`, select all with `super+a`, and only then enter the URL. Do not type a URL into the new-tab page search box; for ordinary HTTPS sites prefer the host without `https://` so keyboard layout cannot drop the colon. If a scheme or port is required, set the fresh address-bar element with `set_value` instead.",
  "For text output, always call `nodeRepl.write(String(value))` or `nodeRepl.write(JSON.stringify(value))`; do not rely on an implicit JavaScript return value or write state to a temporary file just to observe it. For screenshots, use only `state.screenshot.url` from `get_app_state`, convert it with `fileURLToPath` from `node:url`, read the bytes, and call `nodeRepl.emitImage` with the matching MIME type (`image/jpeg` for `.jpeg`/`.jpg`, `image/png` for `.png`). `sky.screenshot`, `sky.target.screenshot`, and `view_image` are unsupported in this runtime. Chat endpoints may report that an image result was omitted; that is expected compatibility behavior, so continue with the accessibility tree and do not retry unsupported image APIs or use shell/image-copy workarounds.",
  "The node-repl session persists variables across calls, but the gateway automatically wraps each call in an isolated async scope and bootstraps `globalThis.sky` when needed. Keep each snippet self-contained, fetch fresh state after actions, and do not rely on local variables from an earlier call; never redeclare an existing top-level `let`, `const`, or `var`.",
  "Use `sky.get_app_state({ app: 'com.google.Chrome' })`, `sky.click(...)`, `sky.scroll(...)`, `sky.type_text(...)`, and `sky.press_key(...)` as needed. Use `sky.list_apps()` only if targeting the known Chrome bundle identifier fails. Do not search for or list MCP servers, plugins, or resources first. Do not call a gateway-specific Computer Use function and do not replace native Computer Use with shell commands or browser automation. If the native executor is absent, report that it is unavailable instead of probing for another interface.",
].join(" ");

const COMPUTER_TOOL_TYPES = new Set(["computer", "computer_use", "computer_use_preview"]);
const DISCOVERY_TOOL_NAMES = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "request_plugin_install",
]);

const DEFAULT_NATIVE_PARAMETERS = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "Self-contained JavaScript for the native Computer Use node runtime. The gateway automatically bootstraps @oai/sky and isolates this call, so use fresh local variables, call nodeRepl.write for text output, and inspect fresh state after actions.",
    },
    title: { type: "string", description: "Short description of the UI operation" },
    timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
  },
  required: ["code"],
};

function toolFunctionName(tool: any): string {
  return String(tool?.function?.name || tool?.name || "").trim().toLowerCase();
}

/**
 * Make a native node-repl call safe to execute after any previous call.
 * Arguments are JSON because this function runs at the Responses/Chat
 * protocol boundary, before the Codex desktop client executes the code.
 */
export function normalizeNativeComputerUseToolArguments(
  rawArguments: string,
  options: NativeComputerUseToolArgumentOptions = {},
): string {
  if (typeof rawArguments !== "string" || !rawArguments) return rawArguments;

  let parsed: any;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.code !== "string") return rawArguments;

  const code = parsed.code;
  if (code.includes(NATIVE_COMPUTER_USE_WRAPPER_MARKER)) return rawArguments;

  const resultBridge = options.resultToken
    ? [
      "  const __opencodexResult = { text: '', images: [], error: '' };",
      "  const __opencodexRender = (value) => {",
      "    if (typeof value === 'string') return value;",
      "    try { return JSON.stringify(value); } catch { return String(value); }",
      "  };",
      "  const __opencodexAppendText = (value) => {",
      `    const rendered = __opencodexRender(value); if (__opencodexResult.text.length < ${MAX_NATIVE_COMPUTER_USE_RESULT_TEXT}) __opencodexResult.text += rendered.slice(0, ${MAX_NATIVE_COMPUTER_USE_RESULT_TEXT} - __opencodexResult.text.length);`,
      "  };",
      "  const __opencodexCaptureImage = async (value) => {",
      "    try {",
      "      let dataUrl = ''; let mimeType = '';",
      "      if (typeof value === 'string' && value.startsWith('data:image/')) dataUrl = value;",
      "      else if (typeof value === 'string' && value.startsWith('file:')) {",
      "        const { readFile } = await import('node:fs/promises'); const { fileURLToPath } = await import('node:url');",
      "        const bytes = await readFile(fileURLToPath(value)); mimeType = /\\.jpe?g$/i.test(value) ? 'image/jpeg' : /\\.webp$/i.test(value) ? 'image/webp' : 'image/png';",
      "        dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;",
      "      } else if (value && typeof value === 'object') {",
      "        const bytes = value.bytes || value.data; mimeType = typeof value.mimeType === 'string' ? value.mimeType : 'image/png';",
      "        if (bytes) dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;",
      "      }",
      `      if (/^data:image\\/(?:png|jpe?g|webp);base64,/i.test(dataUrl) && dataUrl.length <= ${MAX_NATIVE_COMPUTER_USE_RESULT_IMAGE}) __opencodexResult.images.push(dataUrl);`,
      "    } catch {}",
      "  };",
      "  const __opencodexOriginalNodeRepl = globalThis.nodeRepl;",
      "  // Use a plain facade. Native node-repl methods are read-only/non-configurable, so a Proxy cannot override them.",
      "  const __opencodexNodeRepl = {",
      "    cwd: __opencodexOriginalNodeRepl.cwd,",
      "    homeDir: __opencodexOriginalNodeRepl.homeDir,",
      "    tmpDir: __opencodexOriginalNodeRepl.tmpDir,",
      "    requestMeta: __opencodexOriginalNodeRepl.requestMeta,",
      "    write: (value) => { __opencodexAppendText(value); return Reflect.apply(__opencodexOriginalNodeRepl.write, __opencodexOriginalNodeRepl, [value]); },",
      "    emitImage: async (value) => { const result = await Reflect.apply(__opencodexOriginalNodeRepl.emitImage, __opencodexOriginalNodeRepl, [value]); await __opencodexCaptureImage(value); return result; },",
      "    setResponseMeta: (meta) => typeof __opencodexOriginalNodeRepl.setResponseMeta === 'function' ? Reflect.apply(__opencodexOriginalNodeRepl.setResponseMeta, __opencodexOriginalNodeRepl, [meta]) : undefined,",
      "  };",
      "  const __opencodexOriginalConsole = globalThis.console;",
      "  const __opencodexConsole = {};",
      "  for (const __opencodexMethod of ['log', 'info', 'warn', 'error', 'debug']) {",
      "    __opencodexConsole[__opencodexMethod] = (...args) => {",
      "      __opencodexAppendText(args.map(__opencodexRender).join(' ') + '\\n');",
      "      const __opencodexFn = __opencodexOriginalConsole[__opencodexMethod];",
      "      return typeof __opencodexFn === 'function' ? Reflect.apply(__opencodexFn, __opencodexOriginalConsole, args) : undefined;",
      "    };",
      "  }",
      "  const __opencodexSendResult = async () => {",
      "    try {",
      "      const { writeFile } = await import('node:fs/promises');",
      `      await writeFile(${JSON.stringify(nativeComputerUseResultFilePath(options.resultToken))}, JSON.stringify({ token: ${JSON.stringify(options.resultToken)}, text: __opencodexResult.text, images: __opencodexResult.images, error: __opencodexResult.error }), { encoding: 'utf8', mode: 0o600 });`,
      "    } catch {}",
      "  };",
      "  try {",
      "    await (async (nodeRepl, console) => {",
      code,
      "    })(__opencodexNodeRepl, __opencodexConsole);",
      "  } catch (__opencodexError) {",
      "    __opencodexResult.error = __opencodexRender(__opencodexError);",
      "    throw __opencodexError;",
      "  } finally {",
      "    await __opencodexSendResult();",
      "  }",
    ].join("\n")
    : "";

  return JSON.stringify({
    ...parsed,
    code: [
      NATIVE_COMPUTER_USE_WRAPPER_MARKER,
      "await (async () => {",
      NATIVE_COMPUTER_USE_BOOTSTRAP,
      resultBridge,
      resultBridge ? "  // The provider snippet runs with a capture facade; desktop actions still execute in the native runtime." : code,
      resultBridge ? "})();" : "})();",
    ].join("\n"),
  });
}

export function isNativeComputerUseExecutorName(name: unknown): boolean {
  return NATIVE_COMPUTER_USE_EXECUTOR_NAMES.has(String(name || "").trim().toLowerCase());
}

/**
 * Codex can advertise the local executor as a standard Responses MCP tool
 * instead of a `computer` descriptor or an already-flattened function. Keep
 * this shape on the same generic Computer Use path for every provider.
 */
export function isNativeComputerUseMcpTool(tool: any): boolean {
  if (!tool || typeof tool !== "object") return false;
  if (String(tool.type || "").trim().toLowerCase() !== "mcp") return false;

  const serverLabel = String(tool.server_label || tool.serverLabel || "").trim().toLowerCase();
  if (serverLabel !== "node_repl") return false;

  const allowedTools = Array.isArray(tool.allowed_tools)
    ? tool.allowed_tools.map((name: any) => String(name || "").trim().toLowerCase()).filter(Boolean)
    : [];
  return allowedTools.length === 0 || allowedTools.includes("js") || allowedTools.some(isNativeComputerUseExecutorName);
}

export function canonicalNativeComputerUseExecutorName(name: unknown): string {
  return isNativeComputerUseExecutorName(name)
    ? CANONICAL_NATIVE_COMPUTER_USE_EXECUTOR_NAME
    : String(name || "").trim();
}

export interface NativeComputerUseMcpDescriptor {
  serverLabel: string;
  toolName: string;
}

/**
 * Convert the flattened Chat tool name back to the Responses MCP identity.
 * Both spellings have appeared in Codex tool lists:
 *   mcp__node_repl_js
 *   mcp__node_repl__js
 */
export function nativeComputerUseMcpDescriptor(name: unknown): NativeComputerUseMcpDescriptor | null {
  const value = String(name || "").trim().toLowerCase();
  if (!isNativeComputerUseExecutorName(value)) return null;

  const remainder = value.slice("mcp__".length);
  const namespaceSeparator = remainder.indexOf("__");
  if (namespaceSeparator > 0) {
    return {
      serverLabel: remainder.slice(0, namespaceSeparator),
      toolName: remainder.slice(namespaceSeparator + 2) || "js",
    };
  }

  const functionSeparator = remainder.lastIndexOf("_");
  if (functionSeparator <= 0) {
    return { serverLabel: "node_repl", toolName: "js" };
  }
  return {
    serverLabel: remainder.slice(0, functionSeparator),
    toolName: remainder.slice(functionSeparator + 1) || "js",
  };
}

/** True for the Responses computer descriptor or the native executor tool. */
export function isComputerUseTool(tool: any): boolean {
  if (!tool || typeof tool !== "object") return false;
  if (COMPUTER_TOOL_TYPES.has(String(tool.type || "").trim().toLowerCase())) return true;
  if (isNativeComputerUseMcpTool(tool)) return true;
  return isNativeComputerUseExecutorName(toolFunctionName(tool));
}

export function hasNativeComputerUseTool(tools?: unknown[]): boolean {
  return Array.isArray(tools) && tools.some((tool) => isNativeComputerUseExecutorName(toolFunctionName(tool)));
}

export function hasComputerUseTool(tools?: unknown[]): boolean {
  return Array.isArray(tools) && tools.some(isComputerUseTool);
}

/**
 * Ensure a model whose catalog advertises native Computer Use receives the
 * same local executor even when the desktop client omitted the descriptor on
 * a fresh request. This is a capability projection, not a model-specific
 * adapter: the provider still only sees one ordinary function tool.
 */
export function ensureNativeComputerUseResponsesTool(tools?: unknown[], enabled = false): any[] | undefined {
  if (!enabled) return tools as any[] | undefined;
  const next = Array.isArray(tools) ? [...tools] : [];
  if (!hasComputerUseTool(next)) next.push(buildNativeComputerUseResponsesTool());
  return next;
}

/**
 * Hide discovery/management helpers from the upstream model, but preserve
 * the actual native node-repl executor so its function call can return to
 * Codex Desktop for execution.
 */
export function isComputerUseDiscoveryToolName(name: unknown): boolean {
  const value = String(name || "").trim().toLowerCase();
  if (DISCOVERY_TOOL_NAMES.has(value)) return true;
  if (isNativeComputerUseExecutorName(value)) return false;
  return value.startsWith("mcp__node_repl_js_")
    || value.startsWith("mcp__node_repl__js_")
    || value.startsWith("mcp__codex_apps__");
}

/** Normalize a Responses computer descriptor into the real Codex executor. */
export function buildNativeComputerUseChatTool(sourceTool: any = {}): any {
  const sourceFunction = sourceTool?.function && typeof sourceTool.function === "object"
    ? sourceTool.function
    : undefined;
  const sourceName = sourceFunction?.name || sourceTool?.name;
  const name = isNativeComputerUseExecutorName(sourceName)
    ? canonicalNativeComputerUseExecutorName(sourceName)
    : CANONICAL_NATIVE_COMPUTER_USE_EXECUTOR_NAME;
  const sourceDescription = typeof sourceFunction?.description === "string"
    ? sourceFunction.description.trim()
    : typeof sourceTool?.description === "string"
      ? sourceTool.description.trim()
      : "";
  const description = [
    sourceDescription,
    "This is the Codex-native Computer Use executor registered as mcp__node_repl_js. Run JavaScript through the native node runtime; use @oai/sky for screenshots and desktop actions, then inspect the fresh state.",
  ].filter(Boolean).join(" ");

  return {
    type: "function",
    function: {
      name,
      description,
      parameters: sourceFunction?.parameters || sourceTool?.parameters || DEFAULT_NATIVE_PARAMETERS,
    },
  };
}

/**
 * Responses providers use a top-level function tool shape. The Codex
 * `computer` descriptor is native to the client and is not understood by
 * most third-party Responses endpoints, so expose the same local executor as
 * a normal function while preserving its MCP identity on the way back.
 */
export function buildNativeComputerUseResponsesTool(sourceTool: any = {}): any {
  const chatTool = buildNativeComputerUseChatTool(sourceTool);
  const fn = chatTool.function;
  return {
    type: "function",
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
  };
}

export function normalizeComputerUseResponsesTools(tools?: unknown[]): any[] | undefined {
  if (!Array.isArray(tools)) return tools as any[] | undefined;
  const usesComputer = tools.some(isComputerUseTool);
  if (!usesComputer) return tools as any[];

  const result: any[] = [];
  let hasExecutor = false;
  for (const rawTool of tools) {
    if (!rawTool || typeof rawTool !== "object") continue;
    if (isComputerUseTool(rawTool)) {
      if (!hasExecutor) {
        result.push(buildNativeComputerUseResponsesTool(rawTool));
        hasExecutor = true;
      }
      continue;
    }

    const rawName = toolFunctionName(rawTool);
    if (isComputerUseDiscoveryToolName(rawName)) continue;
    if (isNativeComputerUseExecutorName(rawName)) {
      result.push(buildNativeComputerUseResponsesTool(rawTool));
      hasExecutor = true;
      continue;
    }

    // Responses expects `{type:"function", name, parameters}` while Chat
    // tool lists use `{type:"function", function:{...}}`. Normalize only
    // this ordinary function shape on the direct Responses path.
    if ((rawTool as any).type === "function" && (rawTool as any).function) {
      const fn = (rawTool as any).function;
      result.push({
        type: "function",
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || { type: "object", properties: {} },
        ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
      });
      continue;
    }
    result.push(rawTool);
  }

  if (!hasExecutor) result.push(buildNativeComputerUseResponsesTool());
  return result;
}

function normalizeNativeComputerUseItem(item: any): any {
  if (!item || typeof item !== "object") return item;
  const name = item.name || item.function?.name;
  const isRestoredNativeIdentity = item.namespace === "mcp__node_repl" && item.name === "js";
  if (!isNativeComputerUseExecutorName(name) && !isRestoredNativeIdentity) return item;
  const normalizedArguments = typeof item.arguments === "string"
    ? normalizeNativeComputerUseToolArguments(item.arguments)
    : item.arguments;
  return {
    ...item,
    name: "js",
    namespace: "mcp__node_repl",
    ...(typeof normalizedArguments === "string" ? { arguments: normalizedArguments } : {}),
  };
}

/** Restore native MCP identity in direct third-party Responses output. */
export function normalizeNativeComputerUseResponsesPayload(payload: any, nativeCallIds?: Set<string>): any {
  if (!payload || typeof payload !== "object") return payload;

  const rememberNativeItem = (item: any): void => {
    if (!nativeCallIds || !item || typeof item !== "object") return;
    const name = item.name || item.function?.name;
    const isRestoredNativeIdentity = item.namespace === "mcp__node_repl" && item.name === "js";
    if (!isNativeComputerUseExecutorName(name) && !isRestoredNativeIdentity) return;
    for (const id of [item.id, item.item_id, item.call_id]) {
      if (typeof id === "string" && id) nativeCallIds.add(id);
    }
  };

  rememberNativeItem(payload.item);
  if (Array.isArray(payload.output)) payload.output.forEach(rememberNativeItem);
  if (payload.response && Array.isArray(payload.response.output)) payload.response.output.forEach(rememberNativeItem);

  let next = payload;
  if (payload.item) next = { ...next, item: normalizeNativeComputerUseItem(payload.item) };
  if (Array.isArray(payload.output)) {
    next = { ...next, output: payload.output.map(normalizeNativeComputerUseItem) };
  }
  if (payload.response && Array.isArray(payload.response.output)) {
    next = {
      ...next,
      response: {
        ...payload.response,
        output: payload.response.output.map(normalizeNativeComputerUseItem),
      },
    };
  }

  if (nativeCallIds && typeof payload.arguments === "string") {
    const relatedIds = [payload.item_id, payload.call_id, payload.id]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (relatedIds.some((id) => nativeCallIds.has(id))) {
      next = {
        ...next,
        arguments: normalizeNativeComputerUseToolArguments(payload.arguments),
      };
    }
  }
  return next;
}

export function appendComputerUseInstructions(instructions: unknown, tools?: unknown[]): string {
  const original = typeof instructions === "string" ? instructions.trim() : "";
  if (!hasComputerUseTool(tools)) return original;
  if (original.includes(NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS)) return original;
  return original
    ? `${original}\n\n${NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS}`
    : NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS;
}
