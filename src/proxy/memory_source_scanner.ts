import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import {
  parseMemoryFilePath,
  type ImportSessionCandidate
} from "./memory_file_import.js";

export interface ScannedMemorySource {
  source_id: string;
  agent: string;
  path: string;
  display_path: string;
  format: "json" | "jsonl" | "sqlite" | "markdown";
  modified_at: number;
  sessions: ImportSessionCandidate[];
}

export interface ScannedAgentGroup {
  name: string;
  sources: ScannedMemorySource[];
  session_count: number;
}

const MAX_SCAN_FILE_BYTES = 48 * 1024 * 1024;
const MAX_CANDIDATE_FILES = 250;

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function agentName(path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes(`${sep}.hermes${sep}`)) return "Hermes";
  if (lower.includes(`${sep}.claude${sep}`)) return "Claude Code";
  if (lower.includes("opencode")) return "OpenCode";
  if (lower.includes("antigravity")) return "Antigravity";
  if (lower.includes("openclaw")) return "OpenClaw";
  if (lower.includes("open-webui") || lower.includes("openwebui")) return "Open WebUI";
  if (lower.includes("continue")) return "Continue";
  if (lower.includes("aider")) return "Aider";
  if (lower.includes("cursor")) return "Cursor";

  const home = homedir();
  const relativePath = relative(home, path);
  const firstSegment = relativePath.split(sep).find((part) => part && !part.startsWith("."));
  return firstSegment || basename(path);
}

function isCandidateFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  const lowerPath = path.toLowerCase();
  if ([".db", ".sqlite", ".sqlite3"].includes(extension)) {
    return /(state|session|chat|conversation|history|memory|opencode)/.test(name);
  }
  if (extension === ".jsonl") return true;
  if (extension === ".json") {
    return /(session|chat|conversation|history|message|memory)/.test(name);
  }
  if (extension === ".md" || extension === ".markdown") {
    return /(memory|memories|history|conversation|context)/.test(name)
      || lowerPath.includes(`${sep}memory${sep}`)
      || (
        lowerPath.includes("antigravity")
        && ["task.md", "walkthrough.md", "implementation_plan.md"].includes(name)
      );
  }
  return false;
}

function collectFiles(root: string, maxDepth: number, output: Set<string>, depth = 0): void {
  if (!existsSync(root) || depth > maxDepth || output.size >= MAX_CANDIDATE_FILES) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (output.size >= MAX_CANDIDATE_FILES) break;
    if ([
      "node_modules", ".git", "cache", "Cache", "Caches", "logs", "tmp",
      "docs", "documentation", "examples", "tests", "backups", "backup", "state-snapshots",
      "scratch", ".tempmediaStorage"
    ].includes(entry)) continue;
    const fullPath = join(root, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectFiles(fullPath, maxDepth, output, depth + 1);
      } else if (
        stat.isFile()
        && stat.size > 0
        && (stat.size <= MAX_SCAN_FILE_BYTES || basename(fullPath).toLowerCase() === "opencode.db")
        && isCandidateFile(fullPath)
      ) {
        output.add(realpathSync(fullPath));
      }
    } catch {}
  }
}

function candidateRoots(): Array<{ path: string; depth: number }> {
  const home = homedir();
  const roots: Array<{ path: string; depth: number }> = [
    { path: join(home, ".hermes"), depth: 3 },
    { path: join(home, ".opencode"), depth: 5 },
    { path: join(home, ".openclaw"), depth: 6 },
    { path: join(home, ".continue"), depth: 5 },
    { path: join(home, ".aider"), depth: 4 },
    { path: join(home, ".config", "opencode"), depth: 5 },
    { path: join(home, ".local", "share", "opencode"), depth: 5 },
    { path: join(home, "Library", "Application Support", "OpenClaw"), depth: 5 },
    { path: join(home, "Library", "Application Support", "Antigravity"), depth: 3 },
    { path: join(home, "Library", "Application Support", "Claude"), depth: 4 }
  ];

  const genericParents = [
    join(home, ".config"),
    join(home, ".local", "share"),
    join(home, "Library", "Application Support")
  ];
  const agentDirectoryPattern = /(agent|assistant|chat|claude|code|claw|hermes|cursor|continue|aider|open.?webui)/i;
  for (const parent of genericParents) {
    if (!existsSync(parent)) continue;
    try {
      for (const entry of readdirSync(parent)) {
        if (agentDirectoryPattern.test(entry)) {
          roots.push({ path: join(parent, entry), depth: 3 });
        }
      }
    } catch {}
  }
  return roots;
}

