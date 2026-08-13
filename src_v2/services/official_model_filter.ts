import fs from "node:fs";
import path from "node:path";

export interface OfficialModelFilterSettings {
  enabled: boolean;
  visible_models: string[];
}

export function normalizeOfficialModelFilterSettings(value: unknown): OfficialModelFilterSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const visible = Array.isArray(source.visible_models) ? source.visible_models : [];
  return {
    enabled: source.enabled === true,
    visible_models: Array.from(new Set(visible
      .map((model) => String(model || "").trim().toLowerCase())
      .filter(Boolean))),
  };
}

export function readOfficialModelFilterSettings(dataDir: string): OfficialModelFilterSettings {
  try {
    return normalizeOfficialModelFilterSettings(JSON.parse(
      fs.readFileSync(path.join(dataDir, "official_model_filter.json"), "utf8"),
    ));
  } catch {
    return { enabled: false, visible_models: [] };
  }
}

export function writeOfficialModelFilterSettings(
  dataDir: string,
  value: unknown,
): OfficialModelFilterSettings {
  const settings = normalizeOfficialModelFilterSettings(value);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dataDir, "official_model_filter.json");
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return settings;
}

/** Apply picker visibility only to native Codex models. */
export function applyOfficialModelFilter(models: any[], value: unknown): void {
  const settings = normalizeOfficialModelFilterSettings(value);
  const visible = new Set(settings.visible_models);
  for (const model of models) {
    const slug = String(model?.slug || model?.model || model?.id || "").trim().toLowerCase();
    if (!slug) continue;
    if (!Object.hasOwn(model, "codexsplit_original_visibility")) {
      model.codexsplit_original_visibility = model.visibility ?? null;
    }
    if (settings.enabled) {
      model.visibility = visible.has(slug) ? "list" : "hide";
      continue;
    }
    if (model.codexsplit_original_visibility === null) delete model.visibility;
    else model.visibility = model.codexsplit_original_visibility;
    delete model.codexsplit_original_visibility;
  }
}
