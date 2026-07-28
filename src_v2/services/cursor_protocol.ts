import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import http2 from "node:http2";
import { relative, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStepSchema,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  CreatePlanSuccessSchema,
  ExaFetchRequestResponseSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  InteractionResponseSchema,
  McpToolDefinitionSchema,
  McpToolsSchema,
  McpArgsSchema,
  McpToolCallSchema,
  McpToolResultSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpToolResultContentItemSchema,
  McpTextContentSchema,
  ShellArgsSchema,
  ShellToolCallSchema,
  ShellResultSchema,
  ShellSuccessSchema,
  ShellFailureSchema,
  ToolCallSchema,
  ModelDetailsSchema,
  AssistantMessageSchema,
  KvClientMessageSchema,
  GetBlobResultSchema,
  SetBlobResultSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  ReadErrorSchema,
  ReadFileNotFoundSchema,
  LsResultSchema,
  LsSuccessSchema,
  LsErrorSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepErrorSchema,
  GrepUnionResultSchema,
  GrepCountResultSchema,
  GrepContentResultSchema,
  GrepFileCountSchema,
  GrepFilesResultSchema,
  GrepFileMatchSchema,
  GrepContentMatchSchema,
  RequestContextEnvSchema,
  RequestContextResultSchema,
  RequestContextSuccessSchema,
  RequestContextSchema,
  ResumeActionSchema,
  ExecClientMessageSchema,
  ExecClientControlMessageSchema,
  ExecClientStreamCloseSchema,
  SwitchModeRequestResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type InteractionQuery,
} from "./cursor_gen/agent_pb.js";

/**
 * Minimal Cursor Connect/protobuf transport used by the subscription bridge.
 *
 * Cursor's desktop client does not expose an OpenAI-compatible endpoint. Its
 * model catalogue and chat APIs are unary/server-streaming protobuf RPCs over
 * the HTTP Connect protocol. Unary requests carry the raw protobuf message;
 * only server-streaming responses use the five-byte Connect envelope. This
 * file intentionally contains only the fields needed by the gateway and
 * never logs request or response contents.
 */

function encodeVarint(value: number): number[] {
  let current = Math.max(0, Math.floor(value));
  const bytes: number[] = [];
  do {
    let byte = current % 128;
    current = Math.floor(current / 128);
    if (current > 0) byte |= 0x80;
    bytes.push(byte);
  } while (current > 0);
  return bytes;
}

function fieldKey(field: number, wireType: number): number[] {
  return encodeVarint(field * 8 + wireType);
}

function bytesField(field: number, value: Uint8Array): Uint8Array {
  return Uint8Array.from([
    ...fieldKey(field, 2),
    ...encodeVarint(value.byteLength),
    ...value,
  ]);
}

function stringField(field: number, value: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(value));
}

function boolField(field: number, value: boolean): Uint8Array {
  return Uint8Array.from([...fieldKey(field, 0), value ? 1 : 0]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

// Cursor's desktop transport creates one 32-byte client key for the lifetime
// of its agent host and sends it on streaming RPCs. Keep the same boundary in
// the gateway without reading or persisting any Cursor credential material.
const cursorClientKey = randomBytes(32).toString("hex");
const execFileAsync = promisify(execFileCallback);

function getInstalledCursorCommit(): string {
  try {
    const product = JSON.parse(readFileSync(
      "/Applications/Cursor.app/Contents/Resources/app/product.json",
      "utf-8",
    )) as { commit?: unknown };
    return typeof product.commit === "string" ? product.commit : "unknown";
  } catch {
    return "unknown";
  }
}

function cursorHeaders(token: string, clientVersion: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    // Cursor's unary catalogue RPC uses application/proto; its current
    // server-streaming Composer RPC requires application/connect+proto on
    // the request as well as the response.
    "Content-Type": accept,
    Accept: accept,
    "Connect-Protocol-Version": "1",
    "x-request-id": randomUUID(),
    "x-client-key": cursorClientKey,
    "x-cursor-client-key": cursorClientKey,
    "x-cursor-streaming": "true",
    "x-cursor-client-type": "ide",
    "x-cursor-client-version": clientVersion,
    "x-cursor-client-commit": getInstalledCursorCommit(),
    "x-cursor-client-device-type": "desktop",
    "x-cursor-client-os": "darwin",
    "x-cursor-client-arch": process.arch,
  };
}

/** Connect binary protocol envelope: flags byte + big-endian uint32 length. */
export function frameConnectMessage(message: Uint8Array, flags = 0): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags & 0xff;
  new DataView(header.buffer).setUint32(1, message.byteLength, false);
  return concat([header, message]);
}

export function encodeAvailableModelsRequest(): Uint8Array {
  return concat([
    boolField(2, true),
    boolField(5, true),
    boolField(6, false),
    boolField(11, true),
  ]);
}

function encodeConversationMessage(text: string, type: 1 | 2): Uint8Array {
  return concat([stringField(1, text), encodeEnumField(2, type)]);
}

function encodeEnumField(field: number, value: number): Uint8Array {
  return Uint8Array.from([...fieldKey(field, 0), ...encodeVarint(value)]);
}

function encodeModelDetails(model: string): Uint8Array {
  return stringField(1, model);
}

export type CursorChatMessage = { role: string; content: string };

export type CursorChatTool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
  name?: string;
  description?: string;
  parameters?: unknown;
};

export type CursorChatOptions = {
  workspaceRoot?: string;
  onToolResult?: (result: CursorToolResult) => void;
  onToolEvent?: (event: CursorToolEvent) => void;
  manualExternalTools?: boolean;
  onExternalToolRequest?: (request: CursorExternalToolRequest) => void;
  continuation?: CursorToolContinuation;
  tools?: CursorChatTool[];
  onServerMessage?: (message: AgentServerMessage) => void;
  /** Return true once to append a bounded continuation after a native tool turn. */
  onTurnEnded?: (hadNativeTools: boolean) => boolean;
  /** Re-open a bounded AgentRun when Cursor closes the HTTP/2 stream after native tools. */
  autoContinueAfterNativeTools?: boolean;
  nativeFollowupDepth?: number;
  resume?: boolean;
};

export type CursorToolResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CursorToolEvent = {
  phase: "requested" | "completed" | "responded";
  transport: "mcp" | "native" | "shell";
  id: number;
  execId?: string;
  name: string;
  arguments?: string;
  exitCode?: number;
};

export type CursorExternalToolRequest = {
  transport: "mcp" | "shell";
  id: number;
  execId?: string;
  /** Cursor provider tool id; this is not the Codex function_call id. */
  providerCallId?: string;
  name: string;
  arguments: string;
  /**
   * Deliver the outer Codex tool result back to this still-open native
   * AgentService stream. This is deliberately an in-memory capability rather
   * than part of the wire payload.
   */
  respond?: (output: string, isError?: boolean) => Promise<void>;
};

export type CursorToolContinuation = {
  transport: "mcp" | "shell";
  callId: string;
  execId?: string;
  /** The original Cursor tool id expected in the provider-side result. */
  providerCallId?: string;
  name: string;
  arguments: string;
  output: string;
  isError: boolean;
};

const CURSOR_MCP_PROVIDER = "opencodex-responses";
const CURSOR_MCP_DISPLAY_PREFIX = `mcp_${CURSOR_MCP_PROVIDER}_`;

// Capability negotiation is deliberate. The Cursor bridge must advertise
// only tools that it can execute and answer on the AgentService stream. In
// particular, advertising every Codex/MCP tool makes Cursor select tools such
// as write_stdin, apply_patch, or plugin tools that this bridge cannot fulfill.
const CURSOR_SUPPORTED_MCP_TOOLS = new Set(["exec_command", "view_file", "list_dir"]);

function normalizeCursorMcpToolName(name: string): string {
  if (name.startsWith(CURSOR_MCP_DISPLAY_PREFIX)) return name.slice(CURSOR_MCP_DISPLAY_PREFIX.length);
  const alternatePrefix = `mcp__${CURSOR_MCP_PROVIDER}__`;
  if (name.startsWith(alternatePrefix)) return name.slice(alternatePrefix.length);
  return name;
}

function cursorSupportedTools(tools: CursorChatTool[] | undefined): CursorChatTool[] {
  return (tools || []).filter((rawTool) => {
    const fn = rawTool.function || rawTool;
    const name = normalizeCursorMcpToolName(String(fn.name || "").trim());
    return CURSOR_SUPPORTED_MCP_TOOLS.has(name);
  });
}

export function cursorAdvertisedToolNames(tools: CursorChatTool[] | undefined): string[] {
  return cursorSupportedTools(tools).map((rawTool) => {
    const fn = rawTool.function || rawTool;
    return normalizeCursorMcpToolName(String(fn.name || "").trim());
  }).filter(Boolean);
}
const cursorTextEncoder = new TextEncoder();
const cursorBlobStore = new Map<string, { data: Uint8Array; storedAt: number }>();
const CURSOR_BLOB_TTL_MS = 15 * 60 * 1000;
const CURSOR_BLOB_MAX_ENTRIES = 4096;

function cursorBlobKey(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function storeCursorBlob(data: Uint8Array): Uint8Array {
  const id = new Uint8Array(createHash("sha256").update(data).digest());
  const key = cursorBlobKey(id);
  cursorBlobStore.delete(key);
  cursorBlobStore.set(key, { data: new Uint8Array(data), storedAt: Date.now() });
  while (cursorBlobStore.size > CURSOR_BLOB_MAX_ENTRIES) {
    const oldest = cursorBlobStore.keys().next().value;
    if (!oldest) break;
    cursorBlobStore.delete(oldest);
  }
  return id;
}

function readCursorBlob(id: Uint8Array): Uint8Array | undefined {
  const key = cursorBlobKey(id);
  const entry = cursorBlobStore.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > CURSOR_BLOB_TTL_MS) {
    cursorBlobStore.delete(key);
    return undefined;
  }
  return new Uint8Array(entry.data);
}

