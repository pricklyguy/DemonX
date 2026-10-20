import { afterEach, describe, expect, it } from 'vitest';
import { RuidaSession, RUIDA_SIMULATOR } from '../server/src/ruida/session';
import { LaserHub } from '../server/src/laserHub';
import { LaserSession } from '../server/src/laserSession';
import { ruidaConfigFromEnv, isLanAddress, type RuidaConfig } from '../server/src/ruida/config';
import { serializePlan } from '../server/src/ruida/plan';
import type { RuidaPlan } from '../server/src/ruida/plan';
import { fingerprint } from '../src/core/hash';

const cfg = (extra: Partial<RuidaConfig> = {}): RuidaConfig => ({ enabled: true, controllers: {}, bedW: 1000, bedH: 600, maxPower: 100, maxSpeed: 600, pause: false, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(10); }
}

const square = (o: { air?: boolean; speed?: number; side?: number; y0?: number } = {}): RuidaPlan => {
  const s = o.side ?? 20, y0 = o.y0 ?? 0;
  return { layers: [{ colorRaw: 0x00e000, mode: 'line', speed: o.speed ?? 40, minPower: 12.5, maxPower: 12.5, air: o.air ?? true,
    points: [{ x: 0, y: y0, burn: false }, { x: s, y: y0, burn: true }, { x: s, y: y0 + s, burn: true }, { x: 0, y: y0 + s, burn: true }, { x: 0, y: y0, burn: true }] }] };
};

let open: RuidaSession | null = null;
async function connected(c: Partial<RuidaConfig> = {}, simSpeed = 20) {
  const s = new RuidaSession({ config: cfg(c), simSpeed, pollMs: 25, replyMs: 400 });
  open = s;
  const r = await s.connect(RUIDA_SIMULATOR);
  expect(r.ok, r.message).toBe(true);
  return s;
}
afterEach(async () => { await open?.close(); open = null; });

/** the simulated machine behind the session (reached for checking what the "controller" did) */
const simOf = (s: RuidaSession) => (s as any).sim.machine as import('../server/src/ruida/machine').RuidaMachine;
const load = (s: RuidaSession, p: RuidaPlan) => { const text = serializePlan(p); const r = s.loadJob('test', text); expect(r.ok, r.message).toBe(true); return fingerprint(text); };

describe('Ruida is off unless turned on, and only named targets open', () => {
  it('lists nothing and refuses to connect when disabled', async () => {
    const s = new RuidaSession({ config: cfg({ enabled: false }) });
    expect(await s.ports()).toEqual([]);
    expect((await s.connect(RUIDA_SIMULATOR)).ok).toBe(false);
  });
  it('takes controllers by name from the server settings, never an address from the browser', async () => {
    const s = new RuidaSession({ config: cfg({ controllers: { laser: '10.0.0.5' } }) });
    expect((await s.ports()).map((p) => p.path)).toEqual([RUIDA_SIMULATOR, 'ruida:laser']);
    for (const t of ['10.0.0.5', 'ruida:10.0.0.5', 'ruida:evil', 'ruida:__proto__', '8.8.8.8', 'COM3']) expect((await s.connect(t)).ok, t).toBe(false);
  });
  it('reads the settings from the environment and keeps only local-network addresses', () => {
    const c = ruidaConfigFromEnv({ DESIGN_RUIDA: '1', DESIGN_RUIDA_HOSTS: 'laser=192.168.1.20, bad=8.8.8.8, x=10.0.0.999', DESIGN_RUIDA_BED: '900x500', DESIGN_RUIDA_MAX_POWER: '30', DESIGN_RUIDA_PAUSE: '1' });
    expect(c).toMatchObject({ enabled: true, controllers: { laser: '192.168.1.20' }, bedW: 900, bedH: 500, maxPower: 30, pause: true });
    expect(ruidaConfigFromEnv({}).enabled).toBe(false);
    expect(isLanAddress('172.20.1.1') && isLanAddress('10.1.2.3') && !isLanAddress('172.32.0.1') && !isLanAddress('1.2.3.4')).toBe(true);
  });
});

