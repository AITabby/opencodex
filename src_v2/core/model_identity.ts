/**
 * Models used by Codex's native control plane are not user-selectable
 * provider models. They must remain on the official OpenAI transport even
 * when the surrounding request carries subagent metadata.
 */
const NATIVE_CONTROL_PLANE_MODELS = new Set(["codex-auto-review"]);

export function isNativeControlPlaneModel(value: unknown): boolean {
  return NATIVE_CONTROL_PLANE_MODELS.has(String(value || "").trim().toLowerCase());
}
