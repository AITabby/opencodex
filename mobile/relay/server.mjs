import http from "node:http";
import http2 from "node:http2";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 8787);
const bindHost = process.env.RELAY_BIND_HOST || "127.0.0.1";
const requireForwardedTls = process.env.RELAY_REQUIRE_TLS === "1";
const pairings = loadPairings();
const statePath = process.env.RELAY_STATE_PATH || "";
const persistedActivityTokens = loadActivityTokens();
const peers = new Map();
const apns = loadApnsConfig();

function loadPairings() {
  if (process.env.RELAY_PAIRINGS_JSON) {
    try {
      const parsed = JSON.parse(process.env.RELAY_PAIRINGS_JSON);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  const channel = process.env.RELAY_CHANNEL || "";
  const token = process.env.RELAY_TOKEN || "";
  return channel && token ? { [channel]: token } : {};
}

function loadActivityTokens() {
  if (!statePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const now = Date.now();
    const result = {};
    for (const [channel, tasks] of Object.entries(parsed?.activityTokens || {})) {
      const fresh = {};
      for (const [taskId, value] of Object.entries(tasks || {})) {
        if (!value || typeof value.token !== "string") continue;
        if (Number.isFinite(value.updatedAt) && now - value.updatedAt > 7 * 24 * 60 * 60 * 1000) continue;
        fresh[taskId] = value;
      }
      if (Object.keys(fresh).length) result[channel] = fresh;
    }
    return result;
  } catch {
    return {};
  }
}

function persistActivityToken(channel, taskId, token) {
  if (!statePath) return;
  try {
    persistedActivityTokens[channel] ||= {};
    persistedActivityTokens[channel][taskId] = { token, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, activityTokens: persistedActivityTokens }) + "\n", { mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    console.error(`[OpenCodex Relay] Unable to persist relay state: ${error.message}`);
  }
}

function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function reject(socket, code = 1008) {
  try { socket.close(code); } catch {}
}

function loadApnsConfig() {
  const keyPath = process.env.APNS_PRIVATE_KEY_PATH || "";
  let privateKey = process.env.APNS_PRIVATE_KEY || "";
  if (!privateKey && keyPath) {
    try { privateKey = fs.readFileSync(keyPath, "utf8"); } catch {}
  }
  if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID || !process.env.APNS_BUNDLE_ID || !privateKey) return null;
  return {
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID,
    bundleId: process.env.APNS_BUNDLE_ID,
    privateKey,
    host: process.env.APNS_ENV === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com"
  };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function apnsJwt() {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: apns.keyId }));
  const body = base64url(JSON.stringify({ iss: apns.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = crypto.createSign("SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(apns.privateKey, "base64url")}`;
}

function sendApns(token, state) {
  if (!apns || !token) return;
  const client = http2.connect(`https://${apns.host}`);
  const isEnd = state.state === "completed" || state.state === "failed";
  const aps = {
    timestamp: Math.floor(Date.now() / 1000),
    event: isEnd ? "end" : "update",
    "content-state": {
      phase: state.state,
      model: state.model || "Codex",
      contextUsedTokens: state.contextUsedTokens ?? null,
      contextWindowTokens: state.contextWindowTokens ?? null,
      quotaUsedPercent: state.quotaUsedPercent ?? null,
      quotaWindowMinutes: state.quotaWindowMinutes ?? null,
      quotaResetsAt: state.quotaResetsAt ?? null,
      requiresAction: state.requiresAction === true,
      elapsedMs: state.elapsedMs ?? null,
      error: state.error || null
    },
    "stale-date": Math.floor(Date.now() / 1000) + 300
  };
  if (state.state === "waiting" || isEnd) {
    const model = state.model || "Codex";
    const alert = state.state === "waiting"
      ? { title: "Codex 等待确认", body: `${model} 正在等待你处理。`, sound: "default" }
      : state.state === "completed"
        ? { title: "Codex 任务完成", body: `${model} 已完成当前任务。`, sound: "default" }
        : { title: "Codex 任务失败", body: state.error ? `${model}：${state.error}` : `${model} 未能完成当前任务。`, sound: "default" };
    aps.alert = alert;
  }
  if (isEnd) aps["dismissal-date"] = Math.floor(Date.now() / 1000) + 60;
  const payload = JSON.stringify({ aps });
  const request = client.request({
    ":method": "POST",
    ":path": `/3/device/${token}`,
    authorization: `bearer ${apnsJwt()}`,
    "apns-topic": `${apns.bundleId}.push-type.liveactivity`,
    "apns-push-type": "liveactivity",
    "apns-priority": "10",
    "content-type": "application/json",
    ":scheme": "https"
  });
  request.on("response", headers => {
    if (Number(headers[":status"]) >= 400) console.error(`[OpenCodex Relay] APNs rejected Live Activity update (${headers[":status"]})`);
  });
  request.on("error", () => {});
  request.end(payload);
  request.on("close", () => client.close());
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      service: "opencodex-task-relay",
      apnsConfigured: Boolean(apns),
      activePairs: peers.size
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://relay.local");
  if (url.pathname !== "/v1/relay") {
    socket.destroy();
    return;
  }
  if (requireForwardedTls && req.headers["x-forwarded-proto"] !== "https") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", ws => {
  let identity = null;

  ws.once("message", raw => {
    let hello;
    try { hello = JSON.parse(raw.toString("utf8")); } catch { reject(ws); return; }
    const expected = pairings[hello?.channel];
    if (hello?.type !== "hello" || hello?.protocol !== "opencodex-task-relay-v1" ||
        !["mac", "phone"].includes(hello?.role) || !expected ||
        !sameSecret(hello.token, expected)) {
      reject(ws);
      return;
    }

    const key = String(hello.channel);
    const pair = peers.get(key) || {};
    if (pair[hello.role] && pair[hello.role].readyState === WebSocket.OPEN) {
      reject(ws, 1008);
      return;
    }
    pair[hello.role] = ws;
    pair.activityTokens ||= new Map(
      Object.entries(persistedActivityTokens[key] || {}).map(([taskId, value]) => [taskId, value.token])
    );
    peers.set(key, pair);
    identity = { key, role: hello.role };
    ws.send(JSON.stringify({ type: "ready", protocol: "opencodex-task-relay-v1" }));

    ws.on("message", message => {
      if (!identity) return;
      let parsed;
      try { parsed = JSON.parse(message.toString("utf8")); } catch {}
      if (parsed?.type === "activity_token" && identity.role === "phone" && parsed.taskId && parsed.token) {
        pair.activityTokens.set(String(parsed.taskId), String(parsed.token));
        persistActivityToken(key, String(parsed.taskId), String(parsed.token));
        return;
      }
      if (parsed?.type === "push_state" && identity.role === "mac") {
        const token = pair.activityTokens.get(String(parsed.taskId));
        if (token) sendApns(token, parsed);
      }
      const target = peers.get(identity.key)?.[identity.role === "mac" ? "phone" : "mac"];
      if (target?.readyState === WebSocket.OPEN) target.send(message, { binary: false });
    });
  });

  ws.on("close", () => {
    if (!identity) return;
    const pair = peers.get(identity.key);
    if (!pair) return;
    if (pair[identity.role] === ws) delete pair[identity.role];
    if (!pair.mac && !pair.phone) peers.delete(identity.key);
  });
});

httpServer.listen(port, bindHost, () => {
  console.log(`[OpenCodex Relay] listening on ${bindHost}:${port}; put it behind TLS before remote use`);
});

function shutdown() {
  for (const pair of peers.values()) {
    pair.mac?.close();
    pair.phone?.close();
  }
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
