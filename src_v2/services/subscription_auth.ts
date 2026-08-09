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
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { SubscriptionAccountPool, type SubscriptionProvider } from "./subscription_account_pool.js";

const GROK_AUTH_PATH = path.join(os.homedir(), ".grok", "auth.json");
const ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity";
const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
const ANTIGRAVITY_KEYCHAIN_PREFIX = "go-keyring-base64:";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const CURSOR_STATE_DB = path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
const CURSOR_APP_BUNDLE = "/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js";
const CURSOR_AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CLAUDE_COOKIE_DB = path.join(os.homedir(), "Library", "Application Support", "Claude", "Cookies");
const CLAUDE_SAFE_STORAGE_SERVICE = "Claude Safe Storage";
const CLAUDE_SAFE_STORAGE_ACCOUNT = "Claude Key";
const CLAUDE_CONFIG_JSON = path.join(os.homedir(), "Library", "Application Support", "Claude", "config.json");
const CLAUDE_TOKEN_CACHE = path.join(os.homedir(), ".opencodex", "claude_desktop_auth.json");
const CLAUDE_CODE_CREDENTIALS = path.join(os.homedir(), ".claude", ".credentials.json");
const CLAUDE_API_HOST = "https://api.anthropic.com";
// Keep these values aligned with the installed Claude Code OAuth client. The
// Claude Desktop cookie is only used to authorize this first-party OAuth
// exchange; the resulting token is the same subscription credential used by
// Claude Code and the model catalog.
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_CODE_SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_OAUTH_HOST = "https://platform.claude.com";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

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
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric)
      ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isValidAccessToken(token: unknown, expiry: unknown, now = Date.now()): boolean {
  if (typeof token !== "string" || token.trim().length === 0) return false;
  const expiryMs = isUsableExpiry(expiry);
  return expiryMs === null || expiryMs - now > REFRESH_SKEW_MS;
}