function cursorBlob(data: unknown): Uint8Array {
  return storeCursorBlob(cursorTextEncoder.encode(JSON.stringify(data)));
}

function parseContinuationOutput(output: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const parsed = JSON.parse(output) as any;
    return {
      exitCode: typeof parsed?.exit_code === "number" ? parsed.exit_code : 0,
      stdout: String(parsed?.stdout || ""),
      stderr: String(parsed?.stderr || ""),
    };
  } catch {
    return { exitCode: 0, stdout: output, stderr: "" };
  }
}

function cursorToolContinuationStep(continuation: CursorToolContinuation) {
  const args = (() => {
    try { return JSON.parse(continuation.arguments || "{}"); } catch { return {}; }
  })();
  const output = parseContinuationOutput(continuation.output);
  const message = continuation.transport === "mcp"
    ? create(ToolCallSchema, {
      tool: {
        case: "mcpToolCall",
        value: create(McpToolCallSchema, {
          args: create(McpArgsSchema, {
            name: continuation.name,
            args: Object.fromEntries(Object.entries(args).map(([key, value]) => [
              key,
              new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)),
            ])),
            toolCallId: continuation.providerCallId || continuation.callId,
            providerIdentifier: CURSOR_MCP_PROVIDER,
            toolName: continuation.name,
          }),
          result: create(McpToolResultSchema, {
            result: {
              case: "success",
              value: create(McpSuccessSchema, {
                isError: continuation.isError,
                content: [create(McpToolResultContentItemSchema, {
                  content: {
                    case: "text",
                    value: create(McpTextContentSchema, { text: continuation.output }),
                  },
                })],
              }),
            },
          }),
        }),
      },
    })
    : create(ToolCallSchema, {
      tool: {
        case: "shellToolCall",
        value: create(ShellToolCallSchema, {
          args: create(ShellArgsSchema, {
            command: String(args?.cmd || ""),
            workingDirectory: String(args?.workdir || ""),
            timeout: 120000,
            toolCallId: continuation.providerCallId || continuation.callId,
            simpleCommands: [],
            hasInputRedirect: false,
            hasOutputRedirect: false,
            isBackground: false,
            skipApproval: false,
            timeoutBehavior: 0,
          }),
          result: create(ShellResultSchema, {
            result: continuation.isError
              ? {
                case: "failure",
                value: create(ShellFailureSchema, {
                  command: String(args?.cmd || ""),
                  workingDirectory: String(args?.workdir || ""),
                  exitCode: output.exitCode,
                  signal: "",
                  stdout: output.stdout,
                  stderr: output.stderr,
                  executionTime: 0,
                  aborted: false,
                }),
              }
              : {
                case: "success",
                value: create(ShellSuccessSchema, {
                  command: String(args?.cmd || ""),
                  workingDirectory: String(args?.workdir || ""),
                  exitCode: output.exitCode,
                  signal: "",
                  stdout: output.stdout,
                  stderr: output.stderr,
                  executionTime: 0,
                }),
              },
          }),
        }),
      },
    });
  return create(ConversationStepSchema, { message: { case: "toolCall", value: message } });
}

function cursorConversationState(messages: CursorChatMessage[], continuation?: CursorToolContinuation): ConversationStateStructure {
  const normalized = messages
    .map((message) => ({ role: String(message.role || "user"), content: String(message.content || "").trim() }))
    .filter((message) => message.content.length > 0);
  const roots: Uint8Array[] = [];
  const turnRecords: Array<{ text: string; steps: Uint8Array[] }> = [];
  let continuationUsed = false;

  for (const message of normalized) {
    if (message.role === "system") {
      roots.push(cursorBlob({ role: "system", content: message.content }));
      continue;
    }
    if (message.role === "user") {
      turnRecords.push({ text: message.content, steps: [] });
      roots.push(cursorBlob({ role: "user", content: [{ type: "text", text: message.content }] }));
      continue;
    }
    if (message.role === "assistant") {
      roots.push(cursorBlob({ role: "assistant", content: [{ type: "text", text: message.content }] }));
      const currentUser = turnRecords.at(-1);
      if (currentUser) {
        currentUser.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
          message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: message.content }) },
        }))));
      }
      continue;
    }
    if (message.role === "tool") {
      roots.push(cursorBlob({ role: "user", content: [{ type: "text", text: `[Tool Result]\n${message.content}` }] }));
      const currentUser = turnRecords.at(-1);
      if (currentUser) {
        const step = continuation && !continuationUsed
          ? cursorToolContinuationStep(continuation)
          : create(ConversationStepSchema, {
            message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: `[Tool Result]\n${message.content}` }) },
          });
        continuationUsed = true;
        currentUser.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, step)));
      }
    }
  }

  // The newest user turn is supplied by AgentRunRequest.action.user_message.
  // Every earlier user turn is complete history, including its assistant/tool
  // steps. This is essential for a tool result followed by a new user
  // instruction: the provider must see the result attached to the prior turn,
  // not as an orphaned root prompt.
  const turns = turnRecords.slice(0, -1).map((turnRecord) => {
    const userMessage = toBinary(UserMessageSchema, create(UserMessageSchema, {
      text: turnRecord.text,
      messageId: randomUUID(),
      mode: 1,
    }));
    return storeCursorBlob(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn",
        value: create(AgentConversationTurnStructureSchema, {
          userMessage: storeCursorBlob(userMessage),
          steps: turnRecord.steps,
        }),
      },
    })));
  });
  return create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: roots,
    turns,
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    readPaths: [],
  });
}

function cursorToolDefinitions(tools: CursorChatTool[] | undefined) {
  const definitions = cursorSupportedTools(tools).map((rawTool) => {
    const fn = rawTool.function || rawTool;
    const name = String(fn.name || "").trim();
    if (!name) return null;
    const schema = fn.parameters && typeof fn.parameters === "object"
      ? fn.parameters
      : { type: "object", properties: {} };
    return create(McpToolDefinitionSchema, {
      name,
      providerIdentifier: CURSOR_MCP_PROVIDER,
      toolName: name,
      description: String(fn.description || ""),
      // Cursor's MCP schema field is a protobuf Value, not UTF-8 JSON bytes.
      // Sending raw JSON here is accepted by the transport but leaves the
      // AgentService turn in a heartbeat-only state.
      inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, schema as any)),
    });
  }).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
  return create(McpToolsSchema, { mcpTools: definitions });
}

function cursorRequestContext() {
  const timeZone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  })();
  return create(RequestContextSchema, {
    env: create(RequestContextEnvSchema, {
      timeZone,
    }),
  });
}

/**
 * Build the actual AgentService request. This is deliberately protocol data:
 * tools are advertised in AgentRunRequest.mcpTools and are never described by
 * a synthetic prompt or selected by keyword matching.
 */
export function encodeAgentRunRequest(
  messages: CursorChatMessage[],
  model: string,
  requestId: string,
  conversationId: string,
  options: CursorChatOptions = {},
): Uint8Array {
  const normalized = messages
    .map((message) => ({ role: String(message.role || "user"), content: String(message.content || "").trim() }))
    .filter((message) => message.content.length > 0);
  const latestUserIndex = normalized.map((message) => message.role).lastIndexOf("user");
  const latestUserText = latestUserIndex >= 0 ? normalized[latestUserIndex]!.content : normalized.at(-1)?.content || "";
  const priorConversation = latestUserIndex > 0
    ? normalized.slice(0, latestUserIndex)
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
      .join("\n\n")
    : "";
  const userText = priorConversation
    ? `Conversation history:\n${priorConversation}\n\nCurrent user message:\n${latestUserText}`
    : latestUserText;
  const userMessage = create(UserMessageSchema, {
    text: userText,
    messageId: requestId,
    // AgentService uses UNSPECIFIED=0 when this is omitted.  The Responses
    // route is an agent/tool turn, so select the native AGENT mode explicitly.
    mode: 1,
  });
  const action = options.resume
    ? create(ConversationActionSchema, {
      action: {
        case: "resumeAction",
        value: create(ResumeActionSchema, {
          requestContext: cursorRequestContext(),
        }),
      },
    })
    : create(ConversationActionSchema, {
      action: {
        case: "userMessageAction",
        value: create(UserMessageActionSchema, {
          userMessage,
          requestContext: cursorRequestContext(),
        }),
      },
    });
  const request = create(AgentRunRequestSchema, {
    conversationState: cursorConversationState(messages, options.continuation),
    action,
    modelDetails: create(ModelDetailsSchema, {
      modelId: model,
      displayModelId: model,
      displayName: model,
      displayNameShort: model,
    }),
    mcpTools: cursorToolDefinitions(options.tools),
    conversationId,
  });
  return frameConnectMessage(toBinary(
    AgentClientMessageSchema,
    create(AgentClientMessageSchema, { message: { case: "runRequest", value: request } }),
  ));
}

function encodeCursorAgentMessage(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message)));
}

function encodeCursorHeartbeat(): Uint8Array {
  return encodeCursorAgentMessage({
    message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
  });
}

