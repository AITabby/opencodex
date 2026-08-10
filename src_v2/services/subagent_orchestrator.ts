import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type SubagentTaskStatus = "running" | "completed" | "failed" | "cancel_requested";
export type SubagentTaskEventType = "started" | "completed" | "failed" | "cancel_requested";
export type SubagentTaskOrigin = "desktop" | "gpt-live";

export const SUBAGENT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_ACTIVE_SUBAGENTS_PER_PARENT = 16;
export const MAX_TOTAL_SUBAGENTS_PER_PARENT = 256;
export const MAX_SUBAGENT_DEPTH = 4;
export const MAX_SUBAGENT_OUTPUT_CHARS = 12_000;

export interface SubagentTaskRecord {
  id: string;
  parent_task_id?: string;
  parent_turn_id?: string;
  source: "native-spawn-agent";
  origin?: SubagentTaskOrigin;
  depth?: number;
  task_name?: string;
  prompt?: string;
  profile_id?: string;
  provider?: string;
  model?: string;
  backend_model?: string;
  reasoning_effort?: string;
  status: SubagentTaskStatus;
  created_at: string;
  updated_at: string;
  error?: string;
  output?: string;
}

export interface SubagentTaskEvent {
  seq: number;
  type: SubagentTaskEventType;
  task_id: string;
  parent_task_id?: string;
  parent_turn_id?: string;
  task: SubagentTaskRecord;
  created_at: string;
}

function clean(value: unknown, max = 300): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function readRecords(filePath: string): SubagentTaskRecord[] {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Array.isArray(value?.tasks) ? value.tasks : [];
  } catch {
    return [];
  }
}