function isStillUsableAccessToken(token: unknown, expiry: unknown, now = Date.now()): boolean {
  if (typeof token !== "string" || token.trim().length === 0) return false;
  const expiryMs = isUsableExpiry(expiry);
  return expiryMs === null || expiryMs > now;
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

function readGrokSession(homeDir = path.dirname(GROK_AUTH_PATH)): { authData: Record<string, GrokSession>; sessionKey: string; session: GrokSession; authPath: string } | null {
  const authPath = path.join(homeDir, "auth.json");
  try {
    if (!fs.existsSync(authPath)) return null;
    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, GrokSession>;
    const sessionKey = Object.keys(authData).find((key) => {
      const value = authData[key];
      return value && (value.key || value.token || value.access_token || value.refresh_token);
    });
    if (!sessionKey || !authData[sessionKey]) return null;
    return { authData, sessionKey, session: authData[sessionKey], authPath };
  } catch {
    return null;
  }
}

function readAntigravityAuth(profileDir?: string): AntigravityAuth | null {
  if (profileDir) {
    try {
      const filePath = path.join(profileDir, "auth.json");
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AntigravityAuth;
    } catch {
      return null;
    }
  }
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

type CursorCredentials = { accessToken: string | null; refreshToken: string | null };
export type ClaudeDesktopToken = { accessToken: string; refreshToken: string; expiresAt: number };
type ClaudeCookieRow = { name?: string; value?: string; encrypted_value?: string };
type ClaudeCookieDiagnostic = { name: string; encrypted: boolean; decryptedLength: number; printable: boolean };
let lastClaudeCookieDiagnostics: ClaudeCookieDiagnostic[] = [];

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readCursorCredentials(profileDir?: string): CursorCredentials {
  if (profileDir) {
    try {
      const filePath = path.join(profileDir, "credentials.json");
      if (!fs.existsSync(filePath)) return { accessToken: null, refreshToken: null };
      const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      return {
        accessToken: String(value.accessToken || value.access_token || "").trim() || null,
        refreshToken: String(value.refreshToken || value.refresh_token || "").trim() || null,
      };
    } catch {
      return { accessToken: null, refreshToken: null };
    }
  }
  const envToken = String(process.env.CURSOR_API_KEY || "").trim();
  if (envToken) return { accessToken: envToken, refreshToken: null };
  if (process.platform !== "darwin" || !fs.existsSync(CURSOR_STATE_DB)) {
    return { accessToken: null, refreshToken: null };
  }

  try {
    const raw = execFileSync("sqlite3", [
      "-json",
      CURSOR_STATE_DB,
      "SELECT key, CAST(value AS TEXT) AS value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/refreshToken');"
    ], { encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim();
    const rows = raw ? JSON.parse(raw) as Array<{ key?: string; value?: string }> : [];
    const values = new Map(rows.map((row) => [String(row.key || ""), String(row.value || "")]));
    return {
      accessToken: values.get("cursorAuth/accessToken") || null,
      refreshToken: values.get("cursorAuth/refreshToken") || null,
    };
  } catch {
    return { accessToken: null, refreshToken: null };
  }
}

function writeCursorCredentials(accessToken: string, refreshToken: string, profileDir?: string): void {
  if (profileDir) {
    writeJsonSecure(path.join(profileDir, "credentials.json"), { accessToken, refreshToken });
    return;
  }
  if (!fs.existsSync(CURSOR_STATE_DB)) return;
  const sql = [
    `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('cursorAuth/accessToken',${sqlQuote(accessToken)});`,
    `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('cursorAuth/refreshToken',${sqlQuote(refreshToken)});`,
  ].join(" ");
  try {
    execFileSync("sqlite3", [CURSOR_STATE_DB, sql], { stdio: "ignore" });
  } catch {
    // Cursor may keep the database locked while it is running. The in-memory
    // token remains usable; the next refresh can retry persistence.
  }
}

function decryptClaudeCookieValue(row: ClaudeCookieRow, safeStorageKey: string): string {
  if (typeof row.value === "string" && row.value) return row.value;
  const encrypted = String(row.encrypted_value || "");
  if (!encrypted) return "";

  // Chromium's macOS cookie format currently uses v10. Keep the parser
  // version-tolerant for future v11/v12 records, while retaining the same
  // AES-CBC payload layout used by Claude Desktop.
  if (!/^(763130|763131|763132)/i.test(encrypted)) return "";
  const keyMaterials = [Buffer.from(safeStorageKey, "utf-8")];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(safeStorageKey)) {
    try {
      const decoded = Buffer.from(safeStorageKey, "base64");
      if (decoded.length > 0) keyMaterials.unshift(decoded);
    } catch {}
  }
  for (const keyMaterial of keyMaterials) {
    try {
      const masterKeys = [] as Buffer[];
      // Newer Electron safeStorage entries are base64-encoded random AES
      // keys; Chromium's legacy path derives the AES key from a passphrase.
      if (keyMaterial.length === 16) masterKeys.push(keyMaterial);
      masterKeys.push(crypto.pbkdf2Sync(
        keyMaterial,
        Buffer.from("saltysalt", "utf-8"),
        1003,
        16,
        "sha1",
      ));
      for (const masterKey of masterKeys) {
        let plaintext: Buffer;
        try {
          const decipher = crypto.createDecipheriv("aes-128-cbc", masterKey, Buffer.alloc(16, 0x20));
          plaintext = Buffer.concat([
            decipher.update(Buffer.from(encrypted.slice(6), "hex")),
            decipher.final(),
          ]);
        } catch {
          continue;
        }
      // Cookies schema v24 prefixes the plaintext with a 32-byte SHA-256
      // digest of the host key. Leaving it attached makes an otherwise valid
      // token contain binary bytes and causes Node's Authorization header to
      // fail before the upstream request is sent.
      const cookieValue = plaintext.length > 32 ? plaintext.subarray(32) : plaintext;
      const decoded = cookieValue.toString("utf-8");
      const firstBinary = decoded.search(/[^\x20-\x7e]/);
      const value = firstBinary >= 0 ? decoded.slice(0, firstBinary) : decoded;
      if (value) return value;
      }
    } catch {}
  }
  return "";
}

function claudeSafeStorageKeyMaterials(safeStorageKey: string): Buffer[] {
  const materials = [Buffer.from(safeStorageKey, "utf-8")];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(safeStorageKey)) {
    try {
      const decoded = Buffer.from(safeStorageKey, "base64");
      if (decoded.length > 0) materials.unshift(decoded);
    } catch {}
  }
  return materials;
}

/**
 * Claude Desktop stores oauth:tokenCache as an Electron safeStorage value.
 * On macOS the serialized value is base64("v10" + AES-CBC ciphertext), while
 * the key is kept in the macOS Keychain under Claude Safe Storage.
 */
export function decryptClaudeSafeStorageValue(encodedValue: string, safeStorageKey: string): string {
  if (!encodedValue || !safeStorageKey) return "";
  let encrypted: Buffer;
  try {
    encrypted = Buffer.from(encodedValue, "base64");
  } catch {
    return "";
  }
  if (encrypted.length < 19 || !/^v1[0-2]$/.test(encrypted.subarray(0, 3).toString("ascii"))) return "";

  for (const keyMaterial of claudeSafeStorageKeyMaterials(safeStorageKey)) {
    const masterKeys: Buffer[] = [];
    if (keyMaterial.length === 16) masterKeys.push(keyMaterial);
    masterKeys.push(crypto.pbkdf2Sync(
      keyMaterial,
      Buffer.from("saltysalt", "utf-8"),
      1003,
      16,
      "sha1",
    ));
    for (const masterKey of masterKeys) {
      try {
        const decipher = crypto.createDecipheriv("aes-128-cbc", masterKey, Buffer.alloc(16, 0x20));
        const plaintext = Buffer.concat([
          decipher.update(encrypted.subarray(3)),
          decipher.final(),
        ]);
        return plaintext.toString("utf-8");
      } catch {
        // Try the next key derivation. The Keychain value format has varied
        // between Electron/Chromium releases.
      }
    }
  }
  return "";
}

function normalizeClaudeDesktopToken(value: any): ClaudeDesktopToken | null {
  const accessToken = [value?.accessToken, value?.access_token, value?.token]
    .find((candidate) => typeof candidate === "string" && candidate.trim())
    ?.trim() || "";
  if (!accessToken) return null;
  const expiresAt = isUsableExpiry(
    value?.expiresAt ?? value?.expires_at ?? value?.expires ?? value?.expiry,
  ) ?? Number.MAX_SAFE_INTEGER;
  return {
    accessToken,
    refreshToken: String(value?.refreshToken || value?.refresh_token || "").trim(),
    expiresAt,
  };
}

export function selectClaudeDesktopTokenCache(cache: unknown): ClaudeDesktopToken | null {
  const candidates: Array<{ token: ClaudeDesktopToken; key: string; order: number }> = [];
  let order = 0;
  const visit = (value: unknown, key = ""): void => {
    if (!value || typeof value !== "object") return;
    const token = normalizeClaudeDesktopToken(value);
    if (token) candidates.push({ token, key, order: order++ });
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, `${key}[${index}]`);
      return;
    }
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, key ? `${key}:${childKey}` : childKey);
    }
  };
  visit(cache);
  candidates.sort((left, right) => {
    const score = (candidate: typeof left): number => {
      const key = candidate.key.toLowerCase();
      return (key.includes("api.anthropic.com") ? 8 : 0)
        + (key.includes("user:inference") ? 4 : 0)
        + (isStillUsableAccessToken(candidate.token.accessToken, candidate.token.expiresAt) ? 2 : 0);
    };
    return score(right) - score(left)
      || right.token.expiresAt - left.token.expiresAt
      || left.order - right.order;
  });
  return candidates[0]?.token || null;
}