describe('Ruida session against the simulated controller', () => {
  it('connects, reads the bed and the position, and shows the position the way the drawing does', async () => {
    const s = await connected();
    await until(() => s.state().status.wpos.x > 100);
    const st = s.state();
    expect(st.kind).toBe('ruida');
    expect(st.connection.connected).toBe(true);
    expect(st.status.state).toBe('Idle');
    expect(st.status.wpos.x).toBeCloseTo(152.14, 2);
    expect(st.status.wpos.y).toBeCloseTo(14.511, 2); // from the rear-left corner, like LightBurn
    expect(st.workArea).toEqual({ width: 1000, height: 600 });
  });

  it('jogs with the laser off: right is X plus, back is Y up, and it will not leave the work area', async () => {
    const s = await connected();
    expect((await s.jog(10, 0, 3000)).ok).toBe(true);
    await until(() => simOf(s).head.x > 161.9);
    expect((await s.jog(0, 10, 3000)).ok).toBe(true);
    await until(() => simOf(s).head.y < 4.6);
    expect(simOf(s).head.y).toBeCloseTo(4.511, 1);
    expect((await s.jog(0, 100, 3000)).ok).toBe(false); // would go to Y < 0
    expect((await s.jog(101, 0, 3000)).ok).toBe(false);
    expect((await s.jog(0, 0, 3000)).ok).toBe(false);
    expect((await s.jog(5, 0, 0)).ok).toBe(false);
    expect(simOf(s).events.filter((e) => e.kind === 'laser')).toEqual([]);
  });

  it('refuses things Ruida cannot do from here, plainly', async () => {
    const s = await connected();
    for (const r of [s.setOrigin(), s.goOrigin(), await s.home(), s.unlock(), await s.enableLaserMode()]) expect(r.ok).toBe(false);
    expect(s.capabilities).toMatchObject({ home: false, setOrigin: false, pause: false });
  });

  it('checks the job before keeping it: limits, shape and size', async () => {
    const s = await connected({ maxPower: 30 });
    expect(s.loadJob('x', 'not json').ok).toBe(false);
    const hot = square(); hot.layers[0].minPower = 50; hot.layers[0].maxPower = 50;
    expect(s.loadJob('x', serializePlan(hot)).code).toBe('invalid-job');
    expect(s.loadJob('x', serializePlan(square({ speed: 5000 }))).ok).toBe(false);
    expect(s.loadJob('x', serializePlan(square({ side: 2000 }))).ok).toBe(false);
    expect(s.loadJob('x', serializePlan(square())).ok).toBe(true);
    expect(s.state().loaded?.name).toBe('x');
  });

  it('frames with the laser off: the four corners and back to the start, power set to 0 first', async () => {
    const s = await connected();
    load(s, square({ side: 30, y0: 10 })); // a box whose corner is NOT at the head: the frame must still come back to the start
    expect((await s.frame(6000)).ok).toBe(true);
    await until(() => simOf(s).events.filter((e) => e.kind === 'rapid').length === 5);
    const m = simOf(s);
    expect(m.events.filter((e) => e.kind === 'laser')).toEqual([]);
    // the commands the controller received: power words 0 and the four moves
    const hex = m.received.map((c) => c.toString('hex'));
    expect(hex.filter((h) => /^c60[12]0000$|^c62[12]0000$/.test(h)).length).toBe(4);
    await until(() => m.state === 'idle' && Math.abs(m.head.x - 152.14) < 0.01 && Math.abs(m.head.y - 14.511) < 0.01);
  });

  it('frames in a circle round the job, laser off, and ends back at the start', async () => {
    const s = await connected();
    load(s, square({ side: 30 }));
    expect((await s.frame(6000, 'circle')).ok).toBe(true);
    const m = simOf(s);
    await until(() => m.events.filter((e) => e.kind === 'rapid').length >= 50);
    expect(m.events.filter((e) => e.kind === 'laser')).toEqual([]);
    await until(() => m.state === 'idle' && Math.abs(m.head.x - 152.14) < 0.01 && Math.abs(m.head.y - 14.511) < 0.01);
  });

  it('does not frame a circle that would leave the bed even when the box itself fits', async () => {
    const s = await connected();
    load(s, square({ side: 80 })); // the box fits (it grows toward the front); the circle through its corners reaches past the rear edge, 14.5 mm behind the head
    expect((await s.frame(6000)).ok).toBe(true);
    await until(() => simOf(s).state === 'idle' && simOf(s).events.filter((e) => e.kind === 'rapid').length >= 5 && Math.abs(simOf(s).head.x - 152.14) < 0.01 && Math.abs(simOf(s).head.y - 14.511) < 0.01);
    await until(() => s.state().status.state === 'Idle');
    const before = simOf(s).events.filter((e) => e.kind === 'rapid').length;
    let r = await s.frame(6000, 'circle');
    for (let i = 0; i < 100 && /busy/.test(r.message); i++) { await sleep(30); r = await s.frame(6000, 'circle'); } // the controller may still say it is moving for a moment
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/past the rear edge/);
    expect(simOf(s).events.filter((e) => e.kind === 'rapid').length).toBe(before);
  });

  it('does not frame a job that would leave the bed from where the head is', async () => {
    const s = await connected();
    load(s, square({ side: 590 })); // fits the bed, but the head is 14.5 mm from the back edge and the job grows toward the front
    const r = await s.frame(6000);
    expect(r.ok).toBe(false);
    expect(simOf(s).events.filter((e) => e.kind === 'rapid')).toEqual([]);
  });

  it('moves to a saved position with the laser off, and only inside the work area and while idle', async () => {
    const s = await connected();
    expect((await s.moveTo(300, 200, 3000)).ok).toBe(true);
    await until(() => Math.abs(simOf(s).head.x - 300) < 0.01 && Math.abs(simOf(s).head.y - 200) < 0.01);
    expect((await s.moveTo(1001, 10, 3000)).ok).toBe(false);
    expect((await s.moveTo(10, -1, 3000)).ok).toBe(false);
    expect((await s.moveTo(Number.NaN, 10, 3000)).ok).toBe(false);
    expect((await s.moveTo(10, 10, 0)).ok).toBe(false);
    expect(simOf(s).head.x).toBeCloseTo(300, 1);
    expect(simOf(s).events.filter((e) => e.kind === 'laser')).toEqual([]);
    await until(() => s.state().status.state === 'Idle');
    const hash = load(s, square({ side: 20 }));
    const started = await s.start(hash);
    expect(started.ok, started.message).toBe(true);
    await until(() => s.state().job.state === 'running');
    expect((await s.moveTo(10, 10, 3000)).ok).toBe(false); // never while a job runs
  });

  it('Home is off unless switched on, then sends the captured command, takes the head to 0, 0 and does not call the wait "lost contact"', async () => {
    const off = await connected();
    const r0 = await off.home();
    expect(r0.ok).toBe(false); expect(r0.code).toBe('home-off');
    expect(off.capabilities.home).toBe(false);
    await open?.close(); open = null;
    const s = await connected({ home: true });
    expect(s.capabilities.home).toBe(true);
    const r = await s.home();
    expect(r.ok, r.message).toBe(true);
    expect(s.state().status.state).toBe('Home');
    expect((await s.jog(5, 0, 3000)).ok).toBe(false); // nothing else while it homes
    expect((await s.moveTo(10, 10, 3000)).ok).toBe(false);
    const m = simOf(s);
    const got = m.received.map((c) => c.toString('hex'));
    expect(got).toContain('d0298989'); // the datagram LightBurn sent: Home, then a rapid move to 0, 0
    expect(got).toContain('d9100000000000000000000000');
    expect(m.events.filter((e) => e.kind === 'laser')).toEqual([]);
    await until(() => Math.abs(m.head.x) < 0.01 && Math.abs(m.head.y) < 0.01 && s.state().status.state === 'Idle', 20000, 'homed');
    expect(s.state().status.wpos.x).toBeCloseTo(0, 1);
    expect(s.state().connection.connected).toBe(true);
  });

  it('Z moves are off unless switched on; then one step is relative, small, laser off, and shown as the change since connecting', async () => {
    const off = await connected();
    const r0 = await off.jogZ(1, 250);
    expect(r0.ok).toBe(false); expect(r0.code).toBe('z-off');
    await open?.close(); open = null;
    const s = await connected({ z: true });
    expect(s.capabilities.z).toBe(true);
    await until(() => s.state().status.state === 'Idle', 4000, 'idle');
    expect((await s.jogZ(11, 250)).ok).toBe(false);
    expect((await s.jogZ(0, 250)).ok).toBe(false);
    expect((await s.jogZ(1, 0)).ok).toBe(false);
    expect((await s.jogZ(1, 250)).ok, 'one step up').toBe(true);
    const m = simOf(s);
    await until(() => Math.abs(m.z - 3_001_000) < 1, 8000, 'z up by 1 mm');
    await until(() => Math.abs(s.state().status.wpos.z - 1) < 0.01, 4000, 'shown as +1 mm');
    expect(m.events.filter((e) => e.kind === 'laser')).toEqual([]);
    await until(() => s.state().status.state === 'Idle', 4000, 'idle');
    expect((await s.jogZ(-2.5, 250)).ok).toBe(true);
    await until(() => Math.abs(m.z - 2_998_500) < 1, 12000, 'z down 2.5 mm');
    // while a job runs nothing moves
    await until(() => s.state().status.state === 'Idle', 4000, 'idle');
    const hash = load(s, square({ side: 20 }));
    expect((await s.start(hash)).ok).toBe(true);
    await until(() => s.state().job.state === 'running', 8000, 'running');
    expect((await s.jogZ(1, 250)).ok).toBe(false);
  });

  it('frames a job from a start point on the machine (Absolute coordinates, User origin): to the box corner, round it, and back to the head', async () => {
    const s = await connected();
    load(s, square({ side: 30 }));
    const m = simOf(s);
    const before = m.events.filter((e) => e.kind === 'rapid').length;
    const r = await s.frame(6000, 'box', { x: 226, y: 140 });
    expect(r.ok, r.message).toBe(true);
    await until(() => m.events.filter((e) => e.kind === 'rapid').length >= before + 6, 8000, 'six moves');
    const moves = m.events.filter((e) => e.kind === 'rapid').slice(before).map((e) => [e.x, e.y]);
    expect(moves).toEqual([[226, 140], [226, 170], [256, 170], [256, 140], [226, 140], [152.14, 14.511]]);
    expect(m.events.filter((e) => e.kind === 'laser')).toEqual([]);
    await until(() => Math.abs(m.head.x - 152.14) < 0.01 && Math.abs(m.head.y - 14.511) < 0.01 && s.state().status.state === 'Idle', 20000, 'back at the start');
  });

  it('does not frame from a start point that would put the job outside the bed, and says which edge', async () => {
    const s = await connected();
    load(s, square({ side: 30 }));
    const m = simOf(s);
    const before = m.events.filter((e) => e.kind === 'rapid').length;
    const r = await s.frame(6000, 'box', { x: 990, y: 100 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/start point.*past the right edge/);
    expect(m.events.filter((e) => e.kind === 'rapid').length).toBe(before);
  });

  it('Auto focus is off unless Z is switched on; then it sends D8 2E, waits without calling the silence lost contact, and ends when Z has stopped', async () => {
    const off = await connected();
    const r0 = await off.autoFocus();
    expect(r0.ok).toBe(false); expect(r0.code).toBe('z-off');
    await open?.close(); open = null;
    const s = await connected({ z: true });
    await until(() => s.state().status.state === 'Idle', 4000, 'idle');
    const z0 = simOf(s).z;
    const r = await s.autoFocus();
    expect(r.ok, r.message).toBe(true);
    expect(s.state().status.state).toBe('Run');
    expect((await s.jogZ(1, 250)).ok).toBe(false); // nothing else while it focuses
    expect(simOf(s).received.map((c) => c.toString('hex'))).toContain('d82e');
    await until(() => s.state().status.state === 'Idle', 25000, 'focus finished');
    expect(simOf(s).z).toBeLessThan(z0);
    expect(s.state().connection.connected).toBe(true);
  });

  it('runs a job: refuses a stale hash, starts, burns with air on, finishes with the laser off', async () => {
    const s = await connected();
    const hash = load(s, square({ side: 20, air: true }));
    expect((await s.start('deadbeef:1')).code).toBe('stale-job');
    const r = await s.start(hash);
    expect(r.ok, r.message).toBe(true);
    await until(() => s.state().job.state === 'running');
    // while it runs nothing else may move or be loaded, and it cannot be dropped
    expect((await s.jog(1, 0, 3000)).ok).toBe(false);
    expect((await s.frame(3000)).ok).toBe(false);
    expect(s.loadJob('y', serializePlan(square())).ok).toBe(false);
    expect((await s.disconnect()).ok).toBe(false);
    expect((await s.start(hash)).ok).toBe(false);
    await until(() => s.state().job.state === 'done', 10000, 'job done');
    const m = simOf(s);
    expect(m.out.laserOn).toBe(false);
    const on = m.events.filter((e) => e.kind === 'laser' && e.laserOn);
    expect(on.length).toBe(1);
    expect(on[0].air).toBe(true);
    expect(s.state().status.state).toBe('Idle');
    // the same job can be started again
    expect((await s.start(hash)).ok).toBe(true);
  });

  it('does not start a job that would run outside the bed from where the head is now', async () => {
    const s = await connected();
    const hash = load(s, square({ y0: -50, side: 20 })); // 50 mm toward the back, but the head is only 14.5 mm from the back edge
    const r = await s.start(hash);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('out-of-bed');
    expect(simOf(s).state).toBe('idle');
  });

  it('from the rear edge, a job that extends toward the rear is refused with the amounts and what to do; one toward the front is accepted', async () => {
    const s = await connected();
    expect((await s.jog(0, 14.5, 3000)).ok).toBe(true); // up = toward the rear: the head is now about 0 mm from the rear edge, like the owner's first test
    await until(() => simOf(s).head.y < 0.1);
    await until(() => s.state().status.wpos.y < 0.1 && s.state().status.state === 'Idle');
    const toRear = load(s, square({ y0: -20, side: 20 }));
    const f = await s.frame(3000);
    expect(f.ok).toBe(false);
    expect(f.message).toMatch(/20 mm past the rear edge/);
    expect(f.message).toMatch(/nine-dot/);
    const r = await s.start(toRear);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/past the rear edge/);
    expect(s.recentLog(10).some((l) => l.kind === 'err' && /rear edge/.test(l.text))).toBe(true); // refusals are in the log too
    expect(simOf(s).received.filter((c) => c[0] === 0xd8 || c[0] === 0xd9).length).toBe(1); // only the jog reached the controller
    const toFront = load(s, square({ y0: 0, side: 20 }));
    expect((await s.start(toFront)).ok).toBe(true);
  });

  it('says which limit a layer is over', async () => {
    const s = await connected({ maxPower: 10 });
    const hot = square(); hot.layers[0].minPower = 12.5; hot.layers[0].maxPower = 12.5;
    const r = s.loadJob('x', serializePlan(hot));
    expect(r.message).toMatch(/12\.5 % is above the limit of 10 %/);
    expect(r.message).toMatch(/DESIGN_RUIDA_MAX_POWER/);
  });

  it('Stop switches the laser off and the controller confirms it', async () => {
    const s = await connected({}, 2);
    const hash = load(s, square({ side: 60, speed: 10 }));
    expect((await s.start(hash)).ok).toBe(true);
    await until(() => simOf(s).out.laserOn);
    const r = await s.stop();
    expect(r.ok, r.message).toBe(true);
    expect(simOf(s).out.laserOn).toBe(false);
    expect(simOf(s).state).toBe('idle'); // Stop waits until the head is back at the job's start and the controller says it is done
    expect(simOf(s).head.x).toBeCloseTo(152.14, 1);
    expect(simOf(s).head.y).toBeCloseTo(14.511, 1);
    expect(r.message).toMatch(/back to where the job started/);
    expect(s.state().job.state).toBe('loaded');
    expect(simOf(s).received.filter((c) => c.toString('hex') === 'd801').length).toBe(3); // sent three times
  });

  it('Pause is off unless switched on; when on, the laser is off while paused', async () => {
    const off = await connected();
    expect((await off.pause()).code).toBe('pause-off');
    await off.close(); open = null;
    const s = await connected({ pause: true }, 2);
    const hash = load(s, square({ side: 60, speed: 10 }));
    await s.start(hash);
    await until(() => (s as any).phase === 'running');
    const pr = await s.pause();
    expect(pr.ok, pr.message).toBe(true);
    await until(() => s.state().job.state === 'paused');
    expect(simOf(s).out.laserOn).toBe(false);
    expect((await s.resume()).ok).toBe(true);
    await until(() => s.state().job.state === 'running');
    expect((await s.stop()).ok).toBe(true);
  });

  it('stops by itself when the controller goes silent during a job', async () => {
    const s = await connected({}, 2);
    const hash = load(s, square({ side: 60, speed: 10 }));
    await s.start(hash);
    await until(() => s.state().job.state === 'running');
    const sim = (s as any).sim;
    const machine = simOf(s);
    await sim.close(); // the "controller" stops answering
    await until(() => s.state().job.state === 'error', 8000, 'lost contact');
    expect(s.state().job.error).toMatch(/Lost contact/);
    expect(s.state().status.state).toBe('Alarm');
    expect(machine.received.length).toBeGreaterThan(0);
  });

  it('closing the session while a job runs stops it', async () => {
    const s = await connected({}, 2);
    const hash = load(s, square({ side: 60, speed: 10 }));
    await s.start(hash);
    await until(() => simOf(s).out.laserOn);
    const m = simOf(s);
    await s.close(); open = null;
    expect(m.out.laserOn).toBe(false);
  });
});

