#!/bin/bash
# Double-click to open the Playable Worlds viewer (no Node.js needed).
# Serves the ready-built dist/ folder on this computer only and opens it in your browser.
# Close this Terminal window to stop it.
cd "$(dirname "$0")/dist" || exit 1
PORT=8765
while lsof -i :$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo "Playable Worlds is running at http://localhost:$PORT/"
echo "Keep this window open while you use it. Close it to stop."
( sleep 1; open "http://localhost:$PORT/" ) &
exec /usr/bin/python3 -m http.server $PORT --bind 127.0.0.1
