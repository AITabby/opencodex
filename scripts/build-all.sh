#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_ROOT="${SCRIPT_DIR:h}"
VOICE_ROOT="$APP_ROOT/voice/OpenCodexBar"

if [[ ! -f "$VOICE_ROOT/Package.swift" ]]; then
  print -u2 "OpenCodexBar source is missing: $VOICE_ROOT"
  exit 1
fi

cd "$APP_ROOT"
print "Building CodexSplit gateway..."
npm run build

print "Building embedded OpenCodexBar voice companion..."
swift build -c release --package-path "$VOICE_ROOT" --product OpenCodexBar
VOICE_BIN_ROOT="$(swift build -c release --package-path "$VOICE_ROOT" --product OpenCodexBar --show-bin-path)"
VOICE_BINARY="$VOICE_BIN_ROOT/OpenCodexBar"

if [[ ! -x "$VOICE_BINARY" ]]; then
  print -u2 "OpenCodexBar build completed without an executable: $VOICE_BINARY"
  exit 1
fi

print "Checking local voice runtime tools..."
for tool in uv uvx ffmpeg; do
  tool_path="$(command -v "$tool" || true)"
  if [[ -n "$tool_path" && -x "$tool_path" ]]; then
    print "  $tool: $tool_path"
  else
    print "  $tool: not found (DMG packaging can use an OPENCODEX_*_BINARY override)"
  fi
done

print ""
print "Build complete:"
print "  gateway: $APP_ROOT/dist"
print "  voice:   $VOICE_BINARY"
print ""
print "Start the web gateway with: npm start"
