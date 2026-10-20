import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parsePositions } from '../src/core/positions';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer } from '../server/src/app';

const good = { v: 1, sets: { 'Pronto 45': [{ name: 'Park', x: 0, y: 0 }, { name: 'Jig corner', x: 120.5, y: 80.25 }] } };

describe('saved positions', () => {
  it('reads a good list and refuses damaged ones', () => {
    expect(parsePositions(good).sets['Pronto 45']).toHaveLength(2);
    const bad = (f: (o: any) => void) => { const o = JSON.parse(JSON.stringify(good)); f(o); return () => parsePositions(o); };
    expect(bad((o) => { o.sets['Pronto 45'][0].x = -1; })).toThrow(/0 to 100000/);
    expect(bad((o) => { o.sets['Pronto 45'][0].y = 'far'; })).toThrow(/0 to 100000/);
    expect(bad((o) => { o.sets['Pronto 45'][1].name = 'Park'; })).toThrow(/Two positions/);
    expect(bad((o) => { o.sets['Pronto 45'][0].name = ''; })).toThrow(/name/);
    expect(bad((o) => { o.sets['Pronto 45'] = Array.from({ length: 51 }, (_, i) => ({ name: 'p' + i, x: 1, y: 1 })); })).toThrow(/too many/);
    expect(() => parsePositions({ v: 2 })).toThrow();
  });
});

describe('saved positions on the server', () => {
  let dir: string, session: LaserSession, server: http.Server, port: number;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-positions-'));
    session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
    server = createLaserServer(session, dir, { positionsFile: path.join(dir, 'data', 'positions.json') }).server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => { await session.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/positions', method, headers }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject); req.end(body);
  });
  it('starts empty, keeps what it is given, and refuses a damaged list or another site', async () => {
    expect((await call('GET')).body).toEqual({ v: 1, sets: {} });
    expect((await call('PUT', JSON.stringify(good))).status).toBe(200);
    expect((await call('GET')).body.sets['Pronto 45'].map((p: any) => p.name)).toEqual(['Park', 'Jig corner']);
    expect((await call('PUT', '{"v":1,"sets":{"a":[{"name":"x","x":-5,"y":1}]}}')).status).toBe(400);
    expect((await call('PUT', JSON.stringify(good), { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('GET')).body.sets['Pronto 45']).toHaveLength(2);
  });
});