describe('the hub picks the backend by target', () => {
  it('keeps GRBL as it was, adds Ruida targets only when enabled, and one connection at a time', async () => {
    const off = new LaserHub(new LaserSession({ listPorts: async () => [] }), new RuidaSession({ config: cfg({ enabled: false }) }));
    expect((await off.ports()).map((p) => p.path)).toEqual(['simulator']);
    expect(off.state().kind).toBe('grbl');
    const hub = new LaserHub(new LaserSession({ listPorts: async () => [], simSpeed: 20 }), new RuidaSession({ config: cfg(), simSpeed: 20, pollMs: 25 }));
    expect((await hub.ports()).map((p) => p.path)).toEqual(['simulator', RUIDA_SIMULATOR]);
    const r = await hub.connect(RUIDA_SIMULATOR);
    expect(r.ok, r.message).toBe(true);
    expect(hub.state().kind).toBe('ruida');
    expect((await hub.connect('simulator')).ok).toBe(false);
    expect((await hub.disconnect()).ok).toBe(true);
    expect(hub.state().kind).toBe('grbl');
    expect((await hub.connect('simulator')).ok).toBe(true);
    expect(hub.state().kind).toBe('grbl');
    await hub.close();
  });
});

describe('the panel is told about changes', () => {
  it('pushes the new position after a jog, even when the move is over before the next look', async () => {
    const s = new RuidaSession({ config: cfg(), simSpeed: 200, pollMs: 25, replyMs: 400 });
    open = s;
    expect((await s.connect(RUIDA_SIMULATOR)).ok).toBe(true);
    const seen: number[] = [];
    s.on('state', (st) => seen.push(st.status.wpos.x));
    expect((await s.jog(10, 0, 3000)).ok).toBe(true);
    await until(() => seen.some((x) => Math.abs(x - 162.14) < 0.05), 4000, 'the new position being pushed');
  });
});

