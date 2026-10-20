import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { emptyDoc as baseDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildLaserJob } from '../src/core/laser';
import { fingerprint } from '../src/core/hash';
import { LaserSession } from '../server/src/laserSession';
import { busyOf, createLaserServer } from '../server/src/app';
import type { Access } from '../server/src/access';
import type { LaserState } from '../server/src/protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(15); }
}
function bigEngrave(): string {
  const d0 = baseDoc();
  let d = { ...d0, layers: [...d0.layers, { ...d0.layers[0], name: 'Engrave', mode: 'engrave' as const, speed: 100, power: 20, color: '#2bb5c9' }] };
  d = execute(d, 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Engrave' }).doc;
  d = execute(d, 'layer_set', { name: 'Engrave', interval: 0.5, speed: 50, overscan: 0 }).doc;
  return buildLaserJob(d).gcode;
}

const state = (over: { job?: string; status?: string } = {}): LaserState => ({
  connection: { connected: true, target: 'x' },
  status: { state: over.status ?? 'Idle' },
  job: { state: over.job ?? 'none' },
} as unknown as LaserState);

describe('busyOf: when must the laser not be interrupted', () => {
  it('is busy while a job runs or is paused, or the head is moving, jogging, homing or held', () => {
    expect(busyOf(state({ job: 'running' }))).toEqual({ busy: true, reason: 'a laser job is running' });
    expect(busyOf(state({ job: 'paused' })).busy).toBe(true);
    for (const s of ['Run', 'Jog', 'Hold', 'Home']) expect(busyOf(state({ status: s })).busy, s).toBe(true);
    expect(busyOf(state({ status: 'Run' })).reason).toMatch(/head is moving/);
  });
  it('is not busy when idle, disconnected, in alarm, or a job has finished or is only loaded', () => {
    expect(busyOf(state())).toEqual({ busy: false, reason: '' });
    for (const s of ['Disconnected', 'Alarm', 'Door', 'Check', 'Sleep']) expect(busyOf(state({ status: s })).busy, s).toBe(false);
    for (const j of ['none', 'loaded', 'done', 'error']) expect(busyOf(state({ job: j })).busy, j).toBe(false);
  });
});

describe('GET /api/busy', () => {
  let dir: string, session: LaserSession, server: http.Server, port: number;
  const start = async (access?: Access) => {
    server = createLaserServer(session, dir, access ? { access } : {}).server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-busy-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<title>Design</title>');
    session = new LaserSession({ simSpeed: 3, listPorts: async () => [] });
  });
  afterEach(async () => { await session.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, p = '/api/busy', headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t.startsWith('{') ? JSON.parse(t) : t }));
    });
    req.on('error', reject); req.end();
  });

  it('says not busy when nothing is happening', async () => {
    await start();
    const r = await call('GET');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ busy: false, reason: '' });
  });

  it('says busy while a job runs, with the reason, and not busy again after Stop', async () => {
    await start();
    await session.connect('simulator');
    await until(() => session.controller.status.state === 'Idle', 3000, 'idle');
    await session.enableLaserMode();
    await until(() => session.controller.status.state === 'Idle', 3000, 'idle after the settings write');
    const gcode = bigEngrave();
    expect(session.loadJob('engrave', gcode).ok).toBe(true);
    expect((await call('GET')).body.busy).toBe(false); // loaded, not started
    expect((await session.start(fingerprint(gcode))).ok).toBe(true);
    await until(() => session.controller.job.state === 'running', 6000, 'running');
    const r = await call('GET');
    expect(r.body.busy).toBe(true);
    expect(r.body.reason).toMatch(/running|moving/);
    expect((await session.stop()).ok).toBe(true);
    await until(() => session.controller.status.state === 'Idle', 4000, 'idle after stop');
    expect((await call('GET')).body).toEqual({ busy: false, reason: '' });
  });

  it('is read-only: other methods are refused', async () => {
    await start();
    for (const m of ['POST', 'PUT', 'DELETE']) expect((await call(m)).status, m).toBe(405);
  });

  it('answers only this computer, even when the PIN or the home network would let a visitor in', async () => {
    // an access policy that admits everybody (as a signed-in home-network browser would be)
    const open = { admits: () => true, handleAuth: () => false, roleOf: () => 'operator', peerOf: () => 'lan', auth: { mode: 'pin', on: () => undefined } } as unknown as Access;
    await start(open);
    expect((await call('GET', '/')).status).toBe(200); // the page itself is let in
    expect((await call('GET', '/api/busy')).status).toBe(200); // a direct local request
    const viaProxy = await call('GET', '/api/busy', { 'x-forwarded-for': '192.168.1.50' }); // came through a proxy: not this computer
    expect(viaProxy.status).toBe(403);
    expect(viaProxy.body).toEqual({ error: 'Forbidden' });
  });
});
