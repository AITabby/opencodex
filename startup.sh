#!/bin/bash
# OpenCodex Startup Launcher Script

# Add Homebrew to PATH to ensure pm2 and node are resolvable in launchd environment
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BRIDGE_PATH="$PROJECT_ROOT/dist/codex-provider-bridge"

echo "[$(date)] Leaving native Desktop launch unchanged; provider bridge is opt-in." >> /tmp/opencodex_startup.log

# Older releases exported the bridge through launchd. Clear only the exact
# OpenCodex-owned values so login startup cannot leave a stale global takeover
# behind or overwrite another tool's CODEX_CLI_PATH.
CURRENT_CLI_PATH=$(/bin/launchctl getenv CODEX_CLI_PATH 2>/dev/null || true)
CURRENT_BRIDGE_PATH=$(/bin/launchctl getenv OPENCODEX_PROVIDER_BRIDGE_PATH 2>/dev/null || true)
if [ "$CURRENT_CLI_PATH" = "$BRIDGE_PATH" ] || [ "$CURRENT_BRIDGE_PATH" = "$BRIDGE_PATH" ]; then
  /bin/launchctl unsetenv CODEX_CLI_PATH || true
  /bin/launchctl unsetenv OPENCODEX_NATIVE_CODEX_PATH || true
  /bin/launchctl unsetenv OPENCODEX_PROVIDER_BRIDGE_PATH || true
  /bin/launchctl unsetenv OPENCODEX_PROVIDER_SPLIT || true
  /bin/launchctl unsetenv OPENCODEX_PROVIDER_BRIDGE_RUNTIME || true
  /bin/launchctl unsetenv OPENCODEX_GATEWAY_PORT || true
  echo "[$(date)] Cleared legacy OpenCodex bridge launch environment." >> /tmp/opencodex_startup.log
fi

echo "[$(date)] Launching OpenCodex Server via PM2 (gateway-only stop isolation)..." >> /tmp/opencodex_startup.log
# The Desktop/Bridge is intentionally independent from the gateway. PM2's
# default tree-kill would otherwise terminate detached Desktop descendants
# when the user runs `pm2 stop opencodex`.
pm2 start "$PROJECT_ROOT/dist/server.js" --name "opencodex" --no-treekill >> /tmp/opencodex_startup.log 2>&1

echo "[$(date)] Waiting for server to initialize..." >> /tmp/opencodex_startup.log
sleep 2

echo "[$(date)] OpenCodex startup sequence complete. Voice Bar remains stopped until launched from the dashboard." >> /tmp/opencodex_startup.log
