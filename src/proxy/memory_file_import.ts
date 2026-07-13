import initSqlJs, { type Database } from "sql.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  normalizeImportedMemory,
  type MemoryMessage,
  type OpenCodexMemoryPackage
} from "./memory_bridge.js";

export interface ImportSessionCandidate {
  id: string;
  title: string;
  source?: string;
  model?: string;
  cwd?: string;
  message_count?: number;
  updated_at?: number;
}

export interface MemoryFileImportResult {
  detected_format: "json" | "jsonl" | "sqlite" | "markdown";
  memory?: OpenCodexMemoryPackage;
  sessions?: ImportSessionCandidate[];
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function messageFromJsonlItem(item: any): { sessionId: string; message: any } | null {
  const sessionId = String(
    item.session_id ?? item.sessionId ?? item.thread_id ?? item.threadId ?? item.conversation_id ?? ""
  );

  if (item.type === "response_item" && item.payload?.type === "message") {
    return {
      sessionId,
      message: {
        id: item.payload.id,
        role: item.payload.role,
        content: item.payload.content
      }
    };
  }

  if (item.type === "event_msg" && item.payload?.type === "user_message") {
    return { sessionId, message: { role: "user", content: item.payload.message } };
  }
  if (item.type === "event_msg" && item.payload?.type === "agent_message") {
    return { sessionId, message: { role: "assistant", content: item.payload.message } };
  }

  const payload = item.type === "message" && item.payload ? item.payload : item;
  if (payload && payload.role && (payload.content !== undefined || payload.text !== undefined)) {
    return {
      sessionId,
      message: {
        id: payload.id,
        role: payload.role,
        content: payload.content ?? payload.text,
        name: payload.name,
        tool_calls: payload.tool_calls
      }
    };
  }
  return null;
}

function parseJsonlItems(text: string): any[] {
  const parsedItems: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsedItems.push(JSON.parse(trimmed));
    } catch {
      throw new Error("JSONL contains an invalid JSON line");
    }
  }
  return parsedItems;
}

function parseClaudeJsonlItems(
  parsedItems: any[],
  fallbackTitle: string
): MemoryFileImportResult {
  const rawMessages: any[] = [];
  const seen = new Set<string>();
  let threadId = "";
  let cwd: string | undefined;
  let model: string | undefined;

  for (const item of parsedItems) {
    if (item?.isSidechain === true) continue;
    if (item?.type !== "user" && item?.type !== "assistant") continue;
    if (!item.message || typeof item.message !== "object") continue;

    const role = item.message.role || item.type;
    if (role !== "user" && role !== "assistant") continue;
    const content = contentText(item.message.content);
    if (!content) continue;

    const messageId = String(item.uuid || item.message.id || "");
    if (messageId && seen.has(messageId)) continue;
    if (messageId) seen.add(messageId);
    rawMessages.push({ id: messageId || undefined, role, content });

    if (!threadId && item.sessionId) threadId = String(item.sessionId);
    if (!cwd && item.cwd) cwd = String(item.cwd);
    const itemModel = item.message.model;
    if (role === "assistant" && itemModel && itemModel !== "<synthetic>") {
      model = String(itemModel);
    }
  }

  if (rawMessages.length === 0) {
    throw new Error("No supported Claude conversation messages were found");
  }

  const firstUser = rawMessages.find((message) => message.role === "user")?.content;
  const title = firstUser
    ? String(firstUser).replace(/\s+/g, " ").slice(0, 100)
    : fallbackTitle;
  const memory = normalizeImportedMemory(rawMessages, title);
  memory.source = {
    application: "Claude Code",
    thread_id: threadId || undefined,
    model_provider: model,
    cwd
  };
  return { detected_format: "jsonl", memory };
}

