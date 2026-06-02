#!/bin/bash
# OpenCodex Startup Launcher Script

# Add Homebrew to PATH to ensure pm2 and node are resolvable in launchd environment
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

echo "[$(date)] Launching OpenCodex Server via PM2..." >> /tmp/opencodex_startup.log
pm2 start /Users/aitabby/projects/opencodex/dist/server.js --name "opencodex" >> /tmp/opencodex_startup.log 2>&1

echo "[$(date)] Waiting for server to initialize..." >> /tmp/opencodex_startup.log
sleep 2

echo "[$(date)] Spawning OpenCodexBar via Terminal.app to inherit GUI and microphone permissions..." >> /tmp/opencodex_startup.log
osascript -e 'tell application "Terminal" to do script "cd \"/Users/aitabby/projects/opencodex-bar\" && ./.build/arm64-apple-macosx/release/OpenCodexBar & disown && exit"' >> /tmp/opencodex_startup.log 2>&1

echo "[$(date)] OpenCodex startup sequence complete." >> /tmp/opencodex_startup.log
