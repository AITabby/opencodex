import test from "node:test";
import assert from "node:assert/strict";
import {
  describeNetworkError,
  mergeNoProxy,
  normalizeNetworkProxyConfig,
  normalizeProxyUrl,
  parseClashMixedPort,
  parseProxyEnvironment
} from "../dist/services/network.js";

test("proxy bypass always includes loopback destinations", () => {
  const entries = mergeNoProxy("example.com,localhost").split(",");
  assert.ok(entries.includes("example.com"));
  assert.ok(entries.includes("localhost"));
  assert.ok(entries.includes("127.0.0.1"));
  assert.ok(entries.includes("::1"));
  assert.equal(entries.filter((entry) => entry === "localhost").length, 1);
});

test("network diagnostics include the underlying fetch cause", () => {
  assert.equal(
    describeNetworkError({
      message: "fetch failed",
      cause: { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" }
    }),
    "fetch failed: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error"
  );
});

test("login shell proxy output is parsed without importing unrelated environment values", () => {
  assert.deepEqual(parseProxyEnvironment([
    "HTTP_PROXY=http://127.0.0.1:7897",
    "HTTPS_PROXY=http://127.0.0.1:7897",
    "SECRET=do-not-import",
    ""
  ].join("\n")), {
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897"
  });
});

test("Clash mixed port is converted to a loopback HTTP proxy", () => {
  assert.equal(parseClashMixedPort("mode: rule\nmixed-port: 7897\nallow-lan: false\n"), "http://127.0.0.1:7897");
  assert.equal(parseClashMixedPort("mixed-port: 70000\n"), "");
});

test("manual proxy configuration validates URLs and requires an endpoint", () => {
  assert.deepEqual(normalizeNetworkProxyConfig({
    mode: "manual",
    httpProxy: "http://127.0.0.1:7897/",
    noProxy: "*.local"
  }), {
    mode: "manual",
    httpProxy: "http://127.0.0.1:7897",
    httpsProxy: "",
    noProxy: "*.local"
  });
  assert.throws(() => normalizeNetworkProxyConfig({ mode: "manual" }), /至少需要填写一个代理地址/);
  assert.throws(() => normalizeProxyUrl("socks5://127.0.0.1:7897"), /仅支持/);
  assert.throws(() => normalizeProxyUrl("http://user:secret@127.0.0.1:7897"), /不能包含用户名或密码/);
});

test("direct proxy mode is represented explicitly", () => {
  assert.deepEqual(normalizeNetworkProxyConfig({ mode: "off" }), {
    mode: "off",
    httpProxy: "",
    httpsProxy: "",
    noProxy: ""
  });
});
