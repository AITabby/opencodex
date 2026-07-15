import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const marker = path.join(os.homedir(), ".opencodex", "native_mode");
try {
  fs.rmSync(marker, { force: true });
  console.log("[OpenCodex] Gateway mode enabled. The local proxy may manage Codex again.");
} catch (error) {
  console.error(`[OpenCodex] Failed to enable gateway mode: ${error.message}`);
  process.exit(1);
}
