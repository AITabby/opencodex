#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_ROOT="${SCRIPT_DIR:h:h}"
APP_BUNDLE="$APP_ROOT/macos-app/build/CodexSplit.app"
IDENTITY="${OPENCODEX_SIGNING_IDENTITY:-}"

if [[ -z "$IDENTITY" ]]; then
  print -u2 "Set OPENCODEX_SIGNING_IDENTITY to an Apple Developer signing identity."
  exit 2
fi
if [[ ! -d "$APP_BUNDLE" ]]; then
  print -u2 "Build the app first with package-app.sh."
  exit 2
fi

codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP_BUNDLE"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
print "Signed and verified $APP_BUNDLE"
