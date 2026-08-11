#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_ROOT="${SCRIPT_DIR:h:h}"
BUILD_ROOT="$APP_ROOT/macos-app/build"
APP_BUNDLE="$BUILD_ROOT/CodexSplit.app"
cd "$APP_ROOT"
VERSION="$(node -p 'require("./package.json").version')"
MARKETING_VERSION="${VERSION%%-*}"
BUNDLE_VERSION="$(node -p 'const raw=require("./package.json").version; const base=raw.split("-")[0].split(".").map(Number); const beta=raw.includes("-beta.") ? Number(raw.split("-beta.")[1]) : 0; String(base[0]*1000000 + base[1]*1000 + base[2]*10 + beta)')"
DMG_PATH="${OPENCODEX_DMG_PATH:-$BUILD_ROOT/CodexSplit-${VERSION}-arm64.dmg}"
REQUIRE_SIGNED="${OPENCODEX_REQUIRE_SIGNED:-0}"

if [[ ! -d "$APP_BUNDLE" ]]; then
  print -u2 "Missing $APP_BUNDLE; run package-app.sh first."
  exit 2
fi

required_files=(
  "$APP_BUNDLE/Contents/MacOS/CodexSplit"
  "$APP_BUNDLE/Contents/Resources/CodexSplitLivePicker"
  "$APP_BUNDLE/Contents/Resources/node"
  "$APP_BUNDLE/Contents/Resources/voice-runtime/uv"
  "$APP_BUNDLE/Contents/Resources/voice-runtime/uvx"
  "$APP_BUNDLE/Contents/Resources/voice-runtime/ffmpeg"
  "$APP_BUNDLE/Contents/Resources/dist/server.js"
  "$APP_BUNDLE/Contents/Resources/dist/voice/minimax_tts.py"
  "$APP_BUNDLE/Contents/Resources/dist/voice/transcribe.py"
  "$APP_BUNDLE/Contents/Resources/dist/voice/silero_vad_daemon.py"
  "$APP_BUNDLE/Contents/Resources/dist/src_v2/assets/codexsplit-logo-compact.png"
  "$APP_BUNDLE/Contents/Resources/OpenCodexMac_OpenCodex.bundle"
  "$APP_BUNDLE/Contents/Resources/OpenCodexBar.app/Contents/Info.plist"
  "$APP_BUNDLE/Contents/Resources/OpenCodexBar.app/Contents/MacOS/OpenCodexBar"
  "$APP_BUNDLE/Contents/Resources/CodexSplit.icns"
)
for file in "${required_files[@]}"; do
  [[ -e "$file" ]] || { print -u2 "Missing app resource: $file"; exit 1; }
done

short_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_BUNDLE/Contents/Info.plist")
bundle_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_BUNDLE/Contents/Info.plist")
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Contents/Info.plist")
print "App: $bundle_id $short_version"
[[ "$short_version" == "$MARKETING_VERSION" ]] || { print -u2 "Marketing version mismatch: package.json=$VERSION, App=$short_version"; exit 1; }
[[ "$bundle_version" == "$BUNDLE_VERSION" ]] || { print -u2 "Bundle version mismatch: expected=$BUNDLE_VERSION, App=$bundle_version"; exit 1; }

if codesign --verify --deep --strict "$APP_BUNDLE" >/dev/null 2>&1; then
  print "Code signature: valid"
  if ! spctl --assess --type execute --verbose=2 "$APP_BUNDLE" >/dev/null 2>&1; then
    print -u2 "Warning: Gatekeeper assessment did not pass (notarization may still be missing)."
    [[ "$REQUIRE_SIGNED" == "1" ]] && exit 1
  fi
else
  print "Code signature: not present (local Ad-hoc build)"
  [[ "$REQUIRE_SIGNED" == "1" ]] && { print -u2 "A signed build is required."; exit 1; }
fi

if [[ -f "$DMG_PATH" ]]; then
  hdiutil verify "$DMG_PATH" >/dev/null
  print "DMG: valid ($DMG_PATH)"
else
  print "DMG: not found (run package-dmg.sh to create it)"
fi
print "Release checks passed."
