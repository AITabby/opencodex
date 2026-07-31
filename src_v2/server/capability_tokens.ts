import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

export const GATEWAY_CAPABILITIES = ["admin", "gateway", "voice", "mobile"] as const;
export type GatewayCapability = typeof GATEWAY_CAPABILITIES[number];
export type CapabilityTokens = Record<GatewayCapability, string>;

const MINIMUM_TOKEN_LENGTH = 32;
const KEYCHAIN_SERVICE = "OpenCodex Local Capability Tokens";
const WINDOWS_VAULT_FILENAME = "capability_tokens.dpapi.json";
const LEGACY_ADMIN_FILENAME = "admin_token";
const DPAPI_ENTROPY = "OpenCodex Local Capability Tokens v1";

const TOKEN_ENVIRONMENT: Record<GatewayCapability, string> = {
  admin: "OPENCODEX_ADMIN_TOKEN",
  gateway: "OPENCODEX_GATEWAY_TOKEN",
  voice: "OPENCODEX_VOICE_TOKEN",
  mobile: "OPENCODEX_MOBILE_TOKEN",
};

type WindowsVault = {
  version: 1;
  protection: "dpapi-current-user";
  ciphertext: string;
};

function isValidToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= MINIMUM_TOKEN_LENGTH;
}

function generateToken(excluded: Iterable<string> = []): string {
  const denied = new Set(excluded);
  while (true) {
    const token = randomBytes(32).toString("hex");
    if (!denied.has(token)) return token;
  }
}

function validateDistinctTokens(tokens: CapabilityTokens): void {
  for (const capability of GATEWAY_CAPABILITIES) {
    if (!isValidToken(tokens[capability])) {
      throw new Error(`OpenCodex ${capability} capability token is missing or too short`);
    }
  }
  if (new Set(Object.values(tokens)).size !== GATEWAY_CAPABILITIES.length) {
    throw new Error("OpenCodex capability tokens must be distinct");
  }
}

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
    `$entropyBytes = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
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
    `$entropyBytes = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
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

