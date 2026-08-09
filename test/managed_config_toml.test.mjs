import test from "node:test";
import assert from "node:assert/strict";

import { buildManagedCodexConfig, tomlString } from "../dist/server/gateway.js";

const WINDOWS_CATALOG_PATH = "C:\\Users\\Example\\.opencodex\\custom_model_catalog.json";
const POSIX_CATALOG_PATH = "/Users/example/.opencodex/custom_model_catalog.json";

test("a Windows path is written as a TOML literal string", () => {
  // In a basic string TOML reads backslash as an escape introducer, so
  // "C:\Users\..." makes \U an invalid Unicode escape and the whole
  // config.toml stops parsing. A literal string takes the value verbatim.
  assert.equal(tomlString(WINDOWS_CATALOG_PATH), `'${WINDOWS_CATALOG_PATH}'`);
  assert.equal(tomlString(POSIX_CATALOG_PATH), `'${POSIX_CATALOG_PATH}'`);
});

test("a value containing an apostrophe falls back to an escaped basic string", () => {
  // A literal string cannot contain an apostrophe, so those values must use the
  // basic form with every backslash escaped.
  assert.equal(tomlString("C:\\it's\\odd"), '"C:\\\\it\'s\\\\odd"');
});

test("the managed block never emits a raw backslash inside a basic string", () => {
  const config = buildManagedCodexConfig("", 8765, "admin-token", WINDOWS_CATALOG_PATH);

  assert.match(config, /model_catalog_json = '[^']*custom_model_catalog\.json'/);
  for (const [, value] of config.matchAll(/=\s*"([^"\n]*)"/g)) {
    assert.ok(!value.includes("\\"), `unescaped backslash in a TOML basic string: ${value}`);
  }
});

test("the managed block still preserves existing config and native defaults", () => {
  const existing = 'model = "gpt-5.6-sol"\n\n[windows]\nsandbox = "unelevated"\n';
  const config = buildManagedCodexConfig(existing, 8765, "admin-token", WINDOWS_CATALOG_PATH);

  assert.match(config, /model = "gpt-5\.6-sol"/);
  assert.match(config, /\[windows\]/);
  assert.match(config, /sandbox = "unelevated"/);
  assert.match(config, /model_provider = "openai"/);
  assert.match(config, /\[model_providers\.opencodex\]/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:8765\/v1"/);
});
