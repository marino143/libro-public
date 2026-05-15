#!/bin/bash
# Build & install libro.app na /Applications/libro.app
# Pokreni: ./build.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/libro.app"

echo "→ Compiling Swift wrapper..."
swiftc "$DIR/libro-app.swift" -o /tmp/libro-binary -framework Cocoa -framework WebKit -O

echo "→ Killing any running libro instance..."
pkill -f "MacOS/libro$" 2>/dev/null || true
sleep 1

echo "→ Installing to $APP/Contents/MacOS/libro..."
mkdir -p "$APP/Contents/MacOS"
mv /tmp/libro-binary "$APP/Contents/MacOS/libro"
chmod +x "$APP/Contents/MacOS/libro"

# Touch app bundle so Finder/Dock refreshes icon cache
touch "$APP"

echo "✓ Done. Launch with: open $APP"
