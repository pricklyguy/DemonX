import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';
import { Aedes } from 'aedes';
import { MqttBridge, buildState, discovery, slugOf, testBroker, ENTITIES, COMMANDS, baseTopic, type Snapshot } from '../src/mqtt.js';
import { emptyJob, emptyProbe, emptyStatus } from '../../shared/protocol.js';
import { applyUpdate, defaultConfig, publicView, ConfigError } from '../src/config.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  status: { ...emptyStatus(), state: 'Run', wpos: { x: 1.23456, y: 2, z: -0.5 }, feed: 300, spindle: 12000 },
  job: { ...emptyJob(), state: 'running', name: 'board.nc', totalLines: 200, doneLines: 50, sentLines: 60, startedAt: 1_000_000 },
  connection: { connected: true, target: '/dev/ttyUSB0', firmware: 'Grbl 1.1h' }, probe: emptyProbe(), jobBytes: 4096, pcb: true, heightmap: true, now: 1_100_000, ...over,
});

describe('buildState', () => {
  it('reports the machine and the job', () => {
    const s = buildState(snap());
    expect(s).toMatchObject({ machine_state: 'Run', x_position: 1.235, z_position: -0.5, feedrate: 300, spindle_speed: 12000, job_progress: 25, file_name: 'board.nc', job_size: 4096, alarm_active: false, feed_hold: false, connected: true, pcb_mode: true });
  });
  it('elapsed runs from the start time and remaining is estimated from the lines done', () => {
    const s = buildState(snap());                       // 100 s elapsed, 50 of 200 lines: 300 s to go
    expect(s.job_elapsed_formatted).toBe('01:40');
    expect(s.job_remaining_formatted).toBe('05:00');
  });
  it('shows hours for a long job, and nothing before there is anything to estimate from', () => {
    expect(buildState(snap({ now: 1_000_000 + 3_700_000 })).job_elapsed_formatted).toBe('1:01:40');
    const first = buildState(snap({ job: { ...snap().job, doneLines: 0 } }));
    expect(first.job_remaining_formatted).toBe('--:--');
  });
  it('a finished job is 100% with nothing left; no file means no clock', () => {
    const done = buildState(snap({ job: { ...snap().job, state: 'done', elapsedMs: 90_000 } }));
    expect(done).toMatchObject({ job_progress: 100, job_remaining_formatted: '00:00', job_elapsed_formatted: '01:30' });
    expect(buildState(snap({ job: emptyJob() }))).toMatchObject({ job_elapsed_formatted: '--:--', job_remaining_formatted: '--:--', file_name: '—' });
  });
  it('alarm, hold and a disconnected machine', () => {
    expect(buildState(snap({ status: { ...emptyStatus(), state: 'Alarm' } })).alarm_active).toBe(true);
    expect(buildState(snap({ status: { ...emptyStatus(), state: 'Hold' } })).feed_hold).toBe(true);
    const off = buildState(snap({ connection: { connected: false, target: '' }, status: { ...emptyStatus(), state: 'Alarm' } }));
    expect(off).toMatchObject({ machine_state: 'Disconnected', alarm_active: false, connected: false });
  });
});

