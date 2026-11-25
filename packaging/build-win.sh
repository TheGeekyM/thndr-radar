#!/bin/bash
# Builds dist/ThndrRadar-Setup-<version>.exe (Node + thndr CLI bundled). Runs on Windows (Git Bash, e.g. GitHub
# Actions windows-latest) or Linux with makensis installed. Usage: packaging/build-win.sh [version]
set -euo pipefail
VERSION="${1:-0.1.0}"
NODE_VERSION=20.19.5
cd "$(dirname "$0")/.."
OUT=build/win; rm -rf build; mkdir -p "$OUT" dist
cp alerts.mjs app.mjs index.html LICENSE README.md packaging/windows/ThndrRadar.vbs "$OUT/"
# Node for Windows (checksum-verified)
ZIP=node-v$NODE_VERSION-win-x64.zip
curl -fsSL -o "build/$ZIP" "https://nodejs.org/dist/v$NODE_VERSION/$ZIP"
(cd build && curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $ZIP\$" | sha256sum -c -)
(cd build && if command -v unzip >/dev/null; then unzip -q "$ZIP"; else 7z x -y "$ZIP" >/dev/null; fi)
cp "build/node-v$NODE_VERSION-win-x64/node.exe" "$OUT/node.exe"
cp "build/node-v$NODE_VERSION-win-x64/LICENSE" "$OUT/NODE-LICENSE"
# thndr CLI: build, keep dist + production deps (pure JS, so building on any OS is fine)
git clone -q --depth 1 https://github.com/armaaar/thndr-mcp build/thndr-mcp
(cd build/thndr-mcp && npm ci --include=dev --no-audit --no-fund --loglevel=error && npm run build --silent && rm -rf node_modules && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
mkdir -p "$OUT/vendor/thndr-mcp"
cp -r build/thndr-mcp/dist build/thndr-mcp/node_modules build/thndr-mcp/package.json build/thndr-mcp/LICENSE build/thndr-mcp/NOTICE "$OUT/vendor/thndr-mcp/"
rm -f "$OUT"/vendor/thndr-mcp/dist/*.map
(cd packaging/windows && makensis -V2 -DVERSION="$VERSION" installer.nsi)
echo "Built dist/ThndrRadar-Setup-$VERSION.exe"
