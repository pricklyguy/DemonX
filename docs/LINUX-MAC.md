# DemonX on Linux or macOS

For a Raspberry Pi, use the [Raspberry Pi guide](RASPBERRY-PI.md) instead; it has a one-command installer.
For Windows, use the [Windows guide](WINDOWS.md).

## What you need

- **Node.js 20 or newer** and **git**.
  - macOS: install [Homebrew](https://brew.sh), then `brew install node git`.
  - Debian or Ubuntu: `sudo apt install git`, then install Node 20+ from [nodejs.org](https://nodejs.org) or NodeSource (the `node` in the default Ubuntu repository is often too old). Check with `node -v`.
- The computer is plugged into the machine by USB, and stays on while you use DemonX.

## Install

Open a terminal and run these one at a time:

```bash
git clone https://github.com/pricklyguy/DemonX.git
cd DemonX
npm install
npm run build
npm start
```

`npm install` and `npm run build` take a few minutes the first time. `npm start` stays running in that terminal; closing the terminal stops DemonX.

## Open it and set a PIN

`npm start` prints the web addresses and an **8-digit setup code**. Open <http://localhost:8080> on this computer. The page asks you to **set a PIN** (or choose to run without one).

To set or change the PIN later, stop DemonX with Ctrl+C and run `npm run set-pin`, or use it while DemonX is running; it notices at once.

Other devices on your home network can open the addresses `npm start` printed (the 📱 button in the header shows a QR code). Until you set a PIN they can only watch.

## Connect to the machine

Type `simulator` in the port box to try everything with no machine. For a real machine, pick its serial port from the list.

- **Linux:** your user needs permission to use serial ports. Run `sudo usermod -aG dialout $USER`, then log out and back in. If it still fails with "permission denied", this is almost always the cause.
- **macOS:** the port looks like `/dev/cu.usbserial-…` or `/dev/cu.usbmodem…`. Pick the `cu.` one, not `tty.`. Some cheap boards need a USB-serial driver (CH340/CP210x) first.

## Update

```bash
cd DemonX
./scripts/update.sh
```

Your settings and PIN live in `data/` and are kept.

## Start automatically

To run DemonX in the background and have it start when the computer boots, follow [Run at boot with PM2](../README.md#run-at-boot-with-pm2-the-mini-pc).

## Stuck?

Open an issue on GitHub and say your operating system, what you ran, and paste what the terminal printed.
