#!/bin/bash
# OpenCodex Startup Launcher Script

# Add Homebrew to PATH to ensure pm2 and node are resolvable in launchd environment
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
umask 077
OPENCODEX_STARTUP_LOG_DIR="${OPENCODEX_STARTUP_LOG_DIR:-${HOME}/Library/Logs/OpenCodex}"
mkdir -p "$OPENCODEX_STARTUP_LOG_DIR"
chmod 700 "$OPENCODEX_STARTUP_LOG_DIR"
OPENCODEX_STARTUP_LOG="$OPENCODEX_STARTUP_LOG_DIR/startup.log"

echo "[$(date)] Launching OpenCodex Server via PM2..." >> "$OPENCODEX_STARTUP_LOG"
pm2 start /Users/aitabby/projects/opencodex/dist/server.js --name "opencodex" >> "$OPENCODEX_STARTUP_LOG" 2>&1

echo "[$(date)] Waiting for server to initialize..." >> "$OPENCODEX_STARTUP_LOG"
sleep 2

echo "[$(date)] OpenCodex startup sequence complete. Voice Bar remains stopped until launched from the dashboard." >> "$OPENCODEX_STARTUP_LOG"
