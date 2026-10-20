import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer } from '../server/src/app';
import { hostOk, makeAccess } from '../server/src/access';
import { AuthStore } from '../../server/src/auth';
import type { ServerMessage } from '../server/src/protocol';

let dir: string, session: LaserSession, server: http.Server, port: number, auth: AuthStore;

async function start(trustLocal: boolean, pin = '2468') {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-access-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<title>Design</title>');
  auth = new AuthStore(path.join(dir, 'auth'));
  if (pin) auth.setPin(pin);
  session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
  server = createLaserServer(session, dir, { libraryFile: path.join(dir, 'lib.json'), access: makeAccess(auth, trustLocal) }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}
afterEach(async () => { if (!session) return; await session.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); (session as unknown) = undefined; });

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any; cookie?: string }>((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { let b: any = t; try { b = JSON.parse(t); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body: b, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] || undefined }); });
  });
  req.on('error', reject); req.end(data);
});
const here = () => ({ origin: `http://127.0.0.1:${port}` });

function ws(cookie?: string): Promise<{ sock: WebSocket; got: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } });
    const got: ServerMessage[] = [];
    sock.on('message', (d) => got.push(JSON.parse(String(d))));
    sock.on('open', () => resolve({ sock, got }));
    sock.on('unexpected-response', (_q, res) => reject(new Error(String(res.statusCode))));
    sock.on('error', reject);
  });
}
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

describe('which names reach the server', () => {
  it('accepts this computer and the home network, never a name from the internet', () => {
    for (const h of ['localhost:8090', '127.0.0.1:8090', '[::1]:8090', '192.168.1.20:8090', '10.0.0.5', '172.16.4.2:8090', 'shop-pc:8090', 'shop-pc.local:8090', 'laser.lan']) expect(hostOk(h), h).toBe(true);
    for (const h of ['evil.example.com', '8.8.8.8:8090', '172.32.0.1', 'rebind.attacker.net:8090', undefined, '']) expect(hostOk(h as string | undefined), String(h)).toBe(false);
  });
});

describe('a browser that has not signed in (another computer on the network)', () => {
  beforeEach(() => start(false));
  it('can look and list ports, but every control message is refused on the server', async () => {
    const a = await ws();
    await until(() => a.got.some((m) => m.type === 'role'));
    expect(a.got.find((m) => m.type === 'role')).toMatchObject({ data: { mode: 'pin', operator: false, peer: 'lan' } });
    expect(a.got.some((m) => m.type === 'state')).toBe(true);
    a.sock.send(JSON.stringify({ type: 'listPorts' }));
    await until(() => a.got.some((m) => m.type === 'ports'));
    for (const msg of [{ type: 'connect', target: 'simulator' }, { type: 'jog', dx: 1, dy: 0, feed: 1000 }, { type: 'stop' }, { type: 'start', hash: 'x' }, { type: 'ruidaAdd', name: 'x', host: '192.168.1.9' }]) a.sock.send(JSON.stringify(msg));
    await until(() => a.got.filter((m) => m.type === 'denied').length === 5);
    expect(session.state().connection.connected).toBe(false);
    a.sock.close();
  });
  it('cannot change the material library', async () => {
    expect((await call('GET', '/api/library')).status).toBe(200);
    expect((await call('PUT', '/api/library', { v: 1, libraries: [] }, here())).status).toBe(401);
  });
  it('signs in with the PIN, and then controls the laser; a wrong PIN does not, and tries are limited', async () => {
    const bad = await call('POST', '/api/auth/login', { pin: '0000' }, here());
    expect(bad.status).toBe(400);
    const good = await call('POST', '/api/auth/login', { pin: '2468', remember: true }, here());
    expect(good.status).toBe(200);
    expect(good.cookie).toMatch(/^demonx_session=/);
    const a = await ws(good.cookie);
    await until(() => a.got.some((m) => m.type === 'role'));
    expect(a.got.find((m) => m.type === 'role')).toMatchObject({ data: { operator: true } });
    a.sock.send(JSON.stringify({ type: 'connect', target: 'simulator' }));
    await until(() => session.state().connection.connected);
    expect((await call('PUT', '/api/library', { v: 1, libraries: [] }, { ...here(), cookie: good.cookie! })).status).toBe(200);
    a.sock.close();
    for (let i = 0; i < 6; i++) await call('POST', '/api/auth/login', { pin: 'nope' }, here());
    expect((await call('POST', '/api/auth/login', { pin: '2468' }, here())).status).toBe(429);
  });
  it('is signed out at once when the PIN is changed', async () => {
    const good = await call('POST', '/api/auth/login', { pin: '2468' }, here());
    const a = await ws(good.cookie);
    await until(() => a.got.some((m) => m.type === 'role'));
    const closed = new Promise<number>((r) => a.sock.on('close', (c) => r(c)));
    expect((await call('POST', '/api/auth/set-pin', { pin: '1357' }, { ...here(), cookie: good.cookie! })).status).toBe(200);
    expect(await closed).toBe(4001);
    const again = await ws(good.cookie);
    await until(() => again.got.some((m) => m.type === 'role'));
    expect(again.got.find((m) => m.type === 'role')).toMatchObject({ data: { operator: false } });
    again.sock.close();
  });
  it('another site cannot sign in or change the PIN for you', async () => {
    expect((await call('POST', '/api/auth/login', { pin: '2468' }, { origin: 'http://evil.example' })).status).toBe(403);
  });
});

describe('who is let in at all', () => {
  beforeEach(() => start(false));
  it('refuses a request that came through a proxy or tunnel, and a name from the internet', async () => {
    expect((await call('GET', '/', undefined, { 'x-forwarded-for': '203.0.113.5' })).status).toBe(403);
    expect((await call('GET', '/', undefined, { host: 'evil.example.com' })).status).toBe(403);
    expect((await call('GET', '/')).status).toBe(200);
  });
});

describe('the computer that runs the server', () => {
  beforeEach(() => start(true, ''));
  it('controls the laser without a PIN, and can set the first one', async () => {
    const a = await ws();
    await until(() => a.got.some((m) => m.type === 'role'));
    expect(a.got.find((m) => m.type === 'role')).toMatchObject({ data: { mode: 'setup', operator: true, peer: 'local' } });
    a.sock.send(JSON.stringify({ type: 'connect', target: 'simulator' }));
    await until(() => session.state().connection.connected);
    expect((await call('POST', '/api/auth/set-pin', { pin: '9753' }, here())).status).toBe(200);
    a.sock.close();
  });
});
