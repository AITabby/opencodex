/**
 * OpenCodex Screenshot Capture Utility
 * Captures the main screen using macOS-native Swift CGDisplay API with standard fallback.
 */

import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendWindowsAction } from "./windows-agent.js";

export class ScreenshotTaker {
  async capture(): Promise<Buffer> {
    if (process.platform === "win32") {
      const result = await sendWindowsAction("screenshot");
      if (!result.data) throw new Error("Windows screenshot returned no image data.");
      return Buffer.from(result.data, "base64");
    }
    try {
      return this.swiftCapture();
    } catch (err: any) {
      console.error("[OpenCodex-Screenshot] Swift CGDisplay capture failed, falling back to screencapture utility:", err.message);
      return this.scCapture();
    }
  }

  private swiftCapture(): Buffer {
    const out = join(tmpdir(), `oc-shot-${Date.now()}.png`);
    const f = join(tmpdir(), `oc-shot-${Date.now()}.swift`);
    const swiftCode = `import Cocoa
import Foundation
let img = CGDisplayCreateImage(CGMainDisplayID())!
let rep = NSBitmapImageRep(cgImage: img)
let png = rep.representation(using: .png, properties: [:])!
try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
`;
    try {
      writeFileSync(f, swiftCode, "utf-8");
      const r = spawnSync("/usr/bin/swift", [f, out], { timeout: 10000 });
      if (r.status !== 0) throw new Error(r.stderr?.toString() || "Swift exit with error status");
      return readFileSync(out);
    } finally {
      try { unlinkSync(f); } catch {}
      try { unlinkSync(out); } catch {}
    }
  }

  private scCapture(): Buffer {
    const out = join(tmpdir(), `oc-shot-sc-${Date.now()}.png`);
    try {
      execSync(`/usr/sbin/screencapture -x -t png "${out}"`, { timeout: 10000 });
      return readFileSync(out);
    } finally {
      try { unlinkSync(out); } catch {}
    }
  }
}
