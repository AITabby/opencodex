import test from "node:test";
import assert from "node:assert/strict";

test("createProxyBypassMatcher matches NO_PROXY hosts and suffixes", async () => {
  const { createProxyBypassMatcher } = await import("../dist/proxy/proxyBypass.js");

  const shouldBypassProxy = createProxyBypassMatcher({
    HTTP_PROXY: "http://127.0.0.1:7890",
    NO_PROXY: "localhost,.internal.example.com,api.example.com"
  });

  assert.equal(shouldBypassProxy("http://localhost:3000/v1"), true);
  assert.equal(shouldBypassProxy("https://svc.internal.example.com/chat"), true);
  assert.equal(shouldBypassProxy("https://api.example.com/v1"), true);
  assert.equal(shouldBypassProxy("https://example.com/v1"), false);
});
