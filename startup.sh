#!/bin/bash
# OpenCodex Startup Launcher Script

# Add Homebrew to PATH to ensure pm2 and node are resolvable in launchd environment
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

echo "[$(date)] Launching OpenCodex Server via PM2..." >> /tmp/opencodex_startup.log
pm2 start /Users/aitabby/projects/opencodex/dist/server.js --name "opencodex" >> /tmp/opencodex_startup.log 2>&1

echo "[$(date)] Waiting for server to initialize..." >> /tmp/opencodex_startup.log
sleep 2

echo "[$(date)] OpenCodex startup sequence complete. Voice Bar remains stopped until launched from the dashboard." >> /tmp/opencodex_startup.log
