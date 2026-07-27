/**
 * Local subscription authentication for providers whose desktop/CLI login
 * stores a short-lived access token plus a refresh token.
 *
 * This module deliberately owns only token resolution and persistence. Model
 * catalog import and request routing call the same resolver so an expired
 * access token cannot make one surface report a different state from another.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const GROK_AUTH_PATH = path.join(os.homedir(), ".grok", "auth.json");
const ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity";
const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
const ANTIGRAVITY_KEYCHAIN_PREFIX = "go-keyring-base64:";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const ANTIGRAVITY_APP_PATHS = [
  "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
  path.join(os.homedir(), "Applications/Antigravity.app/Contents/Resources/bin/language_server")
];

type GrokSession = Record<string, any>;
type AntigravityAuth = { token?: Record<string, any>; [key: string]: any };

function isUsableExpiry(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // OAuth providers may store either seconds or milliseconds.
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isValidAccessToken(token: unknown, expiry: unknown, now = Date.now()): boolean {
  if (typeof token !== "string" || token.trim().length === 0) return false;
  const expiryMs = isUsableExpiry(expiry);
  return expiryMs === null || expiryMs - now > REFRESH_SKEW_MS;
}

function writeJsonSecure(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}

function readGrokSession(): { authData: Record<string, GrokSession>; sessionKey: string; session: GrokSession } | null {
  try {
    if (!fs.existsSync(GROK_AUTH_PATH)) return null;
    const authData = JSON.parse(fs.readFileSync(GROK_AUTH_PATH, "utf-8")) as Record<string, GrokSession>;
    const sessionKey = Object.keys(authData).find((key) => {
      const value = authData[key];
      return value && (value.key || value.token || value.access_token || value.refresh_token);
    });
    if (!sessionKey || !authData[sessionKey]) return null;
    return { authData, sessionKey, session: authData[sessionKey] };
  } catch {
    return null;
  }
}

function readAntigravityAuth(): AntigravityAuth | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync("security", [
      "find-generic-password",
      "-a", ANTIGRAVITY_KEYCHAIN_ACCOUNT,
      "-s", ANTIGRAVITY_KEYCHAIN_SERVICE,
      "-w"
    ], { encoding: "utf-8" }).trim();
    if (!raw.startsWith(ANTIGRAVITY_KEYCHAIN_PREFIX)) return null;
    const encoded = raw.slice(ANTIGRAVITY_KEYCHAIN_PREFIX.length);
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as AntigravityAuth;
  } catch {
    return null;
  }
}

function writeAntigravityAuth(auth: AntigravityAuth): void {
  const raw = `${ANTIGRAVITY_KEYCHAIN_PREFIX}${Buffer.from(JSON.stringify(auth), "utf-8").toString("base64")}`;
  execFileSync("security", [
    "add-generic-password",
    "-a", ANTIGRAVITY_KEYCHAIN_ACCOUNT,
    "-s", ANTIGRAVITY_KEYCHAIN_SERVICE,
    "-w", raw,
    "-U"
  ], { stdio: "ignore" });
}

function readAntigravityOAuthClient(): { clientId: string; clientSecret: string } | null {
  const clientIdFromEnv = String(process.env.OPENCODEX_ANTIGRAVITY_OAUTH_CLIENT_ID || "").trim();
  const clientSecretFromEnv = String(process.env.OPENCODEX_ANTIGRAVITY_OAUTH_CLIENT_SECRET || "").trim();
  if (clientIdFromEnv) return { clientId: clientIdFromEnv, clientSecret: clientSecretFromEnv };

  // Antigravity owns these OAuth client values. Discover them from the local
  // installation instead of copying vendor credentials into this repository.
  // The installed app is the authority for the values used by its Keychain
  // login; this also keeps source-only installs honest when the app is absent.
  for (const appPath of ANTIGRAVITY_APP_PATHS) {
    try {
      if (!fs.existsSync(appPath)) continue;
      const binary = fs.readFileSync(appPath, "utf8");
      const clientIds = [...new Set(binary.match(/[0-9][A-Za-z0-9._-]{20,80}\.apps\.googleusercontent\.com/g) || [])];
      const clientSecrets = [...new Set(binary.match(/GOCSPX-[A-Za-z0-9_-]{20,100}/g) || [])];
      // The Antigravity OAuth client ID is the 75-character Google client ID;
      // other IDs in the language server belong to internal services.
      const clientId = clientIds.find((value) => value.length === 75) || clientIds[0];
      if (clientId && clientSecrets[0]) return { clientId, clientSecret: clientSecrets[0] };
    } catch {
      // A missing or unreadable local app should not break normal token use.
    }
  }
  return null;
}

export class SubscriptionAuthService {
  private static grokRefresh: Promise<string | null> | null = null;
  private static antigravityRefresh: Promise<string | null> | null = null;

  public static hasGrokCredential(): boolean {
    return Boolean(readGrokSession());
  }

  public static hasAntigravityCredential(): boolean {
    const auth = readAntigravityAuth();
    return Boolean(auth?.token?.access_token || auth?.token?.refresh_token);
  }

  private static async refreshGrokToken(): Promise<string | null> {
    const current = readGrokSession();
    if (!current) return null;
    const refreshToken = current.session.refresh_token;
    if (!refreshToken) return null;

    const issuer = String(current.session.oidc_issuer || "https://auth.x.ai").replace(/\/$/, "");
    const clientId = String(current.session.oidc_client_id || "");
    if (!clientId) return null;

    const response = await fetch(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "grok-cli/1.89.0" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return null;

    const refreshed = await response.json() as any;
    const accessToken = refreshed.access_token || refreshed.id_token || refreshed.key;
    if (!accessToken) return null;

    current.session.key = accessToken;
    if (refreshed.refresh_token) current.session.refresh_token = refreshed.refresh_token;
    if (refreshed.expires_in) {
      current.session.expires_at = new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString();
    }
    current.authData[current.sessionKey] = current.session;
    writeJsonSecure(GROK_AUTH_PATH, current.authData);
    return accessToken;
  }

  public static async getGrokAccessToken(forceRefresh = false): Promise<string | null> {
    const current = readGrokSession();
    if (!current) return null;
    const session = current.session;
    const token = session.key || session.token || session.access_token || "";
    if (!forceRefresh && isValidAccessToken(token, session.expires_at)) return token;

    if (!this.grokRefresh) {
      this.grokRefresh = this.refreshGrokToken().finally(() => { this.grokRefresh = null; });
    }
    const refreshed = await this.grokRefresh;
    if (refreshed) return refreshed;

    // A temporary refresh outage should not interrupt a still-valid token.
    return !forceRefresh && isValidAccessToken(token, session.expires_at) ? token : null;
  }

  private static async refreshAntigravityToken(): Promise<string | null> {
    const auth = readAntigravityAuth();
    const token = auth?.token;
    if (!token?.refresh_token) return null;

    const oauthClient = readAntigravityOAuthClient();
    if (!oauthClient) return null;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: String(token.refresh_token),
        client_id: oauthClient.clientId,
        ...(oauthClient.clientSecret ? { client_secret: oauthClient.clientSecret } : {})
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return null;

    const refreshed = await response.json() as any;
    if (!refreshed.access_token) return null;
    const expiry = new Date(Date.now() + (Number(refreshed.expires_in) || 3600) * 1000).toISOString();
    token.access_token = refreshed.access_token;
    token.expiry = expiry;
    token.expires_at = expiry;
    if (refreshed.refresh_token) token.refresh_token = refreshed.refresh_token;
    writeAntigravityAuth(auth as AntigravityAuth);
    return refreshed.access_token;
  }

  public static async getAntigravityAccessToken(forceRefresh = false): Promise<string | null> {
    const auth = readAntigravityAuth();
    const token = auth?.token;
    if (!token) return null;
    const accessToken = token.access_token || "";
    const expiry = token.expiry || token.expires_at;
    if (!forceRefresh && isValidAccessToken(accessToken, expiry)) return accessToken;

    if (!this.antigravityRefresh) {
      this.antigravityRefresh = this.refreshAntigravityToken().finally(() => { this.antigravityRefresh = null; });
    }
    const refreshed = await this.antigravityRefresh;
    if (refreshed) return refreshed;

    return !forceRefresh && isValidAccessToken(accessToken, expiry) ? accessToken : null;
  }
}