function encodeCursorResumeAction(): Uint8Array {
  return encodeCursorAgentMessage({
    message: {
      case: "conversationAction",
      value: create(ConversationActionSchema, {
        action: {
          case: "resumeAction",
          value: create(ResumeActionSchema, {
            requestContext: cursorRequestContext(),
          }),
        },
      }),
    },
  });
}

function encodeCursorRequestContextResult(id: number, workspaceRoot: string, tools: CursorChatTool[] | undefined): Uint8Array {
  const context = cursorRequestContext();
  const clientMessage = create(AgentClientMessageSchema, {
    message: {
      case: "execClientMessage",
      value: create(ExecClientMessageSchema, {
        id,
        message: {
          case: "requestContextResult",
          value: create(RequestContextResultSchema, {
            result: {
              case: "success",
              value: create(RequestContextSuccessSchema, {
                requestContext: create(RequestContextSchema, {
                  ...context,
                  tools: cursorToolDefinitions(tools).mcpTools,
                }),
              }),
            },
          }),
        },
      }),
    },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage));
}

function encodeCursorExecStreamClose(id: number): Uint8Array {
  return encodeCursorAgentMessage({
    message: {
      case: "execClientControlMessage",
      value: create(ExecClientControlMessageSchema, {
        message: { case: "streamClose", value: create(ExecClientStreamCloseSchema, { id }) },
      }),
    },
  });
}

function encodeCursorNativeExecResult(
  execMessage: import("./cursor_gen/agent_pb.js").ExecServerMessage,
  messageCase: "readResult" | "lsResult" | "grepResult",
  value: unknown,
): Uint8Array {
  return encodeCursorAgentMessage({
    message: {
      case: "execClientMessage",
      value: create(ExecClientMessageSchema, {
        id: execMessage.id,
        execId: execMessage.execId,
        message: { case: messageCase, value: value as never },
      }),
    },
  });
}

/**
 * Convert the result produced by the outer Codex tool into the exact native
 * result message requested by Cursor. The provider asked for read/ls/grep,
 * while the outer contract exposes exec_command; returning a shell-shaped
 * result here would leave the native Agent turn waiting forever or make it
 * restart from a reconstructed prompt.
 */
function encodeCursorNativeExternalResult(
  execMessage: import("./cursor_gen/agent_pb.js").ExecServerMessage,
  output: string,
  isError: boolean,
): Uint8Array {
  const parsed = parseContinuationOutput(output);
  const failed = isError || parsed.exitCode !== 0;
  const message = execMessage.message;
  if (message.case === "readArgs") {
    const value = create(ReadResultSchema, {
      result: failed
        ? { case: "error", value: create(ReadErrorSchema, { path: message.value.path, error: parsed.stderr || parsed.stdout || "tool execution failed" }) }
        : {
          case: "success",
          value: create(ReadSuccessSchema, {
            path: message.value.path,
            totalLines: parsed.stdout.length === 0 ? 0 : parsed.stdout.split(/\r\n|\r|\n/).length,
            fileSize: BigInt(Buffer.byteLength(parsed.stdout, "utf8")),
            truncated: false,
            output: { case: "content", value: parsed.stdout },
          }),
        },
    });
    return encodeCursorNativeExecResult(execMessage, "readResult", value);
  }

  if (message.case === "lsArgs") {
    const names = parsed.stdout
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^total\s+/i.test(line))
      .map((line) => line.split(/\s+/).at(-1) || "")
      .filter(Boolean);
    const childrenFiles = names.map((name) => create(LsDirectoryTreeNode_FileSchema, { name }));
    const value = create(LsResultSchema, {
      result: failed
        ? { case: "error", value: create(LsErrorSchema, { path: message.value.path, error: parsed.stderr || parsed.stdout || "tool execution failed" }) }
        : {
          case: "success",
          value: create(LsSuccessSchema, {
            directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
              absPath: message.value.path,
              childrenDirs: [],
              childrenFiles,
              childrenWereProcessed: true,
              fullSubtreeExtensionCounts: Object.fromEntries(childrenFiles.map((file) => {
                const dot = file.name.lastIndexOf(".");
                return [dot > 0 ? file.name.slice(dot) : "(none)", 1];
              })),
              numFiles: childrenFiles.length,
            }),
          }),
        },
    });
    return encodeCursorNativeExecResult(execMessage, "lsResult", value);
  }

  const args = message.case === "grepArgs" ? message.value : undefined;
  const grouped = new Map<string, import("./cursor_gen/agent_pb.js").GrepFileMatch>();
  if (!failed && args) {
    for (const line of parsed.stdout.split(/\r\n|\r|\n/)) {
      const firstColon = line.indexOf(":");
      const secondColon = firstColon < 0 ? -1 : line.indexOf(":", firstColon + 1);
      if (firstColon <= 0 || secondColon <= firstColon) continue;
      const file = line.slice(0, firstColon);
      const lineNumber = Number(line.slice(firstColon + 1, secondColon));
      if (!Number.isFinite(lineNumber)) continue;
      const existing = grouped.get(file) || create(GrepFileMatchSchema, { file, matches: [] });
      existing.matches.push(create(GrepContentMatchSchema, {
        lineNumber,
        content: line.slice(secondColon + 1),
        contentTruncated: false,
        isContextLine: false,
      }));
      grouped.set(file, existing);
    }
  }
  const matches = [...grouped.values()];
  const totalMatches = matches.reduce((sum, file) => sum + file.matches.length, 0);
  const union = create(GrepUnionResultSchema, {
    result: {
      case: "content",
      value: create(GrepContentResultSchema, {
        matches,
        totalLines: totalMatches,
        totalMatchedLines: totalMatches,
        clientTruncated: false,
        ripgrepTruncated: false,
      }),
    },
  });
  const value = create(GrepResultSchema, {
    result: failed
      ? { case: "error", value: create(GrepErrorSchema, { error: parsed.stderr || parsed.stdout || "tool execution failed" }) }
      : {
        case: "success",
        value: create(GrepSuccessSchema, {
          pattern: args?.pattern || "",
          path: args?.path || ".",
          outputMode: args?.outputMode || "content",
          workspaceResults: { [args?.path || "."]: union },
        }),
      },
  });
  return encodeCursorNativeExecResult(execMessage, "grepResult", value);
}

function workspacePath(root: string, requested: string): string {
  const workspace = resolvePath(root);
  const path = resolvePath(workspace, requested || ".");
  const rel = relative(workspace, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("path is outside the workspace");
  return path;
}

function executeCursorNativeRead(
  execMessage: import("./cursor_gen/agent_pb.js").ExecServerMessage,
  root: string,
): Uint8Array {
  if (execMessage.message.case !== "readArgs") throw new Error("invalid read exec");
  let path = resolvePath(root, ".");
  try {
    path = workspacePath(root, execMessage.message.value.path);
    const bytes = readFileSync(path);
    const content = new TextDecoder().decode(bytes.subarray(0, 1_000_000));
    const result = create(ReadResultSchema, {
      result: {
        case: "success",
        value: create(ReadSuccessSchema, {
          path,
          totalLines: content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length,
          fileSize: BigInt(bytes.length),
          truncated: bytes.length > 1_000_000,
          output: { case: "content", value: content },
        }),
      },
    });
    return encodeCursorNativeExecResult(execMessage, "readResult", result);
  } catch (error) {
    const message = String(error?.message || error);
    const result = create(ReadResultSchema, {
      result: message.includes("ENOENT")
        ? { case: "fileNotFound", value: create(ReadFileNotFoundSchema, { path }) }
        : { case: "error", value: create(ReadErrorSchema, { path, error: message }) },
    });
    return encodeCursorNativeExecResult(execMessage, "readResult", result);
  }
}

function executeCursorNativeLs(
  execMessage: import("./cursor_gen/agent_pb.js").ExecServerMessage,
  root: string,
): Uint8Array {
  if (execMessage.message.case !== "lsArgs") throw new Error("invalid ls exec");
  let path = resolvePath(root, ".");
  try {
    path = workspacePath(root, execMessage.message.value.path);
    const entries = readdirSync(path, { withFileTypes: true }).slice(0, 500);
    const childrenDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => create(LsDirectoryTreeNodeSchema, {
      absPath: resolvePath(path, entry.name),
      childrenDirs: [],
      childrenFiles: [],
      childrenWereProcessed: false,
      fullSubtreeExtensionCounts: {},
      numFiles: 0,
    }));
    const childrenFiles = entries.filter((entry) => entry.isFile()).map((entry) => create(LsDirectoryTreeNode_FileSchema, { name: entry.name }));
    const result = create(LsResultSchema, {
      result: {
        case: "success",
        value: create(LsSuccessSchema, {
          directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
            absPath: path,
            childrenDirs,
            childrenFiles,
            childrenWereProcessed: true,
            fullSubtreeExtensionCounts: Object.fromEntries(childrenFiles.map((file) => {
              const dot = file.name.lastIndexOf(".");
              return [dot > 0 ? file.name.slice(dot) : "(none)", 1];
            })),
            numFiles: childrenFiles.length,
          }),
        }),
      },
    });
    return encodeCursorNativeExecResult(execMessage, "lsResult", result);
  } catch (error) {
    const result = create(LsResultSchema, {
      result: { case: "error", value: create(LsErrorSchema, { path, error: String(error?.message || error) }) },
    });
    return encodeCursorNativeExecResult(execMessage, "lsResult", result);
  }
}

