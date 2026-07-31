import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { RequestDecompressor } from "../dist/core/decompressor.js";
import { buildContentSecurityPolicy, CodexBridgeServer } from "../dist/server/gateway.js";
import {
  redactLogLine,
  redactSensitiveText,
  safeDiagnosticTarget,
} from "../dist/server/privacy.js";
import {
  PrivateRuntimeDirectory,
  VOICE_RUNTIME_PACKAGES,
} from "../dist/server/private_runtime.js";
import {
  LocalRequestGuard,
  requestPolicyForHttp,
  requestPolicyForWebSocket,
} from "../dist/server/request_limits.js";
import { getDashboardHtml } from "../dist/services/dashboard.js";
import { getVisualizerHtml } from "../dist/services/visualizer.js";

const source = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function localRequest(port, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: options.path || "/health",
      method: options.method || "GET",
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test("private runtime files are random, isolated, and cleaned as one exact directory", () => {
  const runtime = new PrivateRuntimeDirectory("opencodex-p2-test");
  const first = runtime.uniqueFile("voice-audio", "wav");
  const second = runtime.uniqueFile("voice-audio", ".wav");

  assert.equal(path.dirname(first), runtime.root);
  assert.notEqual(first, second);
  assert.match(path.basename(first), /^voice-audio-[0-9a-f-]{36}\.wav$/);
  runtime.writePrivateFile(first, Buffer.from("private voice bytes"));
  assert.equal(readFileSync(first, "utf8"), "private voice bytes");
  assert.throws(() => runtime.writePrivateFile(path.join(os.tmpdir(), "outside.txt"), "no"), /outside/);

  if (process.platform !== "win32") {
    assert.equal(statSync(runtime.root).mode & 0o777, 0o700);
    assert.equal(statSync(first).mode & 0o777, 0o600);
  }

  runtime.cleanup();
  assert.equal(existsSync(runtime.root), false);
  assert.throws(() => runtime.fixedFile("late.txt"), /cleaned/);
});

test("voice runtime dependencies are immutable package specifications", () => {
  assert.deepEqual(VOICE_RUNTIME_PACKAGES, {
    edgeTts: "edge-tts==7.2.8",
    whisper: "openai-whisper==20250625",
    sileroVad: "silero-vad==6.2.1",
  });
  for (const requirement of Object.values(VOICE_RUNTIME_PACKAGES)) {
    assert.match(requirement, /^[a-z0-9-]+==[0-9][A-Za-z0-9.]*$/);
  }
});

test("persistent diagnostics redact credentials and user content", () => {
  const raw = [
    "Authorization: Bearer sk-this-is-a-secret-token",
    "cookie=session=private-value",
    '{"api_key":"json-private-key"}',
    "url=https://example.test/path?api_key=top-secret",
    'args={"path":"C:/private/customer.txt"}',
    "[STT] confidential spoken sentence",
    "HTTP 500: upstream private response body",
  ].join("\n");
  const safe = redactSensitiveText(raw);

  for (const secret of [
    "sk-this-is-a-secret-token",
    "private-value",
    "json-private-key",
    "top-secret",
    "customer.txt",
    "confidential spoken sentence",
    "upstream private response body",
  ]) {
    assert.equal(safe.includes(secret), false, secret);
  }
  assert.match(safe, /\[REDACTED/);
  assert.equal(redactLogLine("[WS Chunk] model output"), "[WS Chunk] content=[REDACTED]");
  assert.equal(
    safeDiagnosticTarget("https://api.example.test/v1/responses?api_key=secret#fragment"),
    "https://api.example.test/v1/responses",
  );
});

test("decompression rejects oversized and unsupported request bodies", () => {
  const compressed = gzipSync(Buffer.alloc(4096, 65));
  assert.throws(
    () => RequestDecompressor.decompressBody(compressed, "gzip", 128),
    /Could not decompress gzip request body/,
  );
  assert.throws(
    () => RequestDecompressor.decompressBody(Buffer.alloc(129), null, 128),
    /exceeds the decompressed size limit/,
  );
  assert.throws(
    () => RequestDecompressor.decompressBody(Buffer.from("payload"), "br", 128),
    /Unsupported Content-Encoding/,
  );
});

test("route policies apply least-privilege body, rate, and concurrency ceilings", () => {
  const sessionImport = requestPolicyForHttp("POST", "/api/sessions/import");
  const voiceStt = requestPolicyForHttp("POST", "/api/voice/stt");
  const voiceAsk = requestPolicyForHttp("POST", "/api/voice/ask");
  const gatewayRoot = requestPolicyForHttp("POST", "/v1");

  assert.equal(sessionImport.maxConcurrent, 1);
  assert.ok(sessionImport.bodyLimitBytes > voiceStt.bodyLimitBytes);
  assert.ok(voiceStt.bodyLimitBytes > voiceAsk.bodyLimitBytes);
  assert.equal(gatewayRoot.id, "model-gateway");
  assert.equal(requestPolicyForHttp("POST", "/backend-api").id, "model-gateway");
  assert.equal(requestPolicyForWebSocket("voice").maxConcurrent, 2);
});

test("local request guard rejects concurrent and rate-limit excess", () => {
  let now = 10_000;
  const guard = new LocalRequestGuard(() => now);
  const policy = {
    id: "unit-policy",
    bodyLimitBytes: 1024,
    requestsPerMinute: 2,
    maxConcurrent: 1,
  };

  const first = guard.acquire(policy);
  assert.equal(first.allowed, true);
  assert.equal(guard.acquire(policy).reason, "concurrency");
  first.release();
  first.release();

  const second = guard.acquire(policy);
  assert.equal(second.allowed, true);
  second.release();
  const limited = guard.acquire(policy);
  assert.equal(limited.allowed, false);
  assert.equal(limited.reason, "rate");
  assert.equal(limited.retryAfterSeconds, 60);

  now += 60_000;
  assert.equal(guard.acquire(policy).allowed, true);
});

test("Dashboard and visualizer use nonce-bound local assets and click-to-load remote images", async () => {
  const nonce = "p2-test-nonce";
  const dashboard = getDashboardHtml(nonce);
  const visualizer = getVisualizerHtml(false, "vortex", nonce);
  const dashboardSource = await source("src_v2/services/dashboard.ts");

  for (const html of [dashboard, visualizer]) {
    assert.match(html, new RegExp(`<style nonce="${nonce}">`));
    assert.match(html, new RegExp(`<script nonce="${nonce}">`));
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|cdn\.simpleicons|simpleicons\.org/i);
  }
  assert.doesNotMatch(visualizer, /\sonclick=/i);
  assert.match(dashboardSource, /data-remote-session-image/);
  assert.match(dashboardSource, /referrerPolicy='no-referrer'/);
  assert.match(dashboardSource, /image\.src=remote\.href/);
  assert.doesNotMatch(dashboardSource, /<img[^>]+src="https?:\/\//i);
});

test("gateway CSP denies ambient execution and framing", () => {
  const csp = buildContentSecurityPolicy("abc123");
  for (const directive of [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'nonce-abc123'",
    "form-action 'self'",
  ]) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
});

test("running gateway emits nonce-matched headers, enforces body limits, and removes runtime files", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "opencodex-p2-gateway-test-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  const port = await freePort();
  const server = new CodexBridgeServer(port);
  const runtimeRoot = server.runtimeFiles.root;
  const voiceToken = server.capabilityTokens.voice;

  try {
    await server.start();
    const dashboard = await localRequest(port, { path: "/dashboard" });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers["x-content-type-options"], "nosniff");
    assert.equal(dashboard.headers["referrer-policy"], "no-referrer");
    assert.equal(dashboard.headers["x-frame-options"], "DENY");
    assert.equal(dashboard.headers["cross-origin-resource-policy"], "same-origin");
    const nonce = dashboard.headers["content-security-policy"]?.match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.equal(dashboard.body.includes(`<script nonce="${nonce}">`), true);

    const oversized = await localRequest(port, {
      path: "/api/voice/ask",
      method: "POST",
      headers: {
        Authorization: `Bearer ${voiceToken}`,
        "Content-Type": "application/json",
        "Content-Length": String(256 * 1024 + 1),
      },
    });
    assert.equal(oversized.status, 413);
    assert.equal(JSON.parse(oversized.body).max_bytes, 256 * 1024);
    assert.equal(existsSync(runtimeRoot), true);
  } finally {
    await server.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(existsSync(runtimeRoot), false);
});

test("voice implementations contain no predictable global temporary paths", async () => {
  const [gateway, appDelegate, dropZone, privateStorage, wakeListener, startup] = await Promise.all([
    source("src_v2/server/gateway.ts"),
    source("voice/OpenCodexBar/Sources/OpenCodexBar/AppDelegate.swift"),
    source("voice/OpenCodexBar/Sources/OpenCodexBar/NotchDropZoneController.swift"),
    source("voice/OpenCodexBar/Sources/OpenCodexBar/PrivateRuntimeStorage.swift"),
    source("wake_word_listener.py"),
    source("startup.sh"),
  ]);

  for (const text of [gateway, appDelegate, dropZone, wakeListener, startup]) {
    assert.doesNotMatch(text, /\/tmp\//);
  }
  assert.match(privateStorage, /posixPermissions: 0o700/);
  assert.match(privateStorage, /posixPermissions: 0o600/);
  assert.match(appDelegate, /PrivateRuntimeStorage\.shared\.cleanup\(\)/);
  assert.match(gateway, /VOICE_RUNTIME_PACKAGES\.edgeTts/);
  assert.match(gateway, /VOICE_RUNTIME_PACKAGES\.whisper/);
  assert.match(gateway, /VOICE_RUNTIME_PACKAGES\.sileroVad/);
});
