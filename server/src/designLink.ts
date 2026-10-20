import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

// DemonX Design is a separate program (design/, its own server, run by PM2 as "demonx-design"). Updating DemonX also updates it,
// but only where it is already installed, and never while it is busy: the update restarts its server, which drops the laser
// connection. Design answers "are you busy?" on a local-only address (GET /api/busy).

export const DESIGN_PM2_NAME = 'demonx-design';

export interface DesignBusy { busy: boolean; reason: string }

/** The port Design listens on and whether it is https, from design/design.env (what its PM2 definition reads) */
export function designAddress(designDir: string): { port: number; tls: boolean } {
  let port = 8090, tls = false;
  try {
    for (const line of fs.readFileSync(path.join(designDir, 'design.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const v = m[2].replace(/^"(.*)"$/, '$1');
      if (m[1] === 'DESIGN_PORT' && /^\d{1,5}$/.test(v)) port = Number(v);
      if (m[1] === 'DESIGN_TLS_CERT' && v) tls = true;
    }
  } catch { /* no design.env: the defaults */ }
  return { port, tls };
}

/**
 * Ask Design whether it is busy. Resolves to null when it is idle (or not running at all: nothing to interrupt), else the reason
 * the update must not go ahead: busy, or not able to say (too old to have the question, or not answering).
 */
export function askDesignBusy(port: number, tls: boolean, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const mod = tls ? https : http;
    const req = mod.request({ host: '127.0.0.1', port, path: '/api/busy', method: 'GET', timeout: timeoutMs, ...(tls ? { rejectUnauthorized: false } : {}) }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; if (body.length > 10_000) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve('DemonX Design is too old to say whether a laser job is running. Restart it once (pm2 restart demonx-design) so it has the newer code, then try again');
        if (res.statusCode !== 200) return resolve(`DemonX Design could not say whether it is busy (it answered ${res.statusCode})`);
        try {
          const j = JSON.parse(body) as Partial<DesignBusy>;
          if (typeof j.busy !== 'boolean') throw new Error('bad answer');
          resolve(j.busy ? `DemonX Design is busy: ${String(j.reason || 'a laser job or move is going on').slice(0, 200)}` : null);
        } catch { resolve('DemonX Design gave an answer that could not be read, so it cannot be known whether a laser job is running'); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('DemonX Design did not answer in time, so it cannot be known whether a laser job is running'); });
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED' ? null : `DemonX Design could not be asked whether it is busy (${e.code ?? e.message})`));
    req.end();
  });
}
