export function isNativeResponsesReasoningId(value: unknown): boolean {
  return typeof value === "string" && /^rs(?:_|[A-Za-z0-9_-])+/i.test(value.trim());
}

export function sanitizeNativeResponsesBody(body: any): { body: any; removedReasoningItems: number; removedPreviousResponseId: boolean } {
  const sanitized = { ...(body || {}) };
  let removedReasoningItems = 0;
  let removedPreviousResponseId = false;

  if (Array.isArray(body?.input)) {
    sanitized.input = body.input.filter((item: any) => {
      if (item?.type !== "reasoning") return true;
      const keep = isNativeResponsesReasoningId(item.id);
      if (!keep) removedReasoningItems++;
      return keep;
    });
  }

  if (typeof body?.previous_response_id === "string" && body.previous_response_id.trim() && !/^resp(?:_|[A-Za-z0-9_-])+/i.test(body.previous_response_id.trim())) {
    delete sanitized.previous_response_id;
    removedPreviousResponseId = true;
  }

  return { body: sanitized, removedReasoningItems, removedPreviousResponseId };
}
