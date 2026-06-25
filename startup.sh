#!/bin/bash
# OpenCodex Startup Launcher Script

# Add Homebrew to PATH to ensure pm2 and node are resolvable in launchd environment
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BAR_DIR="${OPENCODEX_BAR_DIR:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)/opencodex-bar}"

echo "[$(date)] Launching OpenCodex Server via PM2..." >> /tmp/opencodex_startup.log
pm2 start "$SCRIPT_DIR/dist/server.js" --name "opencodex" >> /tmp/opencodex_startup.log 2>&1

echo "[$(date)] Waiting for server to initialize..." >> /tmp/opencodex_startup.log
sleep 2

echo "[$(date)] Spawning OpenCodexBar via Terminal.app to inherit GUI and microphone permissions..." >> /tmp/opencodex_startup.log
if [ -d "$BAR_DIR" ]; then
  osascript -e "tell application \"Terminal\" to do script \"cd \\\"$BAR_DIR\\\" && ./.build/arm64-apple-macosx/release/OpenCodexBar & disown && exit\"" >> /tmp/opencodex_startup.log 2>&1
else
  echo "[$(date)] OpenCodexBar directory not found at $BAR_DIR; skipping companion launch." >> /tmp/opencodex_startup.log
fi

echo "[$(date)] OpenCodex startup sequence complete." >> /tmp/opencodex_startup.log
