/**
 * Request Decompressor for OpenCodex V2 Gateway
 * Decompresses zstd / gzip / deflate HTTP request bodies sent by Codex Desktop.
 */

import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";

export class RequestDecompressor {
  public static decompressBody(rawBuffer: Buffer, contentEncoding: string | null): Buffer {
    const encoding = (contentEncoding ?? "").trim().toLowerCase();
    if (!encoding || encoding === "identity") {
      return rawBuffer;
    }

    try {
      if (encoding === "zstd") {
        return zstdDecompressSync(rawBuffer);
      }
      if (encoding === "gzip" || encoding === "x-gzip") {
        return gunzipSync(rawBuffer);
      }
      if (encoding === "deflate") {
        try {
          return inflateSync(rawBuffer);
        } catch {
          return inflateRawSync(rawBuffer);
        }
      }
    } catch (err: any) {
      console.error(`[CodexBridge V2] Decompression failed for encoding '${encoding}':`, err.message);
    }

    return rawBuffer;
  }
}
