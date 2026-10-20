// The HTTP and WebSocket side of DemonX Design's server (kept apart from index.ts so tests can start it on any port).
import { ROTARY_MAX_BYTES, readRotary, writeRotary } from './rotary.js';
import { POSITIONS_MAX_BYTES, readPositions, writePositions } from './positions.js';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { isLocalRequest, sameOrigin } from '../../../server/src/auth.js';
import type { LaserBackend } from './laserBackend.js';
import type { ClientMessage, LaserState, ServerMessage } from './protocol.js';
import { LIBRARY_MAX_BYTES, readLibraries, writeLibraries } from './library.js';
import type { Access } from './access.js';
import type { CameraStore } from './camera.js';
import { LASERS_MAX_BYTES, readLasers, writeLasers } from './lasers.js';
import { TOOLLIB_MAX_BYTES, readToolLib, writeToolLib } from './toollib.js';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

/**
 * Only addresses that mean this computer. A web page on another site cannot name the laser server by one of these,
 * and a name that is pointed at 127.0.0.1 later (DNS rebinding) arrives with the wrong Host and is refused here.
 */
export const hostAllowed = (host: string | undefined): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host ?? '');

/**
 * Is the laser doing something that must not be interrupted (by an update that restarts this server, for instance)? A job that
 * runs or is paused, a start in progress (a Ruida job being sent counts as running), a frame or any move of the head, homing, or a
 * hold. Idle, disconnected, an alarm or a finished job are not busy. Design has no held jog (a jog is one short move), so a jog
 * counts only while the head is moving.
 */
export function busyOf(state: LaserState): { busy: boolean; reason: string } {
  if (state.job.state === 'running') return { busy: true, reason: 'a laser job is running' };
  if (state.job.state === 'paused') return { busy: true, reason: 'a laser job is paused' };
  switch (state.status.state) {
    case 'Run': return { busy: true, reason: 'the laser head is moving (a frame, a move or a job)' };
    case 'Jog': return { busy: true, reason: 'a jog is moving the laser head' };
    case 'Hold': return { busy: true, reason: 'the laser is on hold in the middle of a move' };
    case 'Home': return { busy: true, reason: 'the laser is homing' };
    default: return { busy: false, reason: '' };
  }
}

