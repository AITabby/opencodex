import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("mobile client stores and sends only its dedicated capability token", async () => {
  const [model, events, view] = await Promise.all([
    read("mobile/OpenCodexMobile/MobileModel.swift"),
    read("mobile/OpenCodexMobile/TaskEventClient.swift"),
    read("mobile/OpenCodexMobile/ContentView.swift"),
  ]);

  assert.match(model, /@Published var mobileToken: String/);
  assert.match(model, /KeychainStore\.string\(for: "gateway-mobile-token"\)/);
  assert.match(model, /KeychainStore\.set\(mobileToken, for: "gateway-mobile-token"\)/);
  assert.match(model, /KeychainStore\.remove\("gateway-admin-token"\)/);
  assert.doesNotMatch(model, /KeychainStore\.(?:string|set)[^\n]*gateway-admin-token/);
  assert.match(events, /Bearer \\\(mobileToken\)/);
  assert.doesNotMatch(events, /adminToken/);
  assert.match(view, /移动端配对令牌/);
});
