#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_ROOT="${SCRIPT_DIR:h:h}"
PACKAGE_ROOT="$APP_ROOT/macos-app"
DIST_ROOT="$PACKAGE_ROOT/build"
APP_BUNDLE="$DIST_ROOT/OpenCodex.app"
DMG_PATH="$DIST_ROOT/OpenCodex-1.0.0-arm64.dmg"
DMG_STAGING="$PACKAGE_ROOT/.build/dmg-staging"

"$PACKAGE_ROOT/scripts/package-app.sh"
if [[ -n "${OPENCODEX_SIGNING_IDENTITY:-}" ]]; then
  "$PACKAGE_ROOT/scripts/sign-app.sh"
fi
rm -f "$DMG_PATH"
rm -rf "$DMG_STAGING"
mkdir -p "$DMG_STAGING"
cp -R "$APP_BUNDLE" "$DMG_STAGING/OpenCodex.app"
ln -s /Applications "$DMG_STAGING/Applications"
# Force HFS+ for reproducible UDZO verification. On newer macOS versions the
# default APFS source image can be recognized by imageinfo but intermittently
# fail hdiutil verify with a temporary-resource error.
hdiutil create -volname "OpenCodex" -fs HFS+ -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_PATH" >/dev/null
print "Created $DMG_PATH"
