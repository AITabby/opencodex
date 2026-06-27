import { ProxyAgent } from "undici";

function getProxyUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.HTTPS_PROXY || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY;
}

function getNoProxyList(env: NodeJS.ProcessEnv): string[] {
  return (env.NO_PROXY || env.no_proxy || "")
    .split(",")
    .map(pattern => pattern.trim())
    .filter(Boolean);
}

function matchesNoProxyPattern(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (hostname === pattern) return true;
  if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
  return hostname.endsWith("." + pattern);
}

export function createProxyBypassMatcher(env: NodeJS.ProcessEnv = process.env) {
  const proxyUrl = getProxyUrl(env);
  const noProxyList = getNoProxyList(env);

  return (url: string): boolean => {
    if (!proxyUrl || noProxyList.length === 0) return false;
    try {
      const hostname = new URL(url).hostname;
      return noProxyList.some(pattern => matchesNoProxyPattern(hostname, pattern));
    } catch {
      return false;
    }
  };
}

export function createFetchDispatcherSelector(env: NodeJS.ProcessEnv = process.env) {
  const proxyUrl = getProxyUrl(env);
  const noProxyList = getNoProxyList(env);
  const shouldBypassProxy = createProxyBypassMatcher(env);
  const defaultFetchDispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : undefined;

  return {
    proxyUrl,
    noProxyList,
    getFetchDispatcher(url: string) {
      return shouldBypassProxy(url) ? undefined : defaultFetchDispatcher;
    }
  };
}
