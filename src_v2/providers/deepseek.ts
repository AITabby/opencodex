export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_RESPONSES_URL = `${DEEPSEEK_API_BASE_URL}/responses`;
export const DEEPSEEK_RESPONSES_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;

const DEEPSEEK_RESPONSES_MODEL_SET = new Set<string>(DEEPSEEK_RESPONSES_MODELS);

export function isDeepSeekProvider(providerName?: string, presetId?: string): boolean {
  return [providerName, presetId]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.trim().toLowerCase() === DEEPSEEK_PROVIDER_ID);
}

export function isDeepSeekResponsesModel(model: string): boolean {
  const normalized = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^deepseek\//, "");
  return DEEPSEEK_RESPONSES_MODEL_SET.has(normalized);
}

/**
 * Reduce saved/dashboard model identifiers to the exact models that should be
 * connectivity-tested. Provider entries may contain a display-name mapping
 * (`alias=upstream` or `alias->upstream`) while catalog entries may be
 * namespaced (`deepseek/deepseek-v4-flash`).
 */
export function selectDeepSeekResponsesModels(models: readonly unknown[]): string[] {
  const selected: string[] = [];
  for (const value of models) {
    if (typeof value !== "string") continue;
    const raw = value.trim();
    if (!raw) continue;
    const separator = raw.includes("=") ? "=" : (raw.includes("->") ? "->" : "");
    const upstream = separator ? raw.split(separator).slice(1).join(separator).trim() : raw;
    const normalized = upstream.toLowerCase().replace(/^deepseek\//, "");
    if (!DEEPSEEK_RESPONSES_MODEL_SET.has(normalized) || selected.includes(normalized)) continue;
    selected.push(normalized);
  }
  return selected;
}

/**
 * The official DeepSeek preset is intentionally pinned to the official API.
 * Custom DeepSeek-compatible gateways must use the custom-provider flow so
 * their endpoint identity and credentials remain explicit.
 */
export function effectiveDeepSeekBaseUrl(
  providerName: string | undefined,
  presetId: string | undefined,
  configuredBaseUrl: string,
): string {
  return isDeepSeekProvider(providerName, presetId)
    ? DEEPSEEK_API_BASE_URL
    : configuredBaseUrl;
}
