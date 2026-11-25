#!/bin/sh
# Builds dist/thndr-radar_<version>_amd64.deb with Node and the thndr CLI bundled (no system Node needed).
# Usage: packaging/build-deb.sh [version]     (needs: git, npm, curl, dpkg-deb)
set -eu
VERSION="${1:-0.1.0}"
NODE_VERSION=20.19.5
THNDR_MCP_REF=main
cd "$(dirname "$0")/.."
ROOT=$(pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/pkg"; APP="$PKG/opt/thndr-radar"
mkdir -p "$APP" "$PKG/DEBIAN" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/scalable/apps" "$ROOT/dist"

# 1. the app
cp alerts.mjs app.mjs index.html LICENSE README.md "$APP/"

# 2. Node runtime (official binary, checksum-verified)
TAR=node-v$NODE_VERSION-linux-x64.tar.xz
curl -fsSL -o "$WORK/$TAR" "https://nodejs.org/dist/v$NODE_VERSION/$TAR"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TAR\$" | (cd "$WORK" && sha256sum -c -)
mkdir -p "$APP/node/bin"
tar -xJf "$WORK/$TAR" -C "$WORK"
cp "$WORK/node-v$NODE_VERSION-linux-x64/bin/node" "$APP/node/bin/node"
cp "$WORK/node-v$NODE_VERSION-linux-x64/LICENSE" "$APP/node/LICENSE"

# 3. thndr CLI: build, then keep only dist + production deps (Apache-2.0, LICENSE/NOTICE kept)
git clone -q --depth 1 --branch "$THNDR_MCP_REF" https://github.com/armaaar/thndr-mcp "$WORK/thndr-mcp"
(cd "$WORK/thndr-mcp" && npm ci --include=dev --no-audit --no-fund --loglevel=error && npm run build --silent && rm -rf node_modules && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
mkdir -p "$APP/vendor/thndr-mcp"
cp -r "$WORK/thndr-mcp/dist" "$WORK/thndr-mcp/node_modules" "$WORK/thndr-mcp/package.json" "$WORK/thndr-mcp/LICENSE" "$WORK/thndr-mcp/NOTICE" "$APP/vendor/thndr-mcp/"
rm -f "$APP"/vendor/thndr-mcp/dist/*.map

# 4. launcher, menu entry, icon
install -m 755 packaging/thndr-radar "$PKG/usr/bin/thndr-radar"
cp packaging/icon.svg "$PKG/usr/share/icons/hicolor/scalable/apps/thndr-radar.svg"
cat > "$PKG/usr/share/applications/thndr-radar.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Thndr Radar
Comment=RSI, trade plans and buy/sell alerts for EGX stocks (unofficial)
Exec=thndr-radar
Icon=thndr-radar
Terminal=false
Categories=Finance;Office;
StartupWMClass=ThndrRadar
DESK

# 5. package metadata
cat > "$PKG/DEBIAN/control" <<CTRL
Package: thndr-radar
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: curl, iproute2, libnotify-bin, xdg-utils
Recommends: google-chrome-stable | chromium-browser | chromium
Installed-Size: $(du -sk "$PKG" | cut -f1)
Maintainer: TheGeekyM <TheGeekyM@users.noreply.github.com>
Homepage: https://github.com/TheGeekyM/thndr-radar
Description: Unofficial desktop radar for EGX stocks on Thndr
 Live prices, RSI signals, trade plans (buy zone, stop-loss, targets),
 order book, trades, desktop alerts and Arabic explanations, using the
 community thndr-mcp CLI. Not affiliated with Thndr. Not financial advice.
CTRL
chmod -R u+rwX,go+rX,go-w "$PKG"
dpkg-deb --root-owner-group -Zxz --build "$PKG" "$ROOT/dist/thndr-radar_${VERSION}_amd64.deb" >/dev/null
echo "Built dist/thndr-radar_${VERSION}_amd64.deb ($(du -h "$ROOT/dist/thndr-radar_${VERSION}_amd64.deb" | cut -f1))"
