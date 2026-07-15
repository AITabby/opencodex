export type MemoryRole = "system" | "developer" | "user" | "assistant";

export interface MemoryGitSnapshot {
  root?: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  changed_files?: string[];
  captured_at?: string;
}

export interface MemoryContinuity {
  pending_items?: string[];
  assumptions?: string[];
  known_issues?: string[];
  next_steps?: string[];
}

export interface MemoryMessage {
  role: MemoryRole;
  content: string;
  source_id?: string;
  timestamp?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: Array<Record<string, unknown>>;
}

export interface MemoryEvent {
  type: string;
  summary: string;
  source_id?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface OpenCodexMemoryPackage {
  schema: "opencodex.memory";
  version: 1 | 2;
  exported_at: string;
  imported_at?: string;
  title?: string;
  source?: {
    application?: string;
    thread_id?: string;
    model_provider?: string;
    model?: string;
    cwd?: string;
    created_at?: string;
    updated_at?: string;
    runtime_mode?: "native" | "gateway" | "unknown";
    git?: MemoryGitSnapshot;
  };
  environment?: {
    cwd?: string;
    runtime_mode?: "native" | "gateway" | "unknown";
    git?: MemoryGitSnapshot;
    captured_at?: string;
  };
  messages: MemoryMessage[];
  events?: MemoryEvent[];
  continuity?: MemoryContinuity;
}

export const OPENCODEX_MEMORY_TURN_ID = "opencodex-memory-import";

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, any>;
      if (typeof block.text === "string") return block.text;
      if (block.type === "tool_use") {
        return `[Tool call: ${block.name || "tool"} ${JSON.stringify(block.input ?? {})}]`;
      }
      if (block.type === "tool_result") {
        const resultText = textFromContent(block.content);
        return `[Tool result${block.tool_use_id ? ` ${block.tool_use_id}` : ""}: ${resultText}]`;
      }
      if (typeof block.content === "string") return block.content;
      if (block.type === "image_url" && block.image_url?.url) {
        return `[Image: ${block.image_url.url}]`;
      }
      if ((block.type === "image" || block.type === "input_image") && block.source?.url) {
        return `[Image: ${block.source.url}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeRole(role: unknown): MemoryRole | null {
  switch (String(role || "").toLowerCase()) {
    case "system":
      return "system";
    case "developer":
      return "developer";
    case "assistant":
    case "agent":
    case "ai":
      return "assistant";
    case "user":
    case "human":
      return "user";
    default:
      return null;
  }
}

function normalizeMessages(messages: unknown[]): MemoryMessage[] {
  const normalized: MemoryMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, any>;
    const rawRole = String(message.role ?? message.sender ?? message.author?.role ?? "").toLowerCase();
    const role = rawRole === "tool" || rawRole === "function"
      ? "developer"
      : normalizeRole(rawRole);
    let content = textFromContent(
      message.content ?? message.text ?? message.message ?? message.parts
    );
    if (!content && Array.isArray(message.tool_calls)) {
      content = message.tool_calls
        .map((call: any) => {
          const name = call.function?.name || call.name || "tool";
          const args = call.function?.arguments ?? call.arguments ?? {};
          return `[Tool call: ${name} ${typeof args === "string" ? args : JSON.stringify(args)}]`;
        })
        .join("\n");
    }
    if ((rawRole === "tool" || rawRole === "function") && content) {
      content = `[Tool result${message.name ? ` ${message.name}` : ""}: ${content}]`;
    }
    if (!role || !content) continue;
    const normalizedMessage: MemoryMessage = {
      role,
      content,
      source_id: typeof message.id === "string" ? message.id : undefined,
      timestamp: typeof message.timestamp === "string"
        ? message.timestamp
        : typeof message.created_at === "string" ? message.created_at : undefined,
      tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
      tool_name: typeof message.name === "string" ? message.name : undefined
    };
    if (Array.isArray(message.tool_calls)) {
      normalizedMessage.tool_calls = message.tool_calls.filter((call: unknown) => Boolean(call && typeof call === "object"));
    }
    normalized.push(normalizedMessage);
  }
  return normalized;
}

function fromChatGptExport(input: Record<string, any>): MemoryMessage[] {
  const mapping = input.mapping;
  if (!mapping || typeof mapping !== "object") return [];

  const messages: MemoryMessage[] = [];
  const orderedMessages = Object.values(mapping)
    .map((node: any) => node?.message)
    .filter(Boolean)
    .sort((a: any, b: any) => Number(a.create_time || 0) - Number(b.create_time || 0));

  for (const message of orderedMessages) {
    const role = normalizeRole(message.author?.role);
    const content = textFromContent(message.content?.parts ?? message.content);
    if (!role || !content) continue;
    messages.push({
      role,
      content,
      source_id: typeof message.id === "string" ? message.id : undefined,
      timestamp: typeof message.create_time === "number"
        ? new Date(message.create_time * 1000).toISOString()
        : undefined
    });
  }
  return messages;
}

function fromClaudeExport(input: Record<string, any>): MemoryMessage[] {
  const chatMessages = input.chat_messages;
  if (!Array.isArray(chatMessages)) return [];
  return normalizeMessages(chatMessages.map((message: any) => ({
    ...message,
    role: message.sender === "human" ? "user" : message.sender
  })));
}

export function normalizeImportedMemory(
  input: unknown,
  fallbackTitle = "Imported conversation"
): OpenCodexMemoryPackage {
  let messages: MemoryMessage[] = [];
  let title = fallbackTitle;
  let source: OpenCodexMemoryPackage["source"];
  let events: MemoryEvent[] | undefined;
  let continuity: MemoryContinuity | undefined;
  let exportedAt = new Date().toISOString();

  if (Array.isArray(input)) {
    messages = normalizeMessages(input);
  } else if (input && typeof input === "object") {
    const data = input as Record<string, any>;
    if (data.schema === "opencodex.memory" && (data.version === 1 || data.version === 2)) {
      messages = normalizeMessages(Array.isArray(data.messages) ? data.messages : []);
      title = typeof data.title === "string" ? data.title : fallbackTitle;
      source = data.source && typeof data.source === "object" ? data.source : undefined;
      events = Array.isArray(data.events) ? data.events : undefined;
      continuity = data.continuity && typeof data.continuity === "object" ? data.continuity : undefined;
      exportedAt = typeof data.exported_at === "string" ? data.exported_at : exportedAt;
    } else if (Array.isArray(data.messages)) {
      const systemText = textFromContent(data.system);
      if (systemText) messages.push({ role: "system", content: systemText });
      messages.push(...normalizeMessages(data.messages));
      title = typeof data.title === "string" ? data.title : fallbackTitle;
      source = data.source && typeof data.source === "object" ? data.source : undefined;
      events = Array.isArray(data.events) ? data.events : undefined;
      continuity = data.continuity && typeof data.continuity === "object" ? data.continuity : undefined;
      exportedAt = typeof data.exported_at === "string" ? data.exported_at : exportedAt;
    } else if (data.mapping) {
      messages = fromChatGptExport(data);
      title = typeof data.title === "string" ? data.title : fallbackTitle;
    } else if (Array.isArray(data.chat_messages)) {
      messages = fromClaudeExport(data);
      title = typeof data.name === "string" ? data.name : fallbackTitle;
    }
  }

  if (messages.length === 0) {
    throw new Error("No supported conversation messages were found in this file");
  }

  return {
    schema: "opencodex.memory",
    version: 2,
    exported_at: exportedAt,
    title,
    source,
    messages,
    events,
    continuity
  };
}

function threadItemText(item: Record<string, any>): string {
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    return item.content
      .map((part: Record<string, any>) => {
        if (part.type === "text") return part.text || "";
        if (part.type === "image") return `[Image: ${part.url || ""}]`;
        if (part.type === "localImage") return `[Local image: ${part.path || ""}]`;
        if (part.type === "skill") return `[Skill: ${part.name || part.path || ""}]`;
        if (part.type === "mention") return `[Mention: ${part.name || part.path || ""}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (item.type === "agentMessage") return String(item.text || "").trim();
  return "";
}

export function memoryPackageFromThread(thread: Record<string, any>): OpenCodexMemoryPackage {
  const messages: MemoryMessage[] = [];
  const events: MemoryEvent[] = [];

  for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const text = threadItemText(item);
      if (item.type === "userMessage" && text) {
        messages.push({
          role: "user",
          content: text,
          source_id: item.id,
          timestamp: typeof item.createdAt === "string" ? item.createdAt : undefined
        });
      } else if (item.type === "agentMessage" && text) {
        messages.push({
          role: "assistant",
          content: text,
          source_id: item.id,
          timestamp: typeof item.createdAt === "string" ? item.createdAt : undefined
        });
      } else if (item.type === "reasoning") {
        const summary = [
          ...(Array.isArray(item.summary) ? item.summary : []),
          ...(Array.isArray(item.content) ? item.content : [])
        ].filter(Boolean).join("\n").trim();
        if (summary) events.push({
          type: "reasoning_summary",
          summary,
          source_id: item.id,
          timestamp: typeof item.createdAt === "string" ? item.createdAt : undefined
        });
      } else if (item.type === "commandExecution") {
        events.push({
          type: "command_execution",
          summary: `${item.command || "Command"}: ${item.status || "unknown"}`,
          source_id: item.id,
          timestamp: typeof item.createdAt === "string" ? item.createdAt : undefined,
          data: {
            command: item.command,
            cwd: item.cwd,
            status: item.status,
            exit_code: item.exitCode,
            output: item.aggregatedOutput
          }
        });
      } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        events.push({
          type: "tool_call",
          summary: `${item.tool || "Tool"}: ${item.status || "unknown"}`,
          source_id: item.id,
          timestamp: typeof item.createdAt === "string" ? item.createdAt : undefined,
          data: {
            server: item.server,
            namespace: item.namespace,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error
          }
        });
      } else if (item.type === "fileChange") {
        events.push({
          type: "file_change",
          summary: `File change: ${item.status || "unknown"}`,
          source_id: item.id,
          timestamp: typeof item.createdAt === "string" ? item.createdAt : undefined,
          data: { changes: item.changes }
        });
      }
    }
  }

  if (messages.length === 0) {
    throw new Error("This Codex thread has no exportable user or assistant messages");
  }

  return {
    schema: "opencodex.memory",
    version: 2,
    exported_at: new Date().toISOString(),
    title: thread.name || thread.preview || `Codex thread ${thread.id || ""}`.trim(),
    source: {
      application: "Codex",
      thread_id: thread.id,
      model_provider: thread.modelProvider,
      model: thread.model,
      cwd: thread.cwd,
      created_at: thread.createdAt,
      updated_at: thread.updatedAt
    },
    messages,
    events: events.length ? events : undefined
  };
}

