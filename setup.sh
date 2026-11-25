#!/bin/sh
# One-time setup: builds the unofficial Thndr CLI (github.com/armaaar/thndr-mcp) into vendor/
# and adds "Thndr Radar" to your app menu (Linux desktops).
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 20+ is required"; exit 1; }
if [ ! -f vendor/thndr-mcp/dist/thndr.js ]; then
  git clone --depth 1 https://github.com/armaaar/thndr-mcp vendor/thndr-mcp
  (cd vendor/thndr-mcp && npm ci --include=dev --no-audit --no-fund && npm run build)
fi
chmod +x start.sh vendor/thndr-mcp/dist/thndr.js
if [ -d "$HOME/.local/share/applications" ]; then
  cat > "$HOME/.local/share/applications/thndr-radar.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Thndr Radar
Comment=RSI, trade plans and buy/sell alerts for EGX stocks
Exec=$PWD/start.sh
Icon=$PWD/packaging/icon-256.png
Terminal=false
Categories=Finance;Office;
StartupWMClass=ThndrRadar
DESK
  echo "Added 'Thndr Radar' to your app menu."
fi
node alerts.mjs --test
echo "Done. Start it with ./start.sh (or from the app menu), then click 'Log in to Thndr'."
