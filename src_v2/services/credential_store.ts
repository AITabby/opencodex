/**
 * Credential Store for CodexBridge (OpenCodex V2)
 * Handles API Key resolution from providers.json, environment variables, or disk configuration.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { ProviderConfig } from "../core/types.js";

/**
 * Restore-native keeps provider identities, endpoints, and credentials, but
 * removes every selected-model field.  Keeping this as a pure transformation
 * makes it safe to reuse from the dashboard reset route and from tests.
 */
export function clearProviderModelSelections(providers: ProviderConfig[]): ProviderConfig[] {
  const modelFields = [
    "models",
    "selected_models",
    "active_models",
    "model_protocols",
    "model_metadata",
    "models_metadata",
    "model_context_windows",
    "context_windows",
    "last_test_status",
    "last_test_at",
    "last_test_message",
  ];

  return (Array.isArray(providers) ? providers : []).map((rawProvider: ProviderConfig) => {
    const provider: any = { ...(rawProvider as any), models: [] };
    for (const field of modelFields) {
      if (field !== "models") delete provider[field];
    }
    return provider as ProviderConfig;
  });
}

export class CredentialStore {
  private static readonly providerService = "OpenCodex Provider Credential";
  private static providersConfigPath = path.join(os.homedir(), ".opencodex", "providers.json");
  private static cachedProviders: ProviderConfig[] = [];
  private static lastMtime = 0;

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
        if (process.platform === "darwin") {
          let migrated = false;
          for (const provider of CredentialStore.cachedProviders as any[]) {
            if (provider.api_key && !provider.credential_ref) {
              try {
                CredentialStore.storeProviderSecret(provider, provider.api_key);
                migrated = true;
              } catch (error: any) {
                console.error(`[OpenCodex] Could not migrate ${provider.name} credential to Keychain: ${error.message}`);
              }
            }
          }
          if (migrated) CredentialStore.saveProviders(CredentialStore.cachedProviders);
        }
        CredentialStore.lastMtime = stat.mtimeMs;
        return CredentialStore.cachedProviders;
      }
    } catch {
      // Return empty array on read errors
    }
    return [];
  }

  public static setApiKey(providerName: string, apiKey: string): void {
    const providers = CredentialStore.loadProviders();
    let p = providers.find((item) => item.name === providerName);
    if (p) {
      CredentialStore.storeProviderSecret(p, apiKey);
    } else {
      const created: any = { name: providerName, type: "openai-compatible", baseUrl: "" };
      CredentialStore.storeProviderSecret(created, apiKey);
      providers.push(created);
    }
    CredentialStore.saveProviders(providers);
  }

  /** Attach a credential to a provider already present in the current list. */
  public static setApiKeyOnProviders(providers: ProviderConfig[], providerName: string, apiKey: string): void {
    const list = Array.isArray(providers) ? providers : [];
    const provider = list.find((item: any) => item?.name === providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} was not found while saving its credential`);
    }
    CredentialStore.storeProviderSecret(provider, apiKey);
    CredentialStore.saveProviders(list);
  }

  private static storeProviderSecret(provider: any, apiKey: string): void {
    if (process.platform !== "darwin") {
      throw new Error("OpenCodex provider credentials require macOS Keychain");
    }
    const account = `provider:${String(provider.name || "custom")}`;
    CredentialStore.writeKeychainSecret(CredentialStore.providerService, account, apiKey);
    provider.credential_ref = `keychain:${CredentialStore.providerService}:${account}`;
    delete provider.api_key;
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
      const dir = path.dirname(CredentialStore.providersConfigPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const safeProviders = providers.map((provider: any) => {
        const { api_key: _apiKey, refresh_token: _refreshToken, ...safeProvider } = provider;
        return safeProvider;
      });
      fs.writeFileSync(CredentialStore.providersConfigPath, JSON.stringify({ providers: safeProviders }, null, 2), { encoding: "utf-8", mode: 0o600 });
      fs.chmodSync(CredentialStore.providersConfigPath, 0o600);
      CredentialStore.cachedProviders = safeProviders;
      CredentialStore.lastMtime = fs.statSync(CredentialStore.providersConfigPath).mtimeMs;
    } catch (e: any) {
      console.error(`Failed to save providers config: ${e.message}`);
    }
  }

  public static resolveApiKey(provider: ProviderConfig): string {
    if ((provider as any).credential_ref) {
      const fromKeychain = CredentialStore.readProviderSecret((provider as any).credential_ref);
      if (fromKeychain) return fromKeychain;
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
    if (process.platform !== "darwin" || !reference.startsWith(`keychain:${CredentialStore.providerService}:`)) return "";
    const account = reference.slice(`keychain:${CredentialStore.providerService}:`.length);
    const result = spawnSync("security", [
      "find-generic-password", "-a", account, "-s", CredentialStore.providerService, "-w"
    ], { encoding: "utf-8" });
    return result.status === 0 ? result.stdout.trim() : "";
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
