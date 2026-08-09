import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ChatGptAccountPool, type ChatGptAccountView } from "./chatgpt_account_pool.js";
import { resolveNativeCodexPath } from "./chatgpt_account_usage.js";

export type ChatGptAccountLoginStatus = "pending" | "completed" | "failed" | "cancelled";

export interface ChatGptAccountLoginView {
  flow_id: string;
  account_id: string;
  status: ChatGptAccountLoginStatus;
  started_at: string;
  finished_at?: string;
  error?: string;
  auth_status: ChatGptAccountView["auth_status"];
}

type LoginFlow = Omit<ChatGptAccountLoginView, "auth_status"> & {
  child: ChildProcessWithoutNullStreams;
  auth_mtime_ms: number;
  poll_timer: NodeJS.Timeout;
};

function nowIso(): string {
  return new Date().toISOString();
}

function authPath(account: ChatGptAccountView): string {
  return path.join(account.profile_dir, "auth.json");
}

function authMtime(account: ChatGptAccountView): number {
  try {
    return fs.statSync(authPath(account)).mtimeMs;
  } catch {
    return 0;
  }
}

function hasAuth(account: ChatGptAccountView): boolean {
  try {
    const stat = fs.statSync(authPath(account));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  return raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token[=:][^\s,}]+/gi, "token=[redacted]")
    .trim()
    .slice(0, 240) || "官方登录失败";
}

/**
 * Owns only the official login subprocess for each isolated account profile.
 * The native executable and native app-server remain untouched; the bridge
 * supplies CODEX_HOME and waits for the native login flow to materialize the
 * profile's auth.json. Tokens never cross the dashboard API.
 */
export class ChatGptAccountLoginService {
  private readonly flows = new Map<string, LoginFlow>();

  constructor(
    private readonly accountPool: ChatGptAccountPool,
    private readonly nativePathResolver: () => string = resolveNativeCodexPath,
  ) {}

