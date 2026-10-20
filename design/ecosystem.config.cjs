// PM2 process definition for DemonX Design. Start with:  pm2 start ecosystem.config.cjs
// The settings that belong to one machine (the laser's address, the power limit, who may connect) go in design.env next to this
// file, one KEY=value per line (see design.env.example). That file is not part of the code and is never committed.
const fs = require('node:fs');
const path = require('node:path');

const env = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, 'design.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
} catch { /* no design.env: the defaults apply (this computer only, no Ruida) */ }

module.exports = {
  apps: [
    {
      name: 'demonx-design',
      cwd: __dirname,
      script: './node_modules/.bin/tsx',
      args: 'server/src/index.ts',
      env,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
      time: true,
    },
  ],
};
