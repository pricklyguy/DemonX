import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { circumference, DEFAULT_ROTARY, mmPerStep, parseRotary } from '../src/core/rotary';
import { rotaryOn, writeRotary } from '../server/src/rotary';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer } from '../server/src/app';
import { RuidaSession, RUIDA_SIMULATOR } from '../server/src/ruida/session';
import { serializePlan } from '../server/src/ruida/plan';
import { fingerprint } from '../src/core/hash';

const good = { v: 1, sets: { 'ruida-sim': { enabled: true, type: 'chuck', steps: 10000, objectDiameter: 80, rollerDiameter: 50 } } };

describe('rotary settings', () => {
  it('works out the circumference and the surface per step', () => {
    const r = { ...DEFAULT_ROTARY, objectDiameter: 100 };
    expect(circumference(r)).toBeCloseTo(314.159, 3);
    expect(mmPerStep(r)).toBeCloseTo(0.0314159, 6);
    expect(mmPerStep({ ...r, type: 'roller', rollerDiameter: 50 })).toBeCloseTo((Math.PI * 50) / 10000, 6);
  });
  it('reads good settings and refuses damaged ones', () => {
    expect(parseRotary(good).sets['ruida-sim'].objectDiameter).toBe(80);
    const bad = (f: (o: any) => void) => { const o = JSON.parse(JSON.stringify(good)); f(o); return () => parseRotary(o); };
    expect(bad((o) => { o.sets['ruida-sim'].type = 'belt'; })).toThrow(/chuck or roller/);
    expect(bad((o) => { o.sets['ruida-sim'].steps = 0; })).toThrow(/steps/);
    expect(bad((o) => { o.sets['ruida-sim'].objectDiameter = -3; })).toThrow(/diameter/);
    expect(() => parseRotary({ v: 2 })).toThrow();
  });
});

describe('rotary on the server', () => {
  let dir: string, session: LaserSession, server: http.Server, port: number;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-rotary-'));
    session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
    server = createLaserServer(session, dir, { rotaryFile: path.join(dir, 'data', 'rotary.json') }).server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => { await session.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/rotary', method, headers }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject); req.end(body);
  });
  it('starts empty, keeps what it is given, and refuses damage or another site', async () => {
    expect((await call('GET')).body).toEqual({ v: 1, sets: {} });
    expect((await call('PUT', JSON.stringify(good))).status).toBe(200);
    expect((await call('GET')).body.sets['ruida-sim'].enabled).toBe(true);
    expect((await call('PUT', '{"v":1,"sets":{"a":{"type":"x"}}}')).status).toBe(400);
    expect((await call('PUT', JSON.stringify(good), { origin: 'http://evil.example' })).status).toBe(403);
  });
  it('says whether rotary is on for a laser', () => {
    const f = path.join(dir, 'r.json');
    expect(rotaryOn(f, 'ruida-sim')).toBe(false);
    writeRotary(f, JSON.stringify(good));
    expect(rotaryOn(f, 'ruida-sim')).toBe(true);
    expect(rotaryOn(f, 'other')).toBe(false);
  });
});

describe('a Ruida session with rotary on', () => {
  it('refuses Frame and Start while rotary is switched on, and works again when it is off', async () => {
    let on = true;
    const s = new RuidaSession({ config: { enabled: true, controllers: {}, bedW: 1000, bedH: 600, maxPower: 100, maxSpeed: 600, pause: false }, simSpeed: 20, pollMs: 25, replyMs: 400, rotaryOn: () => on });
    try {
      expect((await s.connect(RUIDA_SIMULATOR)).ok).toBe(true);
      const text = serializePlan({ layers: [{ colorRaw: 0xe000, mode: 'line', speed: 40, minPower: 10, maxPower: 10, air: false, points: [{ x: 0, y: 0, burn: false }, { x: 10, y: 0, burn: true }] }] });
      expect(s.loadJob('t', text).ok).toBe(true);
      const f = await s.frame(3000);
      expect(f.ok).toBe(false); expect(f.code).toBe('rotary-unverified');
      const st = await s.start(fingerprint(text));
      expect(st.ok).toBe(false); expect(st.code).toBe('rotary-unverified');
      on = false;
      const f2 = await s.frame(3000);
      expect(f2.ok, f2.message).toBe(true);
    } finally { await s.close(); }
  });
});
