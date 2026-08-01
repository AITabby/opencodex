import { randomUUID } from "node:crypto";

/**
 * Codex expects a compaction item to carry opaque encrypted_content. The
 * gateway cannot manufacture OpenAI's encrypted payload, so third-party
 * compaction state is carried in a private, versioned envelope instead. The
 * envelope is expanded back into an ordinary developer message before the
 * next provider request, including when the user switches to native GPT.
 */
export const GATEWAY_COMPACTION_PREFIX = "opencodex-compaction-v1:";

export const COMPACTION_SYSTEM_PROMPT = [
  "You are compacting an AI coding-agent conversation.",
  "Return only durable continuation state, not a reply to the user and not a description of this instruction.",
  "Preserve: the user's actual objective, confirmed facts, files and code changes, constraints, decisions, errors and their causes, unfinished work, and the exact next actions.",
  "Discard: greetings, repeated explanations, transient tool chatter, failed guesses that are no longer relevant, and verbose reasoning.",
  "Never invent a result. Mark uncertain or unverified details as uncertain.",
].join(" ");

export const COMPACTION_USER_PROMPT = [
  "Compact the conversation above for the next turn.",
  "Use concise labeled sections: Objective, Facts, Changes, Constraints, Open Issues, Next Actions.",
  "Keep names, paths, identifiers, commands, and error messages exact when they matter.",
  "Output only the compacted continuation state.",
].join(" ");

export type GatewayCompactionState = {
  version: 1;
  summary: string;
  model?: string;
  generated_at: string;
  fallback?: boolean;
};

export function isCompactionRequestPath(pathname: string): boolean {
  const path = String(pathname || "").replace(/\/+$/, "").toLowerCase();
  return path === "/v1/responses/compact" || path === "/responses/compact";
}

/**
 * Newer Codex clients use /responses/compact. Keep a body-level guard too so
 * a client that sends a compaction trigger through /responses is not routed
 * to a normal model turn and mistaken for a successful compaction.
 */
export function isCompactionRequestBody(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  if (body.compact === true || body.compaction === true || body.type === "response.compaction") return true;
  return Array.isArray(body.input) && body.input.some((item: any) => item?.type === "compaction_trigger");
}

function cleanSummary(value: unknown): string {
  return String(value || "").replace(/\u0000/g, "").trim();
}

