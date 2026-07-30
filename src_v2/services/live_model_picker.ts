export const LIVE_MODEL_PICKER_TIMEOUT_MS = 90 * 1000;
export const LIVE_MODEL_BINDING_TTL_MS = 30 * 60 * 1000;

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
  return Boolean(metadata && Array.isArray(tools) && tools.length > 0);
}

export function isToolContinuation(body: any): boolean {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some((item: any) =>
    item?.type === "function_call_output" ||
    item?.type === "computer_call_output" ||
    item?.role === "tool",
  );
}
