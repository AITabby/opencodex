import { createCipheriv, randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import type { CodexTaskEvent, TaskEventBus } from "./task_events.js";

const RELAY_PROTOCOL = "opencodex-task-relay-v1";

export interface TaskEventRelayConfig {
  url: string;
  channel: string;
  token: string;
  encryptionKey: Buffer;
}

function encryptedEvent(event: CodexTaskEvent, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(event), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    type: "event",
    version: 1,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url")
  });
}

/**
 * Optional outbound-only bridge for remote task notifications.
 *
 * It is inert unless all relay settings are explicitly configured. The relay
 * receives only an encrypted envelope; prompt text and tool payloads never
 * leave the Mac gateway.
 */
export class TaskEventRelay {
  private socket: WebSocket | null = null;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private readonly pending = new Map<string, CodexTaskEvent>();
  private readonly unsubscribe: () => void;

  constructor(private readonly bus: TaskEventBus, private readonly config: TaskEventRelayConfig) {
    this.unsubscribe = bus.subscribe((event) => this.onEvent(event));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }

  private onEvent(event: CodexTaskEvent): void {
    this.pending.set(event.taskId, event);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendEvent(event);
      this.pending.delete(event.taskId);
    }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    try {
      const socket = new WebSocket(this.config.url, {
        headers: {
          "x-opencodex-relay-channel": this.config.channel,
          Authorization: `Bearer ${this.config.token}`
        },
        maxPayload: 64 * 1024
      });
      this.socket = socket;

      socket.once("open", () => {
        this.reconnectDelay = 1000;
        socket.send(JSON.stringify({
          type: "hello",
          protocol: RELAY_PROTOCOL,
          role: "mac",
          channel: this.config.channel,
          token: this.config.token
        }));
        for (const event of this.pending.values()) this.sendEvent(event);
        this.pending.clear();
      });
      socket.on("close", () => this.scheduleReconnect(socket));
      socket.on("error", () => {
        // The close handler owns reconnect and deliberately avoids logging
        // credentials or relay URLs that may contain private query values.
      });
    } catch {
      this.scheduleReconnect(null);
    }
  }

  private sendEvent(event: CodexTaskEvent): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(encryptedEvent(event, this.config.encryptionKey));
      // The relay may use this metadata-only message for an APNs Live
      // Activity update while the phone app is suspended. It contains no
      // prompt, tool arguments, paths, or file contents.
      this.socket.send(JSON.stringify({
        type: "push_state",
        taskId: event.taskId,
        sessionId: event.sessionId,
        state: event.state,
        model: event.model,
        contextUsedTokens: event.contextUsedTokens,
        contextWindowTokens: event.contextWindowTokens,
        quotaUsedPercent: event.quotaUsedPercent,
        quotaWindowMinutes: event.quotaWindowMinutes,
        quotaResetsAt: event.quotaResetsAt,
        requiresAction: event.requiresAction === true,
        elapsedMs: event.elapsedMs,
        error: event.error
      }));
    } catch {}
  }

  private scheduleReconnect(socket: WebSocket | null): void {
    if (socket && this.socket !== socket) return;
    this.socket = null;
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export function parseRelayKey(raw: string): Buffer | null {
  const value = raw.trim();
  const key = value.length === 64 && /^[0-9a-f]+$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64url");
  return key.length === 32 ? key : null;
}
