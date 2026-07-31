import type { WebSocketRoute } from "./security_boundary.js";

const KIB = 1024;
const MIB = 1024 * KIB;

export type RequestPolicy = {
  id: string;
  bodyLimitBytes: number;
  requestsPerMinute: number;
  maxConcurrent: number;
};

export type GuardDecision = {
  allowed: boolean;
  reason?: "rate" | "concurrency";
  retryAfterSeconds: number;
  release: () => void;
};

const NOOP = () => {};

export function requestPolicyForHttp(method: string | undefined, pathname: string): RequestPolicy {
  const normalizedMethod = (method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
    if (pathname.startsWith("/api/logs")) {
      return { id: "logs-read", bodyLimitBytes: 0, requestsPerMinute: 180, maxConcurrent: 4 };
    }
    if (pathname === "/health" || pathname === "/" || pathname === "/dashboard" || pathname === "/visualizer" || pathname.startsWith("/assets/")) {
      return { id: "public-ui", bodyLimitBytes: 0, requestsPerMinute: 180, maxConcurrent: 16 };
    }
    return { id: "local-read", bodyLimitBytes: 0, requestsPerMinute: 240, maxConcurrent: 16 };
  }

  if (pathname === "/api/sessions/import") {
    return { id: "session-import", bodyLimitBytes: 36 * MIB, requestsPerMinute: 6, maxConcurrent: 1 };
  }
  if (pathname === "/api/voice/stt") {
    return { id: "voice-stt", bodyLimitBytes: 16 * MIB, requestsPerMinute: 30, maxConcurrent: 2 };
  }
  if (pathname === "/api/voice/tts") {
    return { id: "voice-tts", bodyLimitBytes: 512 * KIB, requestsPerMinute: 90, maxConcurrent: 3 };
  }
  if (pathname === "/api/voice/ask") {
    return { id: "voice-ask", bodyLimitBytes: 256 * KIB, requestsPerMinute: 60, maxConcurrent: 2 };
  }
  if (pathname === "/api/providers/test") {
    return { id: "provider-test", bodyLimitBytes: MIB, requestsPerMinute: 20, maxConcurrent: 2 };
  }
  if (pathname === "/api/mobile/messages") {
    return { id: "mobile-message", bodyLimitBytes: 512 * KIB, requestsPerMinute: 60, maxConcurrent: 4 };
  }
  if (
    pathname === "/v1"
    || pathname.startsWith("/v1/")
    || pathname === "/responses"
    || pathname.startsWith("/responses/")
    || pathname === "/backend-api"
    || pathname.startsWith("/backend-api/")
  ) {
    return { id: "model-gateway", bodyLimitBytes: 24 * MIB, requestsPerMinute: 120, maxConcurrent: 8 };
  }
  if (pathname.startsWith("/api/")) {
    return { id: "admin-write", bodyLimitBytes: 2 * MIB, requestsPerMinute: 90, maxConcurrent: 8 };
  }
  return { id: "local-other", bodyLimitBytes: MIB, requestsPerMinute: 60, maxConcurrent: 4 };
}

export function requestPolicyForWebSocket(route: WebSocketRoute): RequestPolicy {
  if (route === "voice") {
    return { id: "ws-voice", bodyLimitBytes: 0, requestsPerMinute: 30, maxConcurrent: 2 };
  }
  if (route === "realtime") {
    return { id: "ws-realtime", bodyLimitBytes: 0, requestsPerMinute: 60, maxConcurrent: 8 };
  }
  if (route === "responses") {
    return { id: "ws-responses", bodyLimitBytes: 0, requestsPerMinute: 30, maxConcurrent: 4 };
  }
  return { id: "ws-unknown", bodyLimitBytes: 0, requestsPerMinute: 20, maxConcurrent: 2 };
}

type GuardState = {
  windowStartedAt: number;
  count: number;
  active: number;
};

export class LocalRequestGuard {
  private readonly states = new Map<string, GuardState>();
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  public acquire(policy: RequestPolicy): GuardDecision {
    const now = this.clock();
    const state = this.states.get(policy.id) || { windowStartedAt: now, count: 0, active: 0 };
    if (now - state.windowStartedAt >= 60_000) {
      state.windowStartedAt = now;
      state.count = 0;
    }

    if (state.active >= policy.maxConcurrent) {
      this.states.set(policy.id, state);
      return { allowed: false, reason: "concurrency", retryAfterSeconds: 1, release: NOOP };
    }
    if (state.count >= policy.requestsPerMinute) {
      this.states.set(policy.id, state);
      const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - (now - state.windowStartedAt)) / 1000));
      return { allowed: false, reason: "rate", retryAfterSeconds, release: NOOP };
    }

    state.count += 1;
    state.active += 1;
    this.states.set(policy.id, state);
    let released = false;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      release: () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
      },
    };
  }
}
