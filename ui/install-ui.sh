#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Installing UI dependencies (Electron)..."
npm install

APP="$(pwd)"
DESK="$HOME/.local/share/applications/spl-output-monitor.desktop"
mkdir -p "$(dirname "$DESK")"
cat > "$DESK" <<EOF
[Desktop Entry]
Type=Application
Name=SPL Output Monitor
Comment=Audio output loudness and listening exposure
Exec=$APP/node_modules/.bin/electron $APP --no-sandbox
Icon=audio-headphones
Terminal=false
Categories=AudioVideo;Utility;
StartupWMClass=SPL Output Monitor
EOF
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo "Done. Launch 'SPL Output Monitor' from your app menu, or run: npm start"