function readClaudeDesktopConfigToken(): ClaudeDesktopToken | null {
  if (process.platform !== "darwin" || !fs.existsSync(CLAUDE_CONFIG_JSON)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_JSON, "utf-8")) as Record<string, unknown>;
    const safeStorageKey = execFileSync("security", [
      "find-generic-password", "-s", CLAUDE_SAFE_STORAGE_SERVICE,
      "-a", CLAUDE_SAFE_STORAGE_ACCOUNT, "-w",
    ], { encoding: "utf-8", timeout: 5000 }).trim();
    if (!safeStorageKey) return null;

    // V2 is the active Claude Desktop cache. Keep the legacy key as a
    // fallback for older installed versions and existing login states.
    for (const cacheKey of ["oauth:tokenCacheV2", "oauth:tokenCache"]) {
      const encoded = config[cacheKey];
      if (typeof encoded !== "string" || !encoded) continue;
      const decrypted = decryptClaudeSafeStorageValue(encoded, safeStorageKey);
      if (!decrypted) continue;
      try {
        const cache = JSON.parse(decrypted) as unknown;
        const token = selectClaudeDesktopTokenCache(cache);
        if (token) return token;
      } catch {
        // A stale/rotated Electron cache is not a usable credential. The
        // cookie exchange below remains available as a compatibility path.
      }
    }
  } catch {}
  return null;
}