export function createLaserServer(session: LaserBackend, webRoot: string, opts: { libraryFile?: string; lasersFile?: string; toolLibFile?: string; positionsFile?: string; rotaryFile?: string; camera?: CameraStore; /** serve over https (a certificate and its key): the browser then offers a real Save As and open dialog */ tls?: { cert: Buffer; key: Buffer }; /** who may reach the server and control it; without it only this computer may (tests) */ access?: Access } = {}): { server: http.Server; wss: WebSocketServer } {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const access = opts.access;
    if (access ? !access.admits(req) : !isLocalRequest(req.socket.remoteAddress, req.headers) || !hostAllowed(req.headers.host)) { res.writeHead(403).end('DemonX Design is only available on the computer that runs it and the home network.'); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    if (access?.handleAuth(req, res, url.pathname)) return;
    if (url.pathname.startsWith('/api/camera') && opts.camera) {
      const cam = opts.camera;
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
      if (url.pathname === '/api/camera/status' && req.method === 'GET') { json(200, cam.status()); return; }
      if (url.pathname === '/api/camera.jpg' && req.method === 'GET') {
        cam.still().then((f) => { res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store' }).end(f.body); }, (e: Error) => json(503, { error: e.message }));
        return;
      }
      if (url.pathname === '/api/camera/config' && req.method === 'PUT') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) { json(403, { error: 'Forbidden' }); return; }
        if (access && access.roleOf(req) !== 'operator') { json(401, { error: 'Sign in first' }); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => { try { cam.save(JSON.parse(body || '{}')); json(200, cam.status()); } catch (e) { json(400, { error: e instanceof SyntaxError ? 'That is not valid JSON' : (e as Error).message }); } });
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/api/lasers') {
      const file = opts.lasersFile;
      if (!file) { res.writeHead(404).end(); return; }
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
      if (req.method === 'GET') { json(200, readLasers(file)); return; }
      if (req.method === 'PUT') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) { json(403, { error: 'Forbidden' }); return; }
        if (access && access.roleOf(req) !== 'operator') { json(401, { error: 'Sign in first' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size <= LASERS_MAX_BYTES) chunks.push(c); });
        req.on('end', () => {
          if (size > LASERS_MAX_BYTES) { json(413, { error: 'The list is too big' }); return; }
          try { json(200, writeLasers(file, Buffer.concat(chunks).toString('utf8'))); } catch (e) { json(400, { error: (e as Error).message }); }
        });
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/api/toollib') {
      const file = opts.toolLibFile;
      if (!file) { res.writeHead(404).end(); return; }
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
      if (req.method === 'GET') { json(200, readToolLib(file)); return; }
      if (req.method === 'PUT') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) { json(403, { error: 'Forbidden' }); return; }
        if (access && access.roleOf(req) !== 'operator') { json(401, { error: 'Sign in first' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size <= TOOLLIB_MAX_BYTES) chunks.push(c); });
        req.on('end', () => {
          if (size > TOOLLIB_MAX_BYTES) { json(413, { error: 'The library is too big' }); return; }
          try { json(200, writeToolLib(file, Buffer.concat(chunks).toString('utf8'))); } catch (e) { json(400, { error: (e as Error).message }); }
        });
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/api/busy') {
      // read-only, and only for programs on this computer (the update script asks before it restarts the server): never for the
      // home network, whatever the PIN says
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
      if (!isLocalRequest(req.socket.remoteAddress, req.headers)) { res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: 'Forbidden' })); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(busyOf(session.state())));
      return;
    }
    if (url.pathname === '/api/rotary') {
      const file = opts.rotaryFile;
      if (!file) { res.writeHead(404).end(); return; }
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
      if (req.method === 'GET') { json(200, readRotary(file)); return; }
      if (req.method === 'PUT') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) { json(403, { error: 'Forbidden' }); return; }
        if (access && access.roleOf(req) !== 'operator') { json(401, { error: 'Sign in first' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size <= ROTARY_MAX_BYTES) chunks.push(c); });
        req.on('end', () => {
          if (size > ROTARY_MAX_BYTES) { json(413, { error: 'Too big' }); return; }
          try { json(200, writeRotary(file, Buffer.concat(chunks).toString('utf8'))); } catch (e) { json(400, { error: (e as Error).message }); }
        });
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/api/positions') {
      const file = opts.positionsFile;
      if (!file) { res.writeHead(404).end(); return; }
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
      if (req.method === 'GET') { json(200, readPositions(file)); return; }
      if (req.method === 'PUT') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) { json(403, { error: 'Forbidden' }); return; }
        if (access && access.roleOf(req) !== 'operator') { json(401, { error: 'Sign in first' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size <= POSITIONS_MAX_BYTES) chunks.push(c); });
        req.on('end', () => {
          if (size > POSITIONS_MAX_BYTES) { json(413, { error: 'The list is too big' }); return; }
          try { json(200, writePositions(file, Buffer.concat(chunks).toString('utf8'))); } catch (e) { json(400, { error: (e as Error).message }); }
        });
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/api/library') {
      const file = opts.libraryFile;
      if (!file) { res.writeHead(404).end(); return; }
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); };
      if (req.method === 'GET') { json(200, readLibraries(file)); return; }
      if (req.method === 'PUT') {
        // only a page served by this server, and only someone who may control the machine, may change the file
        if (!sameOrigin(req.headers.origin, req.headers.host)) { json(403, { error: 'Forbidden' }); return; }
        if (access && access.roleOf(req) !== 'operator') { json(401, { error: 'Sign in first' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size <= LIBRARY_MAX_BYTES) chunks.push(c); });
        req.on('end', () => {
          if (size > LIBRARY_MAX_BYTES) { json(413, { error: 'The library is too big' }); return; }
          try { json(200, writeLibraries(file, Buffer.concat(chunks).toString('utf8'))); } catch (e) { json(400, { error: (e as Error).message }); }
        });
        return;
      }
      res.writeHead(405).end();
      return;
    }
    let file = path.join(webRoot, decodeURIComponent(url.pathname));
    if (!file.startsWith(webRoot)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('The app is not built yet: run `npm run build` in the design folder.'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  };
  const server = (opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler)) as http.Server;

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 32 * 1024 * 1024,
    verifyClient: ({ req }: { req: http.IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) =>
      done((opts.access ? opts.access.admits(req) : isLocalRequest(req.socket.remoteAddress, req.headers) && hostAllowed(req.headers.host)) && sameOrigin(req.headers.origin, req.headers.host), 403, 'Forbidden'),
  });

  const send = (ws: WebSocket, m: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const broadcast = (m: ServerMessage) => wss.clients.forEach((c) => send(c as WebSocket, m));
  session.on('state', (s) => broadcast({ type: 'state', data: s }));
  session.on('log', (l) => broadcast({ type: 'log', data: l }));

  const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

  // a PIN was set, changed or removed, or someone signed out: reconnect everybody so each browser learns its new role
  opts.access?.auth.on('changed', () => wss.clients.forEach((c) => c.close(4001, 'Access changed')));

  /** What a browser that may not control is allowed to ask for: to look, never to move or fire */
  const VIEWER_MESSAGES = new Set<ClientMessage['type']>(['listPorts']);

  wss.on('connection', (ws, req) => {
    const access = opts.access;
    send(ws, { type: 'role', data: access ? { mode: access.auth.mode, operator: access.roleOf(req) === 'operator', peer: access.peerOf(req) } : { mode: 'setup', operator: true, peer: 'local' } });
    send(ws, { type: 'state', data: session.state() });
    send(ws, { type: 'logs', data: session.recentLog(100) });
    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      // checked on every message, so a session that expired or was signed out stops working at once
      if (access && !VIEWER_MESSAGES.has(msg.type) && access.roleOf(req) !== 'operator') {
        return send(ws, { type: 'denied', data: { message: access.auth.mode === 'pin' ? 'Sign in with the PIN to control the laser (Settings, Access)' : 'Set a PIN on the computer that runs DemonX Design, then sign in here, to control the laser' } });
      }
      const reply = (r: { ok: boolean; message: string; code?: string }) => send(ws, { type: 'notice', data: r });
      try {
        switch (msg.type) {
          case 'listPorts': return send(ws, { type: 'ports', data: await session.ports() });
          case 'connect': return reply(await session.connect(String(msg.target)));
          case 'disconnect': return reply(await session.disconnect());
          case 'checkLaser': await session.checkLaser(); return;
          case 'enableLaserMode': return reply(await session.enableLaserMode());
          case 'jog': return reply(await session.jog(num(msg.dx), num(msg.dy), num(msg.feed)));
          case 'autoFocus': return reply(await session.autoFocus());
          case 'jogZ': return reply(await session.jogZ(num(msg.dz), num(msg.feed)));
          case 'moveTo': return reply(await session.moveTo(num(msg.x), num(msg.y), num(msg.feed)));
          case 'setOrigin': return reply(await session.setOrigin());
          case 'goOrigin': return reply(await session.goOrigin(num(msg.feed)));
          case 'home': return reply(await session.home());
          case 'unlock': return reply(await session.unlock());
          case 'reset': return reply(await session.reset());
          case 'loadJob':
            if (typeof msg.name !== 'string' || typeof msg.content !== 'string') return;
            return reply(await session.loadJob(msg.name, msg.content));
          case 'frame': {
            if (typeof msg.content === 'string') { const r = await session.loadJob(typeof msg.name === 'string' ? msg.name : 'laser-job', msg.content); if (!r.ok) return reply(r); }
            const o = msg.origin as { x?: unknown; y?: unknown } | undefined;
            if (o !== undefined && !(typeof o === 'object' && o !== null && Number.isFinite(o.x) && Number.isFinite(o.y) && (o.x as number) >= 0 && (o.y as number) >= 0 && (o.x as number) <= 100000 && (o.y as number) <= 100000)) return reply({ ok: false, message: 'The start point must be two numbers' });
            return reply(await session.frame(num(msg.feed), msg.shape === 'circle' ? 'circle' : 'box', o ? { x: o.x as number, y: o.y as number } : undefined));
          }
          case 'start': {
            if (typeof msg.content === 'string') { const r = await session.loadJob(typeof msg.name === 'string' ? msg.name : 'laser-job', msg.content); if (!r.ok) return reply(r); }
            return reply(await session.start(String(msg.hash), msg.acknowledgeUnverified === true));
          }
          case 'pause': return reply(await session.pause());
          case 'resume': return reply(await session.resume());
          case 'stop': return reply(await session.stop());
          case 'ruidaAdd':
          case 'ruidaRemove': {
            if (typeof msg.name !== 'string' || (msg.type === 'ruidaAdd' && typeof msg.host !== 'string')) return;
            const r = msg.type === 'ruidaAdd' ? session.addController?.(msg.name, msg.host) : session.removeController?.(msg.name);
            reply(r ?? { ok: false, message: 'Not available' });
            return send(ws, { type: 'ports', data: await session.ports() });
          }
        }
      } catch (e) {
        reply({ ok: false, message: 'Something went wrong: ' + (e as Error).message });
      }
    });
  });
  return { server, wss };
}
