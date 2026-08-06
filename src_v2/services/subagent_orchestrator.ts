import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type SubagentTaskStatus = "running" | "completed" | "failed" | "cancel_requested";
export type SubagentTaskEventType = "started" | "completed" | "failed" | "cancel_requested";

export interface SubagentTaskRecord {
  id: string;
  parent_task_id?: string;
  parent_turn_id?: string;
  source: "native-spawn-agent";
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

  constructor(dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex")) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "subagent_tasks.json");
    this.eventFilePath = path.join(dataDir, "subagent_task_events.json");
  }

  public start(input: {
    task_id?: string;
    parent_task_id?: string;
    parent_turn_id?: string;
    profile_id?: string;
    provider?: string;
    model?: string;
    backend_model?: string;
    reasoning_effort?: string;
    task_name?: string;
    prompt?: string;
  }): SubagentTaskRecord {
    const now = new Date().toISOString();
    const suppliedTaskId = clean(input.task_id, 160);
    const taskId = suppliedTaskId && suppliedTaskId !== "__active__"
      ? suppliedTaskId
      : `subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const records = this.load();
    const existing = records.find((task) => task.id === taskId);
    const shouldPublishStart = !existing || existing.status !== "running";
    const record: SubagentTaskRecord = {
      id: taskId,
      parent_task_id: clean(input.parent_task_id, 160) || undefined,
      parent_turn_id: clean(input.parent_turn_id, 160) || undefined,
      source: "native-spawn-agent",
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
    if (shouldPublishStart) this.publish("started", record);
    return record;
  }

  public complete(taskId: unknown): SubagentTaskRecord | null {
    return this.update(taskId, "completed");
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

  /**
   * Read the durable lifecycle feed used by the Desktop bridge and GPT-Live
   * sideband. The feed is intentionally metadata-only: prompts are bounded
   * and credentials/provider response bodies are never persisted here.
   */
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

  private update(taskId: unknown, status: SubagentTaskStatus, error?: string): SubagentTaskRecord | null {
    const id = clean(taskId, 160);
    if (!id) return null;
    const records = this.load();
    const index = records.findIndex((task) => task.id === id);
    if (index < 0) return null;
    const previousStatus = records[index].status;
    const record = { ...records[index], status, updated_at: new Date().toISOString(), ...(error ? { error } : {}) };
    records[index] = record;
    this.save(records);
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

  private load(): SubagentTaskRecord[] {
    return readRecords(this.filePath);
  }

  private loadEvents(): SubagentTaskEvent[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.eventFilePath, "utf-8"));
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
    const bounded = tasks.slice(-200);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ schema_version: 1, tasks: bounded }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }
}