function executeCursorNativeGrep(
  execMessage: import("./cursor_gen/agent_pb.js").ExecServerMessage,
  root: string,
): Uint8Array {
  if (execMessage.message.case !== "grepArgs") throw new Error("invalid grep exec");
  const args = execMessage.message.value;
  let path = resolvePath(root, ".");
  try {
    path = workspacePath(root, args.path || ".");
    const pattern = new RegExp(args.pattern, args.caseInsensitive ? "i" : "");
    const files: string[] = [];
    const collect = (candidate: string) => {
      if (files.length >= 500) return;
      const stat = statSync(candidate);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(candidate, { withFileTypes: true })) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          collect(resolvePath(candidate, entry.name));
        }
      } else if (stat.isFile() && stat.size <= 1_000_000) files.push(candidate);
    };
    collect(path);
    const matches = files.map((file) => {
      const lines = readFileSync(file, "utf8").split(/\r\n|\r|\n/);
      const content = lines.flatMap((line, index) => pattern.test(line)
        ? [create(GrepContentMatchSchema, { lineNumber: index + 1, content: line, contentTruncated: false, isContextLine: false })]
        : []);
      return content.length > 0 ? create(GrepFileMatchSchema, { file, matches: content }) : undefined;
    }).filter((value): value is NonNullable<typeof value> => Boolean(value)).slice(0, 200);
    const outputMode = args.outputMode || "content";
    const totalMatches = matches.reduce((sum, file) => sum + file.matches.length, 0);
    const union = outputMode === "count"
      ? create(GrepUnionResultSchema, {
        result: {
          case: "count",
          value: create(GrepCountResultSchema, {
            counts: matches.map((file) => create(GrepFileCountSchema, { file: file.file, count: file.matches.length })),
            totalFiles: matches.length,
            totalMatches,
            clientTruncated: files.length >= 500,
            ripgrepTruncated: false,
          }),
        },
      })
      : outputMode === "files_with_matches"
        ? create(GrepUnionResultSchema, {
          result: {
            case: "files",
            value: create(GrepFilesResultSchema, {
              files: matches.map((file) => file.file),
              totalFiles: matches.length,
              clientTruncated: files.length >= 500,
              ripgrepTruncated: false,
            }),
          },
        })
        : create(GrepUnionResultSchema, {
          result: {
            case: "content",
            value: create(GrepContentResultSchema, {
              matches,
              totalLines: totalMatches,
              totalMatchedLines: totalMatches,
              clientTruncated: files.length >= 500,
              ripgrepTruncated: false,
            }),
          },
        });
    const result = create(GrepResultSchema, {
      result: {
        case: "success",
        value: create(GrepSuccessSchema, {
          pattern: args.pattern,
          path,
          outputMode: args.outputMode || "content",
          workspaceResults: { [relative(resolvePath(root), path) || path]: union },
        }),
      },
    });
    return encodeCursorNativeExecResult(execMessage, "grepResult", result);
  } catch (error) {
    const result = create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error: String(error?.message || error) }) },
    });
    return encodeCursorNativeExecResult(execMessage, "grepResult", result);
  }
}

function encodeCursorMcpResult(id: number, execId: string, text: string, isError: boolean): Uint8Array {
  return encodeCursorAgentMessage({
    message: {
      case: "execClientMessage",
      value: create(ExecClientMessageSchema, {
        id,
        execId,
        message: {
          case: "mcpResult",
          value: create((awaitableMcpResultSchema()), {
            result: {
              case: "success",
              value: create(McpSuccessSchema, {
                isError,
                content: [create(McpToolResultContentItemSchema, {
                  content: { case: "text", value: create(McpTextContentSchema, { text }) },
                })],
              }),
            },
          }),
        },
      }),
    },
  });
}

function encodeCursorKvResponse(message: import("./cursor_gen/agent_pb.js").KvServerMessage): Uint8Array {
  const kvMessage = message.message.case === "getBlobArgs"
    ? {
        case: "getBlobResult" as const,
        value: create(GetBlobResultSchema, readCursorBlob(message.message.value.blobId)
          ? { blobData: readCursorBlob(message.message.value.blobId) }
          : {}),
      }
    : message.message.case === "setBlobArgs"
      ? {
          case: "setBlobResult" as const,
          value: create(SetBlobResultSchema, {}),
        }
      : undefined;
  if (message.message.case === "setBlobArgs") {
    const blob = message.message.value;
    const key = cursorBlobKey(blob.blobId);
    cursorBlobStore.set(key, { data: new Uint8Array(blob.blobData), storedAt: Date.now() });
  }
  return encodeCursorAgentMessage({
    message: {
      case: "kvClientMessage",
      value: create(KvClientMessageSchema, { id: message.id, message: kvMessage }),
    },
  });
}

// Kept as a small indirection so the large generated module remains the only
// source of protobuf field numbers and oneof layout.
function awaitableMcpResultSchema() {
  return McpResultSchema;
}

async function executeCursorMcpTool(
  execMessage: import("./cursor_gen/agent_pb.js").ExecServerMessage,
  workspaceRoot: string,
  onToolResult?: (result: CursorToolResult) => void,
  onToolEvent?: (event: CursorToolEvent) => void,
): Promise<Uint8Array> {
  const args = execMessage.message.case === "mcpArgs" ? execMessage.message.value : undefined;
  const rawArgs = Object.fromEntries(Object.entries(args?.args || {}).map(([key, value]) => {
    const text = new TextDecoder().decode(value);
    try { return [key, JSON.parse(text)]; } catch { return [key, text]; }
  }));
  const toolName = normalizeCursorMcpToolName(String(args?.toolName || args?.name || ""));
  onToolEvent?.({
    phase: "requested",
    transport: "mcp",
    id: execMessage.id,
    execId: execMessage.execId,
    name: toolName || "(unnamed)",
    arguments: JSON.stringify(rawArgs),
  });
  const command = typeof rawArgs.cmd === "string" ? rawArgs.cmd
    : typeof rawArgs.command === "string" ? rawArgs.command : "";
  if (["view_file", "list_dir"].includes(toolName)) {
    const root = resolvePath(workspaceRoot);
    const requested = resolvePath(root, typeof rawArgs.path === "string" ? rawArgs.path : ".");
    const rel = relative(root, requested);
    if (rel === ".." || rel.startsWith(`..${sep}`) || requested === "") {
      onToolEvent?.({ phase: "completed", transport: "mcp", id: execMessage.id, execId: execMessage.execId, name: toolName, exitCode: 126 });
      return encodeCursorMcpResult(execMessage.id, execMessage.execId, "OpenCodex denied a path outside the workspace.", true);
    }
    try {
      if (toolName === "view_file") {
        const content = readFileSync(requested, "utf8");
        onToolEvent?.({ phase: "completed", transport: "mcp", id: execMessage.id, execId: execMessage.execId, name: toolName, exitCode: 0 });
        return encodeCursorMcpResult(execMessage.id, execMessage.execId, JSON.stringify({ path: requested, content }), false);
      }
      const entries = readdirSync(requested, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }));
      onToolEvent?.({ phase: "completed", transport: "mcp", id: execMessage.id, execId: execMessage.execId, name: toolName, exitCode: 0 });
      return encodeCursorMcpResult(execMessage.id, execMessage.execId, JSON.stringify({ path: requested, entries }), false);
    } catch (error) {
      onToolEvent?.({ phase: "completed", transport: "mcp", id: execMessage.id, execId: execMessage.execId, name: toolName, exitCode: 1 });
      return encodeCursorMcpResult(execMessage.id, execMessage.execId, String(error?.message || error), true);
    }
  }
  if (!command || !["exec_command", "shell_command"].includes(toolName)) {
    onToolEvent?.({ phase: "completed", transport: "mcp", id: execMessage.id, execId: execMessage.execId, name: toolName || "(unnamed)", exitCode: 126 });
    return encodeCursorMcpResult(
      execMessage.id,
      execMessage.execId,
      `OpenCodex does not have an implementation for Cursor MCP tool ${toolName || "(unnamed)"}.`,
      true,
    );
  }
  let result: CursorToolResult | undefined;
  await executeCursorShell({
    id: execMessage.id,
    execId: execMessage.execId,
    command,
    workingDirectory: typeof rawArgs.workdir === "string" ? rawArgs.workdir : workspaceRoot,
    timeoutMs: typeof rawArgs.timeout_ms === "number" ? rawArgs.timeout_ms : 120000,
    streaming: false,
  }, workspaceRoot, (value) => {
    result = value;
    onToolResult?.(value);
    onToolEvent?.({
      phase: "completed",
      transport: "mcp",
      id: execMessage.id,
      execId: execMessage.execId,
      name: toolName,
      exitCode: value.exitCode,
    });
  });
  const output = result?.stdout?.trim() || "";
  const error = result?.stderr?.trim() || "";
  const text = result?.exitCode === 0
    ? JSON.stringify({ command, exit_code: 0, stdout: output, stderr: error })
    : JSON.stringify({ command, exit_code: result?.exitCode ?? 1, stdout: output, stderr: error });
  return encodeCursorMcpResult(execMessage.id, execMessage.execId, text, result?.exitCode !== 0);
}

