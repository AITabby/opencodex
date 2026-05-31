#!/bin/bash
TEXT="$1"
echo "$TEXT" | pbcopy
osascript -e 'tell application "Codex" to activate' -e 'delay 0.2' -e 'tell application "System Events" to keystroke "v" using command down' -e 'delay 0.1' -e 'tell application "System Events" to key code 36'
echo "Injected: $TEXT"
