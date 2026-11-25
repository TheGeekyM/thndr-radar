#!/bin/sh
# Starts the Thndr Radar server (if not already running) and opens it as a desktop window.
# The server keeps running after the window closes so alerts keep coming.
# Stop it with: kill $(ss -ltnp 'sport = :7777' | grep -o 'pid=[0-9]*' | cut -d= -f2)
cd "$(dirname "$0")"
export THNDR_BIN="$PWD/vendor/thndr-mcp/dist/thndr.js"
NODE="$(command -v node || echo /usr/local/bin/node)"
if ! curl -sf http://127.0.0.1:7777/api/state >/dev/null; then
  nohup "$NODE" "$PWD/app.mjs" >> app.log 2>&1 &
  sleep 1
fi
BROWSER="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
if [ -n "$BROWSER" ]; then
  exec "$BROWSER" --app=http://127.0.0.1:7777 --class=ThndrRadar --window-size=1440,860
else
  xdg-open http://127.0.0.1:7777
fi
