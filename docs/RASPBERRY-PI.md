# DemonX on a Raspberry Pi

For a small machine with its own Pi (for example a PCB mill running plain GRBL). Everything runs on the Pi; you open DemonX from any computer or phone on the network.

## What you need
- A Raspberry Pi 3, 4, 5 or Zero 2 W (not a Pi 1 or Zero 1), a microSD card (16 GB or more) and a power supply
- The machine's USB cable to the Pi
- A computer with Raspberry Pi Imager (https://www.raspberrypi.com/software/)

## 1. Flash the card
In Raspberry Pi Imager choose **Raspberry Pi OS (64-bit)**. Use **Lite** if the Pi has no screen of its own (you will use DemonX from another computer), or the full Desktop version if a screen is attached to it. Before writing, open the settings (the gear / "Edit settings") and set:
- a **hostname**, e.g. `demonx` (you will reach the Pi as `demonx.local`)
- a **user name and password** (e.g. `prickly`)
- your **Wi-Fi** name and password, and your country
- **Enable SSH** (password login is fine on a home or shop network)

Write the card, put it in the Pi and power it on. Give it a couple of minutes the first time.

*Tip: keep the old card. Putting it back in the Pi brings back whatever ran before (CNCjs); this card runs DemonX.*

## 2. Connect from your computer
```bash
ssh YOUR-USER@demonx.local
```
(If `demonx.local` is not found, look up the Pi's address in your router and use that.)

## 3. Install DemonX
```bash
git clone https://github.com/pricklyguy/demonx.git
cd demonx
./scripts/install-pi.sh
```
The script installs Node.js, the packages and the web page, gives your user serial-port access, and sets DemonX to start at every boot. It takes several minutes on a Pi. When it finishes it prints the address. Reboot once when it says so (`sudo reboot`).

To install a specific release instead of the newest code, add its tag: `git clone --branch v2.0.0-test.2 https://github.com/pricklyguy/demonx.git` (the tags are on the Releases page).

If the repository is private, GitHub will ask for credentials: use a personal access token as the password.

## 3b. Set a PIN
The installer asks for a PIN at the end. Until one is set, DemonX only lets other devices **watch**: nobody can control the machine, so a fresh install is safe by default. If you skipped the question you can still set one two ways:
- **From a phone or computer:** open DemonX; the bar at the top asks for a **setup code**. The code is printed at the end of the install and in `pm2 logs demonx` (look for "setup code"; it changes each time DemonX restarts), then choose a PIN.
- **On the Pi:** `cd ~/demonx && npm run set-pin` (it asks twice, and a running DemonX notices at once). `npm run set-pin -- --open` chooses to run without a PIN, so browsers on your home network can control the machine; anything from outside your network, including VPNs such as Tailscale, can still only watch.

Forgot the PIN? Run `npm run set-pin` again.

## 4. Open it
`http://demonx.local:8080` from any browser on the network. First type `simulator` in the port box and press Connect to check everything works with no machine attached.

## 5. Connect the machine
Plug the machine's USB cable into the Pi. In DemonX press **Refresh ports**: the port is usually `/dev/ttyUSB0` or `/dev/ttyACM0`. Choose it, set the speed to **115200** (the GRBL default) and press Connect.

Start with the machine's power off or the tool and cutter removed, and test slowly: jog a small step, home, and watch it. Open **Settings → Controller** to see the GRBL `$` settings.

Only one program can use the serial port at a time: stop CNCjs or anything else that uses it before connecting.

## Everyday
| Task | Command |
|------|---------|
| Is it running? | `pm2 status` |
| See errors | `pm2 logs demonx` |
| Restart | `pm2 restart demonx` |
| Update | `cd ~/demonx && ./scripts/update.sh` |

## If something goes wrong
- **Cannot connect to the port**: `ls /dev/ttyUSB* /dev/ttyACM*` shows whether the Pi sees the machine at all; if you were just added to the `dialout` group, reboot. `pm2 logs demonx` shows the reason.
- **The build runs out of memory** (Pi with 512 MB to 1 GB): add swap, the script prints the command.
- **Page does not open**: `pm2 status` should show `demonx` as `online`. Port 8080 busy: `pm2 logs demonx`.
