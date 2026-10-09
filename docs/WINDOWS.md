DEMONX FOR WINDOWS
==================

DemonX is a CNC controller that runs in your web browser. One computer (this one) is connected to the machine; any
browser on your network can watch and control it. It works with GRBL and FluidNC controllers.

You need: Windows 10 or 11 (64-bit), a USB cable from this computer to the machine's controller, and a web browser.
You do NOT need to install Node, Python or anything else: it is all in this folder.


1. INSTALL
----------
a. Right-click the zip file you downloaded, choose Properties. If you see an "Unblock" box at the bottom, tick it and
   press OK. (Windows marks files downloaded from the internet as untrusted; without this it may block the start file.)
b. Right-click the zip, choose "Extract All...". When it asks where, type  C:\  and press Extract.
   That gives you the folder  C:\DemonX  . (Do not run it from inside the zip. Avoid "Program Files": DemonX
   saves your settings in its own folder.)
c. Open  C:\DemonX  and double-click  "Start DemonX.bat".


2. FIRST START
--------------
- A black window opens (leave it open: closing it stops DemonX) and your browser opens DemonX after a few seconds.
- Windows Defender Firewall asks if "Node.js JavaScript Runtime" may communicate on networks.
  Tick "Private networks" and press Allow. Without this, only this computer can open DemonX.
  (If you pressed Cancel by mistake: Windows Security, Firewall & network protection, "Allow an app through firewall",
  Change settings, find "Node.js JavaScript Runtime", tick Private.)
- "Windows protected your PC" (SmartScreen)? Press "More info", then "Run anyway". The start files are not
  signed with a paid certificate.


3. CONNECT TO THE MACHINE
-------------------------
- Plug the machine's USB cable into this computer, and switch the machine on.
- In DemonX, Connection panel: open the Serial port box and pick the port (for example COM3), then Connect.
  Baud rate: 115200 for most GRBL and FluidNC controllers.
- No port listed? Open Device Manager (right-click Start), "Ports (COM & LPT)". If the board shows with a yellow
  warning or under "Other devices", it needs a USB driver. Many Arduino-style boards use a CH340 chip:
  search for "CH340 driver", install it, unplug and replug the cable, then press "Refresh ports" in DemonX.
- "Access denied" or "File not found" when connecting: another program has the port open (CNCjs, UGS, Arduino IDE,
  a second DemonX). Close it and try again.
- Can't tell which COM port? Unplug the cable, press Refresh ports, plug it back in, press Refresh ports: the new one is it.
- First time on this machine: go slowly. Check the position readout, jog a little, and be ready at the machine's
  emergency stop before you run anything.


4. USE IT FROM A PHONE OR ANOTHER COMPUTER
------------------------------------------
- DemonX shows the address: in the black window ("From a phone or another computer on the same network: ..."),
  and in DemonX under Settings, Access, with a Copy button and a QR code you can scan with a phone's camera. The phone button (📱) in the DemonX header opens the same
  address and QR code in a popup. It looks like
  http://192.168.1.20:8080
- On the other device (same network), type that address into its browser.
- Several addresses listed? A computer can have more than one network card (Wi-Fi, cable, VPN). Try the first;
  if it does not open, try the next. (Command Prompt, ipconfig, "IPv4 Address" shows the same numbers.)
- A new install has no PIN, and until one is set other devices can only WATCH. On this computer DemonX shows a
  "Set a PIN" bar at the top: choose a PIN there. (Or run "Set PIN.bat" in the DemonX folder.)
  After that, other devices can control the machine once they enter the PIN ("Remember this device" keeps them signed in).
  This computer never asks for the PIN.
- No keyboard on this computer, or you are setting it up from your phone? The black window shows a setup code
  ("enter this setup code, then choose a PIN"). Open DemonX on the other device and enter that code with the PIN you choose.
- Devices outside your home network, and VPNs such as Tailscale, can only watch until they enter the PIN.
  "Run without a PIN" (a button on the Set PIN bar) lets your home network control the machine without one; outside still only watches.


5. START BY ITSELF WHEN WINDOWS STARTS
--------------------------------------
Double-click "Start at login.bat". DemonX then starts, minimised, when you sign in. It asks whether to open the browser
too: answer Y for a computer you sit at, N for one that nobody sits at (you use it from other devices). Run it again to
change your answer. (The computer must be signed in: DemonX is not a Windows service.)
"Stop starting at login.bat" undoes it.
Also tell Windows not to sleep while the machine is running: Settings, System, Power, "Screen and sleep".
A computer that sleeps during a job will stop sending the program.


6. UPDATING
-----------
Download the new zip, unblock it (step 1a), close DemonX, right-click the zip, Extract All, type  C:\  again, and answer
"Replace" if asked.
Your settings, macros, height map and backups are in the "data" folder, which the zip does not contain, so they stay.
To go back to an older version, extract that older zip over it the same way.


7. WHERE THINGS ARE
-------------------
  data\config.json         your settings (camera, Home Assistant, spindle, PCB mode). Contains passwords: do not share it.
  data\auth.json           the PIN (stored scrambled). Forgot the PIN? Run "Set PIN.bat", or close DemonX, delete this file, start DemonX again.
  data\macros.json         your macros
  data\fluidnc-backups\    copies of FluidNC config files made when you save them from DemonX
To make a backup of everything, copy the "data" folder.
To uninstall: close DemonX, run "Stopping starting at login", and delete the folder.


8. TROUBLESHOOTING
------------------
"Port 8080 is already in use": another program uses that port (a second DemonX, CNCjs). Close it, or use another port:
  open Command Prompt in this folder and run   set PORT=8090 && "Start DemonX.bat"   then open http://localhost:8090
The window closes at once: open Command Prompt, go to the folder (cd C:\DemonX) and run  "Start DemonX.bat"  to see the message.
Antivirus removes or blocks files: DemonX is not signed; add the DemonX folder as an exclusion, or download again.
Other devices cannot connect: check step 2 (firewall, Private networks) and that both are on the same network.
Camera video (RTSP) needs ffmpeg installed; Home Assistant cameras and Reolink snapshots do not.

LICENSE
-------
DemonX is free software under the GNU General Public License, version 3 or later (see LICENSE.txt in this folder).
You may share and change it under those terms. The source code is at github.com/pricklyguy/DemonX
It comes with no warranty. Test with the machine's emergency stop in reach, and run new programs in the air first.
This package also contains Node.js (MIT licence, node\LICENSE-node.txt) and open-source packages with their own licences.

Project: Prickly Guy Creations (PGC), github.com/pricklyguy/DemonX
