import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CameraStore, validEntity, validHaUrl } from '../server/src/camera';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer } from '../server/src/app';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe('camera settings', () => {
  it('knows a Home Assistant camera name, and only sends the token to the home network', () => {
    expect(validEntity('camera.test_mainstream')).toBe(true);
    for (const bad of ['pronto', 'camera.', 'light.x', 'camera.A b', '']) expect(validEntity(bad), bad).toBe(false);
    expect(validHaUrl('http://192.168.1.10:8123/')).toBe('http://192.168.1.10:8123');
    expect(validHaUrl('http://homeassistant.local:8123')).toBe('http://homeassistant.local:8123');
    for (const bad of ['http://evil.example.com', 'https://8.8.8.8', 'ftp://192.168.1.2', 'http://user:pw@192.168.1.2', 'nope', 42]) expect(validHaUrl(bad), String(bad)).toBeNull();
  });
});

describe('camera on the server', () => {
  let ha: http.Server, haPort: number, dir: string, hits: number, server: http.Server, session: LaserSession, port: number, store: CameraStore;
  beforeEach(async () => {
    hits = 0;
    ha = http.createServer((req, res) => {
      hits++;
      if (req.headers.authorization !== 'Bearer secret-token') { res.writeHead(401).end(); return; }
      if (req.url === '/api/camera_proxy/camera.shop') res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => ha.listen(0, '127.0.0.1', r));
    haPort = (ha.address() as AddressInfo).port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-cam-'));
    fs.mkdirSync(path.join(dir, 'cnc'));
  });
  afterEach(async () => { await new Promise((r) => ha.close(r)); if (session) { await session.close(); await new Promise((r) => server.close(r)); } fs.rmSync(dir, { recursive: true, force: true }); session = undefined as never; });

  async function serve(cncDir?: string) {
    store = new CameraStore(path.join(dir, 'camera.json'), cncDir);
    session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
    server = createLaserServer(session, dir, { camera: store }).server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  }
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: Buffer; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const parts: Buffer[] = []; res.on('data', (c) => parts.push(c)); res.on('end', () => { const b = Buffer.concat(parts); resolve({ status: res.statusCode ?? 0, body: b, text: b.toString() }); });
    });
    req.on('error', reject); req.end(data);
  });

  it('uses the Home Assistant setup of DemonX CNC, and the token never reaches the browser', async () => {
    fs.writeFileSync(path.join(dir, 'cnc', 'config.json'), JSON.stringify({ homeAssistant: { url: `http://127.0.0.1:${haPort}`, token: 'secret-token', insecureTls: false }, camera: { haEntity: 'camera.shop' } }));
    await serve(path.join(dir, 'cnc'));
    const st = await call('GET', '/api/camera/status');
    expect(JSON.parse(st.text)).toMatchObject({ configured: true, entity: 'camera.shop', from: 'cnc', hasToken: true });
    expect(st.text).not.toContain('secret-token');
    const pic = await call('GET', '/api/camera.jpg');
    expect(pic.status).toBe(200);
    expect(pic.body.equals(JPEG)).toBe(true);
    // two requests within a second share one picture
    await call('GET', '/api/camera.jpg');
    expect(hits).toBe(1);
  });

  it('has its own settings when there is no DemonX CNC, checked before they are kept', async () => {
    await serve();
    expect((await call('GET', '/api/camera.jpg')).status).toBe(503);
    expect((await call('PUT', '/api/camera/config', { entity: 'bad' }, { origin: `http://127.0.0.1:${port}` })).status).toBe(400);
    expect((await call('PUT', '/api/camera/config', { entity: 'camera.shop', url: 'http://evil.example.com', token: 'x' }, { origin: `http://127.0.0.1:${port}` })).status).toBe(400);
    expect((await call('PUT', '/api/camera/config', { entity: 'camera.shop', url: `http://127.0.0.1:${haPort}`, token: 'secret-token' }, { origin: 'http://evil.example' })).status).toBe(403);
    const ok = await call('PUT', '/api/camera/config', { entity: 'camera.shop', url: `http://127.0.0.1:${haPort}`, token: 'secret-token' }, { origin: `http://127.0.0.1:${port}` });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain('secret-token');
    expect(JSON.parse(ok.text)).toMatchObject({ configured: true, from: 'own' });
    expect((await call('GET', '/api/camera.jpg')).body.equals(JPEG)).toBe(true);
    if (process.platform !== 'win32') expect((fs.statSync(path.join(dir, 'camera.json')).mode & 0o077)).toBe(0); // the file is private (Windows has no such file modes)
  });

  it('says why when Home Assistant refuses', async () => {
    await serve();
    await call('PUT', '/api/camera/config', { entity: 'camera.shop', url: `http://127.0.0.1:${haPort}`, token: 'wrong' }, { origin: `http://127.0.0.1:${port}` });
    const r = await call('GET', '/api/camera.jpg');
    expect(r.status).toBe(503);
    expect(r.text).toMatch(/refused the access token/);
  });
});
