#!/usr/bin/env bash
# Set up DemonX on a Raspberry Pi (or any Debian/Ubuntu-style Linux): Node.js, the app's packages, the build,
# serial-port access, and PM2 so it starts at every boot.
#
# Run it from the DemonX folder, as the user that will run DemonX (not as root; it asks for sudo where needed):
#     ./scripts/install-pi.sh
# It is safe to run again: it skips what is already done. To update later use ./scripts/update.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not root (it uses sudo where it must)."
command -v apt-get >/dev/null 2>&1 || die "This script is for Debian-style systems (Raspberry Pi OS, Ubuntu). Install Node.js 20+ yourself, then run: npm install && npm run build && pm2 start ecosystem.config.cjs"

case "$(uname -m)" in
  armv6l) die "This Pi (ARMv6: Pi 1 or Pi Zero) is too old for current Node.js. A Pi 3, Pi 4, Pi 5 or Zero 2 W works." ;;
esac

say "Memory check"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
echo "This computer has about ${MEM_MB} MB of memory."
if [ "$MEM_MB" -lt 900 ]; then
  echo "That is little for building the web page. If the build below is killed or runs out of memory, add swap:"
  echo "  sudo dphys-swapfile swapoff && sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile && sudo dphys-swapfile setup && sudo dphys-swapfile swapon"
fi

say "Node.js 20 or newer"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  [ "$MAJOR" -ge 20 ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 1 ]; then
  echo "Found Node.js $(node -v)"
else
  echo "Installing Node.js 22 (from NodeSource)..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "Installed Node.js $(node -v)"
fi

say "Tools used if a native part has to be compiled (usually not needed)"
sudo apt-get install -y git build-essential python3

say "Serial port access (the dialout group)"
if id -nG "$USER" | tr ' ' '\n' | grep -qx dialout; then
  echo "$USER is already in the dialout group."
else
  sudo usermod -aG dialout "$USER"
  echo "Added $USER to dialout. This takes effect at the next login (the reboot at the end covers it)."
  NEED_REBOOT=1
fi

say "Installing packages and building (a few minutes on a Pi)"
npm install
npm run build

say "PM2 (keeps DemonX running and starts it at boot)"
if ! command -v pm2 >/dev/null 2>&1; then sudo npm install -g pm2; fi
if pm2 describe demonx >/dev/null 2>&1; then pm2 restart demonx; else pm2 start ecosystem.config.cjs; fi
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME"
pm2 save
pm2 status demonx

say "Access PIN"
echo "DemonX needs a PIN before other devices can control the machine (until then they can only watch)."
if [ -t 0 ]; then
  echo "Choose one now. Press Enter at the first question to skip it and use a setup code instead."
  npm run set-pin || true
else
  echo "There is no keyboard here to ask on, so no PIN was set."
fi
sleep 2
if npm run --silent set-pin -- --show 2>/dev/null | grep -q "No PIN yet"; then
  CODE=$(pm2 logs demonx --nostream --lines 80 2>/dev/null | grep -o 'setup code, then choose a PIN: *[0-9]\{4\}-[0-9]\{4\}' | tail -1 | grep -o '[0-9]\{4\}-[0-9]\{4\}')
  echo
  echo "No PIN is set yet. Open DemonX from another device and enter this setup code, then choose a PIN:"
  echo "    ${CODE:-(not found: run  pm2 logs demonx  and look for "setup code")}"
  echo "(Or run  npm run set-pin  here whenever you like. The code changes each time DemonX restarts.)"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
say "Done"
echo "DemonX is running. Open it from any computer on the network:"
echo "    http://${IP:-the-pi-address}:8080     (or http://$(hostname).local:8080)"
echo "Type  simulator  in the port box to try it with no machine, or pick the machine's serial port."
echo
echo "Useful:  pm2 status | pm2 logs demonx | pm2 restart demonx | ./scripts/update.sh"
if [ "${NEED_REBOOT:-0}" = "1" ]; then
  echo
  echo "Please reboot once so the serial-port permission applies:   sudo reboot"
fi