export class SubagentOrchestrator {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly eventFilePath: string;
  private readonly timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex")) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "subagent_tasks.json");
    this.eventFilePath = path.join(dataDir, "subagent_task_events.json");
    this.reconcileStaleRunning();
    const now = Date.now();
    for (const task of this.load()) {
      if (task.status !== "running") continue;
      const updatedAt = Date.parse(task.updated_at || task.created_at || "");
      const elapsed = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : SUBAGENT_TASK_TIMEOUT_MS;
      this.armTimeout(task.id, Math.max(1, SUBAGENT_TASK_TIMEOUT_MS - elapsed));
    }
  }

  public start(input: {
    task_id?: string;
    parent_task_id?: string;
    parent_turn_id?: string;
    task_name?: string;
    prompt?: string;
    profile_id?: string;
    provider?: string;
    model?: string;
    backend_model?: string;
    reasoning_effort?: string;
    origin?: SubagentTaskOrigin;
    depth?: number;
  }): SubagentTaskRecord {
    const now = new Date().toISOString();
    const suppliedTaskId = clean(input.task_id, 160);
    const taskId = suppliedTaskId && suppliedTaskId !== "__active__"
      ? suppliedTaskId
      : `subagent-${randomUUID()}`;
    const records = this.load();
    const existing = records.find((task) => task.id === taskId);
    if (existing?.status === "running") {
      const refreshed = { ...existing, updated_at: now };
      this.save(records.map((task) => task.id === taskId ? refreshed : task));
      this.armTimeout(taskId);
      return refreshed;
    }
    const parentTaskId = clean(input.parent_task_id, 160) || undefined;
    const siblings = records.filter((task) =>
      task.status === "running" && (task.parent_task_id || "__root__") === (parentTaskId || "__root__"),
    );
    if (siblings.length >= MAX_ACTIVE_SUBAGENTS_PER_PARENT) {
      throw new Error(`父任务当前已有 ${MAX_ACTIVE_SUBAGENTS_PER_PARENT} 个运行中的子智能体`);
    }
    const totalChildren = records.filter((task) =>
      (task.parent_task_id || "__root__") === (parentTaskId || "__root__"),
    ).length;
    if (totalChildren >= MAX_TOTAL_SUBAGENTS_PER_PARENT) {
      throw new Error(`父任务累计子智能体数量已达到 ${MAX_TOTAL_SUBAGENTS_PER_PARENT} 个`);
    }
    const requestedDepth = Number(input.depth);
    const depth = Number.isFinite(requestedDepth) ? Math.max(0, Math.floor(requestedDepth)) : 1;
    if (depth > MAX_SUBAGENT_DEPTH) {
      throw new Error(`子智能体嵌套深度超过 ${MAX_SUBAGENT_DEPTH} 层`);
    }
    const record: SubagentTaskRecord = {
      id: taskId,
      parent_task_id: parentTaskId,
      parent_turn_id: clean(input.parent_turn_id, 160) || undefined,
      source: "native-spawn-agent",
      origin: input.origin === "gpt-live" ? "gpt-live" : "desktop",
      depth,
      task_name: clean(input.task_name, 160) || undefined,
      prompt: clean(input.prompt, 2000) || undefined,
      profile_id: clean(input.profile_id, 80) || undefined,
      provider: clean(input.provider, 120) || undefined,
      model: clean(input.model, 240) || undefined,
      backend_model: clean(input.backend_model, 240) || undefined,
      reasoning_effort: clean(input.reasoning_effort, 40) || undefined,
      status: "running",
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    this.save([...records.filter((task) => task.id !== taskId), record]);
    this.publish("started", record);
    this.armTimeout(taskId);
    return record;
  }

  public complete(taskId: unknown, output?: unknown): SubagentTaskRecord | null {
    return this.update(taskId, "completed", undefined, clean(output, MAX_SUBAGENT_OUTPUT_CHARS));
  }

  public fail(taskId: unknown, error: unknown): SubagentTaskRecord | null {
    return this.update(taskId, "failed", clean(error, 500));
  }

  public requestCancel(taskId: unknown): SubagentTaskRecord | null {
    return this.update(taskId, "cancel_requested");
  }

  public list(limit = 100): SubagentTaskRecord[] {
    return this.load().slice(-Math.max(1, Math.min(500, Math.floor(limit)))).reverse();
  }

  private update(taskId: unknown, status: SubagentTaskStatus, error?: string, output?: string): SubagentTaskRecord | null {
    const id = clean(taskId, 160);
    if (!id) return null;
    const records = this.load();
    const index = records.findIndex((task) => task.id === id);
    if (index < 0) return null;
    const previousStatus = records[index].status;
    const record = {
      ...records[index],
      status,
      updated_at: new Date().toISOString(),
      ...(error ? { error } : {}),
      ...(status === "completed" && output ? { output } : {}),
    };
    records[index] = record;
    this.save(records);
    if (status !== "running") this.clearTimeout(id);
    if (previousStatus !== status) {
      const eventType: SubagentTaskEventType = status === "completed"
        ? "completed"
        : status === "cancel_requested"
          ? "cancel_requested"
          : "failed";
      this.publish(eventType, record);
    }
    return record;
  }

  /** Read the durable, metadata-only lifecycle feed used by the Desktop bridge. */
  public listEvents(options: {
    limit?: number;
    after?: number;
    parent_task_id?: string;
    parent_turn_id?: string;
  } = {}): SubagentTaskEvent[] {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(options.limit || 100))));
    const after = Math.max(0, Math.floor(Number(options.after || 0)));
    const parentTaskId = clean(options.parent_task_id, 160);
    const parentTurnId = clean(options.parent_turn_id, 160);
    return this.loadEvents()
      .filter((event) => event.seq > after)
      .filter((event) => !parentTaskId || event.parent_task_id === parentTaskId)
      .filter((event) => !parentTurnId || event.parent_turn_id === parentTurnId)
      .slice(-limit);
  }

  public latestEventSequence(): number {
    return this.loadEvents().reduce((max, event) => Math.max(max, Number(event?.seq || 0)), 0);
  }

  private load(): SubagentTaskRecord[] {
    return readRecords(this.filePath).map((task) => ({
      ...task,
      origin: task.origin === "gpt-live" ? "gpt-live" : "desktop",
      depth: Number.isFinite(Number(task.depth)) ? Number(task.depth) : 1,
    }));
  }

  private armTimeout(taskId: string, delayMs = SUBAGENT_TASK_TIMEOUT_MS): void {
    this.clearTimeout(taskId);
    const timer = setTimeout(() => {
      const current = this.load().find((task) => task.id === taskId);
      if (current?.status === "running") {
        this.update(taskId, "failed", "子智能体超过生命周期超时，已自动结束");
      }
    }, Math.max(1, Math.floor(delayMs)));
    timer.unref?.();
    this.timeoutHandles.set(taskId, timer);
  }

  private clearTimeout(taskId: string): void {
    const timer = this.timeoutHandles.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.timeoutHandles.delete(taskId);
  }

  private reconcileStaleRunning(): void {
    const now = Date.now();
    const records = this.load();
    const stale = records.filter((task) => {
      if (task.status !== "running") return false;
      const updatedAt = Date.parse(task.updated_at || task.created_at || "");
      return !Number.isFinite(updatedAt) || now - updatedAt >= SUBAGENT_TASK_TIMEOUT_MS;
    });
    if (stale.length === 0) return;
    const staleIds = new Set(stale.map((task) => task.id));
    const next = records.map((task) => staleIds.has(task.id)
      ? { ...task, status: "failed" as const, updated_at: new Date().toISOString(), error: "网关重启后发现未闭合的运行中子智能体，已自动结束" }
      : task);
    this.save(next);
    for (const task of next) {
      if (staleIds.has(task.id)) this.publish("failed", task);
    }
  }

  private loadEvents(): SubagentTaskEvent[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.eventFilePath, "utf8"));
      return Array.isArray(value?.events) ? value.events : [];
    } catch {
      return [];
    }
  }

  private publish(type: SubagentTaskEventType, task: SubagentTaskRecord): void {
    const events = this.loadEvents();
    const lastSeq = events.reduce((max, event) => Math.max(max, Number(event?.seq || 0)), 0);
    const event: SubagentTaskEvent = {
      seq: lastSeq + 1,
      type,
      task_id: task.id,
      parent_task_id: task.parent_task_id,
      parent_turn_id: task.parent_turn_id,
      task: { ...task },
      created_at: new Date().toISOString(),
    };
    this.saveEvents([...events, event]);
  }

  private saveEvents(events: SubagentTaskEvent[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const bounded = events.slice(-1000);
    const temporaryPath = `${this.eventFilePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ schema_version: 1, events: bounded }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.eventFilePath);
    try { fs.chmodSync(this.eventFilePath, 0o600); } catch {}
  }

  private save(tasks: SubagentTaskRecord[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    // Retain at least the per-parent cumulative cap in the durable file;
    // otherwise truncating at 200 would allow a busy parent to create more
    // than MAX_TOTAL_SUBAGENTS_PER_PARENT over time without being counted.
    const bounded = tasks.slice(-Math.max(200, MAX_TOTAL_SUBAGENTS_PER_PARENT));
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ schema_version: 1, tasks: bounded }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }
}
