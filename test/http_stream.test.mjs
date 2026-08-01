import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  HTTP_FORWARD_WRITE_CHUNK_BYTES,
  writeHttpResponseChunked,
} from "../dist/services/http_stream.js";

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  chunks = [];
  writes = 0;

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    this.writes += 1;
    if (this.writes % 2 === 0) {
      queueMicrotask(() => this.emit("drain"));
      return false;
    }
    return true;
  }
}

test("large forwarded response bodies are written in bounded backpressured chunks", async () => {
  const response = new FakeResponse();
  const source = "x".repeat(HTTP_FORWARD_WRITE_CHUNK_BYTES * 2 + 17);
  await writeHttpResponseChunked(response, source);

  assert.ok(response.chunks.length >= 3);
  assert.ok(response.chunks.every((chunk) => chunk.byteLength <= HTTP_FORWARD_WRITE_CHUNK_BYTES));
  assert.equal(Buffer.concat(response.chunks).toString(), source);
});
