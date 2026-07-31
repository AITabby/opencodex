/**
 * Request Decompressor for OpenCodex V2 Gateway
 * Decompresses zstd / gzip / deflate HTTP request bodies sent by Codex Desktop.
 */

import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";

export class RequestDecompressor {
  public static decompressBody(rawBuffer: Buffer, contentEncoding: string | null, maxOutputLength = 64 * 1024 * 1024): Buffer {
    const encoding = (contentEncoding ?? "").trim().toLowerCase();
    if (rawBuffer.length > maxOutputLength) {
      throw new Error("Request body exceeds the decompressed size limit");
    }
    if (!encoding || encoding === "identity") {
      return rawBuffer;
    }

    try {
      const options = { maxOutputLength };
      if (encoding === "zstd") {
        return zstdDecompressSync(rawBuffer, options);
      }
      if (encoding === "gzip" || encoding === "x-gzip") {
        return gunzipSync(rawBuffer, options);
      }
      if (encoding === "deflate") {
        try {
          return inflateSync(rawBuffer, options);
        } catch {
          return inflateRawSync(rawBuffer, options);
        }
      }
    } catch (error) {
      throw new Error(`Could not decompress ${encoding} request body`, { cause: error });
    }

    throw new Error(`Unsupported Content-Encoding: ${encoding}`);
  }
}
