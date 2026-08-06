#!/bin/bash
# OpenCodex Startup Launcher Script

# Add Homebrew to PATH to ensure pm2 and node are resolvable in launchd environment
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BRIDGE_PATH="$PROJECT_ROOT/dist/codex-provider-bridge"
NATIVE_CODEX_PATH=""
for candidate in \
  "/Applications/ChatGPT.app/Contents/Resources/codex" \
  "/Applications/Codex.app/Contents/Resources/codex"; do
  if [ -x "$candidate" ]; then
    NATIVE_CODEX_PATH="$candidate"
    break
  fi
done

echo "[$(date)] Configuring the provider bridge for future Desktop launches..." >> /tmp/opencodex_startup.log
if [ -x "$BRIDGE_PATH" ] && [ -n "$NATIVE_CODEX_PATH" ]; then
  # ChatGPT/Codex is launched independently by macOS after this LaunchAgent.
  # Register the bridge in the user's launchd environment so its app-server
  # inherits CODEX_CLI_PATH instead of starting the native CLI directly.
  /bin/launchctl setenv CODEX_CLI_PATH "$BRIDGE_PATH" || true
  /bin/launchctl setenv OPENCODEX_NATIVE_CODEX_PATH "$NATIVE_CODEX_PATH" || true
  /bin/launchctl setenv OPENCODEX_PROVIDER_BRIDGE_PATH "$BRIDGE_PATH" || true
  /bin/launchctl setenv OPENCODEX_PROVIDER_SPLIT "1" || true
  # The gateway consumes this one-shot marker after it is listening and
  # starts Desktop through the bridge. This makes the gateway the owner of
  # the provider split instead of relying on Desktop's login-item order.
  STARTUP_DATA_DIR="${HOME:-/Users/aitabby}/.opencodex"
  mkdir -p "$STARTUP_DATA_DIR"
  : > "$STARTUP_DATA_DIR/restart_desktop_after_gateway_ready"
  chmod 600 "$STARTUP_DATA_DIR/restart_desktop_after_gateway_ready" || true
  echo "[$(date)] Provider bridge registered: $BRIDGE_PATH" >> /tmp/opencodex_startup.log
else
  # Do not leave a stale bridge path behind if the bundled/source bridge is
  # unavailable; native GPT can still start directly in that case.
  /bin/launchctl unsetenv CODEX_CLI_PATH || true
  /bin/launchctl unsetenv OPENCODEX_NATIVE_CODEX_PATH || true
  /bin/launchctl unsetenv OPENCODEX_PROVIDER_BRIDGE_PATH || true
  /bin/launchctl unsetenv OPENCODEX_PROVIDER_SPLIT || true
  rm -f "${HOME:-/Users/aitabby}/.opencodex/restart_desktop_after_gateway_ready" || true
  echo "[$(date)] Provider bridge unavailable; leaving native Desktop launch unchanged." >> /tmp/opencodex_startup.log
fi

echo "[$(date)] Launching OpenCodex Server via PM2..." >> /tmp/opencodex_startup.log
pm2 start "$PROJECT_ROOT/dist/server.js" --name "opencodex" >> /tmp/opencodex_startup.log 2>&1

echo "[$(date)] Waiting for server to initialize..." >> /tmp/opencodex_startup.log
sleep 2

echo "[$(date)] OpenCodex startup sequence complete. Voice Bar remains stopped until launched from the dashboard." >> /tmp/opencodex_startup.log
