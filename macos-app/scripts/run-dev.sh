#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_ROOT="${SCRIPT_DIR:h:h}"
cd "$APP_ROOT"

npm run build
OPENCODEX_DEV_ROOT="$APP_ROOT" swift run --package-path macos-app CodexSplit