function readClaudeDesktopCookies(): { sessionKey: string; organizationUuid: string } | null {
  if (process.platform !== "darwin" || !fs.existsSync(CLAUDE_COOKIE_DB)) return null;
  try {
    const safeStorageKey = execFileSync("security", [
      "find-generic-password", "-s", CLAUDE_SAFE_STORAGE_SERVICE,
      "-a", CLAUDE_SAFE_STORAGE_ACCOUNT, "-w"
    ], { encoding: "utf-8", timeout: 5000 }).trim();
    if (!safeStorageKey) return null;

    const raw = execFileSync("sqlite3", [
      "-json", CLAUDE_COOKIE_DB,
      "SELECT name, value, hex(encrypted_value) AS encrypted_value FROM cookies " +
      "WHERE host_key IN ('.claude.ai','claude.ai') AND name IN " +
      "('sessionKeyV2','sessionKey','sessionKeyV3','sessionKeyLC','sessionKeyV3LC','lastActiveOrg') " +
      "ORDER BY CASE name " +
      "WHEN 'sessionKey' THEN 1 WHEN 'sessionKeyV3' THEN 2 WHEN 'sessionKeyV2' THEN 3 " +
      "WHEN 'sessionKeyLC' THEN 4 WHEN 'sessionKeyV3LC' THEN 5 ELSE 6 END;"
    ], { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
    const rows = raw ? JSON.parse(raw) as ClaudeCookieRow[] : [];
    const values = new Map<string, string>();
    lastClaudeCookieDiagnostics = [];
    for (const row of rows) {
      const name = String(row.name || "");
      if (values.has(name)) continue;
      const decrypted = decryptClaudeCookieValue(row, safeStorageKey);
      lastClaudeCookieDiagnostics.push({
        name,
        encrypted: Boolean(row.encrypted_value),
        decryptedLength: decrypted.length,
        printable: decrypted.length > 0 && /^[\x20-\x7e]+$/.test(decrypted),
      });
      if (decrypted) values.set(name, decrypted);
    }
    const sessionKey = ["sessionKey", "sessionKeyV3", "sessionKeyV2", "sessionKeyLC", "sessionKeyV3LC"]
      .map((name) => (values.get(name) || "").trim())
      // Prefer a usable decrypted cookie. A stale/rotated cookie can decrypt
      // to arbitrary bytes while a newer V2/V3 cookie is still valid.
      .find((value) => value.length > 0 && /^[\x20-\x7e]+$/.test(value)) || "";
    const organizationValue = values.get("lastActiveOrg") || "";
    const organizationUuid = organizationValue.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
    if (!sessionKey || !/^[\x20-\x7e]+$/.test(sessionKey) || !/^[0-9a-f-]{36}$/i.test(organizationUuid)) return null;
    return { sessionKey, organizationUuid };
  } catch {
    return null;
  }
}

function readClaudeDesktopToken(): ClaudeDesktopToken | null {
  try {
    if (!fs.existsSync(CLAUDE_TOKEN_CACHE)) return null;
    const value = JSON.parse(fs.readFileSync(CLAUDE_TOKEN_CACHE, "utf-8"));
    return normalizeClaudeDesktopToken(value);
  } catch {}
  return null;
}

function readClaudeProfileToken(profileDir: string): ClaudeDesktopToken | null {
  for (const fileName of [".credentials.json", "credentials.json", "claude_desktop_auth.json"]) {
    try {
      const filePath = path.join(profileDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const token = normalizeClaudeDesktopToken(value?.claudeAiOauth || value);
      if (token) return token;
    } catch {}
  }
  return null;
}

function writeClaudeDesktopToken(value: ClaudeDesktopToken, profileDir?: string): void {
  if (profileDir) {
    writeJsonSecure(path.join(profileDir, ".credentials.json"), { claudeAiOauth: {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
    } });
    return;
  }
  writeJsonSecure(CLAUDE_TOKEN_CACHE, value);
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function getClaudeDesktopVersion(): string {
  try {
    const infoPath = "/Applications/Claude.app/Contents/Info.plist";
    const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", infoPath], { encoding: "utf-8" }).trim();
    if (version) return version;
  } catch {}
  return "unknown";
}

function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return isUsableExpiry(value.exp);
  } catch {
    return null;
  }
}

export function getCursorClientVersion(): string {
  try {
    const infoPath = "/Applications/Cursor.app/Contents/Info.plist";
    const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", infoPath], { encoding: "utf-8" }).trim();
    if (version) return version;
  } catch {}
  return "unknown";
}

function getCursorAuthClientId(): string {
  const configured = String(process.env.OPENCODEX_CURSOR_AUTH_CLIENT_ID || "").trim();
  if (configured) return configured;
  // Cursor keeps this public OAuth client id in the installed desktop bundle.
  // Read the installed client first so a future client rotation does not
  // require a gateway release. The fallback is the current public desktop id.
  try {
    if (fs.existsSync(CURSOR_APP_BUNDLE)) {
      const source = fs.readFileSync(CURSOR_APP_BUNDLE, "utf-8");
      const candidate = source.match(/Cvr="([A-Za-z0-9]{32})",Evr="prod\.authentication\.cursor\.sh"/)?.[1];
      if (candidate) return candidate;
    }
  } catch {}
  return CURSOR_AUTH_CLIENT_ID;
}

function writeAntigravityAuth(auth: AntigravityAuth, profileDir?: string): void {
  if (profileDir) {
    writeJsonSecure(path.join(profileDir, "auth.json"), auth);
    return;
  }
  const raw = `${ANTIGRAVITY_KEYCHAIN_PREFIX}${Buffer.from(JSON.stringify(auth), "utf-8").toString("base64")}`;
  execFileSync("security", [
    "add-generic-password",
    "-a", ANTIGRAVITY_KEYCHAIN_ACCOUNT,
    "-s", ANTIGRAVITY_KEYCHAIN_SERVICE,
    "-w", raw,
    "-U"
  ], { stdio: "ignore" });
}

export function selectAntigravityOAuthClientId(binary: string, clientIds: string[]): string | undefined {
  // Recent Antigravity language servers can contain more than one Google
  // OAuth client ID.  Array order is not a contract: the first ID may belong
  // to an internal service and will make an otherwise valid refresh token
  // fail with `invalid_client`.
  const ranked = clientIds
    .map((value) => {
      const index = binary.indexOf(value);
      const context = binary
        .slice(Math.max(0, index - 400), index + value.length + 400)
        .toLowerCase();
      const score =
        (context.includes("client") ? 4 : 0) +
        (context.includes("oauth") ? 3 : 0) +
        (context.includes("token") ? 2 : 0) +
        (value.length === 75 ? 1 : 0);
      return { value, score };
    })
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.value || clientIds.find((value) => value.length === 75) || clientIds[0];
}

export function extractAntigravityOAuthClientSecrets(binary: string): string[] {
  // Google OAuth web client secrets use the `GOCSPX-` prefix followed by a
  // 28-character payload.  Some language-server builds place two secrets
  // next to each other without a delimiter; a broad `{20,100}` match would
  // incorrectly merge them into one unusable value.
  return [...new Set(binary.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) || [])];
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
      const clientSecrets = extractAntigravityOAuthClientSecrets(binary);
      const clientId = selectAntigravityOAuthClientId(binary, clientIds);
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
  private static cursorRefresh: Promise<string | null> | null = null;
  private static claudeRefresh: Promise<string | null> | null = null;
  private static claudeLastAuthFailure = "not_attempted";
  private static accountPool: SubscriptionAccountPool | null = null;

  public static configureAccountPool(pool: SubscriptionAccountPool): void {
    this.accountPool = pool;
  }

  private static selectProfile(provider: SubscriptionProvider): string | null {
    return this.accountPool?.selectForRequest(provider)?.profile_dir || null;
  }

  public static hasGrokCredential(): boolean {
    return Boolean(readGrokSession());
  }

  public static hasAntigravityCredential(): boolean {
    const auth = readAntigravityAuth();
    return Boolean(auth?.token?.access_token || auth?.token?.refresh_token);
  }

  private static async refreshGrokToken(profileDir?: string): Promise<string | null> {
    const current = readGrokSession(profileDir || undefined);
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
    writeJsonSecure(current.authPath, current.authData);
    return accessToken;
  }

  public static async getGrokAccessToken(forceRefresh = false): Promise<string | null> {
    const profileDir = this.selectProfile("grok");
    const current = readGrokSession(profileDir || undefined) || (profileDir ? null : readGrokSession());
    if (!current) return null;
    const session = current.session;
    const token = session.key || session.token || session.access_token || "";
    if (!forceRefresh && isValidAccessToken(token, session.expires_at)) return token;

    if (!this.grokRefresh) {
      this.grokRefresh = this.refreshGrokToken(profileDir || undefined).finally(() => { this.grokRefresh = null; });
    }
    const refreshed = await this.grokRefresh;
    if (refreshed) return refreshed;

    // A temporary refresh outage should not interrupt a still-valid token.
    return !forceRefresh && isValidAccessToken(token, session.expires_at) ? token : null;
  }

  private static async refreshAntigravityToken(profileDir?: string): Promise<string | null> {
    const auth = readAntigravityAuth(profileDir || undefined);
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
    writeAntigravityAuth(auth as AntigravityAuth, profileDir || undefined);
    return refreshed.access_token;
  }

  public static async getAntigravityAccessToken(forceRefresh = false): Promise<string | null> {
    const profileDir = this.selectProfile("antigravity");
    const auth = readAntigravityAuth(profileDir || undefined) || (profileDir ? null : readAntigravityAuth());
    const token = auth?.token;
    if (!token) return null;
    const accessToken = token.access_token || "";
    const expiry = token.expiry || token.expires_at;
    if (!forceRefresh && isValidAccessToken(accessToken, expiry)) return accessToken;

    if (!this.antigravityRefresh) {
      this.antigravityRefresh = this.refreshAntigravityToken(profileDir || undefined).finally(() => { this.antigravityRefresh = null; });
    }
    const refreshed = await this.antigravityRefresh;
    if (refreshed) return refreshed;

    // A refresh can fail transiently while the current token is still valid.
    // Keep that token for the caller; the API request can then succeed or
    // trigger the normal one-time 401/403 refresh path. Treating the
    // refresh-skew window as an immediate logout made subscription imports
    // fail even though the desktop session was still usable.
    return !forceRefresh && isStillUsableAccessToken(accessToken, expiry) ? accessToken : null;
  }

  public static getClaudeApiKey(): string | null {
    const envKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (envKey) return envKey;
    const claudeJson = path.join(os.homedir(), ".claude.json");
    if (fs.existsSync(claudeJson)) {
      try {
        const data = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
        if (data.primaryApiKey) return data.primaryApiKey;
      } catch {}
    }
    return null;
  }

  private static getClaudeEnvironmentToken(): string | null {
    const token = String(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || "").trim();
    return token || null;
  }

  private static getClaudeCodeToken(): ClaudeDesktopToken | null {
    try {
      if (!fs.existsSync(CLAUDE_CODE_CREDENTIALS)) return null;
      const data = JSON.parse(fs.readFileSync(CLAUDE_CODE_CREDENTIALS, "utf-8"));
      const oauth = data?.claudeAiOauth || data;
      const accessToken = String(oauth?.accessToken || oauth?.access_token || "").trim();
      if (!accessToken) return null;
      return {
        accessToken,
        refreshToken: String(oauth.refreshToken || oauth.refresh_token || "").trim(),
        expiresAt: isUsableExpiry(oauth.expiresAt ?? oauth.expires_at) || Number.MAX_SAFE_INTEGER,
      };
    } catch {
      return null;
    }
  }

  private static async refreshClaudeDesktopToken(cached: ClaudeDesktopToken | null, profileDir?: string): Promise<string | null> {
    if (!cached?.refreshToken) {
      this.claudeLastAuthFailure = "no_cached_refresh_token";
      return null;
    }
    try {
      const response = await fetch(`${CLAUDE_OAUTH_HOST}/v1/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": CLAUDE_OAUTH_BETA,
          "User-Agent": "claude-code",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: cached.refreshToken,
          client_id: CLAUDE_CODE_CLIENT_ID,
          scope: CLAUDE_CODE_SCOPE,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        this.claudeLastAuthFailure = `refresh_http_${response.status}`;
        return null;
      }
      const refreshed = await response.json() as any;
      if (typeof refreshed.access_token !== "string" || !refreshed.access_token) {
        this.claudeLastAuthFailure = "refresh_missing_access_token";
        return null;
      }
      const next: ClaudeDesktopToken = {
        accessToken: refreshed.access_token,
        refreshToken: String(refreshed.refresh_token || cached.refreshToken),
        expiresAt: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000,
      };
      writeClaudeDesktopToken(next, profileDir || undefined);
      return next.accessToken;
    } catch {
      this.claudeLastAuthFailure = "refresh_network_error";
      return null;
    }
  }

  private static async exchangeClaudeDesktopToken(): Promise<string | null> {
    const cookies = readClaudeDesktopCookies();
    if (!cookies) {
      this.claudeLastAuthFailure = "desktop_cookie_unavailable";
      return null;
    }

    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier, "utf-8").digest());
    const stateAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const stateBytes = crypto.randomBytes(32);
    let state = "";
    for (const byte of stateBytes) state += stateAlphabet[byte % stateAlphabet.length];

    let stage = "authorize_request";
    try {
      const authorizeResponse = await fetch(`${CLAUDE_API_HOST}/v1/oauth/${cookies.organizationUuid}/authorize`, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${cookies.sessionKey}`,
          "Content-Type": "application/json",
          "anthropic-client-platform": "DESKTOP_APP",
          "anthropic-client-version": getClaudeDesktopVersion(),
        },
        body: JSON.stringify({
          response_type: "code",
          client_id: CLAUDE_CODE_CLIENT_ID,
          organization_uuid: cookies.organizationUuid,
          redirect_uri: CLAUDE_CODE_REDIRECT_URI,
          scope: CLAUDE_CODE_SCOPE,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!authorizeResponse.ok) {
        const errorBody = await authorizeResponse.json().catch(() => ({})) as any;
        const errorCode = String(errorBody?.error?.code || errorBody?.error?.type || errorBody?.error_code || errorBody?.error || "")
          .replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
        const errorDetail = String(errorBody?.error_description || errorBody?.message || errorBody?.error?.message || errorBody?.error?.details?.error_code || errorBody?.detail || "")
          .replace(/https?:\/\/[^\s]+/g, "url").replace(/[^A-Za-z0-9 _-]/g, "_").slice(0, 48).trim();
        this.claudeLastAuthFailure = `authorize_http_${authorizeResponse.status}${errorCode ? `_${errorCode}` : ""}${errorDetail ? `_${errorDetail}` : ""}`;
        return null;
      }
      stage = "authorize_response";
      const authorizeBody = await authorizeResponse.json() as any;
      const redirectUri = String(authorizeBody.redirect_uri || "");
      if (!redirectUri) {
        this.claudeLastAuthFailure = "authorize_missing_redirect";
        return null;
      }
      const code = new URL(redirectUri).searchParams.get("code");
      if (!code) {
        this.claudeLastAuthFailure = "authorize_missing_code";
        return null;
      }

      stage = "token_request";
      const tokenResponse = await fetch(`${CLAUDE_OAUTH_HOST}/v1/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": CLAUDE_OAUTH_BETA,
          "User-Agent": "claude-code",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLAUDE_CODE_CLIENT_ID,
          code,
          redirect_uri: CLAUDE_CODE_REDIRECT_URI,
          state,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.json().catch(() => ({})) as any;
        const errorCode = String(errorBody?.error?.code || errorBody?.error?.type || errorBody?.error_code || errorBody?.error || "")
          .replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
        const errorDetail = String(errorBody?.error_description || errorBody?.message || errorBody?.error?.message || errorBody?.error?.details?.error_code || errorBody?.detail || "")
          .replace(/https?:\/\/[^\s]+/g, "url").replace(/[^A-Za-z0-9 _-]/g, "_").slice(0, 48).trim();
        this.claudeLastAuthFailure = `token_http_${tokenResponse.status}${errorCode ? `_${errorCode}` : ""}${errorDetail ? `_${errorDetail}` : ""}`;
        return null;
      }
      stage = "token_response";
      const tokenBody = await tokenResponse.json() as any;
      if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token || typeof tokenBody.refresh_token !== "string") {
        this.claudeLastAuthFailure = "token_missing_access_or_refresh";
        return null;
      }
      const token: ClaudeDesktopToken = {
        accessToken: tokenBody.access_token,
        refreshToken: tokenBody.refresh_token,
        expiresAt: Date.now() + (Number(tokenBody.expires_in) || 3600) * 1000,
      };
      writeClaudeDesktopToken(token);
      return token.accessToken;
    } catch (error: any) {
      const kind = String(error?.cause?.code || error?.name || "error").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
      this.claudeLastAuthFailure = `desktop_exchange_${stage}_${kind}`;
      return null;
    }
  }

  public static async getClaudeAccessToken(forceRefresh = false): Promise<string | null> {
    this.claudeLastAuthFailure = "no_usable_token";
    const profileDir = this.selectProfile("claude");
    if (profileDir) {
      const cached = readClaudeProfileToken(profileDir);
      if (!forceRefresh && cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) {
        this.claudeLastAuthFailure = "pool_cached_token";
        return cached.accessToken;
      }
      if (!this.claudeRefresh) {
        this.claudeRefresh = this.refreshClaudeDesktopToken(cached, profileDir)
          .finally(() => { this.claudeRefresh = null; });
      }
      const refreshed = await this.claudeRefresh;
      if (refreshed) return refreshed;
      return !forceRefresh && cached && cached.expiresAt > Date.now() ? cached.accessToken : null;
    }

    const apiKey = this.getClaudeApiKey();
    if (apiKey) {
      this.claudeLastAuthFailure = "api_key";
      return apiKey;
    }

    const environmentToken = this.getClaudeEnvironmentToken();
    if (environmentToken) {
      this.claudeLastAuthFailure = "environment_token";
      return environmentToken;
    }

    // Claude Desktop 1.24+ keeps the authoritative OAuth cache in its
    // encrypted config.json. The OpenCodex cache and Claude Code credentials
    // remain fallbacks for older installations and CLI logins.
    const cached = readClaudeDesktopConfigToken()
      || readClaudeDesktopToken()
      || this.getClaudeCodeToken();
    if (!forceRefresh && cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      this.claudeLastAuthFailure = "cached_token";
      return cached.accessToken;
    }

    if (!this.claudeRefresh) {
      this.claudeRefresh = (async () => {
        const refreshed = await this.refreshClaudeDesktopToken(cached);
        if (refreshed) return refreshed;
        return this.exchangeClaudeDesktopToken();
      })().finally(() => { this.claudeRefresh = null; });
    }
    const refreshed = await this.claudeRefresh;
    if (refreshed) return refreshed;
    return !forceRefresh && cached && cached.expiresAt > Date.now() ? cached.accessToken : null;
  }

  public static getClaudeAuthFailure(): string {
    return this.claudeLastAuthFailure;
  }

  public static getClaudeCookieDiagnostics(): ClaudeCookieDiagnostic[] {
    return lastClaudeCookieDiagnostics.map((item) => ({ ...item }));
  }

  public static getCursorApiKey(): string | null {
    return readCursorCredentials().accessToken;
  }

  /**
   * Capture the credential currently owned by the vendor app/CLI into an
   * isolated account profile. This is the fallback for providers that do not
   * expose a safe, separate login command; it never returns token material to
   * the dashboard API.
   */
  public static async captureCurrentCredential(provider: SubscriptionProvider, profileDir: string): Promise<void> {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(profileDir, 0o700); } catch {}
    if (provider === "grok") {
      const current = readGrokSession();
      if (!current) throw new Error("未检测到当前 Grok 登录态，请先登录 Grok");
      writeJsonSecure(path.join(profileDir, "auth.json"), { [current.sessionKey]: current.session });
      return;
    }
    if (provider === "antigravity") {
      const current = readAntigravityAuth();
      if (!current?.token?.access_token && !current?.token?.refresh_token) throw new Error("未检测到当前 Antigravity 登录态，请先登录客户端");
      writeJsonSecure(path.join(profileDir, "auth.json"), current);
      return;
    }
    if (provider === "cursor") {
      const current = readCursorCredentials();
      if (!current.accessToken && !current.refreshToken) throw new Error("未检测到当前 Cursor 登录态，请先登录客户端");
      writeCursorCredentials(current.accessToken || "", current.refreshToken || "", profileDir);
      return;
    }
    const current = readClaudeDesktopConfigToken() || readClaudeDesktopToken() || this.getClaudeCodeToken();
    if (!current) throw new Error("未检测到当前 Claude OAuth 登录态，请先登录 Claude / Claude Code");
    writeClaudeDesktopToken(current, profileDir);
  }

  private static async refreshCursorToken(profileDir?: string): Promise<string | null> {
    const credentials = readCursorCredentials(profileDir || undefined);
    if (!credentials.refreshToken) return null;
    const response = await fetch("https://api2.cursor.sh/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cursor-client-type": "desktop",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: getCursorAuthClientId(),
        refresh_token: credentials.refreshToken,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const refreshed = await response.json() as any;
    const accessToken = String(refreshed.access_token || "").trim();
    if (!accessToken) return null;
    writeCursorCredentials(accessToken, accessToken, profileDir || undefined);
    return accessToken;
  }

  public static async getCursorAccessToken(forceRefresh = false): Promise<string | null> {
    const profileDir = this.selectProfile("cursor");
    const credentials = readCursorCredentials(profileDir || undefined);
    const token = credentials.accessToken;
    if (!token) return null;
    if (!forceRefresh && isValidAccessToken(token, jwtExpiry(token))) return token;

    if (!this.cursorRefresh) {
      this.cursorRefresh = this.refreshCursorToken(profileDir || undefined).finally(() => { this.cursorRefresh = null; });
    }
    const refreshed = await this.cursorRefresh;
    if (refreshed) return refreshed;
    return !forceRefresh && isValidAccessToken(token, jwtExpiry(token)) ? token : null;
  }

  public static hasClaudeCredential(): boolean {
    return Boolean(
      this.getClaudeApiKey() ||
      this.getClaudeEnvironmentToken() ||
      readClaudeDesktopConfigToken() ||
      readClaudeDesktopCookies() ||
      readClaudeDesktopToken() ||
      this.getClaudeCodeToken(),
    );
  }

  public static hasCursorCredential(): boolean {
    const credentials = readCursorCredentials();
    return Boolean(credentials.accessToken || credentials.refreshToken);
  }
}