function encodeCursorInteractionResponse(query: InteractionQuery): Uint8Array {
  const reason = "opencodex bridge is non-interactive; proceed without this interaction.";
  let result: any;
  switch (query.query.case) {
    case "createPlanRequestQuery":
      result = {
        case: "createPlanRequestResponse",
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, { result: { case: "success", value: create(CreatePlanSuccessSchema, {}) } }),
        }),
      };
      break;
    case "askQuestionInteractionQuery":
      result = {
        case: "askQuestionInteractionResponse",
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: { case: "rejected", value: create(AskQuestionRejectedSchema, { reason }) },
          }),
        }),
      };
      break;
    case "switchModeRequestQuery":
      result = {
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: { case: "rejected", value: create(SwitchModeRequestResponse_RejectedSchema, { reason }) },
        }),
      };
      break;
    case "webSearchRequestQuery":
      result = {
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: { case: "approved", value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
        }),
      };
      break;
    case "exaSearchRequestQuery":
      result = {
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: { case: "approved", value: create(ExaSearchRequestResponse_ApprovedSchema, {}) },
        }),
      };
      break;
    case "exaFetchRequestQuery":
      result = {
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: { case: "approved", value: create(ExaFetchRequestResponse_ApprovedSchema, {}) },
        }),
      };
      break;
    default:
      result = undefined;
  }
  return encodeCursorAgentMessage({
    message: {
      case: "interactionResponse",
      value: create(InteractionResponseSchema, { id: query.id, result }),
    },
  });
}

export function encodeGetChatRequest(
  messages: CursorChatMessage[],
  model: string,
  requestId: string,
  conversationId: string,
): Uint8Array {
  const normalized = messages
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim(),
    }))
    .filter((message) => message.content.length > 0);

  const firstHuman = normalized.findIndex((message) => message.role === "user");
  if (firstHuman >= 0) {
    const systemText = normalized
      .slice(0, firstHuman)
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    if (systemText) {
      normalized[firstHuman] = {
        ...normalized[firstHuman],
        content: `${systemText}\n\n${normalized[firstHuman].content}`,
      };
    }
  }

  const conversation = normalized
    .filter((message) => message.role !== "system")
    .map((message) => {
      const type: 1 | 2 = message.role === "assistant" ? 2 : 1;
      return bytesField(2, encodeConversationMessage(message.content, type));
    });

  return concat([
    ...conversation,
    bytesField(7, encodeModelDetails(model)),
    stringField(9, requestId),
    stringField(15, conversationId),
    // Explicitly disable Cursor's own provider fallback. An imported
    // subscription must never silently switch to another provider/model.
    boolField(30, false),
  ]);
}

/**
 * Encode the current Cursor Composer request. Cursor's installed desktop
 * client now calls AiService/StreamComposer with GetComposerChatRequest;
 * the older GetChatRequest/StreamChat pair is still reachable but has been
 * deprecated upstream.
 */
export function encodeComposerChatRequest(
  messages: CursorChatMessage[],
  model: string,
  conversationId: string,
): Uint8Array {
  const normalized = messages
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim(),
    }))
    .filter((message) => message.content.length > 0);

  const firstHuman = normalized.findIndex((message) => message.role === "user");
  if (firstHuman >= 0) {
    const systemText = normalized
      .slice(0, firstHuman)
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    if (systemText) {
      normalized[firstHuman] = {
        ...normalized[firstHuman],
        content: `${systemText}\n\n${normalized[firstHuman].content}`,
      };
    }
  }

  const conversation = normalized
    .filter((message) => message.role !== "system")
    .map((message) => {
      const type: 1 | 2 = message.role === "assistant" ? 2 : 1;
      return bytesField(1, encodeConversationMessage(message.content, type));
    });

  return concat([
    ...conversation,
    bytesField(5, encodeModelDetails(model)),
    stringField(23, conversationId),
    boolField(24, true),
  ]);
}

/** Encode the current Cursor ChatService request used by the installed client. */
export function encodeUnifiedChatRequest(
  messages: CursorChatMessage[],
  model: string,
  conversationId: string,
): Uint8Array {
  const composerRequest = encodeComposerChatRequest(messages, model, conversationId);
  return concat([
    composerRequest,
    boolField(22, true), // is_chat
    boolField(33, true), // use_unified_chat_prompt
    boolField(37, false), // allow_model_fallbacks
  ]);
}

type ParsedField = { field: number; wireType: number; value: number | Uint8Array };

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length && shift < 53) {
    const byte = bytes[cursor++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new Error("Invalid Cursor protobuf varint");
}

function parseFields(bytes: Uint8Array): ParsedField[] {
  const fields: ParsedField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.next;
    const field = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (field <= 0) throw new Error("Invalid Cursor protobuf field");
    if (wireType === 0) {
      const parsed = readVarint(bytes, offset);
      fields.push({ field, wireType, value: parsed.value });
      offset = parsed.next;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.next;
      const end = offset + length.value;
      if (end > bytes.length) throw new Error("Invalid Cursor protobuf length");
      fields.push({ field, wireType, value: bytes.slice(offset, end) });
      offset = end;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 3) {
      // A few AgentService bookkeeping messages still contain legacy
      // protobuf groups. They are not text-bearing fields, but they must be
      // skipped so a later InteractionUpdate can still be decoded.
      offset = skipProtobufGroup(bytes, offset);
    } else if (wireType === 4) {
      break;
    } else {
      // Unknown extension fields are safe to ignore while decoding the
      // provider's evolving AgentService messages.
      break;
    }
    if (offset > bytes.length) throw new Error("Invalid Cursor protobuf field boundary");
  }
  return fields;
}

function skipProtobufGroup(bytes: Uint8Array, offset: number): number {
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.next;
    const wireType = key.value % 8;
    if (wireType === 4) return offset;
    if (wireType === 3) {
      offset = skipProtobufGroup(bytes, offset);
      continue;
    }
    if (wireType === 0) {
      offset = readVarint(bytes, offset).next;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.next + length.value;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      return offset;
    }
    if (offset > bytes.length) throw new Error("Invalid Cursor protobuf group boundary");
  }
  return offset;
}

function decodeAgentRequestContextId(message: Uint8Array): number | null {
  try {
    const execMessage = parseFields(message).find((field) => field.field === 2 && field.wireType === 2);
    const execBytes = asBytes(execMessage?.value as number | Uint8Array);
    if (!execBytes) return null;
    const fields = parseFields(execBytes);
    const id = fields.find((field) => field.field === 1 && field.wireType === 0);
    const requestContext = fields.find((field) => field.field === 10 && field.wireType === 2);
    // Proto3 omits the default uint32 id, which means the first request is
    // commonly sent without field 1 and therefore uses id 0.
    return requestContext ? Number(id?.value ?? 0) : null;
  } catch {
    return null;
  }
}

function encodeAgentRequestContextResponse(id: number, workspaceRoot: string): Uint8Array[] {
  const requestContext = concat([
    bytesField(4, concat([
      stringField(1, `${process.platform} ${process.arch}`),
      stringField(2, workspaceRoot),
      stringField(3, "/bin/zsh"),
      boolField(5, false),
      stringField(11, workspaceRoot),
      stringField(21, workspaceRoot),
    ])),
    boolField(33, true),
    boolField(36, true),
    boolField(39, true),
    boolField(40, true),
    boolField(41, true),
    boolField(43, true),
    boolField(44, true),
    boolField(45, true),
  ]);
  const requestContextSuccess = bytesField(1, requestContext);
  const requestContextResult = bytesField(1, requestContextSuccess);
  const execClientMessage = concat([
    encodeEnumField(1, id),
    bytesField(10, requestContextResult),
  ]);
  return [
    frameConnectMessage(bytesField(2, execClientMessage)),
    encodeCursorExecStreamClose(id),
  ];
}

function asBytes(value: number | Uint8Array): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function asString(value: number | Uint8Array): string {
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
}

function fieldString(fields: ParsedField[], fieldNumber: number): string {
  const field = fields.find((candidate) => candidate.field === fieldNumber && candidate.wireType === 2);
  return asString(field?.value as number | Uint8Array).trim();
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function cursorNativeToolRequest(
  execMessage: import("./cursor_gen/agent_pb.js").ExecServerMessage,
  workspaceRoot: string,
): CursorExternalToolRequest | undefined {
  const message = execMessage.message;
  const root = resolvePath(workspaceRoot);
  if (message.case === "readArgs") {
    const path = resolvePath(root, message.value.path || ".");
    return {
      transport: "shell",
      id: execMessage.id,
      execId: execMessage.execId,
      providerCallId: message.value.toolCallId,
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: `cat ${shellQuote(path)}`,
        workdir: root,
      }),
    };
  }
  if (message.case === "lsArgs") {
    const path = resolvePath(root, message.value.path || ".");
    return {
      transport: "shell",
      id: execMessage.id,
      execId: execMessage.execId,
      providerCallId: message.value.toolCallId,
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: `ls -la ${shellQuote(path)}`,
        workdir: root,
      }),
    };
  }
  if (message.case === "grepArgs") {
    const args = message.value;
    const path = resolvePath(root, args.path || ".");
    const commandParts = ["rg", "--line-number"];
    if (args.caseInsensitive) commandParts.push("--ignore-case");
    if (args.multiline) commandParts.push("--multiline");
    if (args.outputMode === "files_with_matches") commandParts.push("--files-with-matches");
    if (args.outputMode === "count") commandParts.push("--count");
    if (args.glob) commandParts.push("--glob", shellQuote(args.glob));
    if (args.type) commandParts.push("--type", shellQuote(args.type));
    if (args.context !== undefined) commandParts.push("--context", String(Math.max(0, args.context)));
    if (args.contextBefore !== undefined) commandParts.push("--before-context", String(Math.max(0, args.contextBefore)));
    if (args.contextAfter !== undefined) commandParts.push("--after-context", String(Math.max(0, args.contextAfter)));
    commandParts.push("--", shellQuote(args.pattern), shellQuote(path));
    return {
      transport: "shell",
      id: execMessage.id,
      execId: execMessage.execId,
      providerCallId: args.toolCallId,
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: commandParts.join(" "),
        workdir: root,
      }),
    };
  }
  return undefined;
}

