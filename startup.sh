#!/bin/bash
# OpenCodex startup launcher.
#
# This script is run by launchd. Keep the server in the foreground so launchd
# can supervise it and restart it if it exits. Do not use PM2 here: launchd is
# already the process supervisor on macOS, and PM2 is not guaranteed to exist
# in a login-free launchd environment.
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BAR_DIR="${OPENCODEX_BAR_DIR:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)/opencodex-bar}"

LOG_FILE="/tmp/opencodex_startup.log"
echo "[$(date)] Launching OpenCodex server under launchd..." >> "$LOG_FILE"

NODE_BIN="${OPENCODEX_NODE_BIN:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[$(date)] ERROR: Node.js executable not found." >> "$LOG_FILE"
  exit 1
fi

if ! pgrep -f '/OpenCodexBar([[:space:]]|$)' >/dev/null 2>&1; then
  echo "[$(date)] Spawning OpenCodexBar via Terminal.app..." >> "$LOG_FILE"
  if [ -d "$BAR_DIR" ]; then
    osascript -e "tell application \"Terminal\" to do script \"cd \\\"$BAR_DIR\\\" && ./.build/arm64-apple-macosx/release/OpenCodexBar & disown && exit\"" >> "$LOG_FILE" 2>&1 || true
  else
    echo "[$(date)] OpenCodexBar directory not found at $BAR_DIR; skipping companion launch." >> "$LOG_FILE"
  fi
fi

echo "[$(date)] Starting $NODE_BIN $SCRIPT_DIR/dist/server.js in foreground." >> "$LOG_FILE"
cd "$SCRIPT_DIR"
exec "$NODE_BIN" "$SCRIPT_DIR/dist/server.js"
