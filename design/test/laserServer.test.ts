import { afterEach, describe, expect, it } from 'vitest';
import { emptyDoc as baseDoc } from '../src/core/types';
/** The old two-layer starting document: Layer 1 (cut) and Engrave */
const emptyDoc = () => { const d = baseDoc(); return { ...d, layers: [...d.layers, { ...d.layers[0], name: 'Engrave', mode: 'engrave' as const, speed: 100, power: 20, color: '#2bb5c9' }] }; };
import type { Doc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildLaserJob } from '../src/core/laser';
import { fingerprint } from '../src/core/hash';
import { validateLaserGcode } from '../server/src/validate';
import { LaserSession } from '../server/src/laserSession';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(20);
  }
}

function smallJob(extra: any = {}): string {
  let d = run(emptyDoc(), 'add_rect', { x: 5, y: 5, w: 20, h: 10, layer: 'Layer 1' }).doc;
  d = run(d, 'layer_set', { name: 'Layer 1', speed: 50, ...extra }).doc;
  return buildLaserJob(d).gcode;
}
function bigEngrave(): string {
  let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Engrave' }).doc;
  d = run(d, 'layer_set', { name: 'Engrave', interval: 0.5, speed: 50, overscan: 0 }).doc;
  return buildLaserJob(d).gcode;
}

describe('laser G-code the server will accept', () => {
  it('accepts what the Design app writes (cut, engrave, passes, air)', () => {
    expect(validateLaserGcode(smallJob()).ok).toBe(true);
    expect(validateLaserGcode(bigEngrave()).ok).toBe(true);
    let d = run(emptyDoc(), 'add_circle', { cx: 10, cy: 10, r: 5, layer: 'Layer 1' }).doc;
    d = run(d, 'layer_set', { name: 'Layer 1', passes: 3, air: true }).doc;
    const check = validateLaserGcode(buildLaserJob(d).gcode, 1000);
    expect(check.ok).toBe(true);
    expect(check.maxS).toBe(600);
  });

  const bad: [string, string, RegExp][] = [
    ['constant power M3', 'M3 S500\nG1 X5 F300\nM5', /M3 is not allowed/],
    ['an arc', 'M4 S0\nG2 X5 Y5 I1 J1 F300\nM5', /G2 is not allowed/],
    ['homing', 'G28\nM5', /G28 is not allowed/],
    ['a settings command', '$32=0\nM5', /settings commands/],
    ['a work offset', 'G10 L20 P0 X0\nM5', /G10 is not allowed/],
    ['a Z move', 'M4 S0\nG1 Z5 F300\nM5', /Z words are not allowed/],
    ['relative mode (G91)', 'G91\nM5', /G91 is not allowed/],
    ['spindle clockwise with a tool change', 'M6 T1\nM5', /M6 is not allowed/],
    ['power without M4', 'M5\nG1 X5 S300 F300', /power without M4/],
    ['S on a rapid', 'M4 S0\nG0 X5 S300\nM5', /S on a G0 rapid/],
    ['coordinates without a motion word', 'M4 S0\nX5 Y5\nM5', /X\/Y without G0 or G1/],
    ['a feed of zero', 'M4 S0\nG1 X5 F0\nM5', /feed F0/],
    ['a huge feed', 'M4 S0\nG1 X5 F999999\nM5', /feed F999999/],
    ['a huge coordinate', 'M4 S0\nG1 X999999 F300\nM5', /out of range/],
    ['junk', 'M4 S0\nHELLO WORLD\nM5', /not understood|words are not allowed/],
    ['ending with the laser on', 'M4 S0\nG1 X5 S300 F300', /ends with the laser still on/],
    ['an empty job', '; just a comment\n\n', /empty/],
  ];
  for (const [what, text, why] of bad) {
    it(`refuses ${what}`, () => {
      const c = validateLaserGcode(text);
      expect(c.ok).toBe(false);
      expect(c.error).toMatch(why);
    });
  }

  it('refuses power above the controller maximum and says which line', () => {
    const c = validateLaserGcode('G21\nM4 S0\nG1 X5 S2000 F300\nM5', 1000);
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/^Line 3: S2000 is above the controller's maximum \(1000, \$30\)/);
  });

  it('ignores comments of both kinds', () => {
    expect(validateLaserGcode('; a comment\n(another one)\nM4 S0 ; on\nG1 X5 S10 F100 (go)\nM5').ok).toBe(true);
  });
});

