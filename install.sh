#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/.local/share/dbmon"
BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"

echo "Installing dbmon into $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR" "$UNIT_DIR"
cp dbmon.py "$APP_DIR/dbmon.py"
chmod +x "$APP_DIR/dbmon.py"
ln -sf "$APP_DIR/dbmon.py" "$BIN_DIR/dbmon"
cp dbmon.service "$UNIT_DIR/dbmon.service"

systemctl --user daemon-reload
systemctl --user enable --now dbmon.service

echo
echo "Installed. dbmon service is running."
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "Note: add $BIN_DIR to your PATH to use the 'dbmon' command." ;;
esac
echo "Next: ./gen-tones.sh   then   dbmon calibrate"