function parseGrokJsonlItems(
  parsedItems: any[],
  fallbackTitle: string
): MemoryFileImportResult {
  const rawMessages: any[] = [];
  let cwd: string | undefined;
  let model: string | undefined;

  for (const item of parsedItems) {
    if (item?.type !== "user" && item?.type !== "assistant" && item?.type !== "system") continue;
    
    const role = item.type === "system" ? "system" : item.type;
    let content = "";
    if (typeof item.content === "string") {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      content = item.content
        .map((c: any) => c.text || c.content || "")
        .join("\n");
    }
    
    if (role === "user") {
      const userInfoMatch = content.match(/Workspace Path:\s*([^\n]+)/);
      if (userInfoMatch) {
        cwd = userInfoMatch[1].trim();
      }

      if (content.includes("<user_info>") || content.includes("<system-reminder>")) {
        continue;
      }
      
      const match = content.match(/<user_query>([\s\S]*?)<\/user_query>/);
      if (match) {
        content = match[1].trim();
      }
    }
    
    if (!content) continue;
    rawMessages.push({ role, content });
  }

  if (rawMessages.length === 0) {
    throw new Error("No supported Grok conversation messages were found");
  }

  const firstUser = rawMessages.find((message) => message.role === "user")?.content;
  const title = firstUser
    ? String(firstUser).replace(/\s+/g, " ").slice(0, 100)
    : fallbackTitle;
  const memory = normalizeImportedMemory(rawMessages, title);
  memory.source = {
    application: "Grok Build",
    model_provider: "grok-4.5",
    cwd
  };
  return { detected_format: "jsonl", memory };
}

function parseJsonl(
  text: string,
  fallbackTitle: string,
  selectedSessionId?: string
): MemoryFileImportResult {
  const parsedItems = parseJsonlItems(text);
  if (parsedItems.some(
    (item) => (
      item?.type === "user" || item?.type === "assistant"
    ) && item?.message?.role
  )) {
    return parseClaudeJsonlItems(parsedItems, fallbackTitle);
  }
  if (parsedItems.some(
    (item) => (
      item?.type === "user" || item?.type === "assistant" || item?.type === "system"
    ) && (typeof item?.content === "string" || Array.isArray(item?.content))
  )) {
    return parseGrokJsonlItems(parsedItems, fallbackTitle);
  }

  const responseItems = parsedItems.filter(
    (item) => item.type === "response_item" && item.payload?.type === "message"
  );
  const sourceItems = responseItems.length > 0 ? responseItems : parsedItems;
  const grouped = new Map<string, any[]>();

  for (const item of sourceItems) {
    const converted = messageFromJsonlItem(item);
    if (!converted) continue;
    const key = converted.sessionId || "default";
    const list = grouped.get(key) || [];
    list.push(converted.message);
    grouped.set(key, list);
  }

  if (grouped.size === 0) {
    throw new Error("No supported conversation messages were found in this JSONL file");
  }

  if (grouped.size > 1 && !selectedSessionId) {
    return {
      detected_format: "jsonl",
      sessions: Array.from(grouped.entries()).map(([id, messages]) => ({
        id,
        title: id,
        message_count: messages.length
      }))
    };
  }

  const selectedId = selectedSessionId || grouped.keys().next().value || "default";
  const messages = grouped.get(selectedId);
  if (!messages) throw new Error("The selected JSONL session was not found");

  return {
    detected_format: "jsonl",
    memory: normalizeImportedMemory(messages, fallbackTitle)
  };
}

function collectClaudeJsonlFiles(root: string, output: string[]): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectClaudeJsonlFiles(fullPath, output);
      } else if (stat.isFile() && entry.toLowerCase().endsWith(".jsonl")) {
        output.push(fullPath);
      }
    } catch {}
  }
}