describe('controllers are added by name and address, and remembered', () => {
  const tmp = () => `${process.env.TMPDIR ?? '/tmp'}/design-ruida-${Date.now()}-${Math.random().toString(16).slice(2)}/ruida-controllers.json`;
  it('adds a laser from the panel, lists it with its address, and keeps it for the next start', async () => {
    const file = tmp();
    const a = new RuidaSession({ config: cfg(), storeFile: file });
    expect(a.addController('Pronto', '192.168.1.50').ok).toBe(true);
    expect((await a.ports()).find((p) => p.path === 'ruida:Pronto')?.description).toMatch(/192\.168\.1\.50/);
    const b = new RuidaSession({ config: cfg(), storeFile: file }); // a new start of the server
    expect((await b.ports()).map((p) => p.path)).toContain('ruida:Pronto');
    expect(b.removeController('Pronto').ok).toBe(true);
    const c = new RuidaSession({ config: cfg(), storeFile: file });
    expect((await c.ports()).map((p) => p.path)).not.toContain('ruida:Pronto');
  });
  it('says why an entry is refused', () => {
    const s = new RuidaSession({ config: cfg(), storeFile: tmp() });
    expect(s.addController('Laser', '8.8.8.8').message).toMatch(/local network/);
    expect(s.addController('Laser', 'my-laser.local').message).toMatch(/four numbers/);
    expect(s.addController('Laser', '10.0.0.999').ok).toBe(false);
    expect(s.addController('', '10.0.0.5').ok).toBe(false);
    expect(s.addController('a/b', '10.0.0.5').ok).toBe(false);
    expect(new RuidaSession({ config: cfg({ enabled: false }) }).addController('Laser', '10.0.0.5').ok).toBe(false);
  });
  it('settings from the server cannot be changed from the panel', () => {
    const s = new RuidaSession({ config: cfg({ controllers: { fixed: '10.0.0.5' } }), storeFile: tmp() });
    expect(s.addController('fixed', '10.0.0.6').ok).toBe(false);
    expect(s.removeController('fixed').ok).toBe(false);
  });
  it('an unreachable laser gives a message that says what to check, with its address', async () => {
    const s = new RuidaSession({ config: cfg({ controllers: { dead: '127.0.0.1' } }), controllerPort: 9, localPort: 0, replyMs: 150 });
    open = s;
    const r = await s.connect('ruida:dead');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/127\.0\.0\.1 did not answer/);
    expect(r.message).toMatch(/same network/);
  });
});