function antigravityIndexedSources(): string[] {
  const root = join(homedir(), ".gemini", "antigravity");
  const annotationsDir = join(root, "annotations");
  if (!existsSync(annotationsDir)) return [];

  const sources: string[] = [];
  try {
    for (const entry of readdirSync(annotationsDir)) {
      if (!entry.toLowerCase().endsWith(".pbtxt")) continue;
      const threadId = entry.slice(0, -".pbtxt".length);
      const databasePath = join(root, "conversations", `${threadId}.db`);
      const brainPath = join(root, "brain", threadId);
      if (existsSync(databasePath)) {
        sources.push(realpathSync(databasePath));
      } else if (existsSync(brainPath)) {
        sources.push(realpathSync(brainPath));
      }
    }
  } catch {}
  return sources;
}

async function parseCandidate(path: string): Promise<ScannedMemorySource | null> {
  try {
    const stat = statSync(path);
    const parsed = await parseMemoryFilePath(path);
    const sessions = parsed.sessions?.length
      ? parsed.sessions
      : parsed.memory
        ? [{
            id: "__default__",
            title: parsed.memory.title || basename(path),
            source: parsed.memory.source?.application,
            model: parsed.memory.source?.model_provider,
            cwd: parsed.memory.source?.cwd,
            message_count: parsed.memory.messages.length,
            updated_at: stat.mtimeMs / 1000
          }]
        : [];
    if (sessions.length === 0) return null;

    return {
      source_id: createHash("sha256").update(path).digest("hex").slice(0, 20),
      agent: agentName(path),
      path,
      display_path: displayPath(path),
      format: parsed.detected_format,
      modified_at: stat.mtimeMs,
      sessions
    };
  } catch {
    return null;
  }
}

export async function scanLocalMemorySources(): Promise<ScannedAgentGroup[]> {
  const files = new Set<string>();
  for (const root of candidateRoots()) collectFiles(root.path, root.depth, files);
  const claudeProjects = join(homedir(), ".claude", "projects");
  if (existsSync(claudeProjects)) files.add(realpathSync(claudeProjects));
  for (const source of antigravityIndexedSources()) files.add(source);

  const sourcePaths = new Set(
    Array.from(files).map((path) => {
      const name = basename(path).toLowerCase();
      return path.toLowerCase().includes("antigravity")
        && ["task.md", "walkthrough.md", "implementation_plan.md"].includes(name)
        ? dirname(path)
        : path;
    })
  );
  const candidates = Array.from(sourcePaths)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, MAX_CANDIDATE_FILES);
  const parsedSources: Array<ScannedMemorySource | null> = new Array(candidates.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(6, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      parsedSources[index] = await parseCandidate(candidates[index]);
    }
  });
  await Promise.all(workers);

  const groups = new Map<string, ScannedMemorySource[]>();
  for (const source of parsedSources) {
    if (!source) continue;
    const list = groups.get(source.agent) || [];
    list.push(source);
    groups.set(source.agent, list);
  }

  return Array.from(groups.entries())
    .map(([name, sources]) => ({
      name,
      sources,
      session_count: sources.reduce((sum, source) => sum + source.sessions.length, 0)
    }))
    .sort((a, b) => b.session_count - a.session_count || a.name.localeCompare(b.name));
}
