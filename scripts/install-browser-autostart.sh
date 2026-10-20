#!/usr/bin/env bash
# Open DemonX in a browser automatically at login.
#   ./scripts/install-browser-autostart.sh           install
#   ./scripts/install-browser-autostart.sh --remove  undo
set -euo pipefail
ENTRY="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/demonx-browser.desktop"
if [ "${1:-}" = "--remove" ]; then rm -f "$ENTRY"; echo "Removed $ENTRY"; exit 0; fi
LAUNCHER="$(cd "$(dirname "$0")" && pwd)/demonx-browser.sh"
chmod +x "$LAUNCHER"
mkdir -p "$(dirname "$ENTRY")"
cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=DemonX CNC
Comment=Open the DemonX controller at login
Exec=$LAUNCHER
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
DESKTOP
echo "Installed: $ENTRY"
echo "DemonX will open in your browser at the next login."
