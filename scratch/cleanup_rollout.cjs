const fs = require('fs');

const path = "/Users/aitabby/.codex/sessions/2026/06/28/rollout-2026-06-28T23-25-52-019f0ed6-4ba3-7941-832c-ef8e123c502f.jsonl";
if (fs.existsSync(path)) {
  const content = fs.readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  // Keep only the first 102 lines (1-indexed, so index 0 to 101)
  const cleanLines = lines.slice(0, 102);
  fs.writeFileSync(path, cleanLines.join('\n') + '\n', 'utf-8');
  console.log("Successfully cleaned up rollout file, truncated to 102 lines.");
} else {
  console.log("Rollout file not found.");
}
