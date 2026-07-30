import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"];
const PROXY_ENV_NAMES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;
const NETWORK_CONFIG_PATH = path.join(os.homedir(), ".opencodex", "network.json");

export type ProxyMode = "auto" | "manual" | "off";

export interface NetworkProxyConfig {
  mode: ProxyMode;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface ResolvedNetworkProxy extends NetworkProxyConfig {
  source: "environment" | "login-shell" | "manual" | "saved" | "clash" | "direct";
  enabled: boolean;
}

export function mergeNoProxy(value = ""): string {
  const entries = String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!seen.has(loopback.toLowerCase())) entries.push(loopback);
  }
  return entries.join(",");
}

export function parseProxyEnvironment(output = ""): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    if (!(PROXY_ENV_NAMES as readonly string[]).includes(name)) continue;
    const value = line.slice(separator + 1).trim();
    if (value) parsed[name] = value;
  }
  return parsed;
}

export function readLoginShellProxyEnvironment(): Record<string, string> {
  if (process.platform !== "darwin") return {};
  try {
    const command = [
      "for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy",
      "do value=$(/usr/bin/printenv \"$name\")",
      "if [ -n \"$value\" ]; then /usr/bin/printf '%s=%s\\n' \"$name\" \"$value\"; fi",
      "done",
    ].join("; ");
    const output = execFileSync("/bin/zsh", ["-lc", command], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseProxyEnvironment(output);
  } catch {
    return {};
  }
}

export function parseClashMixedPort(contents = ""): string {
  const match = String(contents || "").match(/^\s*mixed-port\s*:\s*(\d{1,5})\s*(?:#.*)?$/mi);
  const port = Number(match?.[1] || 0);
  return port > 0 && port <= 65535 ? `http://127.0.0.1:${port}` : "";
}

export function normalizeProxyUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("代理地址仅支持 http:// 或 https://");
    }
    if (!url.hostname || url.username || url.password) {
      throw new Error("代理地址不能包含用户名或密码");
    }
    return url.toString().replace(/\/$/, "");
  } catch (error: any) {
    if (error?.message?.startsWith("代理地址")) throw error;
    throw new Error(`无效的代理地址：${raw}`);
  }
}

export function normalizeNetworkProxyConfig(input: any = {}): NetworkProxyConfig {
  const rawMode = String(input?.mode || "auto").trim().toLowerCase();
  if (!["auto", "manual", "off"].includes(rawMode)) {
    throw new Error("代理模式必须是 auto、manual 或 off");
  }
  const mode = rawMode as ProxyMode;
  const httpProxy = normalizeProxyUrl(input?.httpProxy);
  const httpsProxy = normalizeProxyUrl(input?.httpsProxy);
  const noProxy = String(input?.noProxy || "").trim();
  if (noProxy.length > 2048 || /[\r\n]/.test(noProxy)) {
    throw new Error("不使用代理的地址列表格式无效");
  }
  if (mode === "manual" && !httpProxy && !httpsProxy) {
    throw new Error("手动模式至少需要填写一个代理地址");
  }
  return { mode, httpProxy, httpsProxy, noProxy };
}

export function readNetworkProxyConfig(): NetworkProxyConfig {
  try {
    const persisted = JSON.parse(fs.readFileSync(NETWORK_CONFIG_PATH, "utf-8"));
    // Files written by older OpenCodex versions had no mode. Treat those
    // loopback values as an automatic fallback so the upgrade is lossless.
    return normalizeNetworkProxyConfig({
      mode: persisted?.mode || "auto",
      httpProxy: persisted?.httpProxy,
      httpsProxy: persisted?.httpsProxy,
      noProxy: persisted?.noProxy,
    });
  } catch {
    return { mode: "auto", httpProxy: "", httpsProxy: "", noProxy: "" };
  }
}

