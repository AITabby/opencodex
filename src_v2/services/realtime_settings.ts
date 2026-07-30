import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REALTIME_MODEL_OVERRIDE_TTL_MS = 10 * 60 * 1000;

export type RealtimeSettings = {
  pending_work_model: string;
  pending_set_at: number;
  last_applied_model: string;
  last_applied_at: number;
};

function defaultSettings(): RealtimeSettings {
  return {
    pending_work_model: "",
    pending_set_at: 0,
    last_applied_model: "",
    last_applied_at: 0,
  };
}

export function normalizeRealtimeWorkModel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\r\n\t]/g, "").slice(0, 200);
}

export function loadRealtimeSettings(dataDir = path.join(os.homedir(), ".opencodex")): RealtimeSettings {
  const settingsPath = path.join(dataDir, "realtime_settings.json");
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return {
      pending_work_model: normalizeRealtimeWorkModel(raw?.pending_work_model),
      pending_set_at: Number.isFinite(raw?.pending_set_at) ? Number(raw.pending_set_at) : 0,
      last_applied_model: normalizeRealtimeWorkModel(raw?.last_applied_model),
      last_applied_at: Number.isFinite(raw?.last_applied_at) ? Number(raw.last_applied_at) : 0,
    };
  } catch {
    return defaultSettings();
  }
}

export function saveRealtimeSettings(
  settings: RealtimeSettings,
  dataDir = path.join(os.homedir(), ".opencodex"),
): RealtimeSettings {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(dataDir, "realtime_settings.json");
  const normalized: RealtimeSettings = {
    pending_work_model: normalizeRealtimeWorkModel(settings.pending_work_model),
    pending_set_at: Number.isFinite(settings.pending_set_at) ? Number(settings.pending_set_at) : 0,
    last_applied_model: normalizeRealtimeWorkModel(settings.last_applied_model),
    last_applied_at: Number.isFinite(settings.last_applied_at) ? Number(settings.last_applied_at) : 0,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(normalized, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { fs.chmodSync(settingsPath, 0o600); } catch {}
  return normalized;
}

export function armRealtimeWorkModel(
  model: unknown,
  dataDir = path.join(os.homedir(), ".opencodex"),
  now = Date.now(),
): RealtimeSettings {
  const next = loadRealtimeSettings(dataDir);
  next.pending_work_model = normalizeRealtimeWorkModel(model);
  next.pending_set_at = next.pending_work_model ? now : 0;
  return saveRealtimeSettings(next, dataDir);
}

export function consumeRealtimeWorkModel(
  dataDir = path.join(os.homedir(), ".opencodex"),
  now = Date.now(),
): { model: string; settings: RealtimeSettings } {
  const next = loadRealtimeSettings(dataDir);
  const pending = next.pending_work_model;
  const fresh = Boolean(pending) && now - next.pending_set_at <= REALTIME_MODEL_OVERRIDE_TTL_MS;
  next.pending_work_model = "";
  next.pending_set_at = 0;
  if (fresh) {
    next.last_applied_model = pending;
    next.last_applied_at = now;
  }
  return { model: fresh ? pending : "", settings: saveRealtimeSettings(next, dataDir) };
}