describe('laser session against the simulator', () => {
  let session: LaserSession | undefined;
  afterEach(async () => { await session?.close(); session = undefined; });

  async function connected(): Promise<LaserSession> {
    session = new LaserSession({ simSpeed: 100, listPorts: async () => [{ path: 'COM7' }] });
    const r = await session.connect('simulator');
    expect(r.ok).toBe(true);
    await until(() => session!.controller.status.state === 'Idle', 3000, 'idle');
    return session;
  }
  const tx = (s: LaserSession) => s.controller.logBuffer.filter((l) => l.kind === 'tx').map((l) => l.text);

  it('lists the simulator first, and refuses a port the computer does not have', async () => {
    session = new LaserSession({ listPorts: async () => [{ path: 'COM7' }] });
    expect((await session.ports()).map((p) => p.path)).toEqual(['simulator', 'COM7']);
    const r = await session.connect('/etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not a serial port/);
  });

  it('reads laser mode: off at first, then on after it is enabled', async () => {
    const s = await connected();
    const info = await s.checkLaser();
    expect(info).toMatchObject({ mode: 'off', sMax: 1000 });
    expect(info.note).toMatch(/\$32=0/);
    const r = await s.enableLaserMode();
    expect(r.ok).toBe(true);
    expect(s.laser.mode).toBe('on');
  });

  it('will not start while laser mode is off, nor with a stale job, nor an unsent one', async () => {
    const s = await connected();
    expect((await s.start('x')).code).toBe('no-job');
    const gcode = smallJob();
    expect(s.loadJob('test', gcode).ok).toBe(true);
    const hash = fingerprint(gcode);
    const off = await s.start(hash);
    expect(off.ok).toBe(false);
    expect(off.code).toBe('laser-mode-off');
    await s.enableLaserMode();
    await until(() => s.controller.status.state === 'Idle', 3000, 'idle after the settings write');
    const stale = await s.start('00000000:1');
    expect(stale.code).toBe('stale-job');
    expect(s.controller.job.state).toBe('loaded');
  });

  it('runs a job to the end with every line the app wrote, and the laser off at the end', async () => {
    const s = await connected();
    await s.enableLaserMode();
    await until(() => s.controller.status.state === 'Idle', 3000, 'idle after the settings write');
    const gcode = smallJob();
    expect(s.loadJob('square', gcode).ok).toBe(true);
    const r = await s.start(fingerprint(gcode));
    expect(r.ok).toBe(true);
    await until(() => s.controller.job.state === 'done', 10000, 'job done');
    const sent = tx(s);
    expect(sent).toContain('M4S0');
    expect(sent.at(-1)).toBe('M2');
    expect(sent.some((l) => l === 'M5')).toBe(true);
    expect(sent.filter((l) => /^M3/.test(l))).toEqual([]);
    expect(s.controller.status.accessories).not.toMatch(/S|C/); // spindle/laser reported off
  });

  it('refuses a job that uses more power than the controller allows ($30)', async () => {
    const s = await connected();
    await s.checkLaser(); // sMax 1000
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 5, h: 5, layer: 'Layer 1' }).doc;
    d = run(d, 'machine_set', { sMax: 5000 }).doc;
    const r = s.loadJob('too hot', buildLaserJob(d).gcode);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid-job');
    expect(r.message).toMatch(/above the controller's maximum \(1000, \$30\)/);
    expect(s.loaded).toBeNull();
  });

  it('stops a running job: feed hold, reset, laser off, job back to loaded', async () => {
    session = new LaserSession({ simSpeed: 3, listPorts: async () => [] });
    const s = session;
    await s.connect('simulator');
    await until(() => s.controller.status.state === 'Idle', 3000, 'idle');
    await s.enableLaserMode();
    await until(() => s.controller.status.state === 'Idle', 3000, 'idle after the settings write');
    const gcode = bigEngrave();
    expect(s.loadJob('engrave', gcode).ok).toBe(true);
    expect((await s.start(fingerprint(gcode))).ok).toBe(true);
    await until(() => s.controller.job.doneLines > 20, 8000, 'some progress');
    const stop = await s.stop();
    expect(stop.ok).toBe(true);
    expect(s.controller.job.state).toBe('loaded');
    await until(() => s.controller.status.state === 'Idle', 4000, 'idle after reset');
    expect(s.controller.job.doneLines).toBe(0);
  });

  it('will not disconnect, jog, home or load while a job runs', async () => {
    session = new LaserSession({ simSpeed: 3, listPorts: async () => [] });
    const s = session;
    await s.connect('simulator');
    await until(() => s.controller.status.state === 'Idle', 3000, 'idle');
    await s.enableLaserMode();
    await until(() => s.controller.status.state === 'Idle', 3000, 'idle after the settings write');
    const gcode = bigEngrave();
    s.loadJob('engrave', gcode);
    await s.start(fingerprint(gcode));
    await until(() => s.controller.job.state === 'running', 6000, 'running');
    expect((await s.disconnect()).message).toMatch(/job is running/);
    expect(s.jog(1, 0, 1000).ok).toBe(false);
    expect(s.home().ok).toBe(false);
    expect(s.loadJob('another', smallJob()).ok).toBe(false);
    expect(s.setOrigin().ok).toBe(false);
    expect(s.frame(3000).ok).toBe(false);
    expect(s.pause().ok).toBe(true);
    expect(s.controller.job.state).toBe('paused');
    await s.stop();
  });

  it('jogs XY only, with limits, and as a $J jog (which never fires the laser)', async () => {
    const s = await connected();
    expect(s.jog(200, 0, 1000).message).toMatch(/at most 100 mm/);
    expect(s.jog(5, 0, 0).message).toMatch(/1 to 10000/);
    expect(s.jog(5, 0, 99999).ok).toBe(false);
    expect(s.jog(0, 0, 1000).ok).toBe(false);
    expect(s.jog(NaN, 1, 1000).ok).toBe(false);
    expect(s.jog(5, -2.5, 1500).ok).toBe(true);
    await until(() => tx(s).some((l) => l.startsWith('$J=')), 2000, 'jog line');
    expect(tx(s).filter((l) => l.startsWith('$J='))).toEqual(['$J=G21G91X5Y-2.5F1500']);
  });

  it('frames the job with the laser off, and returns to where it started', async () => {
    const s = await connected();
    expect(s.frame(3000).message).toMatch(/Send the job first/);
    const gcode = smallJob();
    s.loadJob('square', gcode);
    expect(s.frame(3000).ok).toBe(true);
    await until(() => tx(s).includes('G1X0.000Y0.000'), 3000, 'return move');
    const lines = tx(s);
    expect(lines[lines.findIndex((l) => l === 'M5')]).toBe('M5'); // laser off first
    expect(lines.indexOf('M5')).toBeLessThan(lines.findIndex((l) => l.startsWith('G1X')));
    const corners = lines.filter((l) => /^G1X\d/.test(l));
    expect(corners).toEqual(['G1X0.000Y0.000F3000', 'G1X20.000Y0.000', 'G1X20.000Y10.000', 'G1X0.000Y10.000', 'G1X0.000Y0.000', 'G1X0.000Y0.000']);
    expect(lines.some((l) => /S\d/.test(l))).toBe(false); // no power word anywhere in a frame
  });

  it('sets and goes to work zero with the laser off', async () => {
    const s = await connected();
    expect(s.setOrigin().ok).toBe(true);
    expect(s.goOrigin(2000).ok).toBe(true);
    expect(s.goOrigin(0).ok).toBe(false);
    await until(() => tx(s).includes('G21G90G1X0Y0F2000'), 2000, 'go to origin');
    const l = tx(s);
    expect(l).toContain('G10L20P0X0Y0');
    expect(l.indexOf('M5')).toBeLessThan(l.indexOf('G21G90G1X0Y0F2000'));
  });

  it('says so when it is not connected', async () => {
    session = new LaserSession();
    const s = session;
    expect(s.jog(1, 0, 100).message).toBe('Not connected');
    expect(s.home().ok).toBe(false);
    expect(s.reset().ok).toBe(false);
    expect(s.loadJob('x', smallJob()).ok).toBe(false);
    expect((await s.start('x')).ok).toBe(false);
    expect((await s.stop()).ok).toBe(false);
  });
});
