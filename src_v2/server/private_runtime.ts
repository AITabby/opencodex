import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const VOICE_RUNTIME_PACKAGES = Object.freeze({
  edgeTts: "edge-tts==7.2.8",
  whisper: "openai-whisper==20250625",
  sileroVad: "silero-vad==6.2.1",
});

function safeSegment(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

/**
 * Per-process private scratch space for voice audio and generated helpers.
 *
 * The directory is random, owner-only on POSIX platforms, and validated
 * before recursive cleanup so a malformed path can never expand the delete
 * scope beyond the exact directory created by this instance.
 */
export class PrivateRuntimeDirectory {
  public readonly root: string;
  private readonly prefix: string;
  private cleaned = false;

  constructor(prefix = "opencodex-runtime") {
    this.prefix = safeSegment(prefix, "opencodex-runtime");
    const tempRoot = path.resolve(os.tmpdir());
    this.root = fs.mkdtempSync(path.join(tempRoot, `${this.prefix}-${process.pid}-`));
    fs.chmodSync(this.root, 0o700);
  }

  public fixedFile(name: string): string {
    this.assertActive();
    const safeName = safeSegment(path.basename(name), "runtime-file");
    if (safeName !== name || path.basename(name) !== name) {
      throw new Error(`Invalid private runtime filename: ${name}`);
    }
    return path.join(this.root, safeName);
  }

  public uniqueFile(label: string, extension = ""): string {
    this.assertActive();
    const safeLabel = safeSegment(label, "runtime-file");
    const safeExtension = extension
      ? `.${safeSegment(extension.replace(/^\./, ""), "bin")}`
      : "";
    return path.join(this.root, `${safeLabel}-${randomUUID()}${safeExtension}`);
  }

  public writePrivateFile(filePath: string, content: string | NodeJS.ArrayBufferView): void {
    this.assertOwnedPath(filePath);
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }

  public removeFile(filePath: string): void {
    this.assertOwnedPath(filePath);
    try { fs.unlinkSync(filePath); } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  public cleanup(): void {
    if (this.cleaned) return;
    const tempRoot = path.resolve(os.tmpdir());
    const resolvedRoot = path.resolve(this.root);
    if (
      path.dirname(resolvedRoot) !== tempRoot
      || !path.basename(resolvedRoot).startsWith(`${this.prefix}-${process.pid}-`)
    ) {
      throw new Error(`Refusing to clean unexpected private runtime directory: ${resolvedRoot}`);
    }
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
    this.cleaned = true;
  }

  private assertActive(): void {
    if (this.cleaned) throw new Error("Private runtime directory has already been cleaned");
  }

  private assertOwnedPath(filePath: string): void {
    this.assertActive();
    const resolvedRoot = path.resolve(this.root);
    const resolvedPath = path.resolve(filePath);
    if (path.dirname(resolvedPath) !== resolvedRoot) {
      throw new Error(`Refusing to access a file outside the private runtime directory: ${resolvedPath}`);
    }
  }
}
