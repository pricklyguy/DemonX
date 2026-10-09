import { WebSocket } from 'ws';
import type { ServerResponse } from 'node:http';
import { get } from './camera.js';
import { ConfigError, type AppConfig } from './config.js';

// Home Assistant's own camera stream (HLS). The browser plays it directly, so there is no
// picture-by-picture conversion: that is what makes it look as smooth as the HA dashboard.
// DemonX asks HA for the stream (the access token stays here) and passes the video through.

const PREFIX = '/api/camera/hls/';

/** Ask Home Assistant to start a stream for the camera; resolves to an address under /api/camera/hls/ */
export function haStreamUrl(cfg: AppConfig, timeoutMs = 15_000): Promise<string> {
  const ha = cfg.homeAssistant, entity = cfg.camera.haEntity;
  if (!ha.url) throw new ConfigError('Home Assistant is not set up yet: enter its address and an access token');
  if (!ha.token) throw new ConfigError('Home Assistant needs an access token (Profile, Security, Long-lived access tokens)');
  if (!entity) throw new ConfigError('Choose a Home Assistant camera');
  const wsUrl = ha.url.replace(/^http/, 'ws') + '/api/websocket';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, ha.url.startsWith('https') && ha.insecureTls ? { rejectUnauthorized: false } : {});
    const done = (e?: Error, url?: string) => { clearTimeout(t); ws.removeAllListeners(); try { ws.close(); } catch { /* already closed */ } e ? reject(e) : resolve(url!); };
    const t = setTimeout(() => done(new Error('Home Assistant did not answer in time')), timeoutMs);
    ws.on('error', (e) => done(new Error(`Could not reach Home Assistant: ${(e as Error).message}`)));
    ws.on('close', () => done(new Error('Home Assistant closed the connection')));
    ws.on('message', (raw) => {
      let m: { type?: string; success?: boolean; result?: { url?: string }; error?: { message?: string } };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: ha.token }));
      else if (m.type === 'auth_invalid') done(new Error('Home Assistant refused the access token'));
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type: 'camera/stream', entity_id: entity }));
      else if (m.type === 'result') {
        const u = m.result?.url;
        if (!m.success || !u) return done(new Error(m.error?.message ?? 'Home Assistant could not start a stream for that camera (does it support streaming?)'));
        const rel = u.startsWith('http') ? new URL(u).pathname : u;
        if (!rel.startsWith('/api/hls/')) return done(new Error('Home Assistant answered with an unexpected stream address'));
        done(undefined, PREFIX + rel.slice('/api/hls/'.length));
      }
    });
  });
}

/** Is this one of our HLS addresses, and is the rest of it safe to pass on? */
export const hlsPath = (pathname: string): string | undefined => {
  if (!pathname.startsWith(PREFIX)) return undefined;
  const rest = pathname.slice(PREFIX.length);
  return /^[A-Za-z0-9_\-./]+$/.test(rest) && !rest.split('/').some((p) => p === '..' || p === '') ? rest : undefined;
};

/** Pass one playlist or segment through from Home Assistant */
export async function proxyHls(cfg: AppConfig, rest: string, search: string, res: ServerResponse): Promise<void> {
  const ha = cfg.homeAssistant;
  if (!ha.url) { res.writeHead(409, { 'content-type': 'text/plain' }).end('Home Assistant is not set up'); return; }
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const up = await get({ url: `${ha.url}/api/hls/${rest}${search}`, headers: { Authorization: `Bearer ${ha.token}` }, insecure: ha.insecureTls }, ac.signal);
    // HA may compress the playlists; the bytes are passed on as they are, so say how they are encoded
    const enc = up.headers['content-encoding'];
    res.writeHead(200, { 'content-type': String(up.headers['content-type'] ?? 'application/octet-stream'), 'cache-control': 'no-store', ...(enc ? { 'content-encoding': enc } : {}) });
    up.pipe(res);
    up.on('error', () => res.destroy());
  } catch (e) {
    if (ac.signal.aborted) return;
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end((e as Error).message);
  }
}
