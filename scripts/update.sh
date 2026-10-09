#!/usr/bin/env bash
# Update DemonX to the latest code on the current branch and restart it under PM2.
set -euo pipefail
cd "$(dirname "$0")/.."
# package-lock.json is rewritten by every npm install (differently on a Pi); a changed copy would stop git from pulling or switching branches
git checkout -- package-lock.json 2>/dev/null || true
git pull
npm install
npm run build
if pm2 describe demonx >/dev/null 2>&1; then
  pm2 restart demonx
else
  pm2 start ecosystem.config.cjs
  pm2 save
fi
pm2 status demonx