function parseClaudeProjectsDirectory(
  path: string,
  selectedSessionId?: string
): MemoryFileImportResult {
  const files: string[] = [];
  collectClaudeJsonlFiles(path, files);

  if (selectedSessionId) {
    const selectedPath = files.find(
      (filePath) => basename(filePath, ".jsonl") === selectedSessionId
    );
    if (!selectedPath) throw new Error("The selected Claude session was not found");
    return parseClaudeJsonlItems(
      parseJsonlItems(readFileSync(selectedPath, "utf8")),
      selectedSessionId
    );
  }

  const sessions: ImportSessionCandidate[] = [];
  for (const filePath of files) {
    try {
      const parsed = parseClaudeJsonlItems(
        parseJsonlItems(readFileSync(filePath, "utf8")),
        basename(filePath, ".jsonl")
      );
      if (!parsed.memory) continue;
      const stat = statSync(filePath);
      sessions.push({
        id: parsed.memory.source?.thread_id || basename(filePath, ".jsonl"),
        title: parsed.memory.title || basename(filePath, ".jsonl"),
        source: "Claude Code",
        model: parsed.memory.source?.model_provider,
        cwd: parsed.memory.source?.cwd,
        message_count: parsed.memory.messages.length,
        updated_at: stat.mtimeMs / 1000
      });
    } catch {}
  }
  if (sessions.length === 0) throw new Error("Claude projects directory contains no readable sessions");
  sessions.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return { detected_format: "jsonl", sessions };
}

function parseMarkdown(text: string, fallbackTitle: string): MemoryFileImportResult {
  const messages: MemoryMessage[] = [];
  const headingPattern = /^#{2,3}\s+(?:\*\*)?(System|Developer|User|Assistant)(?:\*\*)?:?\s*$/gim;
  const matches = Array.from(text.matchAll(headingPattern));

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length;
    const content = text.slice(start, end).replace(/^\s*---\s*$/gm, "").trim();
    if (!content) continue;
    messages.push({
      role: match[1].toLowerCase() as MemoryMessage["role"],
      content
    });
  }

  if (messages.length === 0 && text.trim()) {
    messages.push({ role: "user", content: text.trim() });
  }
  if (messages.length === 0) throw new Error("The Markdown file is empty");

  return {
    detected_format: "markdown",
    memory: {
      schema: "opencodex.memory",
      version: 1,
      exported_at: new Date().toISOString(),
      title: fallbackTitle,
      source: { application: "Markdown" },
      messages
    }
  };
}

function parseAntigravityBundle(path: string): MemoryFileImportResult {
  const documentNames = ["task.md", "implementation_plan.md", "walkthrough.md"];
  const documents = documentNames
    .map((name) => {
      const filePath = join(path, name);
      if (!existsSync(filePath)) return null;
      const text = readFileSync(filePath, "utf8").trim();
      return text ? { name, text } : null;
    })
    .filter((document): document is { name: string; text: string } => Boolean(document));

  if (documents.length === 0) {
    throw new Error("Antigravity task directory contains no supported memory documents");
  }

  const preferredDocument = documents.find((document) => document.name === "walkthrough.md")
    || documents.find((document) => document.name === "implementation_plan.md")
    || documents[0];
  const firstHeading = preferredDocument.text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = firstHeading || `Antigravity ${basename(path)}`;
  const labels: Record<string, string> = {
    "task.md": "Task",
    "implementation_plan.md": "Implementation Plan",
    "walkthrough.md": "Walkthrough"
  };
  const content = documents
    .map((document) => `# ${labels[document.name] || document.name}\n\n${document.text}`)
    .join("\n\n---\n\n");

  return {
    detected_format: "markdown",
    memory: {
      schema: "opencodex.memory",
      version: 1,
      exported_at: new Date().toISOString(),
      title,
      source: {
        application: "Antigravity",
        thread_id: basename(path)
      },
      messages: [{ role: "user", content }]
    }
  };
}

function readProtobufVarint(
  bytes: Buffer,
  offset: number
): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length && shift < 53) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  return null;
}

