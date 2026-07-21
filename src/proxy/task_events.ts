export type CodexTaskState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type CodexTaskSource = "native" | "gateway";

export interface CodexTaskEventInput {
  taskId: string;
  sessionId?: string;
  state: CodexTaskState;
  source: CodexTaskSource;
  model?: string;
  petTheme?: "vortex" | "siri";
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  quotaUsedPercent?: number;
  quotaWindowMinutes?: number;
  quotaResetsAt?: number;
  title?: string;
  requiresAction?: boolean;
  error?: string;
  elapsedMs?: number;
}

export interface CodexTaskEvent extends CodexTaskEventInput {
  version: 1;
  sequence: number;
  occurredAt: string;
}

type TaskEventListener = (event: CodexTaskEvent) => void;

/**
 * Process-local task event bus.
 *
 * It deliberately carries metadata only. Prompt text, tool arguments, file
 * contents, and API credentials never enter this stream. The same bus can be
 * consumed by the dashboard now and by an APNs relay later.
 */
export class TaskEventBus {
  private sequence = 0;
  private readonly events: CodexTaskEvent[] = [];
  private readonly listeners = new Set<TaskEventListener>();
  private readonly maxEvents: number;

  constructor(maxEvents = 200) {
    this.maxEvents = Math.max(20, maxEvents);
  }

  publish(input: CodexTaskEventInput): CodexTaskEvent {
    const event: CodexTaskEvent = {
      version: 1,
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
      ...input,
      sessionId: input.sessionId || input.taskId,
      requiresAction: input.requiresAction === true
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected client must not affect Codex request handling.
      }
    }
    return event;
  }

  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  since(sequence = 0): CodexTaskEvent[] {
    return this.events.filter((event) => event.sequence > sequence);
  }

  snapshot(inputs: CodexTaskEventInput[]): CodexTaskEvent[] {
    const occurredAt = new Date().toISOString();
    return inputs.map((input) => ({
      version: 1,
      // Snapshots are state, not new events. Keep the current sequence so
      // clients do not advance their event cursor while reconnecting.
      sequence: this.sequence,
      occurredAt,
      ...input,
      sessionId: input.sessionId || input.taskId,
      requiresAction: input.requiresAction === true
    }));
  }

  latest(): CodexTaskEvent | null {
    return this.events[this.events.length - 1] || null;
  }
}
