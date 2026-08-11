#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_ROOT="${SCRIPT_DIR:h:h}"
PACKAGE_ROOT="$APP_ROOT/macos-app"
BUILD_ROOT="$PACKAGE_ROOT/.build"
DIST_ROOT="$PACKAGE_ROOT/build"
APP_BUNDLE="$DIST_ROOT/CodexSplit.app"
ICONSET="$PACKAGE_ROOT/.build/CodexSplit.iconset"
ICON_SOURCE="$PACKAGE_ROOT/Resources/CodexSplit-icon-source.png"

cd "$APP_ROOT"
VERSION="$(node -p 'require("./package.json").version')"
MARKETING_VERSION="${VERSION%%-*}"
BUNDLE_VERSION="$(node -p 'const raw=require("./package.json").version; const base=raw.split("-")[0].split(".").map(Number); const beta=raw.includes("-beta.") ? Number(raw.split("-beta.")[1]) : 0; String(base[0]*1000000 + base[1]*1000 + base[2]*10 + beta)')"
npm run build

VOICE_HELPER_FILES=(minimax_tts.py transcribe.py silero_vad_daemon.py)
for helper in "${VOICE_HELPER_FILES[@]}"; do
  if [[ ! -f "$APP_ROOT/dist/voice/$helper" ]]; then
    print -u2 "Missing packaged voice helper: $APP_ROOT/dist/voice/$helper"
    exit 1
  fi
done

swift build -c release --package-path "$PACKAGE_ROOT" --product CodexSplit
swift build -c release --package-path "$PACKAGE_ROOT" --product CodexSplitLivePicker
BIN_ROOT="$(swift build -c release --package-path "$PACKAGE_ROOT" --show-bin-path)"

NODE_BINARY="${OPENCODEX_NODE_BINARY:-$(command -v node)}"
if [[ -z "$NODE_BINARY" || ! -x "$NODE_BINARY" ]]; then
  print -u2 "Unable to locate a Node.js runtime. Set OPENCODEX_NODE_BINARY explicitly."
  exit 1
fi

# The app bundle contains one Node executable, not the user's Homebrew
# installation. Reject runtimes that require external dylibs so a package
# cannot look complete while its gateway exits immediately after launch.
validate_node_runtime() {
  local runtime_version node_links unsupported_links
  if ! runtime_version="$($NODE_BINARY --version 2>&1)"; then
    print -u2 "Node.js runtime cannot execute: $NODE_BINARY"
    print -u2 "$runtime_version"
    exit 1
  fi
  node_links="$(otool -L "$NODE_BINARY")"
  unsupported_links="$(print -r -- "$node_links" | grep -E '(@rpath/|/opt/homebrew/|/usr/local/(Cellar|opt)/)' || true)"
  if [[ -n "$unsupported_links" ]]; then
    print -u2 "Node.js runtime is not self-contained and cannot be bundled safely: $NODE_BINARY"
    print -u2 "$unsupported_links"
    print -u2 "Use a standalone Node.js binary with OPENCODEX_NODE_BINARY=/path/to/node."
    exit 1
  fi
  print "Using self-contained Node.js $runtime_version from $NODE_BINARY"
}
validate_node_runtime

# Bundle the small portable voice tools so local Whisper and Edge TTS do not
# depend on Homebrew, a system Python installation, or a user's PATH.
UVX_BINARY="${OPENCODEX_UVX_BINARY:-$(command -v uvx || true)}"
UV_BINARY="${OPENCODEX_UV_BINARY:-$(command -v uv || true)}"
FFMPEG_BINARY="${OPENCODEX_FFMPEG_BINARY:-$(command -v ffmpeg || true)}"
if [[ -z "$UVX_BINARY" || ! -x "$UVX_BINARY" ]]; then
  print -u2 "Unable to locate uvx. Set OPENCODEX_UVX_BINARY explicitly."
  exit 1
fi
if [[ -z "$UV_BINARY" || ! -x "$UV_BINARY" ]]; then
  print -u2 "Unable to locate uv. Set OPENCODEX_UV_BINARY explicitly."
  exit 1
fi
if [[ -z "$FFMPEG_BINARY" || ! -x "$FFMPEG_BINARY" ]]; then
  print -u2 "Unable to locate ffmpeg. Set OPENCODEX_FFMPEG_BINARY explicitly."
  exit 1
fi

# Ship the voice companion inside the main app bundle. Release builders can
# point at a prebuilt .app, while a sibling source checkout is supported for
# local/reproducible builds.
VOICE_BAR_SOURCE="${OPENCODEX_BAR_SOURCE:-$APP_ROOT/voice/OpenCodexBar}"
VOICE_BAR_APP_OVERRIDE="${OPENCODEX_BAR_APP_PATH:-}"
VOICE_BAR_APP=""
if [[ -n "$VOICE_BAR_APP_OVERRIDE" ]]; then
  VOICE_BAR_APP="$VOICE_BAR_APP_OVERRIDE"