export function encodeGatewayCompaction(summary: string, model?: string, fallback = false): string {
  const state: GatewayCompactionState = {
    version: 1,
    summary: cleanSummary(summary) || "No durable prior context was available.",
    model: model ? String(model) : undefined,
    generated_at: new Date().toISOString(),
    ...(fallback ? { fallback: true } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${GATEWAY_COMPACTION_PREFIX}${encoded}`;
}

export function decodeGatewayCompaction(value: unknown): GatewayCompactionState | null {
  if (typeof value !== "string" || !value.startsWith(GATEWAY_COMPACTION_PREFIX)) return null;
  try {
    const encoded = value.slice(GATEWAY_COMPACTION_PREFIX.length);
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (parsed?.version !== 1 || typeof parsed.summary !== "string") return null;
    const summary = cleanSummary(parsed.summary);
    if (!summary) return null;
    return {
      version: 1,
      summary,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : "",
      fallback: parsed.fallback === true,
    };
  } catch {
    return null;
  }
}

export function formatGatewayCompactionContext(state: GatewayCompactionState): string {
  return [
    "[OpenCodex compacted conversation state]",
    "Treat the following as trusted prior context. Continue the user's task from it; do not discuss the compaction process unless asked.",
    state.summary,
  ].join("\n\n");
}

export function expandGatewayCompactionItem(item: any): any {
  if (!item || typeof item !== "object") return item;
  if (item.type !== "compaction" && item.type !== "context_compaction") return item;
  const state = decodeGatewayCompaction(item.encrypted_content);
  if (!state) return item;
  return {
    type: "message",
    id: typeof item.id === "string" ? `${item.id}_expanded` : `msg_compaction_${randomUUID()}`,
    role: "developer",
    content: [{ type: "input_text", text: formatGatewayCompactionContext(state) }],
  };
}

export function expandGatewayCompactionItems(body: any): any {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) return body;
  return {
    ...body,
    input: body.input.map((item: any) => expandGatewayCompactionItem(item)),
  };
}

export function buildCompactionResponse(model: string, encryptedContent: string, usage?: Record<string, number>): any {
  const now = Math.floor(Date.now() / 1000);
  const item = buildCompactionItem(encryptedContent);
  return {
    id: `resp_${randomUUID().replace(/-/g, "")}`,
    object: "response.compaction",
    created_at: now,
    model,
    // Keep this output to one item. Codex's remote compaction v2 validator
    // requires one and only one item with type=compaction.
    output: [item],
    usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

export function buildCompactionItem(encryptedContent: string, id?: string): any {
  return {
    id: id || `cmp_${randomUUID().replace(/-/g, "")}`,
    type: "compaction",
    encrypted_content: encryptedContent,
    created_by: "opencodex",
  };
}

/**
 * Remote compaction v2 is consumed as an ordinary streaming Responses turn.
 * Codex counts response.output_item.done events and requires exactly one of
 * them to contain a compaction item. Returning only a JSON
 * response.compaction envelope is not sufficient for that client path.
 */
export function buildCompactionStreamEvents(
  model: string,
  encryptedContent: string,
  usage?: Record<string, number>,
): any[] {
  const now = Math.floor(Date.now() / 1000);
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const item = buildCompactionItem(encryptedContent);
  const response = {
    id: responseId,
    object: "response",
    created_at: now,
    completed_at: now,
    status: "completed",
    model,
    output: [item],
    usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  return [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", completed_at: undefined, output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
    { type: "response.done", response },
  ];
}

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") return String(part.text || part.output_text || "");
      return "";
    }).join("");
  }
  if (content && typeof content === "object") return String(content.text || content.output_text || "");
  return "";
}

/** Extract visible text from JSON returned by Responses, Chat, Anthropic, or Gemini. */
export function extractProviderText(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  if (typeof payload.delta === "string" && payload.delta.trim()) return payload.delta;
  if (typeof payload.delta?.text === "string" && payload.delta.text.trim()) return payload.delta.text;

  if (Array.isArray(payload.choices)) {
    const text = payload.choices.map((choice: any) => contentToText(choice?.message?.content ?? choice?.delta?.content)).join("");
    if (text.trim()) return text.trim();
  }

  if (Array.isArray(payload.output)) {
    const text = payload.output.map((item: any) => contentToText(item?.content)).join("");
    if (text.trim()) return text.trim();
  }

  if (Array.isArray(payload.content)) {
    const text = contentToText(payload.content);
    if (text.trim()) return text.trim();
  }

  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : Array.isArray(payload.response?.candidates)
      ? payload.response.candidates
      : [];
  const candidateText = candidates.map((candidate: any) => contentToText(candidate?.content?.parts)).join("");
  return candidateText.trim();
}

/** Parse either a JSON response or an SSE body produced despite stream=false. */
export function extractProviderTextFromBody(raw: string): string {
  const text = String(raw || "");
  try {
    const parsed = JSON.parse(text);
    const extracted = extractProviderText(parsed);
    if (extracted) return extracted;
  } catch {}

  const chunks: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed.slice(5).trim() === "[DONE]") continue;
    try {
      const extracted = extractProviderText(JSON.parse(trimmed.slice(5).trim()));
      if (extracted) chunks.push(extracted);
    } catch {}
  }
  return chunks.join("").trim();
}

function fallbackContent(content: any): string {
  return contentToText(content).replace(/\s+/g, " ").trim();
}

/**
 * Last-resort local compaction. It is intentionally bounded and keeps both
 * the opening context and the newest tool/result state when the provider's
 * own summarization request is unavailable.
 */
export function buildFallbackCompactionSummary(messages: Array<{ role?: string; content?: any }>, instructions?: string): string {
  const normalized = Array.isArray(messages)
    ? messages.map((message) => ({
      role: String(message?.role || "message"),
      text: fallbackContent(message?.content),
    })).filter((message) => message.text)
    : [];
  const selected = normalized.length <= 32
    ? normalized
    : [...normalized.slice(0, 6), ...normalized.slice(-26)];
  const lines = [
    "Objective and durable context (provider summarization unavailable; preserve and verify before relying on uncertain details):",
  ];
  const instructionText = cleanSummary(instructions);
  if (instructionText) lines.push(`Instructions: ${instructionText.slice(0, 3000)}`);
  for (const message of selected) {
    lines.push(`${message.role}: ${message.text.slice(0, 1400)}`);
  }
  const result = lines.join("\n");
  return result.length <= 16000 ? result : `${result.slice(0, 8000)}\n...[middle context omitted]...\n${result.slice(-8000)}`;
}
