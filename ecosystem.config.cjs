// PM2 process definition for DemonX. Start with:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'demonx',
      cwd: __dirname,
      script: './node_modules/.bin/tsx',
      args: 'server/src/index.ts',
      env: {
        PORT: 8080,
        // A machine that only ever cuts PCBs can reload the last scan at startup.
        // Leave it off for general use: a map belongs to one board in one position.
        // DEMONX_AUTOLOAD_MAP: '1',
      },
      autorestart: true,
      restart_delay: 3000, // give a USB serial port time to come back before retrying
      max_restarts: 20,
      time: true,          // timestamp log lines
    },
  ],
};
