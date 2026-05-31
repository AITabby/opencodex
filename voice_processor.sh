#!/bin/bash
# Voice command processor - monitors /tmp/voice_cmd.txt and processes
CMD_FILE="/tmp/voice_cmd.txt"
REPLY_FILE="/tmp/voice_reply.txt"
LAST_MOD=0

while true; do
  if [ -f "$CMD_FILE" ]; then
    CUR_MOD=$(stat -f "%m" "$CMD_FILE" 2>/dev/null)
    if [ "$CUR_MOD" != "" ] && [ "$CUR_MOD" -gt "$LAST_MOD" ]; then
      LAST_MOD=$CUR_MOD
      TEXT=$(cat "$CMD_FILE" 2>/dev/null)
      if [ "$TEXT" != "" ]; then
        echo "[VP] Processing: $TEXT"
        # Call /api/voice for quick response
        REPLY=$(curl -s -m 60 http://127.0.0.1:8765/api/voice \
          -H "Content-Type: application/json" \
          -d "{\"text\": \"$TEXT\"}" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null)
        if [ "$REPLY" != "" ]; then
          echo "$REPLY" > "$REPLY_FILE"
          echo "[VP] Reply written: $REPLY"
        fi
      fi
    fi
  fi
  sleep 0.5
done
