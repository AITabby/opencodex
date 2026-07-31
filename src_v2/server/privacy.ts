const SECRET_ASSIGNMENT = /((?:authorization|proxy-authorization|cookie|set-cookie|x-opencodex-token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[=:]\s*)(?:bearer\s+)?[^\s,;]+/gi;
const JSON_SECRET_ASSIGNMENT = /(["'](?:authorization|proxy-authorization|cookie|set-cookie|x-opencodex-token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']\s*:\s*["'])(?:bearer\s+)?[^"']*(["'])/gi;
const TOKEN_SHAPE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const SENSITIVE_QUERY = /([?&](?:key|api_key|access_token|refresh_token|token|code|secret)=)[^&#\s]+/gi;

export function redactSensitiveText(value: unknown, maxLength = 1000): string {
  let text = String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(JSON_SECRET_ASSIGNMENT, "$1[REDACTED]$2")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(TOKEN_SHAPE, "[REDACTED]")
    .replace(SENSITIVE_QUERY, "$1[REDACTED]");

  text = text
    .replace(/(\bargs=).+$/gim, "$1[REDACTED]")
    .replace(/(\b(?:prompt|transcript|voice_text)=).+$/gim, "$1[REDACTED]")
    .replace(/(Upstream error \([^)]*\)[^:]*:).+$/gim, "$1 [REDACTED_BODY]")
    .replace(/(HTTP\s+\d{3}:).+$/gim, "$1 [REDACTED_BODY]")
    .replace(/(User said:).+?(\s+while system was saying:).+$/gim, "$1 [REDACTED]$2 [REDACTED]")
    .replace(/(\[(?:WS Chunk|WS Done|STT(?: Interrupted)?|Drop STT|Go|Stream Chunk)\]).+$/gim, "$1 content=[REDACTED]")
    .replace(/(\[(?:Ask|TTS|Stream TTS|Live Mode)[^\]]*\](?:\s+(?:Sending|Synthesizing|Captured|Filtering|Bypassing|Skipping|Merging)[^:]*:)?).+$/gim, "$1 content=[REDACTED]");

  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function safeDiagnosticTarget(rawTarget: string): string {
  try {
    const url = new URL(rawTarget);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export function safeErrorMessage(error: unknown): string {
  if (typeof error === "string") return redactSensitiveText(error, 500);
  const raw = error as any;
  return redactSensitiveText(raw?.message || raw?.code || "operation failed", 500);
}

export function redactLogLine(line: string): string {
  return redactSensitiveText(line, 4000);
}
