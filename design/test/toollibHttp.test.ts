import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer } from '../server/src/app';

let dir: string, session: LaserSession, server: http.Server, port: number;
const lib = { v: 1, tools: [{ id: 'T1', name: 'Test cutter', kind: 'flat', diameter: 6, recipes: [{ machine: 'M', material: 'MDF', status: 'Approved', rpm: 18000, feed: 1000, plunge: 300 }] }] };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-toollib-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<title>Design</title>');
  session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
  server = createLaserServer(session, dir, { toolLibFile: path.join(dir, 'data', 'tool-library.json') }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await session.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/toollib', method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
  });
  req.on('error', reject);
  if (body !== undefined) req.write(body);
  req.end();
});

describe('/api/toollib', () => {
  it('starts empty, keeps what is saved, and refuses a bad file without touching the old one', async () => {
    expect((await call('GET')).body).toEqual({ v: 1, tools: [] });
    const put = await call('PUT', JSON.stringify(lib), { origin: `http://127.0.0.1:${port}` });
    expect(put.status).toBe(200);
    expect((await call('GET')).body.tools[0]).toMatchObject({ id: 'T1', recipes: [{ material: 'MDF' }] });
    const bad = await call('PUT', JSON.stringify({ v: 1, tools: [{ id: 'T2', name: 'x', kind: 'saw', recipes: [] }] }), { origin: `http://127.0.0.1:${port}` });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/kind must be/);
    expect((await call('GET')).body.tools).toHaveLength(1);
    expect((await call('PUT', 'not json', { origin: `http://127.0.0.1:${port}` })).status).toBe(400);
  });
  it('only accepts a save from its own page', async () => {
    expect((await call('PUT', JSON.stringify(lib), { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('GET')).body.tools).toEqual([]);
  });
  it('refuses a library that is too big', async () => {
    const big = JSON.stringify({ v: 1, tools: [], pad: 'x'.repeat(2 * 1024 * 1024 + 10) });
    expect((await call('PUT', big, { origin: `http://127.0.0.1:${port}` })).status).toBe(413);
  });
});