function extractProtobufStrings(bytes: Buffer, depth = 0): string[] {
  if (depth > 5) return [];
  const output: string[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const key = readProtobufVarint(bytes, offset);
    if (!key) break;
    offset = key.offset;
    const wireType = key.value & 7;

    if (wireType === 0) {
      const value = readProtobufVarint(bytes, offset);
      if (!value) break;
      offset = value.offset;
      continue;
    }
    if (wireType === 1) {
      offset += 8;
      continue;
    }
    if (wireType === 5) {
      offset += 4;
      continue;
    }
    if (wireType !== 2) break;

    const lengthValue = readProtobufVarint(bytes, offset);
    if (!lengthValue) break;
    offset = lengthValue.offset;
    const length = lengthValue.value;
    if (length < 0 || offset + length > bytes.length) break;
    const part = bytes.subarray(offset, offset + length);
    offset += length;

    const text = part.toString("utf8").trim();
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const controlCount = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    if (
      text.length >= 2
      && replacementCount === 0
      && controlCount <= Math.max(1, text.length * 0.01)
    ) {
      output.push(text);
    }
    output.push(...extractProtobufStrings(part, depth + 1));
  }

  return output;
}

function antigravityMessageText(payload: Buffer): string {
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
      if (/\$?[0-9a-f]{8}-[0-9a-f-]{27,}.*\$[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(text)) {
        return false;
      }
      if (/^[^/\\]+\.(?:png|jpe?g|gif|webp|heic)$/i.test(text)) return false;
      if (/^(bot-|sessionID|command\(|read_file\(|write_to_file|search_web|list_dir)/i.test(text)) {
        return false;
      }
      if (text.startsWith("{") && /"(toolAction|CommandLine|DirectoryPath|ArtifactMetadata)"/.test(text)) {
        return false;
      }
      if (/^(?:\/|file:\/\/).+\.(?:png|jpe?g|gif|webp)$/i.test(text)) return false;
      if ((text.match(/(?:command|read_file|write_to_file|search_web)\(/g) || []).length >= 3) {
        return false;
      }
      return /[\p{L}\p{N}]/u.test(text);
    })
    .sort((a, b) => b.length - a.length);
  return candidates[0] || "";
}

async function parseAntigravityDatabase(
  path: string,
  selectedSessionId?: string
): Promise<MemoryFileImportResult> {
  const bytes = readFileSync(path);
  const SQL = await initSqlJs();
  const database = new SQL.Database(bytes);
  const threadId = basename(path, ".db");
  try {
    const countRows = queryRows(database, `
      SELECT COUNT(*) AS user_message_count
      FROM steps
      WHERE step_type = 14 AND status = 3 AND length(step_payload) > 0
    `);
    const countRow = countRows[0];
    const firstUserRow = queryRows(database, `
      SELECT step_payload
      FROM steps
      WHERE step_type = 14 AND status = 3 AND length(step_payload) > 0
      ORDER BY idx
      LIMIT 12
    `);
    const firstUserText = firstUserRow
      .map((row) => antigravityMessageText(Buffer.from(row.step_payload || [])))
      .find(Boolean);
    const title = firstUserText
      ? firstUserText.replace(/\s+/g, " ").slice(0, 80)
      : `Antigravity ${threadId.slice(0, 8)}`;

    if (!selectedSessionId) {
      return {
        detected_format: "sqlite",
        sessions: [{
          id: threadId,
          title,
          source: "Antigravity",
          message_count: Number(countRow?.user_message_count || 0) * 2,
          updated_at: statSync(path).mtimeMs / 1000
        }]
      };
    }

    const rows = queryRows(database, `
      SELECT idx, step_type, step_payload
      FROM steps
      WHERE step_type IN (14, 15) AND status = 3 AND length(step_payload) > 0
      ORDER BY idx
    `);
    const messages: MemoryMessage[] = [];
    for (const row of rows) {
      const content = antigravityMessageText(Buffer.from(row.step_payload || []));
      if (!content) continue;
      messages.push({
        role: Number(row.step_type) === 14 ? "user" : "assistant",
        content
      });
    }
    if (messages.length === 0) throw new Error("Antigravity conversation contains no readable messages");

    return {
      detected_format: "sqlite",
      memory: {
        schema: "opencodex.memory",
        version: 1,
        exported_at: new Date().toISOString(),
        title,
        source: {
          application: "Antigravity",
          thread_id: threadId
        },
        messages
      }
    };
  } finally {
    database.close();
  }
}

function queryRows(database: Database, sql: string, params: any[] = []): Record<string, any>[] {
  const statement = database.prepare(sql);
  try {
    statement.bind(params);
    const rows: Record<string, any>[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function tableColumns(database: Database, table: string): Set<string> {
  return new Set(
    queryRows(database, `PRAGMA table_info("${table.replace(/"/g, "\"\"")}")`)
      .map((row) => String(row.name))
  );
}

function hasTable(database: Database, table: string): boolean {
  return queryRows(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [table]
  ).length > 0;
}

function sqliteCandidates(database: Database): ImportSessionCandidate[] {
  if (!hasTable(database, "messages")) {
    throw new Error("SQLite database does not contain a messages table");
  }
  const messageColumns = tableColumns(database, "messages");
  if (!messageColumns.has("role") || !messageColumns.has("content")) {
    throw new Error("SQLite messages table must contain role and content columns");
  }

  if (hasTable(database, "sessions")) {
    const sessionColumns = tableColumns(database, "sessions");
    if (sessionColumns.has("id")) {
      const titleExpr = sessionColumns.has("title") ? "COALESCE(NULLIF(title, ''), id)" : "id";
      const sourceExpr = sessionColumns.has("source") ? "source" : "NULL";
      const modelExpr = sessionColumns.has("model") ? "model" : "NULL";
      const cwdExpr = sessionColumns.has("cwd") ? "cwd" : "NULL";
      const countExpr = sessionColumns.has("message_count")
        ? "message_count"
        : "(SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id)";
      const updatedExpr = sessionColumns.has("ended_at")
        ? "COALESCE(ended_at, started_at, 0)"
        : sessionColumns.has("started_at") ? "started_at" : "0";
      return queryRows(database, `
        SELECT id, ${titleExpr} AS title, ${sourceExpr} AS source, ${modelExpr} AS model,
               ${cwdExpr} AS cwd,
               ${countExpr} AS message_count, ${updatedExpr} AS updated_at
        FROM sessions
        ORDER BY updated_at DESC
      `).map((row) => ({
        id: String(row.id),
        title: String(row.title || row.id),
        source: row.source == null ? undefined : String(row.source),
        model: row.model == null ? undefined : String(row.model),
        cwd: row.cwd == null ? undefined : String(row.cwd),
        message_count: Number(row.message_count || 0),
        updated_at: Number(row.updated_at || 0)
      }));
    }
  }

  if (!messageColumns.has("session_id")) {
    return [{ id: "default", title: "Imported SQLite conversation" }];
  }
  return queryRows(database, `
    SELECT session_id AS id, COUNT(*) AS message_count, MAX(timestamp) AS updated_at
    FROM messages
    GROUP BY session_id
    ORDER BY updated_at DESC
  `).map((row) => ({
    id: String(row.id),
    title: String(row.id),
    message_count: Number(row.message_count || 0),
    updated_at: Number(row.updated_at || 0)
  }));
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function memoryFromSqliteSession(
  database: Database,
  session: ImportSessionCandidate
): OpenCodexMemoryPackage {
  const messageColumns = tableColumns(database, "messages");
  const selectColumns = ["id", "role", "content"];
  for (const optional of ["tool_calls", "tool_name", "timestamp", "reasoning", "reasoning_content"]) {
    if (messageColumns.has(optional)) selectColumns.push(optional);
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (messageColumns.has("session_id") && session.id !== "default") {
    where.push("session_id = ?");
    params.push(session.id);
  }
  if (messageColumns.has("active")) where.push("active = 1");
  const orderBy = messageColumns.has("timestamp") ? "timestamp, id" : "id";
  const rows = queryRows(
    database,
    `SELECT ${selectColumns.join(", ")} FROM messages${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy}`,
    params
  );

  const rawMessages: any[] = [];
  if (hasTable(database, "sessions")) {
    const sessionColumns = tableColumns(database, "sessions");
    if (sessionColumns.has("system_prompt")) {
      const systemRows = queryRows(database, "SELECT system_prompt FROM sessions WHERE id = ? LIMIT 1", [session.id]);
      const systemPrompt = systemRows[0]?.system_prompt;
      if (typeof systemPrompt === "string" && systemPrompt.trim()) {
        rawMessages.push({ role: "system", content: systemPrompt });
      }
    }
  }

  for (const row of rows) {
    let content = typeof row.content === "string" ? row.content : "";
    const reasoning = row.reasoning_content || row.reasoning;
    if (!content && typeof reasoning === "string") content = reasoning;
    rawMessages.push({
      id: row.id == null ? undefined : String(row.id),
      role: row.role,
      content,
      name: row.tool_name,
      tool_calls: parseMaybeJson(row.tool_calls)
    });
  }

  const memory = normalizeImportedMemory(rawMessages, session.title);
  memory.source = {
    application: "Hermes / SQLite",
    thread_id: session.id,
    model_provider: session.source,
    cwd: session.cwd
  };
  return memory;
}

async function parseSqlite(
  bytes: Uint8Array,
  selectedSessionId?: string
): Promise<MemoryFileImportResult> {
  const SQL = await initSqlJs();
  const database = new SQL.Database(bytes);
  try {
    const sessions = sqliteCandidates(database);
    if (sessions.length === 0) throw new Error("SQLite database contains no sessions");
    if (sessions.length > 1 && !selectedSessionId) {
      return { detected_format: "sqlite", sessions: sessions.slice(0, 500) };
    }

    const selected = selectedSessionId
      ? sessions.find((session) => session.id === selectedSessionId)
      : sessions[0];
    if (!selected) throw new Error("The selected SQLite session was not found");
    return {
      detected_format: "sqlite",
      memory: memoryFromSqliteSession(database, selected)
    };
  } finally {
    database.close();
  }
}

async function parseOpenCodeDatabase(
  path: string,
  selectedSessionId?: string
): Promise<MemoryFileImportResult> {
  const bytes = readFileSync(path);
  const SQL = await initSqlJs();
  const database = new SQL.Database(bytes);
  try {
    const sessionRows = queryRows(database, `
      SELECT id, title, directory, time_updated, model,
             (SELECT COUNT(*) FROM message WHERE message.session_id = session.id) AS message_count
      FROM session
      WHERE time_archived IS NULL
        AND parent_id IS NULL
        AND title NOT LIKE '%-branch'
      ORDER BY time_updated DESC
    `);
    const sessions: ImportSessionCandidate[] = sessionRows.map((row) => {
      const modelData = parseMaybeJson(row.model) as any;
      return {
        id: String(row.id),
        title: String(row.title || row.id),
        source: "OpenCode",
        model: typeof modelData === "object" ? modelData?.id : undefined,
        cwd: row.directory == null ? undefined : String(row.directory),
        message_count: Number(row.message_count || 0),
        updated_at: Number(row.time_updated || 0) / 1000
      };
    });
    if (sessions.length === 0) throw new Error("OpenCode database contains no sessions");
    if (!selectedSessionId) {
      return { detected_format: "sqlite", sessions: sessions.slice(0, 500) };
    }

    const selected = sessions.find((session) => session.id === selectedSessionId);
    if (!selected) throw new Error("The selected OpenCode session was not found");
    const rows = queryRows(database, `
      SELECT m.id AS message_id, m.data AS message_data,
             p.id AS part_id, p.data AS part_data
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created, p.time_created
    `, [selectedSessionId]);

    const grouped = new Map<string, { role: string; parts: string[]; model?: string }>();
    for (const row of rows) {
      let message = grouped.get(String(row.message_id));
      if (!message) {
        const messageData = parseMaybeJson(row.message_data) as any;
        message = {
          role: String(messageData?.role || "user"),
          parts: [],
          model: messageData?.modelID
        };
        grouped.set(String(row.message_id), message);
      }
      const partData = parseMaybeJson(row.part_data) as any;
      if (!partData || typeof partData !== "object") continue;
      if (partData.type === "text" && typeof partData.text === "string") {
        message.parts.push(partData.text);
      } else if (partData.type === "tool") {
        const state = partData.state || {};
        const input = state.input ? JSON.stringify(state.input) : "";
        const output = typeof state.output === "string" ? state.output : "";
        message.parts.push(`[Tool ${partData.tool || "tool"} ${input}${output ? `\n${output}` : ""}]`);
      }
    }

    const rawMessages = Array.from(grouped.values())
      .map((message) => ({
        role: message.role,
        content: message.parts.join("\n\n").trim()
      }))
      .filter((message) => message.content);
    const memory = normalizeImportedMemory(rawMessages, selected.title);
    memory.source = {
      application: "OpenCode",
      thread_id: selected.id,
      model_provider: selected.model,
      cwd: selected.cwd
    };
    return { detected_format: "sqlite", memory };
  } finally {
    database.close();
  }
}

export async function parseMemoryFile(
  fileName: string,
  bytes: Uint8Array,
  selectedSessionId?: string
): Promise<MemoryFileImportResult> {
  const lowerName = fileName.toLowerCase();
  const fallbackTitle = fileName.replace(/\.(jsonl|json|markdown|md|sqlite3|sqlite|db)$/i, "");

  if (lowerName.endsWith(".db") || lowerName.endsWith(".sqlite") || lowerName.endsWith(".sqlite3")) {
    return parseSqlite(bytes, selectedSessionId);
  }
  const text = decodeUtf8(bytes);
  if (lowerName.endsWith(".jsonl")) {
    return parseJsonl(text, fallbackTitle, selectedSessionId);
  }
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return parseMarkdown(text, fallbackTitle);
  }
  if (lowerName.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSON file could not be parsed");
    }
    return {
      detected_format: "json",
      memory: normalizeImportedMemory(parsed, fallbackTitle)
    };
  }
  throw new Error("Unsupported file type. Use JSON, JSONL, SQLite, or Markdown");
}

export async function parseMemoryFilePath(
  path: string,
  selectedSessionId?: string
): Promise<MemoryFileImportResult> {
  if (statSync(path).isDirectory()) {
    const lowerPath = path.toLowerCase();
    if (lowerPath.includes(`${join(".claude", "projects").toLowerCase()}`)) {
      return parseClaudeProjectsDirectory(path, selectedSessionId);
    }
    if (lowerPath.includes("antigravity")) return parseAntigravityBundle(path);
  }
  const fileName = basename(path);
  if (
    fileName.toLowerCase().endsWith(".db")
    && path.toLowerCase().includes("antigravity")
    && path.toLowerCase().includes("conversations")
  ) {
    return parseAntigravityDatabase(path, selectedSessionId);
  }
  if (fileName.toLowerCase() === "opencode.db") {
    try {
      return await parseOpenCodeDatabase(path, selectedSessionId);
    } catch (error: any) {
      if (statSync(path).size > 48 * 1024 * 1024) {
        throw new Error(`OpenCode database could not be read: ${error.message}`);
      }
    }
  }
  return parseMemoryFile(fileName, new Uint8Array(readFileSync(path)), selectedSessionId);
}