describe('Frame and Start over the WebSocket check and hold the job themselves (Ruida)', () => {
  it('start with the job in the message: the job is checked, held and started; a bad job is refused with its own reason', { timeout: 30000 }, async () => {
    const { WebSocket } = await import('ws');
    const { createLaserServer } = await import('../server/src/app');
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-web-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<title>x</title>');
    const hub = new LaserHub(new LaserSession({ listPorts: async () => [] }), new RuidaSession({ config: cfg({ maxPower: 10 }), simSpeed: 50, pollMs: 25 }));
    const { server } = createLaserServer(hub, dir);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    const notices: { ok: boolean; message: string }[] = [];
    let latest: any = null;
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'notice') notices.push(m.data); if (m.type === 'state') latest = m.data; });
    await new Promise((r) => ws.once('open', r));
    const send = (m: object) => ws.send(JSON.stringify(m));
    try {
      send({ type: 'connect', target: RUIDA_SIMULATOR });
      await until(() => latest?.connection.connected && latest.kind === 'ruida');
      const hot = square(); hot.layers[0].minPower = 50; hot.layers[0].maxPower = 50;
      const hotText = serializePlan(hot);
      send({ type: 'start', hash: fingerprint(hotText), name: 'x', content: hotText });
      await until(() => notices.some((n) => !n.ok && /above the limit/.test(n.message)));
      expect(latest.loaded).toBeNull(); // nothing was kept, nothing was started
      const ok = square({ side: 20, speed: 40 }); ok.layers[0].minPower = 8; ok.layers[0].maxPower = 8; // under the server's 10 % cap
      const text = serializePlan(ok);
      send({ type: 'start', hash: fingerprint(text), name: 'x', content: text });
      await until(() => latest?.job.state === 'running' || latest?.job.state === 'done' || notices.length > 1, 8000, 'the job running');
      expect(notices.filter((n) => !n.ok).length).toBe(1); // only the rejected hot job; the good one raised no refusal
      await until(() => latest?.job.state === 'done', 15000, 'the job done');
      expect(latest.loaded.name).toBe('x');
    } finally {
      ws.close();
      await hub.close();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