  public start(accountIdValue: unknown, reauth = false): ChatGptAccountLoginView {
    const account = this.accountPool.getAccount(accountIdValue);
    if (!account) throw new Error("ChatGPT 账号不存在");
    const existing = [...this.flows.values()].find((flow) =>
      flow.account_id === account.id && flow.status === "pending");
    if (existing) return this.toView(existing);
    if (!reauth && account.auth_status === "ready") {
      throw new Error("账号已经登录；如需更换账号，请使用重新登录");
    }

    const nativePath = this.nativePathResolver();
    if (!fs.existsSync(nativePath)) {
      throw new Error(`未找到 native Codex 可执行文件：${nativePath}`);
    }
    this.accountPool.prepareAccountLogin(account.id);
    const flowId = randomUUID();
    const flow = {
      flow_id: flowId,
      account_id: account.id,
      status: "pending" as const,
      started_at: nowIso(),
      auth_mtime_ms: reauth ? authMtime(account) : 0,
      child: undefined as unknown as ChildProcessWithoutNullStreams,
      poll_timer: undefined as unknown as NodeJS.Timeout,
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: account.profile_dir,
      CODEX_CLI_PATH: undefined,
      OPENCODEX_NATIVE_CLI_PATH: undefined,
      OPENCODEX_PROVIDER_BRIDGE_PATH: undefined,
      OPENCODEX_PROVIDER_SPLIT: undefined,
      OPENCODEX_PROVIDER_BRIDGE_RUNTIME: undefined,
      OPENCODEX_GATEWAY_PORT: undefined,
      OPENCODEX_CHATGPT_ACCOUNT_ID: account.id,
    };
    const child = spawn(nativePath, ["login"], {
      cwd: account.profile_dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    flow.child = child;
    flow.poll_timer = setInterval(() => this.check(flow), 500);
    this.flows.set(flowId, flow);
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.once("error", (error) => this.finish(flow, "failed", safeError(error)));
    child.once("close", (code, signal) => {
      if (flow.status !== "pending") return;
      if (this.authCompleted(flow)) {
        this.finish(flow, "completed");
        return;
      }
      this.finish(flow, "failed", `官方登录进程结束（${signal || code || "unknown"}）`);
    });
    this.check(flow);
    return this.toView(flow);
  }

  public status(accountIdValue: unknown, flowIdValue?: unknown): ChatGptAccountLoginView {
    const account = this.accountPool.getAccount(accountIdValue);
    if (!account) throw new Error("ChatGPT 账号不存在");
    const flowId = typeof flowIdValue === "string" ? flowIdValue.trim() : "";
    const flow = flowId
      ? this.flows.get(flowId)
      : [...this.flows.values()].reverse().find((candidate) => candidate.account_id === account.id);
    if (flow && flow.account_id === account.id) {
      this.check(flow);
      return this.toView(flow);
    }
    return {
      flow_id: flowId || "",
      account_id: account.id,
      status: account.auth_status === "ready" ? "completed" : "failed",
      started_at: account.updated_at,
      auth_status: account.auth_status,
      ...(account.auth_status === "ready" ? {} : { error: "账号尚未完成官方登录" }),
    };
  }

  public cancel(accountIdValue: unknown, flowIdValue?: unknown): ChatGptAccountLoginView {
    const account = this.accountPool.getAccount(accountIdValue);
    if (!account) throw new Error("ChatGPT 账号不存在");
    const flowId = typeof flowIdValue === "string" ? flowIdValue.trim() : "";
    const flow = flowId
      ? this.flows.get(flowId)
      : [...this.flows.values()].reverse().find((candidate) => candidate.account_id === account.id && candidate.status === "pending");
    if (!flow || flow.account_id !== account.id) return this.status(account.id, flowId);
    if (flow.status === "pending") {
      try { flow.child.kill("SIGTERM"); } catch {}
      this.finish(flow, "cancelled", "已取消官方登录");
    }
    return this.toView(flow);
  }

  public stopAll(): void {
    for (const flow of this.flows.values()) {
      if (flow.status !== "pending") continue;
      try { flow.child.kill("SIGTERM"); } catch {}
      this.finish(flow, "cancelled", "网关已停止");
    }
  }

  private check(flow: LoginFlow): void {
    if (flow.status !== "pending") return;
    const account = this.accountPool.getAccount(flow.account_id);
    if (!account) {
      this.finish(flow, "failed", "账号已从账号池移除");
      return;
    }
    if (this.authCompleted(flow, account)) this.finish(flow, "completed");
  }

  private authCompleted(flow: LoginFlow, current = this.accountPool.getAccount(flow.account_id) || undefined): boolean {
    if (!current || !hasAuth(current)) return false;
    if (flow.auth_mtime_ms <= 0) return true;
    return authMtime(current) > flow.auth_mtime_ms;
  }

  private finish(flow: LoginFlow, status: Exclude<ChatGptAccountLoginStatus, "pending">, error?: string): void {
    if (flow.status !== "pending") return;
    clearInterval(flow.poll_timer);
    flow.status = status;
    flow.finished_at = nowIso();
    if (error) flow.error = error;
    // The native login process normally exits itself after browser OAuth. If
    // the auth file appears first, stop the isolated helper here so a stale
    // login process cannot survive in the background.
    if (!flow.child.killed) {
      try { flow.child.kill("SIGTERM"); } catch {}
    }
    if (status === "completed") this.accountPool.markAuthSuccess(flow.account_id);
  }

  private toView(flow: LoginFlow): ChatGptAccountLoginView {
    const account = this.accountPool.getAccount(flow.account_id);
    return {
      flow_id: flow.flow_id,
      account_id: flow.account_id,
      status: flow.status,
      started_at: flow.started_at,
      ...(flow.finished_at ? { finished_at: flow.finished_at } : {}),
      ...(flow.error ? { error: flow.error } : {}),
      auth_status: account?.auth_status || "missing",
    };
  }
}
