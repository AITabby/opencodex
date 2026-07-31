/**
 * Credential Store for CodexBridge (OpenCodex V2)
 * Handles API Key resolution from providers.json, environment variables, or disk configuration.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ProviderConfig } from "../core/types.js";
import { safeErrorMessage } from "../server/privacy.js";

type WindowsCredentialVault = {
  version: 1;
  protection: "dpapi-current-user";
  ciphertext: string;
};

const WINDOWS_CREDENTIAL_VAULT_FILENAME = "credentials.dpapi.json";
const WINDOWS_DPAPI_ENTROPY = "OpenCodex Secure Credentials v1";
const WINDOWS_CREDENTIAL_REFERENCE_PREFIX = "dpapi-current-user:";

function runPowerShell(script: string, input: string): string {
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", script,
  ], {
    encoding: "utf-8",
    input,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "Windows DPAPI operation failed");
  }
  return result.stdout;
}

function protectWithDpapi(plaintext: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$secretInput = [Console]::In.ReadToEnd()",
    "$secretBytes = [Text.Encoding]::UTF8.GetBytes($secretInput)",
    `$entropyBytes = [Text.Encoding]::UTF8.GetBytes('${WINDOWS_DPAPI_ENTROPY}')`,
    "$protectedBytes = [Security.Cryptography.ProtectedData]::Protect($secretBytes, $entropyBytes, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protectedBytes))",
  ].join(";");
  const ciphertext = runPowerShell(script, plaintext).trim();
  if (!ciphertext) throw new Error("Windows DPAPI returned an empty ciphertext");
  return ciphertext;
}

function unprotectWithDpapi(ciphertext: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$cipherInput = [Console]::In.ReadToEnd().Trim()",
    "$protectedBytes = [Convert]::FromBase64String($cipherInput)",
    `$entropyBytes = [Text.Encoding]::UTF8.GetBytes('${WINDOWS_DPAPI_ENTROPY}')`,
    "$secretBytes = [Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $entropyBytes, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($secretBytes))",
  ].join(";");
  return runPowerShell(script, ciphertext);
}

function atomicPrivateWrite(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function credentialEntryKey(service: string, account: string): string {
  return Buffer.from(JSON.stringify([service, account]), "utf-8").toString("base64url");
}

function encodeWindowsCredentialReference(service: string, account: string): string {
  return `${WINDOWS_CREDENTIAL_REFERENCE_PREFIX}${credentialEntryKey(service, account)}`;
}

function decodeWindowsCredentialReference(reference: string): { service: string; account: string } | null {
  if (!reference.startsWith(WINDOWS_CREDENTIAL_REFERENCE_PREFIX)) return null;
  const encoded = reference.slice(WINDOWS_CREDENTIAL_REFERENCE_PREFIX.length);
  if (!encoded || encoded.length > 4096) return null;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [service, account] = decoded;
    if (typeof service !== "string" || !service || typeof account !== "string" || !account) return null;
    return { service, account };
  } catch {
    return null;
  }
}

export class CredentialStore {
  private static readonly providerService = "OpenCodex Provider Credential";
  private static readonly dataDir = path.join(os.homedir(), ".opencodex");
  private static providersConfigPath = path.join(CredentialStore.dataDir, "providers.json");
  private static windowsCredentialVaultPath = path.join(CredentialStore.dataDir, WINDOWS_CREDENTIAL_VAULT_FILENAME);
  private static cachedProviders: ProviderConfig[] = [];
  private static lastMtime = 0;

  private static readWindowsCredentialEntries(): Record<string, string> {
    if (!fs.existsSync(CredentialStore.windowsCredentialVaultPath)) return {};
    const raw = JSON.parse(fs.readFileSync(CredentialStore.windowsCredentialVaultPath, "utf-8")) as WindowsCredentialVault;
    if (raw?.version !== 1 || raw?.protection !== "dpapi-current-user" || typeof raw?.ciphertext !== "string" || !raw.ciphertext) {
      throw new Error("The Windows credential vault has an unsupported or invalid format");
    }
    const decrypted = JSON.parse(unprotectWithDpapi(raw.ciphertext));
    if (!decrypted || typeof decrypted !== "object" || Array.isArray(decrypted)) {
      throw new Error("The Windows credential vault payload is invalid");
    }
    for (const value of Object.values(decrypted)) {
      if (typeof value !== "string") throw new Error("The Windows credential vault contains an invalid entry");
    }
    return decrypted as Record<string, string>;
  }

  private static persistWindowsCredentialEntries(entries: Record<string, string>): void {
    const vault: WindowsCredentialVault = {
      version: 1,
      protection: "dpapi-current-user",
      ciphertext: protectWithDpapi(JSON.stringify(entries)),
    };
    atomicPrivateWrite(CredentialStore.windowsCredentialVaultPath, `${JSON.stringify(vault, null, 2)}\n`);
  }

  private static writeWindowsCredential(service: string, account: string, secret: string): void {
    const entries = CredentialStore.readWindowsCredentialEntries();
    const key = credentialEntryKey(service, account);
    entries[key] = secret;
    CredentialStore.persistWindowsCredentialEntries(entries);
    const stored = CredentialStore.readWindowsCredentialEntries()[key] || "";
    if (stored !== secret) throw new Error("Windows DPAPI credential verification failed");
  }

  private static readWindowsCredential(service: string, account: string): string {
    return CredentialStore.readWindowsCredentialEntries()[credentialEntryKey(service, account)] || "";
  }

  private static deleteWindowsCredential(service: string, account: string): void {
    if (!fs.existsSync(CredentialStore.windowsCredentialVaultPath)) return;
    const entries = CredentialStore.readWindowsCredentialEntries();
    const key = credentialEntryKey(service, account);
    if (!Object.prototype.hasOwnProperty.call(entries, key)) return;
    delete entries[key];
    CredentialStore.persistWindowsCredentialEntries(entries);
  }

  public static loadProviders(): ProviderConfig[] {
    try {
      if (fs.existsSync(CredentialStore.providersConfigPath)) {
        const stat = fs.statSync(CredentialStore.providersConfigPath);
        if (stat.mtimeMs === CredentialStore.lastMtime && CredentialStore.cachedProviders.length > 0) {
          return CredentialStore.cachedProviders;
        }
        const raw = fs.readFileSync(CredentialStore.providersConfigPath, "utf-8");
        const data = JSON.parse(raw);
        CredentialStore.cachedProviders = Array.isArray(data) ? data : data.providers || [];
        if (process.platform === "darwin" || process.platform === "win32") {
          let migrated = false;
          let migrationFailed = false;
          for (const provider of CredentialStore.cachedProviders as any[]) {
            if (provider.api_key && !provider.credential_ref) {
              try {
                CredentialStore.storeProviderSecret(provider, provider.api_key);
                migrated = true;
              } catch (error: any) {
                migrationFailed = true;
                console.error(`[OpenCodex] Could not migrate provider credential to platform secure storage: ${safeErrorMessage(error)}`);
              }
            }
          }
          // Do not strip any legacy plaintext entry until every pending entry
          // has been copied to secure storage successfully.
          if (migrated && !migrationFailed) CredentialStore.saveProviders(CredentialStore.cachedProviders);
        }
        CredentialStore.lastMtime = stat.mtimeMs;
        return CredentialStore.cachedProviders;
      }
    } catch {
      // Return empty array on read errors
    }
    return [];
  }

  public static setApiKey(provider: ProviderConfig, apiKey: string): void;
  public static setApiKey(providerName: string, apiKey: string): void;
  public static setApiKey(providerOrName: ProviderConfig | string, apiKey: string): void {
    if (typeof providerOrName !== "string") {
      CredentialStore.storeProviderSecret(providerOrName, apiKey);
      return;
    }
    const providers = CredentialStore.loadProviders();
    let provider = providers.find((item) => item.name === providerOrName);
    if (!provider) {
      provider = { name: providerOrName, type: "openai-compatible", baseUrl: "" };
      providers.push(provider);
    }
    CredentialStore.storeProviderSecret(provider, apiKey);
    CredentialStore.saveProviders(providers);
  }

  private static storeProviderSecret(provider: any, apiKey: string): void {
    const previousReference = typeof provider.credential_ref === "string" ? provider.credential_ref : "";
    const account = `provider:${String(provider.name || "custom")}`;
    const reference = CredentialStore.writeSecureSecret(CredentialStore.providerService, account, apiKey);
    provider.credential_ref = reference;
    delete provider.api_key;
    if (previousReference && previousReference !== reference) {
      CredentialStore.deleteSecureSecret(CredentialStore.providerService, previousReference);
    }
  }

  public static writeSecureSecret(service: string, account: string, secret: string): string {
    if (process.platform === "win32") {
      CredentialStore.writeWindowsCredential(service, account, secret);
      return encodeWindowsCredentialReference(service, account);
    }
    if (process.platform === "darwin") {
      CredentialStore.writeKeychainSecret(service, account, secret);
      const reference = `keychain:${service}:${account}`;
      if (CredentialStore.readKeychainSecret(service, reference) !== secret) {
        throw new Error("macOS Keychain credential verification failed");
      }
      return reference;
    }
    throw new Error("OpenCodex credentials require Windows DPAPI or macOS Keychain");
  }

  public static readSecureSecret(service: string, reference: string | undefined): string {
    if (typeof reference !== "string" || !reference) return "";
    if (process.platform === "win32") {
      const decoded = decodeWindowsCredentialReference(reference);
      if (!decoded || decoded.service !== service) return "";
      return CredentialStore.readWindowsCredential(decoded.service, decoded.account);
    }
    if (process.platform === "darwin") {
      return CredentialStore.readKeychainSecret(service, reference);
    }
    return "";
  }

  public static deleteSecureSecret(service: string, reference: string | undefined): void {
    if (typeof reference !== "string" || !reference) return;
    if (process.platform === "win32") {
      const decoded = decodeWindowsCredentialReference(reference);
      if (decoded?.service === service) CredentialStore.deleteWindowsCredential(decoded.service, decoded.account);
      return;
    }
    if (process.platform === "darwin") {
      const prefix = `keychain:${service}:`;
      if (reference.startsWith(prefix)) CredentialStore.deleteKeychainSecret(service, reference.slice(prefix.length));
    }
  }

  public static deleteProviderSecret(provider: ProviderConfig): void {
    const reference = (provider as any).credential_ref;
    CredentialStore.deleteSecureSecret(CredentialStore.providerService, reference);
    delete (provider as any).credential_ref;
    delete provider.api_key;
  }

  public static credentialStorage(reference: unknown): string {
    if (typeof reference !== "string" || !reference) return "none";
    if (reference.startsWith(WINDOWS_CREDENTIAL_REFERENCE_PREFIX)) return "windows-dpapi-current-user";
    if (reference.startsWith("keychain:")) return "macos-keychain";
    return "platform-secure-store";
  }

  public static writeKeychainSecret(service: string, account: string, secret: string): void {
    if (process.platform !== "darwin") {
      throw new Error("OpenCodex credentials require macOS Keychain");
    }
    const result = spawnSync("security", [
      "add-generic-password", "-U", "-a", account, "-s", service, "-w", secret
    ], { encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "Could not save credential to Keychain");
    }
  }

  public static deleteKeychainSecret(service: string, account: string): void {
    if (process.platform !== "darwin") return;
    spawnSync("security", [
      "delete-generic-password", "-a", account, "-s", service
    ], { encoding: "utf-8" });
  }

  public static saveProviders(providers: ProviderConfig[]): void {
    try {
      const safeProviders = providers.map((provider: any) => {
        const { api_key: _apiKey, refresh_token: _refreshToken, ...safeProvider } = provider;
        return safeProvider;
      });
      atomicPrivateWrite(
        CredentialStore.providersConfigPath,
        `${JSON.stringify({ providers: safeProviders }, null, 2)}\n`,
      );
      CredentialStore.cachedProviders = safeProviders;
      CredentialStore.lastMtime = fs.statSync(CredentialStore.providersConfigPath).mtimeMs;
    } catch (e: any) {
      console.error(`Failed to save providers config: ${safeErrorMessage(e)}`);
      throw e;
    }
  }

  public static resolveApiKey(provider: ProviderConfig): string {
    if ((provider as any).credential_ref) {
      const fromSecureStore = CredentialStore.readProviderSecret((provider as any).credential_ref);
      if (fromSecureStore) return fromSecureStore;
    }
    if (provider.api_key && provider.api_key.trim().length > 0) {
      return provider.api_key.trim();
    }
    if (provider.api_key_env && process.env[provider.api_key_env]) {
      return (process.env[provider.api_key_env] || "").trim();
    }
    return "";
  }

  private static readProviderSecret(reference: string): string {
    return CredentialStore.readSecureSecret(CredentialStore.providerService, reference);
  }

  public static readKeychainSecret(service: string, reference: string | undefined): string {
    if (typeof reference !== "string" || !reference.startsWith(`keychain:${service}:`) || process.platform !== "darwin") return "";
    const account = reference.slice(`keychain:${service}:`.length);
    const result = spawnSync("security", [
      "find-generic-password",
      "-a", account,
      "-s", service,
      "-w"
    ], { encoding: "utf-8" });
    return result.status === 0 ? result.stdout.trim() : "";
  }
}
