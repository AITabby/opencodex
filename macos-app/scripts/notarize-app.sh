#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_ROOT="${SCRIPT_DIR:h:h}"
PACKAGE_ROOT="$APP_ROOT/macos-app"
APP_BUNDLE="$PACKAGE_ROOT/build/OpenCodex.app"
cd "$APP_ROOT"
VERSION="$(node -p 'require("./package.json").version')"
DMG_PATH="$PACKAGE_ROOT/build/OpenCodex-${VERSION}-arm64.dmg"
PROFILE="${OPENCODEX_NOTARY_PROFILE:-}"

if [[ -z "$PROFILE" ]]; then
  print -u2 "Set OPENCODEX_NOTARY_PROFILE to an xcrun notarytool keychain profile."
  exit 2
fi
if [[ ! -f "$DMG_PATH" || ! -d "$APP_BUNDLE" ]]; then
  print -u2 "Build and sign the app/DMG first with package-dmg.sh."
  exit 2
fi

xcrun notarytool submit "$DMG_PATH" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP_BUNDLE"
xcrun stapler validate "$APP_BUNDLE"
spctl --assess --type execute --verbose=2 "$APP_BUNDLE"
print "Notarization validation completed for $APP_BUNDLE"
