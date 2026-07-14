import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export function resolveCodexBinary(): string {
  if (process.platform === "darwin") {
    const chatGptBundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    if (existsSync(chatGptBundled)) return chatGptBundled;
    const bundled = "/Applications/Codex.app/Contents/Resources/codex";
    return existsSync(bundled) ? bundled : "codex";
  }

  return "codex";
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrLines: string[] = [];
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  async connect(): Promise<void> {
    if (this.process) return;

    const child = spawn(resolveCodexBinary(), ["app-server", "--stdio"], {
      env: {
        ...process.env,
        HOME: homedir()
      }
    });
    this.process = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf-8");
      let newlineIndex = -1;
      while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        try {
          const message = JSON.parse(line);
          const id = Number(message.id);
          if (!Number.isFinite(id)) continue;
          const pending = this.pending.get(id);
          if (!pending) continue;

          clearTimeout(pending.timer);
          this.pending.delete(id);
          if (message.error) {
            pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
        } catch {
          // Ignore non-JSON app-server output.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrLines.push(trimmed);
        if (this.stderrLines.length > 8) this.stderrLines.shift();
      }
    });

    child.on("error", (error) => {
      this.rejectAll(new Error(`Unable to start Codex app-server: ${error.message}`));
      this.process = null;
    });

    child.on("close", (code) => {
      if (this.pending.size > 0) {
        const details = this.stderrLines.length ? `: ${this.stderrLines.join(" | ")}` : "";
        this.rejectAll(new Error(`Codex app-server exited with code ${code}${details}`));
      }
      this.process = null;
    });

    await this.call("initialize", {
      clientInfo: {
        name: "codex-desktop",
        title: "Codex Desktop",
        version: "1.0.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.notify("initialized");
  }

  call(method: string, params: any, timeoutMs = 30000): Promise<any> {
    if (!this.process) {
      return Promise.reject(new Error("Codex app-server is not connected"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (error: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Unable to write to Codex app-server: ${error.message}`));
      }
    });
  }

  notify(method: string, params?: any): void {
    if (!this.process) return;
    const message = params === undefined ? { method } : { method, params };
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  close(): void {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function withCodexAppServer<T>(
  operation: (client: CodexAppServerClient) => Promise<T>
): Promise<T> {
  const client = new CodexAppServerClient();
  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.close();
  }
}
