/**
 * WebRTC / Realtime Signaling Proxy Engine for OpenCodex Gateway V2
 * Transparently proxies WebSocket & HTTP WebRTC signaling requests to api.openai.com
 * with proper Origin header spoofing and duplex streaming.
 */

import http from "node:http";
import tls from "node:tls";
import { URL } from "node:url";

export function handleWebRtcProxy(req: http.IncomingMessage, socket: any, head: Buffer): void {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const targetHost = "api.openai.com";
  const targetPort = 443;

  console.log(`[OpenCodex WebRTC Proxy] Proxying WebSocket signal: wss://${targetHost}${url.pathname}${url.search}`);

  const options: tls.ConnectionOptions = {
    host: targetHost,
    port: targetPort,
    servername: targetHost,
    rejectUnauthorized: false,
  };

  const targetSocket = tls.connect(options, () => {
    let reqLines = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    reqLines += `Host: ${targetHost}\r\n`;

    for (const [key, value] of Object.entries(req.headers)) {
      const k = key.toLowerCase();
      if (k === "host") continue;
      if (k === "origin") {
        reqLines += `Origin: https://chatgpt.com\r\n`;
        continue;
      }
      if (Array.isArray(value)) {
        for (const v of value) {
          reqLines += `${key}: ${v}\r\n`;
        }
      } else if (value) {
        reqLines += `${key}: ${value}\r\n`;
      }
    }
    reqLines += "\r\n";

    targetSocket.write(reqLines);
    if (head && head.length > 0) {
      targetSocket.write(head);
    }

    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  targetSocket.on("error", (err) => {
    console.error(`[OpenCodex WebRTC Proxy Error] ${err.message}`);
    try { socket.destroy(); } catch {}
  });

  socket.on("error", () => {
    try { targetSocket.destroy(); } catch {}
  });
}
