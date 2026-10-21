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
git clone https://github.com/pricklyguy/DemonX.git demonx
cd demonx
./scripts/install-pi.sh
```
The script installs Node.js, the packages and the web page, gives your user serial-port access, and sets DemonX to start at every boot. It takes several minutes on a Pi. When it finishes it prints the address. Reboot once when it says so (`sudo reboot`).

To install a specific release instead of the newest code, add its tag: `git clone --branch v2.2.2 https://github.com/pricklyguy/DemonX.git demonx` (the tags are on the Releases page).

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
| Update | `cd ~/demonx && ./scripts/update.sh` (the latest code on your branch), or `./scripts/update.sh v2.0.0` for one release |

**Update from the browser.** When the header shows an update badge, **Settings > Updates > Allow Update now on this page** (off until you turn it on) lets a signed-in browser install that release for you: DemonX fetches the release tag from GitHub, runs `npm install`, builds the new screen into a separate folder (`web/dist-next`), and asks PM2 to restart it, but only when the machine is idle. While it installs (a few minutes, longer on a slow Pi) DemonX refuses to start a job, probe, macro or frame (jogging, the console, unlock and spindle off still work), and the page you have open keeps working, and reloading it is safe: the new screen is built aside, and the folder the server serves (`web/dist`) is not touched until the very end. Just before the restart the controls are locked for a moment so nothing can start, and the new screen is swapped in by renaming the folders; if the spindle, a job or a move is going on at that point DemonX is not restarted and the screen tells you to restart it when the machine is idle. The restart closes the connection to the machine, and many Arduino-style GRBL boards reset when it reopens, so expect to home again afterwards. If a step fails, the version you had is put back (its screen was never touched), and if PM2 cannot restart DemonX the old screen is put back too. `./scripts/update.sh` builds aside the same way and DemonX swaps the new screen in when it starts. It leaves the folder on that release (not on a branch), so afterwards use `./scripts/update.sh v<version>` or `git checkout main` to go back to following the branch. **DemonX Design.** If DemonX Design is also set up here under PM2 (a `demonx-design` process), Update now and `./scripts/update.sh` update it too: they install its packages, build its new screen into `design/dist-next`, swap it in and `pm2 restart demonx-design`, after DemonX has been updated. Design is only touched where it is already set up (a CNC-only Pi never is), and a problem with Design only prints a warning: DemonX is still updated and Design keeps running as it was. **Neither is updated while either is busy**: a job, probe, move or jog on the CNC, or a laser job or move in Design (they answer `GET /api/busy` from this computer only). If Design is too old to answer, restart it once (`pm2 restart demonx-design`) and try again; `update.sh` can also ask you at the keyboard. The restart closes Design's connection to the laser. A changed `design/ecosystem.config.cjs` is not re-read by a restart: use `pm2 delete demonx-design`, then `pm2 start design/ecosystem.config.cjs`. Not tried on a real machine yet: be at the machine the first time.

## If something goes wrong
- **Cannot connect to the port**: `ls /dev/ttyUSB* /dev/ttyACM*` shows whether the Pi sees the machine at all; if you were just added to the `dialout` group, reboot. `pm2 logs demonx` shows the reason.
- **The build runs out of memory** (Pi with 512 MB to 1 GB): add swap, the script prints the command.
- **Page does not open**: `pm2 status` should show `demonx` as `online`. Port 8080 busy: `pm2 logs demonx`.
