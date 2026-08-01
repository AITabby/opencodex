import http from "node:http";

/**
 * Bun's Node-compatible HTTP response can stall when one very large
 * response.completed SSE frame is written in a single call. Keep individual
 * writes bounded and respect backpressure so the final frame and stream
 * terminator are flushed before res.end().
 */
export const HTTP_FORWARD_WRITE_CHUNK_BYTES = 64 * 1024;

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

export function copySafeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) result[key] = value;
  });
  return result;
}

function waitForDrain(res: http.ServerResponse): Promise<void> {
  if (res.writableEnded || (res as any).destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
      resolve();
    };
    const onDrain = () => cleanup();
    const onClose = () => cleanup();
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

export async function writeHttpResponseChunked(
  res: http.ServerResponse,
  value: string | Uint8Array,
  chunkBytes = HTTP_FORWARD_WRITE_CHUNK_BYTES,
): Promise<void> {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const size = Math.max(1, Math.floor(chunkBytes));
  for (let offset = 0; offset < data.byteLength; offset += size) {
    if (res.writableEnded || (res as any).destroyed) return;
    const end = Math.min(data.byteLength, offset + size);
    const accepted = res.write(data.subarray(offset, end));
    if (!accepted) await waitForDrain(res);
  }
}

export async function writeSseData(
  res: http.ServerResponse,
  payload: unknown,
): Promise<void> {
  await writeHttpResponseChunked(res, `data: ${JSON.stringify(payload)}\n\n`);
}
