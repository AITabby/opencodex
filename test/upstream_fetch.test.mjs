import test from "node:test";
import assert from "node:assert/strict";
import { fetchUpstream, UpstreamFetchError } from "../dist/services/upstream_fetch.js";

test("upstream fetch retries transient pre-response failures and then recovers", async () => {
  let attempts = 0;
  const response = await fetchUpstream("https://provider.example/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ stream: true }),
    operation: "test-retry",
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: "socket reset" } });
      }
      return new Response("ok", { status: 200 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
});

test("upstream fetch does not retry when the caller aborts", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;

  await assert.rejects(
    fetchUpstream("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        throw new DOMException("The operation was aborted", "AbortError");
      },
    }),
    (error) => error instanceof UpstreamFetchError && error.attempts === 1 && error.retryable === false,
  );

  assert.equal(attempts, 1);
});