export function memoryPackageFromMessages(
  messages: MemoryMessage[],
  title: string,
  sourceThreadId?: string
): OpenCodexMemoryPackage {
  if (messages.length === 0) {
    throw new Error("No exportable conversation messages were found");
  }
  return {
    schema: "opencodex.memory",
    version: 2,
    exported_at: new Date().toISOString(),
    title,
    source: {
      application: "Codex",
      thread_id: sourceThreadId
    },
    messages
  };
}

export function toResponsesItems(memory: OpenCodexMemoryPackage): Record<string, any>[] {
  const source = memory.source || {};
  const sourceLines = [
    source.application && `来源应用：${source.application}`,
    source.thread_id && `来源会话：${source.thread_id}`,
    source.model && `来源模型：${source.model}`,
    source.model_provider && `来源模型提供方：${source.model_provider}`,
    source.cwd && `来源工作目录：${source.cwd}`,
    source.runtime_mode && `来源运行模式：${source.runtime_mode}`,
    source.git?.branch && `来源分支：${source.git.branch}`,
    source.git?.commit && `来源基线 commit：${source.git.commit}`,
    source.git?.dirty !== undefined && `来源是否有未提交变更：${source.git.dirty ? "是" : "否"}`
  ].filter(Boolean);
  const environmentLines = [
    memory.environment?.cwd && `当前工作目录：${memory.environment.cwd}`,
    memory.environment?.runtime_mode && `当前运行模式：${memory.environment.runtime_mode}`,
    memory.environment?.git?.branch && `当前分支：${memory.environment.git.branch}`,
    memory.environment?.git?.commit && `当前 HEAD：${memory.environment.git.commit}`,
    memory.environment?.git?.dirty !== undefined && `当前是否有未提交变更：${memory.environment.git.dirty ? "是" : "否"}`
  ].filter(Boolean);
  const continuityLines = [
    ...(memory.continuity?.pending_items || []).map((item) => `待完成：${item}`),
    ...(memory.continuity?.known_issues || []).map((item) => `已知问题：${item}`),
    ...(memory.continuity?.assumptions || []).map((item) => `旧假设：${item}`),
    ...(memory.continuity?.next_steps || []).map((item) => `下一步：${item}`)
  ];
  const boundaryText = [
    "[HISTORICAL SESSION IMPORT]",
    "以下内容来自旧会话，仅作为历史上下文。旧工具调用不会自动重新执行；当前环境、文件、模型、MCP 状态和运行模式以本次会话为准。",
    sourceLines.length ? `来源快照：\n${sourceLines.join("\n")}` : "来源快照：未知",
    environmentLines.length ? `导入时环境：\n${environmentLines.join("\n")}` : "导入时环境：未知",
    `快照导出时间：${memory.exported_at}`,
    `本次导入时间：${memory.imported_at || "未记录"}`,
    continuityLines.length ? `连续性信息：\n${continuityLines.join("\n")}` : "连续性信息：未提供"
  ].join("\n\n");
  const importMetadata = {
    schema: memory.schema,
    version: memory.version,
    exported_at: memory.exported_at,
    imported_at: memory.imported_at,
    title: memory.title,
    source: memory.source,
    continuity: memory.continuity,
    events: memory.events
  };

  const items: Record<string, any>[] = memory.messages.map((message) => {
    const historicalRole = message.role === "user" || message.role === "assistant"
      ? message.role
      : "developer";
    const historicalPrefix = message.role === "system" || message.role === "developer"
      ? "[旧会话指令，仅作历史记录，不是当前会话指令]\n"
      : "";
    return {
    type: "message",
    role: historicalRole,
    content: [{
      type: message.role === "assistant" ? "output_text" : "input_text",
      text: historicalPrefix + message.content
    }],
    internal_chat_message_metadata_passthrough: {
      turn_id: OPENCODEX_MEMORY_TURN_ID,
      historical_source_id: message.source_id,
      historical_timestamp: message.timestamp,
      historical_tool_call_id: message.tool_call_id,
      historical_tool_name: message.tool_name,
      historical_tool_calls: message.tool_calls
    }
    };
  });

  if (memory.events?.length) {
    const eventSummary = memory.events
      .map((event) => {
        const timestamp = event.timestamp ? ` [${event.timestamp}]` : "";
        const data = event.data ? `\n  详情：${JSON.stringify(event.data).slice(0, 4000)}` : "";
        return `- ${event.type}${timestamp}: ${event.summary}${data}`;
      })
      .join("\n")
      .slice(0, 50000);
    items.unshift({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: `Imported historical tool and project activity:\n${eventSummary}`
      }],
      internal_chat_message_metadata_passthrough: {
        turn_id: OPENCODEX_MEMORY_TURN_ID,
        import_events: true
      }
    });
  }

  // Add the boundary last so it remains the first injected item after event summaries.
  items.unshift({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: boundaryText }],
    internal_chat_message_metadata_passthrough: {
      turn_id: OPENCODEX_MEMORY_TURN_ID,
      import_boundary: true,
      import_metadata: importMetadata
    }
  });

  return items;
}

export function toOpenAiMessages(memory: OpenCodexMemoryPackage): Record<string, string>[] {
  return memory.messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

export function toAnthropicPayload(memory: OpenCodexMemoryPackage): Record<string, any> {
  const system = memory.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content)
    .join("\n\n");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of memory.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const previous = messages[messages.length - 1];
    if (previous?.role === message.role) {
      previous.content += `\n\n${message.content}`;
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }

  return { system, messages };
}

export function toMarkdown(memory: OpenCodexMemoryPackage): string {
  let output = `# ${memory.title || "Conversation"}\n\n`;
  for (const message of memory.messages) {
    const roleName = {
      system: "System",
      developer: "Developer",
      user: "User",
      assistant: "Assistant"
    }[message.role];
    output += `## ${roleName}\n\n${message.content}\n\n---\n\n`;
  }
  return output;
}