type CursorShellRequest = {
  id: number;
  execId: string;
  toolCallId?: string;
  command: string;
  workingDirectory: string;
  timeoutMs: number;
  streaming: boolean;
};

function decodeCursorShellRequest(message: Uint8Array): CursorShellRequest | null {
  try {
    const execMessage = parseFields(message).find((field) => field.field === 2 && field.wireType === 2);
    const execBytes = asBytes(execMessage?.value as number | Uint8Array);
    if (!execBytes) return null;
    const execFields = parseFields(execBytes);
    const shellArgs = execFields.find((field) => (field.field === 2 || field.field === 14) && field.wireType === 2);
    const shellBytes = asBytes(shellArgs?.value as number | Uint8Array);
    if (!shellBytes) return null;
    const shellFields = parseFields(shellBytes);
    const idField = execFields.find((field) => field.field === 1 && field.wireType === 0);
    const command = fieldString(shellFields, 1);
    if (!command) return null;
    const timeoutField = shellFields.find((field) => field.field === 3 && field.wireType === 0);
    return {
      id: Number(idField?.value ?? 0),
      // The native client forwards only ExecServerMessage.exec_id here.
      // ShellArgs.tool_call_id identifies the model tool call, but is not the
      // transport-level exec_id and must not be copied into ExecClientMessage.
      execId: fieldString(execFields, 15),
      toolCallId: fieldString(shellFields, 4),
      command,
      workingDirectory: fieldString(shellFields, 2),
      timeoutMs: Math.max(1000, Math.min(120000, Number(timeoutField?.value ?? 30000))),
      streaming: shellArgs?.field === 14,
    };
  } catch {
    return null;
  }
}

function encodeCursorShellResult(
  request: CursorShellRequest,
  exitCode: number,
  stdout: string,
  stderr: string,
  elapsedMs: number,
): Uint8Array[] {
  if (request.streaming) {
    const streamEvents: Uint8Array[] = [];
    // Cursor's streaming shell protocol expects an explicit start event before
    // stdout/stderr and the final exit event.
    streamEvents.push(bytesField(4, new Uint8Array(0)));
    if (stdout) streamEvents.push(bytesField(1, stringField(1, stdout)));
    if (stderr) streamEvents.push(bytesField(2, stringField(1, stderr)));
    streamEvents.push(bytesField(3, concat([
      encodeEnumField(1, exitCode),
      stringField(2, request.workingDirectory),
      boolField(4, false),
      encodeEnumField(6, Math.min(elapsedMs, 120000)),
    ])));
    const streamFrames = streamEvents.map((event) => {
      const execClientMessage = concat([
        encodeEnumField(1, request.id),
        request.execId ? stringField(15, request.execId) : new Uint8Array(0),
        encodeEnumField(39, Math.min(elapsedMs, 120000)),
        bytesField(14, event),
      ]);
      return frameConnectMessage(bytesField(2, execClientMessage));
    });
    // The native Agent client closes every exec stream explicitly after the
    // final shell_stream event. Without this control message the upstream
    // keeps waiting for more tool output and never resumes the model turn.
    return [
      ...streamFrames,
      encodeCursorExecStreamClose(request.id),
    ];
  }
  const resultFields = concat([
    stringField(1, request.command),
    stringField(2, request.workingDirectory),
    encodeEnumField(3, exitCode),
    stringField(5, stdout.slice(0, 256 * 1024)),
    stringField(6, stderr.slice(0, 64 * 1024)),
      encodeEnumField(7, Math.min(elapsedMs, 120000)),
  ]);
  const shellResult = bytesField(exitCode === 0 ? 1 : 2, resultFields);
  const execClientMessage = concat([
    encodeEnumField(1, request.id),
    request.execId ? stringField(15, request.execId) : new Uint8Array(0),
    encodeEnumField(39, Math.min(elapsedMs, 120000)),
    bytesField(2, shellResult),
  ]);
  return [
    frameConnectMessage(bytesField(2, execClientMessage)),
    encodeCursorExecStreamClose(request.id),
  ];
}

function shellCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 4000) return false;
  // Cursor commonly batches read-only discovery as `pwd && ls -la`. Keep the
  // native tool loop intact while validating every segment independently.
  if (trimmed.includes("&&")) {
    if (/(^|[^&])&([^&]|$)/.test(trimmed)) return false;
    const segments = trimmed.split(/\s*&&\s*/).map((segment) => segment.trim());
    return segments.length > 1 && segments.every((segment) => shellCommandAllowed(segment));
  }
  // Keep the subscription bridge read-only by default. Test/build commands
  // are allowed because the user explicitly uses this route for repository
  // audits; shell metacharacters and network/destructive commands are not.
  if (/[;|<>`$()]|\$\(/.test(trimmed)) return false;
  if (/(^|[^&])&([^&]|$)/.test(trimmed)) return false;
  if (/(^|\s)(sudo|rm|mv|cp|chmod|chown|kill|pkill|curl|wget|ssh|scp|osascript|open)\b/i.test(trimmed)) return false;
  if (/(^|\s)(~|\/)(?!Users\/aitabby\/projects\/opencodex(?:\/|\s|$))/i.test(trimmed)) return false;
  if (/^npm\s+(?:install|i|uninstall|publish|link|exec)\b/i.test(trimmed)) return false;
  const executable = trimmed.split(/\s+/, 1)[0].replace(/^.*\//, "");
  return new Set(["pwd", "date", "ls", "find", "rg", "grep", "sed", "cat", "head", "tail", "wc", "sort", "uniq", "file", "git", "npm", "node", "tsc"]).has(executable);
}

async function executeCursorShell(
  request: CursorShellRequest,
  workspaceRoot: string,
  onToolResult?: (result: CursorToolResult) => void,
  onToolEvent?: (event: CursorToolEvent) => void,
): Promise<Uint8Array[]> {
  const root = workspaceRoot || process.cwd();
  const requestedDirectory = request.workingDirectory || root;
  const cwd = requestedDirectory.startsWith("/") ? requestedDirectory : `${root}/${requestedDirectory}`;
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (cwd !== normalizedRoot && !cwd.startsWith(`${normalizedRoot}/`)) {
    const result = { command: request.command, exitCode: 126, stdout: "", stderr: `OpenCodex denied working directory outside the workspace: ${cwd}` };
    onToolResult?.(result);
    onToolEvent?.({ phase: "completed", transport: "shell", id: request.id, execId: request.execId, name: "shell", exitCode: result.exitCode });
    return encodeCursorShellResult({ ...request, workingDirectory: cwd }, 126, "", `OpenCodex denied working directory outside the workspace: ${cwd}`, 0);
  }
  if (!shellCommandAllowed(request.command)) {
    const result = { command: request.command, exitCode: 126, stdout: "", stderr: "OpenCodex denied this command; only safe workspace audit/test commands are allowed." };
    onToolResult?.(result);
    onToolEvent?.({ phase: "completed", transport: "shell", id: request.id, execId: request.execId, name: "shell", exitCode: result.exitCode });
    return encodeCursorShellResult({ ...request, workingDirectory: cwd }, 126, "", "OpenCodex denied this command; only safe workspace audit/test commands are allowed.", 0);
  }

  const startedAt = Date.now();
  try {
    const result = await execFileAsync("/bin/zsh", ["-lc", request.command], {
      cwd,
      timeout: request.timeoutMs,
      maxBuffer: 320 * 1024,
      encoding: "utf8",
    });
    const stdout = String(result.stdout || "");
    const stderr = String(result.stderr || "");
    onToolResult?.({ command: request.command, exitCode: 0, stdout, stderr });
    onToolEvent?.({ phase: "completed", transport: "shell", id: request.id, execId: request.execId, name: "shell", exitCode: 0 });
    return encodeCursorShellResult({ ...request, workingDirectory: cwd }, 0, stdout, stderr, Date.now() - startedAt);
  } catch (error: any) {
    const exitCode = typeof error?.code === "number" ? error.code : 1;
    const stdout = String(error?.stdout || "");
    const stderr = String(error?.stderr || error?.message || "");
    onToolResult?.({ command: request.command, exitCode, stdout, stderr });
    onToolEvent?.({ phase: "completed", transport: "shell", id: request.id, execId: request.execId, name: "shell", exitCode });
    return encodeCursorShellResult({ ...request, workingDirectory: cwd }, exitCode, stdout, stderr, Date.now() - startedAt);
  }
}

async function writeCursorFrames(
  request: http2.ClientHttp2Stream | null,
  frames: Uint8Array[],
): Promise<void> {
  for (const frame of frames) {
    if (!request || request.destroyed || request.closed) return;
    await new Promise<void>((resolve) => {
      try {
        request.write(Buffer.from(frame), () => resolve());
      } catch {
        resolve();
      }
    });
  }
}

export type CursorModel = { slug: string; name: string };

export function decodeAvailableModelsResponse(message: Uint8Array): CursorModel[] {
  const result: CursorModel[] = [];
  const seen = new Set<string>();
  for (const field of parseFields(message)) {
    if (field.field === 1 && field.wireType === 2) {
      const slug = asString(field.value).trim();
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        result.push({ slug, name: slug });
      }
      continue;
    }
    if (field.field !== 2 || field.wireType !== 2) continue;
    const modelBytes = asBytes(field.value);
    if (!modelBytes) continue;
    let slug = "";
    let name = "";
    let hidden = false;
    for (const modelField of parseFields(modelBytes)) {
      if (modelField.field === 1 && modelField.wireType === 2) slug = asString(modelField.value).trim();
      if (modelField.field === 17 && modelField.wireType === 2) name = asString(modelField.value).trim();
      if (modelField.field === 18 && modelField.wireType === 2) {
        const serverName = asString(modelField.value).trim();
        if (serverName) slug = serverName;
      }
      if (modelField.field === 35 && modelField.wireType === 0) hidden = Number(modelField.value) !== 0;
    }
    if (slug && !hidden && !seen.has(slug)) {
      seen.add(slug);
      result.push({ slug, name: name || slug });
    }
  }
  return result;
}

export function decodeConnectMessages(bytes: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset];
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    offset += 5;
    if (offset + length > bytes.length) throw new Error("Incomplete Cursor Connect frame");
    const message = bytes.slice(offset, offset + length);
    offset += length;
    if ((flags & 0x01) !== 0) throw new Error("Cursor returned a compressed protobuf frame");
    // Connect uses bit 1 for the end-stream/trailer frame. The trailer is
    // transport metadata, not a StreamChatResponse protobuf message.
    if ((flags & 0x02) !== 0) continue;
    messages.push(message);
  }
  if (offset !== bytes.length) throw new Error("Invalid Cursor Connect frame boundary");
  return messages;
}

export function decodeCursorStreamText(message: Uint8Array): string {
  try {
    // AgentServerMessage.interaction_update (field 1) contains a oneof
    // InteractionUpdate. Only InteractionUpdate.text_delta (field 1), whose
    // TextDeltaUpdate.text is also field 1, is user-visible model text.
    // Avoid recursive field-1 searching: prompt_suggestion and
    // post_request_prompt also contain strings and must stay UI metadata.
    const interaction = parseFields(message)
      .find((field) => field.field === 1 && field.wireType === 2);
    const interactionBytes = asBytes(interaction?.value as number | Uint8Array);
    if (!interactionBytes) return "";
    const update = parseFields(interactionBytes)
      .find((field) => field.field === 1 && field.wireType === 2);
    const textDelta = asBytes(update?.value as number | Uint8Array);
    if (!textDelta) return "";
    const text = parseFields(textDelta)
      .find((field) => field.field === 1 && field.wireType === 2);
    return asString(text?.value as number | Uint8Array);
  } catch {
    return "";
  }
}

/**
 * The current AgentService sends the end of a turn as
 * AgentServerMessage.interaction_update.turn_ended (field 14). The bidi
 * transport itself remains open for follow-up context/tool messages, so this
 * semantic marker must be handled separately from the HTTP stream ending.
 */
export function decodeCursorStreamComplete(message: Uint8Array): boolean {
  try {
    const interaction = parseFields(message)
      .find((field) => field.field === 1 && field.wireType === 2);
    const interactionBytes = asBytes(interaction?.value as number | Uint8Array);
    if (!interactionBytes) return false;
    // Cursor may omit turn_ended on this compatibility route, but its
    // prompt_suggestion/post_request_prompt updates are emitted at the same
    // post-turn boundary. They are UI metadata, not assistant text, so use
    // them as a terminal hint and do not forward their contents.
    return parseFields(interactionBytes)
      .some((field) => field.wireType === 2 && [14, 18, 19].includes(field.field));
  } catch {
    return false;
  }
}

export function decodeCursorToolCallCompleted(message: Uint8Array): boolean {
  try {
    const interaction = parseFields(message)
      .find((field) => field.field === 1 && field.wireType === 2);
    const interactionBytes = asBytes(interaction?.value as number | Uint8Array);
    return Boolean(interactionBytes && parseFields(interactionBytes)
      .some((field) => field.field === 3 && field.wireType === 2));
  } catch {
    return false;
  }
}

export function decodeCursorEndStreamError(message: Uint8Array): string | null {
  const text = new TextDecoder().decode(message);
  try {
    const parsed = JSON.parse(text) as any;
    const error = parsed?.error;
    const debugDetails = Array.isArray(error?.details)
      ? error.details
        .map((detail: any) => detail?.debug?.details?.detail || detail?.debug?.details?.title)
        .find((value: unknown) => typeof value === "string" && value)
      : null;
    if (debugDetails) return String(debugDetails);
    if (typeof error?.message === "string" && error.message) return String(error.message);
    if (typeof error === "string" && error) return error;
  } catch {}
  return null;
}

function responseLooksFramed(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, false);
  return bytes[0] <= 3 && length <= bytes.byteLength - 5;
}

export function decodeCursorResponse(bytes: Uint8Array): Uint8Array[] {
  return responseLooksFramed(bytes) ? decodeConnectMessages(bytes) : [bytes];
}

export async function fetchCursorModels(
  token: string,
  clientVersion: string,
  signal?: AbortSignal,
): Promise<CursorModel[]> {
  const response = await fetch("https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels", {
    method: "POST",
    headers: cursorHeaders(token, clientVersion, "application/proto"),
    // Connect unary requests are raw protobuf, not a streaming envelope.
    body: Buffer.from(encodeAvailableModelsRequest()),
    signal,
  });
  if (!response.ok) throw new Error(`Cursor AvailableModels returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return decodeAvailableModelsResponse(bytes);
}

export async function streamCursorChat(
  token: string,
  messages: CursorChatMessage[],
  model: string,
  requestId: string,
  conversationId: string,
  clientVersion: string,
  signal?: AbortSignal,
  options: CursorChatOptions = {},
): Promise<Response> {
  // Cursor's current desktop Agent host uses the HTTP/2 bidi AgentService.
  // StreamUnifiedChat remains available in the bundle but is rejected by the
  // current upstream as an outdated client even with desktop headers.
  const requestBody = encodeAgentRunRequest(messages, model, requestId, conversationId, options);
  const clientKey = randomBytes(32).toString("hex");
  const agentClientVersion = `cli-${new Date().toISOString().slice(0, 10).replace(/-/g, ".")}-agent-host`;

  return new Promise<Response>((resolve, reject) => {
    const session = http2.connect("https://agent.api5.cursor.sh");
    let settled = false;
    let request: http2.ClientHttp2Stream | null = null;
    const heartbeat = setInterval(() => {
      void writeCursorFrames(request, [encodeCursorHeartbeat()]);
    }, 5000);
    const cleanup = () => {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", onAbort);
      if (!session.closed && !session.destroyed) session.close();
    };
    const onAbort = () => {
      request?.close(http2.constants.NGHTTP2_CANCEL);
      session.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    session.once("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let responseBuffer = new Uint8Array(0);
        const answeredRequestContexts = new Set<number>();
        const answeredExecMessages = new Set<string>();
        // A native AgentService turn may emit several tool frames in one
        // HTTP/2 data event. When the outer Codex contract owns execution, we
        // must expose exactly one tool request, pause frame consumption, and
        // only release the buffered next frame after its result is written.
        // Otherwise later native tool requests are consumed and discarded
        // while the first function_call is still waiting in Codex.
        let manualToolPaused = false;
        let nativeToolsUsedInTurn = false;
        request = session.request({
          ":method": "POST",
          ":path": "/agent.v1.AgentService/Run",
          ":scheme": "https",
          ":authority": "agent.api5.cursor.sh",
          authorization: `Bearer ${token}`,
          "content-type": "application/connect+proto",
          accept: "application/connect+proto",
          "connect-protocol-version": "1",
          "x-request-id": requestId,
          "x-cursor-client-version": agentClientVersion,
          "x-cursor-client-type": "cli",
          "x-cursor-client-key": clientKey,
          "x-cursor-streaming": "true",
        });
        request.once("response", (headers) => {
          settled = true;
          resolve(new Response(body, {
            status: Number(headers[":status"] || 0),
            headers: { "content-type": String(headers["content-type"] || "application/connect+proto") },
          }));
        });
        request.on("data", (chunk: Buffer) => {
          const incoming = new Uint8Array(chunk);
          const merged = new Uint8Array(responseBuffer.byteLength + incoming.byteLength);
          merged.set(responseBuffer);
          merged.set(incoming, responseBuffer.byteLength);
          responseBuffer = merged;
          if (manualToolPaused) return;
          let offset = 0;
          while (responseBuffer.byteLength - offset >= 5) {
            const flags = responseBuffer[offset]!;
            const length = new DataView(responseBuffer.buffer, responseBuffer.byteOffset + offset + 1, 4).getUint32(0, false);
            if (responseBuffer.byteLength - offset - 5 < length) break;
            const payload = responseBuffer.slice(offset + 5, offset + 5 + length);
            offset += 5 + length;
            if ((flags & 0x02) === 0) {
              try {
                const serverMessage = fromBinary(AgentServerMessageSchema, payload);
                options.onServerMessage?.(serverMessage);
                if (serverMessage.message.case === "kvServerMessage") {
                  void writeCursorFrames(request, [encodeCursorKvResponse(serverMessage.message.value)]);
                } else if (serverMessage.message.case === "interactionQuery") {
                  void writeCursorFrames(request, [encodeCursorInteractionResponse(serverMessage.message.value)]);
                } else if (serverMessage.message.case === "execServerMessage") {
                  const execMessage = serverMessage.message.value;
                  if (execMessage.message.case === "requestContextArgs") {
                    answeredRequestContexts.add(execMessage.id);
                    void writeCursorFrames(request, [encodeCursorRequestContextResult(execMessage.id, options.workspaceRoot || process.cwd(), options.tools)]);
                  } else if (execMessage.message.case === "readArgs" || execMessage.message.case === "lsArgs" || execMessage.message.case === "grepArgs") {
                    const key = `${execMessage.id}:${execMessage.message.case}`;
                    if (!answeredExecMessages.has(key)) {
                      answeredExecMessages.add(key);
                      const externalRequest = cursorNativeToolRequest(execMessage, options.workspaceRoot || process.cwd());
                      if (options.manualExternalTools && options.onExternalToolRequest && externalRequest) {
                        let responded = false;
                        externalRequest.respond = async (output, isError = false) => {
                          if (responded) return;
                          responded = true;
                          await writeCursorFrames(request, [
                            encodeCursorNativeExternalResult(execMessage, output, isError),
                            encodeCursorExecStreamClose(execMessage.id),
                          ]);
                          manualToolPaused = false;
                          request?.emit("data", Buffer.alloc(0));
                          options.onToolEvent?.({
                            phase: "responded",
                            transport: "native",
                            id: execMessage.id,
                            execId: execMessage.execId,
                            name: execMessage.message.case,
                          });
                        };
                        options.onToolEvent?.({ phase: "requested", ...externalRequest });
                        manualToolPaused = true;
                        options.onExternalToolRequest(externalRequest);
                      } else {
                        nativeToolsUsedInTurn = true;
                        options.onToolEvent?.({
                          phase: "requested",
                          transport: "native",
                          id: execMessage.id,
                          execId: execMessage.execId,
                          name: execMessage.message.case,
                          arguments: "{}",
                        });
                        const frame = execMessage.message.case === "readArgs"
                          ? executeCursorNativeRead(execMessage, options.workspaceRoot || process.cwd())
                          : execMessage.message.case === "lsArgs"
                            ? executeCursorNativeLs(execMessage, options.workspaceRoot || process.cwd())
                            : executeCursorNativeGrep(execMessage, options.workspaceRoot || process.cwd());
                        void writeCursorFrames(request, [frame, encodeCursorExecStreamClose(execMessage.id)]).then(() => {
                          options.onToolEvent?.({
                            phase: "responded",
                            transport: "native",
                            id: execMessage.id,
                            execId: execMessage.execId,
                            name: execMessage.message.case,
                          });
                        });
                      }
                    }
                  } else if (execMessage.message.case === "mcpArgs") {
                    const mcp = execMessage.message.value;
                    const key = `${execMessage.id}:${mcp.toolCallId}:${mcp.toolName || mcp.name}`;
                    if (!answeredExecMessages.has(key)) {
                      answeredExecMessages.add(key);
                      const toolName = normalizeCursorMcpToolName(String(mcp.toolName || mcp.name || "")) || "(unnamed)";
                      const rawArgs = Object.fromEntries(Object.entries(mcp.args || {}).map(([key, value]) => {
                        const text = new TextDecoder().decode(value);
                        try { return [key, JSON.parse(text)]; } catch { return [key, text]; }
                      }));
                      const externalRequest: CursorExternalToolRequest = {
                        transport: "mcp" as const,
                        id: execMessage.id,
                        execId: execMessage.execId,
                        providerCallId: mcp.toolCallId,
                        name: toolName,
                        arguments: JSON.stringify(rawArgs),
                      };
                      if (options.manualExternalTools && options.onExternalToolRequest) {
                        let responded = false;
                        externalRequest.respond = async (output, isError = false) => {
                          if (responded) return;
                          responded = true;
                          await writeCursorFrames(request, [encodeCursorMcpResult(execMessage.id, execMessage.execId, output, isError)]);
                          manualToolPaused = false;
                          request?.emit("data", Buffer.alloc(0));
                          options.onToolEvent?.({
                            phase: "responded",
                            transport: "mcp",
                            id: execMessage.id,
                            execId: execMessage.execId,
                            name: toolName,
                            exitCode: isError ? 1 : 0,
                          });
                        };
                        options.onToolEvent?.({ phase: "requested", ...externalRequest });
                        manualToolPaused = true;
                        options.onExternalToolRequest(externalRequest);
                      } else {
                        void executeCursorMcpTool(execMessage, options.workspaceRoot || process.cwd(), options.onToolResult, options.onToolEvent)
                          .then((frame) => writeCursorFrames(request, [frame]).then(() => {
                            options.onToolEvent?.({
                              phase: "responded",
                              transport: "mcp",
                              id: execMessage.id,
                              execId: execMessage.execId,
                              name: toolName,
                            });
                          }))
                          .catch((error) => writeCursorFrames(request, [
                            encodeCursorMcpResult(execMessage.id, execMessage.execId, String(error?.message || error), true),
                          ]).then(() => {
                            options.onToolEvent?.({
                              phase: "responded",
                              transport: "mcp",
                              id: execMessage.id,
                              execId: execMessage.execId,
                              name: toolName,
                              exitCode: 1,
                            });
                          }));
                      }
                    }
                  }
                }
              } catch {
                // Keep the byte stream available to the compatibility decoder below.
              }
            }
            const requestContextId = decodeAgentRequestContextId(payload);
            if (requestContextId !== null && !answeredRequestContexts.has(requestContextId)) {
              answeredRequestContexts.add(requestContextId);
              void writeCursorFrames(request, encodeAgentRequestContextResponse(requestContextId, options.workspaceRoot || process.cwd()));
            }
            const shellRequest = decodeCursorShellRequest(payload);
            const shellRequestKey = shellRequest ? `${shellRequest.id}:${shellRequest.command}` : "";
            if (shellRequest && !answeredExecMessages.has(shellRequestKey)) {
              answeredExecMessages.add(shellRequestKey);
              const externalRequest: CursorExternalToolRequest = {
                transport: "shell" as const,
                id: shellRequest.id,
                execId: shellRequest.execId,
                providerCallId: shellRequest.toolCallId,
                name: "exec_command",
                arguments: JSON.stringify({ cmd: shellRequest.command, workdir: shellRequest.workingDirectory }),
              };
              if (options.manualExternalTools && options.onExternalToolRequest) {
                let responded = false;
                externalRequest.respond = async (output, isError = false) => {
                  if (responded) return;
                  responded = true;
                  const parsed = parseContinuationOutput(output);
                  const frames = encodeCursorShellResult(
                    shellRequest,
                    isError ? (parsed.exitCode || 1) : parsed.exitCode,
                    parsed.stdout,
                    parsed.stderr,
                    0,
                  );
                  await writeCursorFrames(request, frames);
                  manualToolPaused = false;
                  request?.emit("data", Buffer.alloc(0));
                  options.onToolEvent?.({
                    phase: "responded",
                    transport: "shell",
                    id: shellRequest.id,
                    execId: shellRequest.execId,
                    name: "shell",
                    exitCode: parsed.exitCode,
                  });
                };
                options.onToolEvent?.({ phase: "requested", ...externalRequest });
                manualToolPaused = true;
                options.onExternalToolRequest(externalRequest);
              } else {
                options.onToolEvent?.({ phase: "requested", ...externalRequest });
                void executeCursorShell(shellRequest, options.workspaceRoot || process.cwd(), options.onToolResult, (event) => {
                  options.onToolEvent?.({
                    ...event,
                    transport: "shell",
                    id: shellRequest.id,
                    execId: shellRequest.execId,
                    name: "shell",
                  });
                })
                  .then((frames) => {
                    options.onToolEvent?.({
                      phase: "responded",
                      transport: "shell",
                      id: shellRequest.id,
                      execId: shellRequest.execId,
                      name: "shell",
                    });
                    return writeCursorFrames(request, frames);
                  })
                  .catch(() => {});
              }
            }
            if (decodeCursorStreamComplete(payload) && options.onTurnEnded?.(nativeToolsUsedInTurn)) {
              nativeToolsUsedInTurn = false;
              void writeCursorFrames(request, [encodeCursorResumeAction()]);
            }
            if (manualToolPaused) break;
          }
          const processed = responseBuffer.slice(0, offset);
          responseBuffer = responseBuffer.slice(offset);
          if (processed.byteLength > 0) controller.enqueue(processed);
        });
        request.once("end", () => {
          const shouldReopenAfterNativeTools = Boolean(
            options.autoContinueAfterNativeTools &&
            (options.nativeFollowupDepth || 0) < 16 &&
            nativeToolsUsedInTurn,
          );
          if (!shouldReopenAfterNativeTools) {
            controller.close();
            cleanup();
            return;
          }

          nativeToolsUsedInTurn = false;
          cleanup();
          console.log("[OpenCodex Cursor] native-tool-stream-followup depth=1");
          void (async () => {
            try {
              const followup = await streamCursorChat(
                token,
                messages,
                model,
                `${requestId}-followup-${randomUUID()}`,
                conversationId,
                clientVersion,
                signal,
                {
                  ...options,
                  // The prior external tool result has already been included
                  // in the resumed messages; do not encode it twice.
                  continuation: undefined,
                  resume: true,
                  nativeFollowupDepth: (options.nativeFollowupDepth || 0) + 1,
                },
              );
              if (!followup.body) throw new Error("Cursor follow-up returned no body");
              const reader = followup.body.getReader();
              while (true) {
                const next = await reader.read();
                if (next.done) break;
                if (next.value) controller.enqueue(next.value);
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          })();
        });
        request.once("error", (error) => {
          controller.error(error);
          if (!settled) {
            settled = true;
            cleanup();
            reject(error);
          }
        });
        // AgentService is bidi: keep the request open so the gateway can
        // answer request-context/tool handshakes sent by the server.
        request.write(Buffer.from(requestBody));
      },
      cancel() {
        request?.close(http2.constants.NGHTTP2_CANCEL);
        cleanup();
      },
    });
  });
}
