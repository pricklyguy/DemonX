import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer, hostAllowed } from '../server/src/app';
import type { ServerMessage } from '../server/src/protocol';

let dir: string;
let session: LaserSession;
let server: http.Server;
let port: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<title>Design</title>');
  fs.writeFileSync(path.join(path.dirname(dir), 'design-secret.txt'), 'secret');
  session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
  server = createLaserServer(session, dir).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await session.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(dir), 'design-secret.txt'), { force: true });
});

/** Opens a WebSocket and resolves with it, or rejects with the HTTP status when the server refuses */
function open(headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    // listen from the very start: the server sends its state the moment the socket opens
    const got: ServerMessage[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    (ws as unknown as { got: ServerMessage[] }).got = got;
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    ws.on('error', (e) => reject(e));
  });
}
const get = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  }).on('error', reject);
});
const inbox = (ws: WebSocket) => (ws as unknown as { got: ServerMessage[] }).got;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(f: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v !== undefined) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(15); }
}

describe('who may reach the laser server', () => {
  it('accepts this computer by its own name, with or without an Origin that matches', async () => {
    (await open()).close();
    (await open({ Origin: `http://127.0.0.1:${port}` })).close();
  });

  it('refuses a web page from another site (cross-site WebSocket)', async () => {
    await expect(open({ Origin: 'http://evil.example' })).rejects.toThrow(/403/);
    await expect(open({ Origin: `http://localhost:${port + 1}` })).rejects.toThrow(/403/);
    await expect(open({ Origin: 'null' })).rejects.toThrow(/403/);
  });

  it('refuses a name pointed at this computer later (DNS rebinding): the Host is not this computer', async () => {
    await expect(open({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).rejects.toThrow(/403/);
    expect((await get('/', { Host: `evil.example:${port}` })).status).toBe(403);
    expect(hostAllowed('localhost:8090')).toBe(true);
    expect(hostAllowed('127.0.0.1')).toBe(true);
    expect(hostAllowed('[::1]:8090')).toBe(true);
    expect(hostAllowed('192.168.1.20:8090')).toBe(false);
    expect(hostAllowed('localhost.evil.example')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it('refuses anything that came through a proxy or tunnel', async () => {
    await expect(open({ 'X-Forwarded-For': '203.0.113.9' })).rejects.toThrow(/403/);
    expect((await get('/', { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
  });

  it('serves the app, and nothing outside its folder', async () => {
    const home = await get('/');
    expect(home.status).toBe(200);
    expect(home.body).toContain('<title>Design</title>');
    const escape = await get('/%2e%2e%2fdesign-secret.txt');
    expect(escape.body).not.toContain('secret');
  });
});

describe('talking to the laser through the WebSocket', () => {
  it('sends the state first, lists the simulator, connects, and refuses unsafe requests', async () => {
    const ws = await open();
    const got = inbox(ws);
    const first = await waitFor(() => got.find((m) => m.type === 'state'));
    expect(first.type === 'state' && first.data.connection.connected).toBe(false);

    ws.send(JSON.stringify({ type: 'listPorts' }));
    const ports = await waitFor(() => got.find((m) => m.type === 'ports'));
    expect(ports.type === 'ports' && ports.data[0].path).toBe('simulator');

    ws.send(JSON.stringify({ type: 'jog', dx: 5, dy: 0, feed: 1000 }));
    expect((await waitFor(() => got.find((m) => m.type === 'notice'))).data).toMatchObject({ ok: false, message: 'Not connected' });

    ws.send(JSON.stringify({ type: 'connect', target: '/etc/passwd' }));
    await waitFor(() => got.filter((m) => m.type === 'notice').length >= 2 || undefined);
    expect(got.filter((m) => m.type === 'notice')[1].data).toMatchObject({ ok: false });

    ws.send(JSON.stringify({ type: 'connect', target: 'simulator' }));
    await waitFor(() => got.find((m) => m.type === 'state' && m.data.connection.connected));
    await waitFor(() => got.find((m) => m.type === 'state' && m.data.status.state === 'Idle'));

    // a job with M3 never reaches the machine, whatever the browser sends
    ws.send(JSON.stringify({ type: 'loadJob', name: 'bad', content: 'M3 S1000\nG1 X5 F300\nM5' }));
    const refused = await waitFor(() => got.filter((m) => m.type === 'notice').find((m) => m.data.code === 'invalid-job'));
    expect(refused.data.message).toMatch(/M3 is not allowed/);
    expect(session.loaded).toBeNull();

    ws.send(JSON.stringify({ type: 'jog', dx: 500, dy: 0, feed: 1000 }));
    await waitFor(() => got.filter((m) => m.type === 'notice').find((m) => /at most 100 mm/.test(m.data.message)));
    ws.close();
  });

  it('ignores junk and keeps working', async () => {
    const ws = await open();
    const got = inbox(ws);
    ws.send('not json');
    ws.send(JSON.stringify({ nothing: true }));
    ws.send(JSON.stringify({ type: 'jog', dx: 'a', dy: null, feed: {} }));
    ws.send(JSON.stringify({ type: 'listPorts' }));
    await waitFor(() => got.find((m) => m.type === 'ports'));
    ws.close();
  });
});
