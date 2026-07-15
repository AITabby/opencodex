#!/bin/bash
# Wait for the system to settle and Codex to auto-start
sleep 4
# Check if Codex is running without the debugging port
if ps aux | grep -i "/Applications/ChatGPT.app" | grep -v grep | grep -q -v "remote-debugging-port=8315"; then
    echo "ChatGPT running without debug port. Restarting..."
    killall ChatGPT Codex 2>/dev/null
    sleep 2
fi

# Ensure Codex is started with the debugging port. Launch the bundled binary
# directly because `open -a --args` can silently reuse an instance and drop
# the debugging flag.
if [ -x "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" ]; then
    nohup "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" --remote-debugging-port=8315 >/dev/null 2>&1 &
else
    nohup "/Applications/Codex.app/Contents/MacOS/Codex" --remote-debugging-port=8315 >/dev/null 2>&1 &
fi
echo "ChatGPT launched with remote-debugging-port=8315"
