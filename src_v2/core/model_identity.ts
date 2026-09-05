/**
 * Models used by Codex's native control plane are not user-selectable
 * provider models. They must remain on the official OpenAI transport even
 * when the surrounding request carries subagent metadata.
 */
const NATIVE_CONTROL_PLANE_MODELS = new Set(["codex-auto-review"]);

export function isNativeControlPlaneModel(value: unknown): boolean {
  return NATIVE_CONTROL_PLANE_MODELS.has(String(value || "").trim().toLowerCase());
}

export function isOfficialModelSlug(slug: unknown): boolean {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("openai/")) return true;
  if (normalized.includes("/")) return false;
  return /^(?:gpt(?:-|\s)|o\d|codex(?:-|\s)|chatgpt|\d+\.\d+)/i.test(normalized);
}
