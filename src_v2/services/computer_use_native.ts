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
  "  var cuNodeRepl = globalThis.nodeRepl;",
  "  var cuHome = cuNodeRepl?.env?.HOME || cuNodeRepl?.homeDir || globalThis.process?.env?.HOME;",
  "  if (!cuHome) throw new Error('Computer Use node runtime has no HOME directory');",
  "  var cuFs = await import('node:fs/promises');",
  "  var cuPath = await import('node:path');",
  "  var cuRoot = cuPath.join(cuHome, '.codex', 'plugins', 'cache', 'openai-bundled', 'computer-use');",
  "  var cuEntries = await cuFs.readdir(cuRoot, { withFileTypes: true });",
  "  var cuVersions = cuEntries.filter((entry) => entry.isDirectory() && /^\\d/.test(entry.name)).map((entry) => entry.name).sort().reverse();",
  "  if (!cuVersions[0]) throw new Error('Computer Use plugin is not installed');",
  "  var cuClient = await import(cuPath.join(cuRoot, cuVersions[0], 'scripts', 'computer-use-client.mjs'));",
  "  await cuClient.setupComputerUseRuntime({ globals: globalThis });",
  "}",
].join("\n");

const NATIVE_COMPUTER_USE_WRAPPER_MARKER = "/* opencodex-native-computer-use-call */";

export const NATIVE_COMPUTER_USE_SYSTEM_INSTRUCTIONS = [
  "Codex native Computer Use is available through the provided native node-repl executor (the provider-facing tool name is `mcp__node_repl_js`).",
  "When the user asks you to operate the desktop, browser, or an app, call that executor directly with JavaScript and inspect fresh state after each action.",
  "Use the native `@oai/sky` runtime: the gateway bootstraps it before every executor call when `globalThis.sky` is absent. If you need to bootstrap it yourself, use `nodeRepl.env.HOME` (or `process.env.HOME`), not a presumed `nodeRepl.homeDir`, then select the newest `~/.codex/plugins/cache/openai-bundled/computer-use` version and call `setupComputerUseRuntime({ globals: globalThis })`.",
  "Every direct action must include the target `app` as a plain data property: this includes `click`, `scroll`, `type_text`, `set_value`, `select_text`, `drag`, and `press_key`.",
  "Use exact API shapes: click and scroll use `element_index`; the Enter key is `Return`; modifier combinations are one string such as `super+t`, `super+l`, or `super+a` (the compatible spelling `meta+t` is also a string), never an array and never a `modifiers` field.",
  "There is no `sky.open_app` in this runtime, and no shell `open -a` fallback is needed: `sky.get_app_state({ app: 'com.google.Chrome' })` launches or attaches to the app transparently. Do not inspect a presumed `windows` field; the state shape is `{ app, screenshot, text }`, and the accessibility tree is in `state.text`.",
  "Initialize with `sky.get_app_state({ app: 'com.google.Chrome', disableDiff: true })`; an empty object or empty `text` immediately after launch/navigation means the accessibility snapshot is still loading, not that Chrome is unavailable. Retry `get_app_state` with `disableDiff: true` up to two more times before acting. After every click, scroll, type, key, or value action, call `get_app_state` and use only fresh element indices.",
  "When starting a separate web task, prefer a new tab. After opening it, focus the address bar with `press_key({ app, key: 'super+l' })`, select all with `super+a`, and only then enter the URL. Do not type a URL into the new-tab page search box; for ordinary HTTPS sites prefer the host without `https://` so keyboard layout cannot drop the colon. If a scheme or port is required, set the fresh address-bar element with `set_value` instead.",
  "For screenshots, use only `state.screenshot.url` from `get_app_state`, convert it with `fileURLToPath` from `node:url`, read the bytes, and call `nodeRepl.emitImage` with the matching MIME type (`image/jpeg` for `.jpeg`/`.jpg`, `image/png` for `.png`). `sky.screenshot`, `sky.target.screenshot`, and `view_image` are unsupported in this runtime. Chat endpoints may report that an image result was omitted; that is expected compatibility behavior, so continue with the accessibility tree and do not retry unsupported image APIs or use shell/image-copy workarounds.",
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
      description: "Self-contained JavaScript for the native Computer Use node runtime. The gateway automatically bootstraps @oai/sky and isolates this call, so use fresh local variables and inspect state after actions.",
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
export function normalizeNativeComputerUseToolArguments(rawArguments: string): string {
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

  return JSON.stringify({
    ...parsed,
    code: [
      NATIVE_COMPUTER_USE_WRAPPER_MARKER,
      "await (async () => {",
      NATIVE_COMPUTER_USE_BOOTSTRAP,
      code,
      "})();",
    ].join("\n"),
  });
}

export function isNativeComputerUseExecutorName(name: unknown): boolean {
  return NATIVE_COMPUTER_USE_EXECUTOR_NAMES.has(String(name || "").trim().toLowerCase());
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
  return isNativeComputerUseExecutorName(toolFunctionName(tool));
}

export function hasNativeComputerUseTool(tools?: unknown[]): boolean {
  return Array.isArray(tools) && tools.some((tool) => isNativeComputerUseExecutorName(toolFunctionName(tool)));
}

export function hasComputerUseTool(tools?: unknown[]): boolean {
  return Array.isArray(tools) && tools.some(isComputerUseTool);
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
