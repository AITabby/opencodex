#!/bin/bash
# Wait for the system to settle and Codex to auto-start
sleep 4
# Check if Codex is running without the debugging port
if ps aux | grep -i "/Applications/Codex.app" | grep -v grep | grep -q -v "remote-debugging-port=8315"; then
    echo "Codex running without debug port. Restarting..."
    killall Codex 2>/dev/null
    sleep 2
fi

# Ensure Codex is started with the debugging port
open -a Codex --args --remote-debugging-port=8315
echo "Codex launched with remote-debugging-port=8315"