describe('discovery', () => {
  it('names the device after the setting and gives every entity a unique id and the same device', () => {
    const d = discovery('Cubiko');
    const ids = d.map((x) => x.payload.unique_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(d.length).toBe(ENTITIES.length + 1 + COMMANDS.length);
    const st = d.find((x) => x.topic === 'homeassistant/sensor/cubiko/machine_state/config')!.payload;
    expect(st).toMatchObject({ name: 'Machine State', state_topic: 'demonx/cubiko/state', availability_topic: 'demonx/cubiko/availability', has_entity_name: true, device: { name: 'Cubiko' } });
    expect(d.find((x) => x.topic.endsWith('/stop/config'))!.payload).toMatchObject({ command_topic: 'demonx/cubiko/command/stop', payload_press: 'PRESS' });
    expect(d.find((x) => x.topic.includes('bridge_online'))!.payload.state_topic).toBe('demonx/cubiko/availability');
  });
  it('slugs a name safely', () => {
    expect(slugOf('Demon Carve #2')).toBe('demon_carve_2');
    expect(slugOf('!!!')).toBe('demonx');
  });
});

describe('config', () => {
  it('validates the broker settings and keeps the password secret', () => {
    const c = applyUpdate(defaultConfig(), { mqtt: { host: '10.20.30.50', user: 'ha', password: 'pw', name: 'Cubiko', enabled: true } });
    expect(c.mqtt).toMatchObject({ host: '10.20.30.50', port: 1883, enabled: true });
    const v = publicView(c).mqtt;
    expect(v).toMatchObject({ hasPassword: true, user: 'ha', name: 'Cubiko' });
    expect(JSON.stringify(v)).not.toContain('pw');
    expect(() => applyUpdate(defaultConfig(), { mqtt: { host: 'mqtt://x' } })).toThrow(ConfigError);
    expect(() => applyUpdate(defaultConfig(), { mqtt: { port: 99999 } })).toThrow(ConfigError);
    expect(() => applyUpdate(defaultConfig(), { mqtt: { enabled: true } })).toThrow(/broker address/);
    expect(applyUpdate(c, { mqtt: { port: 1884 } }).mqtt.password).toBe('pw');   // not sent: kept
  });
});

/** A real broker in this process, so the real client library is exercised */
async function broker(auth?: { user: string; pass: string }) {
  const aedes = await Aedes.createBroker();
  if (auth) aedes.authenticate = (_c, u, p, cb) => cb(null, u === auth.user && p?.toString() === auth.pass);
  const server = net.createServer(aedes.handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const published: { topic: string; payload: string; retain: boolean }[] = [];
  aedes.on('publish', (p, c) => { if (c) published.push({ topic: p.topic, payload: p.payload.toString(), retain: p.retain }); });
  return { aedes, port, published, close: () => new Promise<void>((r) => { aedes.close(() => server.close(() => r())); }) };
}
const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

describe('MqttBridge with a real broker', () => {
  const make = (port: number, extra: Partial<ReturnType<typeof defaultConfig>['mqtt']> = {}) => {
    const cfg = { enabled: true, host: '127.0.0.1', port, user: '', password: '', tls: false, name: 'Cubiko', ...extra };
    const ran: string[] = [], logs: string[] = [];
    let current = snap();
    const ctl = new EventEmitter(), probe = new EventEmitter();
    const bridge = new MqttBridge(() => cfg, () => current, (c) => ran.push(c), (_k, t) => logs.push(t), mqtt.connect, 20);
    bridge.attach(ctl, probe);
    return { cfg, bridge, ran, logs, ctl, set: (s: Snapshot) => { current = s; ctl.emit('status'); } };
  };

  it('announces itself, publishes state, follows changes, and only runs the six commands', async () => {
    const b = await broker();
    const m = make(b.port);
    m.bridge.apply();
    await until(() => b.published.some((p) => p.topic === 'demonx/cubiko/state'));
    expect(b.published.find((p) => p.topic === 'demonx/cubiko/availability')).toMatchObject({ payload: 'online', retain: true });
    expect(b.published.filter((p) => p.topic.startsWith('homeassistant/') && p.retain).length).toBe(ENTITIES.length + 1 + COMMANDS.length);
    expect(JSON.parse(b.published.find((p) => p.topic === 'demonx/cubiko/state')!.payload).file_name).toBe('board.nc');

    m.set(snap({ status: { ...emptyStatus(), state: 'Alarm' } }));
    await until(() => b.published.some((p) => p.topic === 'demonx/cubiko/state' && JSON.parse(p.payload).alarm_active === true));

    const pub = mqtt.connect(`mqtt://127.0.0.1:${b.port}`);
    await new Promise((r) => pub.on('connect', r));
    pub.publish('demonx/cubiko/command/hold', 'PRESS');
    pub.publish('demonx/cubiko/command/jog', 'PRESS');          // not a command DemonX accepts
    pub.publish('demonx/cubiko/command/home', 'something else'); // wrong payload
    pub.publish('demonx/cubiko/command/stop', 'PRESS');
    await until(() => m.ran.length >= 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(m.ran).toEqual(['hold', 'stop']);

    m.bridge.stop();
    await until(() => b.published.some((p) => p.topic === 'demonx/cubiko/availability' && p.payload === 'offline'));
    pub.end(true);
    await b.close();
  }, 15000);

  it('removes the entities from Home Assistant when sharing is turned off', async () => {
    const b = await broker();
    const m = make(b.port);
    m.bridge.apply();
    await until(() => b.published.some((p) => p.topic === 'demonx/cubiko/state'));
    m.cfg.enabled = false;
    m.bridge.apply();
    await until(() => b.published.some((p) => p.topic === 'homeassistant/sensor/cubiko/machine_state/config' && p.payload === ''));
    await b.close();
  }, 15000);

  it('testBroker says what is wrong', async () => {
    const b = await broker({ user: 'ha', pass: 'secret' });
    const base = { enabled: true, host: '127.0.0.1', port: b.port, user: 'ha', password: 'secret', tls: false, name: 'x' };
    expect((await testBroker(base)).ok).toBe(true);
    expect(await testBroker({ ...base, password: 'nope' })).toMatchObject({ ok: false, message: expect.stringMatching(/user name or password/) });
    await b.close();
    expect(await testBroker({ ...base, port: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/refused/) });
    expect(await testBroker({ ...base, host: '' })).toMatchObject({ ok: false });
  }, 20000);
});

void baseTopic;