export function saveNetworkProxyConfig(input: any): NetworkProxyConfig {
  const config = normalizeNetworkProxyConfig(input);
  const dataDir = path.dirname(NETWORK_CONFIG_PATH);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(NETWORK_CONFIG_PATH, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.chmodSync(NETWORK_CONFIG_PATH, 0o600);
  return config;
}

function readClashProxy(): string {
  const clashPaths = [
    path.join(os.homedir(), "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
    path.join(os.homedir(), ".config", "clash", "config.yaml"),
    path.join(os.homedir(), ".config", "mihomo", "config.yaml"),
  ];
  for (const configPath of clashPaths) {
    try {
      const proxy = parseClashMixedPort(fs.readFileSync(configPath, "utf-8"));
      if (proxy) return proxy;
    } catch {}
  }
  return "";
}

function proxyPair(environment: Record<string, string>): { httpProxy: string; httpsProxy: string; noProxy: string } {
  const allProxy = environment.ALL_PROXY || environment.all_proxy || "";
  const httpProxy = environment.HTTP_PROXY || environment.http_proxy || allProxy;
  const httpsProxy = environment.HTTPS_PROXY || environment.https_proxy || httpProxy || allProxy;
  return {
    httpProxy: httpProxy ? normalizeProxyUrl(httpProxy) : "",
    httpsProxy: httpsProxy ? normalizeProxyUrl(httpsProxy) : "",
    noProxy: environment.NO_PROXY || environment.no_proxy || "",
  };
}

export function resolveNetworkProxy(config = readNetworkProxyConfig()): ResolvedNetworkProxy {
  if (config.mode === "off") {
    return { ...config, httpProxy: "", httpsProxy: "", source: "direct", enabled: false };
  }
  if (config.mode === "manual") {
    return {
      ...config,
      httpProxy: config.httpProxy || config.httpsProxy,
      httpsProxy: config.httpsProxy || config.httpProxy,
      noProxy: mergeNoProxy(config.noProxy),
      source: "manual",
      enabled: true,
    };
  }

  for (const [source, environment] of [
    ["environment", process.env as Record<string, string>],
    ["login-shell", readLoginShellProxyEnvironment()],
  ] as const) {
    try {
      const pair = proxyPair(environment);
      if (pair.httpProxy || pair.httpsProxy) {
        return {
          ...config,
          httpProxy: pair.httpProxy || pair.httpsProxy,
          httpsProxy: pair.httpsProxy || pair.httpProxy,
          noProxy: mergeNoProxy(pair.noProxy || config.noProxy),
          source,
          enabled: true,
        };
      }
    } catch {}
  }

  if (config.httpProxy || config.httpsProxy) {
    return {
      ...config,
      httpProxy: config.httpProxy || config.httpsProxy,
      httpsProxy: config.httpsProxy || config.httpProxy,
      noProxy: mergeNoProxy(config.noProxy),
      source: "saved",
      enabled: true,
    };
  }
  const clashProxy = readClashProxy();
  if (clashProxy) {
    return {
      ...config,
      httpProxy: clashProxy,
      httpsProxy: clashProxy,
      noProxy: mergeNoProxy(config.noProxy),
      source: "clash",
      enabled: true,
    };
  }
  return { ...config, source: "direct", enabled: false };
}

function dispatcherFor(resolved: ResolvedNetworkProxy): Agent | EnvHttpProxyAgent {
  if (!resolved.enabled) return new Agent();
  return new EnvHttpProxyAgent({
    httpProxy: resolved.httpProxy || undefined,
    httpsProxy: resolved.httpsProxy || undefined,
    noProxy: mergeNoProxy(resolved.noProxy),
  });
}

export function configureNetworkDispatcher(): ResolvedNetworkProxy {
  const resolved = resolveNetworkProxy();
  setGlobalDispatcher(dispatcherFor(resolved));
  return resolved;
}

export async function testNetworkProxy(input: any = readNetworkProxyConfig()): Promise<{
  ok: boolean;
  status: number;
  elapsedMs: number;
  resolved: ResolvedNetworkProxy;
}> {
  const config = normalizeNetworkProxyConfig(input);
  const resolved = resolveNetworkProxy(config);
  const startedAt = Date.now();
  const response = await undiciFetch("https://chatgpt.com/", {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    dispatcher: dispatcherFor(resolved),
  });
  return {
    ok: true,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    resolved,
  };
}

export function describeNetworkError(error: any): string {
  const details = [
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return Array.from(new Set(details)).join(": ") || "Unknown network error";
}