elif [[ -f "$VOICE_BAR_SOURCE/Package.swift" ]]; then
  print "Building embedded OpenCodexBar from $VOICE_BAR_SOURCE..."
  swift build -c release --package-path "$VOICE_BAR_SOURCE" --product OpenCodexBar
  VOICE_BAR_BIN_ROOT="$(swift build -c release --package-path "$VOICE_BAR_SOURCE" --product OpenCodexBar --show-bin-path)"
  VOICE_BAR_APP="$BUILD_ROOT/OpenCodexBar.app"
  rm -rf "$VOICE_BAR_APP"
  mkdir -p "$VOICE_BAR_APP/Contents/MacOS" "$VOICE_BAR_APP/Contents/Resources"
  cp "$VOICE_BAR_BIN_ROOT/OpenCodexBar" "$VOICE_BAR_APP/Contents/MacOS/OpenCodexBar"
  cat > "$VOICE_BAR_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>OpenCodexBar</string>
  <key>CFBundleIdentifier</key>
  <string>com.aitabby.codexsplit.voicebar</string>
  <key>CFBundleName</key>
  <string>CodexSplit Voice Bar</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$MARKETING_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUNDLE_VERSION</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>CodexSplit 需要麦克风权限以使用语音输入。</string>
</dict>
</plist>
PLIST
  chmod +x "$VOICE_BAR_APP/Contents/MacOS/OpenCodexBar"
elif [[ -d "$VOICE_BAR_SOURCE/OpenCodexBar.app" ]]; then
  VOICE_BAR_APP="$VOICE_BAR_SOURCE/OpenCodexBar.app"
else
  print -u2 "Unable to locate OpenCodexBar.app. Set OPENCODEX_BAR_APP_PATH or OPENCODEX_BAR_SOURCE."
  exit 1
fi
if [[ ! -x "$VOICE_BAR_APP/Contents/MacOS/OpenCodexBar" ]]; then
  print -u2 "OpenCodexBar.app is missing an executable: $VOICE_BAR_APP"
  exit 1
fi

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -s format png -z "$double" "$double" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP_BUNDLE/Contents/Resources/CodexSplit.icns"

cp "$BIN_ROOT/CodexSplit" "$APP_BUNDLE/Contents/MacOS/CodexSplit"
cp "$BIN_ROOT/CodexSplitLivePicker" "$APP_BUNDLE/Contents/Resources/CodexSplitLivePicker"
if [[ -d "$BIN_ROOT/OpenCodexMac_OpenCodex.bundle" ]]; then
  cp -R "$BIN_ROOT/OpenCodexMac_OpenCodex.bundle" "$APP_BUNDLE/Contents/Resources/"
fi
cp "$PACKAGE_ROOT/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
cp "$NODE_BINARY" "$APP_BUNDLE/Contents/Resources/node"
cp -R "$APP_ROOT/dist" "$APP_BUNDLE/Contents/Resources/dist"
cp -R "$APP_ROOT/node_modules" "$APP_BUNDLE/Contents/Resources/node_modules"
mkdir -p "$APP_BUNDLE/Contents/Resources/voice-runtime"
cp "$UV_BINARY" "$APP_BUNDLE/Contents/Resources/voice-runtime/uv"
cp "$UVX_BINARY" "$APP_BUNDLE/Contents/Resources/voice-runtime/uvx"
cp "$FFMPEG_BINARY" "$APP_BUNDLE/Contents/Resources/voice-runtime/ffmpeg"
rm -rf "$APP_BUNDLE/Contents/Resources/OpenCodexBar.app"
cp -R "$VOICE_BAR_APP" "$APP_BUNDLE/Contents/Resources/OpenCodexBar.app"
mkdir -p "$APP_BUNDLE/Contents/Resources/dist/src_v2/assets"
cp -R "$APP_ROOT/src_v2/assets/" "$APP_BUNDLE/Contents/Resources/dist/src_v2/assets/"
chmod +x "$APP_BUNDLE/Contents/MacOS/CodexSplit" "$APP_BUNDLE/Contents/Resources/CodexSplitLivePicker" "$APP_BUNDLE/Contents/Resources/node" \
  "$APP_BUNDLE/Contents/Resources/dist/codex-provider-bridge" \
  "$APP_BUNDLE/Contents/Resources/dist/opencodex-codex" \
  "$APP_BUNDLE/Contents/Resources/voice-runtime/uv" \
  "$APP_BUNDLE/Contents/Resources/voice-runtime/uvx" \
  "$APP_BUNDLE/Contents/Resources/voice-runtime/ffmpeg"

# Swift build products may carry an ad-hoc signature before packaging. Once
# resources are copied into the bundle that old signature is incomplete, and
# Gatekeeper can report the downloaded app as damaged instead of showing the
# normal unsigned-app override. Re-sign the complete bundle ad-hoc for local
# distribution; a Developer ID signature, when configured, replaces this in
# package-dmg.sh.
codesign --deep --force --sign - --timestamp=none "$APP_BUNDLE"

print "Created $APP_BUNDLE"