function readKeychainToken(capability: GatewayCapability): string {
  const result = spawnSync("security", [
    "find-generic-password",
    "-a", capability,
    "-s", KEYCHAIN_SERVICE,
    "-w",
  ], { encoding: "utf-8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function writeKeychainToken(capability: GatewayCapability, token: string): void {
  const result = spawnSync("security", [
    "add-generic-password",
    "-U",
    "-a", capability,
    "-s", KEYCHAIN_SERVICE,
    "-w", token,
  ], { encoding: "utf-8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `Could not save ${capability} token to macOS Keychain`);
  }
}

export class CapabilityTokenStore {
  private readonly dataDir: string;
  private readonly environmentManaged = new Set<GatewayCapability>();
  private persistentTokens: Partial<CapabilityTokens> = {};
  private tokens: CapabilityTokens;
  public readonly storageDescription: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });

    const overrides: Partial<CapabilityTokens> = {};
    for (const capability of GATEWAY_CAPABILITIES) {
      const environmentName = TOKEN_ENVIRONMENT[capability];
      const rawValue = process.env[environmentName];
      if (rawValue === undefined) continue;
      const token = rawValue.trim();
      if (!isValidToken(token)) {
        throw new Error(`${environmentName} must contain at least ${MINIMUM_TOKEN_LENGTH} characters`);
      }
      overrides[capability] = token;
      this.environmentManaged.add(capability);
    }

    if (process.platform === "win32") {
      this.persistentTokens = this.readWindowsTokens();
      this.storageDescription = this.environmentManaged.size > 0
        ? "Windows DPAPI CurrentUser plus environment overrides"
        : "Windows DPAPI CurrentUser";
    } else if (process.platform === "darwin") {
      for (const capability of GATEWAY_CAPABILITIES) {
        if (this.environmentManaged.has(capability)) continue;
        const token = readKeychainToken(capability);
        if (isValidToken(token)) this.persistentTokens[capability] = token;
      }
      this.storageDescription = this.environmentManaged.size > 0
        ? "macOS Keychain plus environment overrides"
        : "macOS Keychain";
    } else {
      if (this.environmentManaged.size !== GATEWAY_CAPABILITIES.length) {
        throw new Error(
          "OpenCodex capability tokens require Windows DPAPI, macOS Keychain, or all four OPENCODEX_*_TOKEN environment variables",
        );
      }
      this.storageDescription = "environment overrides";
    }

    const legacyAdminToken = this.readLegacyAdminToken();
    let persistentChanged = false;
    for (const capability of GATEWAY_CAPABILITIES) {
      if (this.environmentManaged.has(capability)) continue;
      if (isValidToken(this.persistentTokens[capability])) continue;
      const used = [
        ...Object.values(this.persistentTokens).filter(isValidToken),
        ...Object.values(overrides).filter(isValidToken),
      ];
      this.persistentTokens[capability] = capability === "admin" && isValidToken(legacyAdminToken)
        ? legacyAdminToken
        : generateToken(used);
      persistentChanged = true;
    }

    if (persistentChanged) this.persistTokens();

    this.tokens = Object.fromEntries(GATEWAY_CAPABILITIES.map((capability) => [
      capability,
      overrides[capability] || this.persistentTokens[capability] || "",
    ])) as CapabilityTokens;
    validateDistinctTokens(this.tokens);
    this.verifyPersistentTokens();
    this.removeLegacyAdminToken();
  }

  public get(capability: GatewayCapability): string {
    return this.tokens[capability];
  }

  public snapshot(): CapabilityTokens {
    return { ...this.tokens };
  }

  public isManagedByEnvironment(capability: GatewayCapability): boolean {
    return this.environmentManaged.has(capability);
  }

  public rotate(capability: GatewayCapability): { token: string; previousToken: string } {
    if (this.environmentManaged.has(capability)) {
      throw new Error(`${TOKEN_ENVIRONMENT[capability]} manages this token and must be rotated outside OpenCodex`);
    }
    const previousToken = this.tokens[capability];
    const token = generateToken(Object.values(this.tokens));
    const previousPersistentTokens = { ...this.persistentTokens };
    this.persistentTokens = { ...this.persistentTokens, [capability]: token };
    try {
      this.persistTokens();
      this.verifyPersistentTokens();
    } catch (error: any) {
      this.persistentTokens = previousPersistentTokens;
      try {
        this.persistTokens();
        this.verifyPersistentTokens();
      } catch (rollbackError: any) {
        throw new Error(
          `Capability-token rotation failed and secure rollback could not be verified: ${rollbackError?.message || rollbackError}`,
        );
      }
      throw error;
    }
    this.tokens = { ...this.tokens, [capability]: token };
    return { token, previousToken };
  }

  private readLegacyAdminToken(): string {
    try {
      const token = fs.readFileSync(path.join(this.dataDir, LEGACY_ADMIN_FILENAME), "utf-8").trim();
      return isValidToken(token) ? token : "";
    } catch {
      return "";
    }
  }

  private removeLegacyAdminToken(): void {
    const legacyPath = path.resolve(this.dataDir, LEGACY_ADMIN_FILENAME);
    if (path.dirname(legacyPath) !== this.dataDir || path.basename(legacyPath) !== LEGACY_ADMIN_FILENAME) {
      throw new Error(`Refusing to remove unexpected legacy token path: ${legacyPath}`);
    }
    if (!fs.existsSync(legacyPath)) return;
    fs.unlinkSync(legacyPath);
    if (fs.existsSync(legacyPath)) {
      throw new Error("OpenCodex could not remove the legacy plaintext admin token");
    }
  }

  private windowsVaultPath(): string {
    return path.join(this.dataDir, WINDOWS_VAULT_FILENAME);
  }

  private readWindowsTokens(): Partial<CapabilityTokens> {
    const vaultPath = this.windowsVaultPath();
    if (!fs.existsSync(vaultPath)) return {};
    try {
      const vault = JSON.parse(fs.readFileSync(vaultPath, "utf-8")) as WindowsVault;
      if (vault.version !== 1 || vault.protection !== "dpapi-current-user" || typeof vault.ciphertext !== "string") {
        throw new Error("unsupported Windows capability-token vault format");
      }
      const parsed = JSON.parse(unprotectWithDpapi(vault.ciphertext));
      const tokens: Partial<CapabilityTokens> = {};
      for (const capability of GATEWAY_CAPABILITIES) {
        if (isValidToken(parsed?.[capability])) tokens[capability] = parsed[capability].trim();
      }
      return tokens;
    } catch (error: any) {
      throw new Error(`Could not decrypt the Windows capability-token vault: ${error?.message || error}`);
    }
  }

  private persistTokens(): void {
    const toPersist = Object.fromEntries(GATEWAY_CAPABILITIES
      .filter((capability) => !this.environmentManaged.has(capability))
      .map((capability) => [capability, this.persistentTokens[capability]]));

    if (process.platform === "win32") {
      const ciphertext = protectWithDpapi(JSON.stringify(toPersist));
      const vault: WindowsVault = { version: 1, protection: "dpapi-current-user", ciphertext };
      atomicPrivateWrite(this.windowsVaultPath(), `${JSON.stringify(vault, null, 2)}\n`);
      return;
    }
    if (process.platform === "darwin") {
      for (const capability of GATEWAY_CAPABILITIES) {
        if (this.environmentManaged.has(capability)) continue;
        const token = this.persistentTokens[capability];
        if (!isValidToken(token)) throw new Error(`Cannot persist an invalid ${capability} token`);
        writeKeychainToken(capability, token);
      }
      return;
    }
    if (this.environmentManaged.size !== GATEWAY_CAPABILITIES.length) {
      throw new Error("No secure capability-token storage is available on this platform");
    }
  }

  private verifyPersistentTokens(): void {
    if (process.platform === "win32") {
      const stored = this.readWindowsTokens();
      for (const capability of GATEWAY_CAPABILITIES) {
        if (this.environmentManaged.has(capability)) continue;
        if (stored[capability] !== this.persistentTokens[capability]) {
          throw new Error(`Windows DPAPI verification failed for the ${capability} token`);
        }
      }
      return;
    }
    if (process.platform === "darwin") {
      for (const capability of GATEWAY_CAPABILITIES) {
        if (this.environmentManaged.has(capability)) continue;
        if (readKeychainToken(capability) !== this.persistentTokens[capability]) {
          throw new Error(`macOS Keychain verification failed for the ${capability} token`);
        }
      }
    }
  }
}
