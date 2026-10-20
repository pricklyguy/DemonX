#!/usr/bin/env bash
# Update DemonX Design to the latest code on the current branch and (re)start it under PM2.
set -euo pipefail
cd "$(dirname "$0")/.."
git checkout -- package-lock.json ../package-lock.json 2>/dev/null || true
git pull --ff-only
# Design shares some code with DemonX CNC (serial port, settings files), which needs the packages at the top of the repo
(cd .. && npm install --no-audit --no-fund)
npm install
npm run build
# start clean every time: a stale PM2 entry (for instance from a start that crashed) cannot then block the update
pm2 delete demonx-design >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 status demonx-design
