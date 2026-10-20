import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseLasers } from '../src/core/lasers';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer } from '../server/src/app';

const good = { v: 1, lasers: [{ name: 'Pronto 45', width: 1000, height: 600, sMax: 1000, rapid: 300, origin: 'tl' }, { name: 'Diode', width: 400, height: 400, sMax: 1000, rapid: 100 }] };

describe('laser list', () => {
  it('reads a good list and refuses damaged ones', () => {
    expect(parseLasers(good).lasers).toHaveLength(2);
    expect(parseLasers(good).lasers[0].origin).toBe('tl');
    const bad = (f: (o: any) => void) => { const o = JSON.parse(JSON.stringify(good)); f(o); return () => parseLasers(o); };
    expect(bad((o) => { o.lasers[0].width = -5; })).toThrow(/width/);
    expect(bad((o) => { o.lasers[1].name = o.lasers[0].name; })).toThrow(/Two lasers/);
    expect(bad((o) => { o.lasers[0].name = ''; })).toThrow(/name/);
    expect(bad((o) => { o.lasers[0].origin = 'middle'; })).not.toThrow(); // an unknown origin is simply not kept
    expect(parseLasers({ ...good, lasers: [{ ...good.lasers[0], origin: 'middle' }] }).lasers[0].origin).toBeUndefined();
    expect(() => parseLasers({ v: 2 })).toThrow();
  });
});

describe('laser list on the server', () => {
  let dir: string, session: LaserSession, server: http.Server, port: number;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lasers-'));
    session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
    server = createLaserServer(session, dir, { lasersFile: path.join(dir, 'data', 'lasers.json') }).server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => { await session.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/lasers', method, headers }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject); req.end(body);
  });
  it('starts empty, keeps what it is given, and refuses a damaged list or another site', async () => {
    expect((await call('GET')).body).toEqual({ v: 1, lasers: [] });
    expect((await call('PUT', JSON.stringify(good))).status).toBe(200);
    expect((await call('GET')).body.lasers.map((l: any) => l.name)).toEqual(['Pronto 45', 'Diode']);
    expect((await call('PUT', '{"v":1,"lasers":[{"name":"x"}]}')).status).toBe(400);
    expect((await call('PUT', JSON.stringify(good), { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('GET')).body.lasers).toHaveLength(2);
  });
});
