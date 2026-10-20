import { describe, it, expect } from 'vitest';
import { GrblController } from '../src/controller.js';
import { ProbeManager } from '../src/probe.js';
import { SimulatorTransport } from '../src/simulator.js';
import { HeightMapStore, validateHeightMap } from '../src/heightmap.js';
import type { AutolevelParams, HeightMap, ProbeSettings } from '../../shared/protocol.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 30000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); }
}

const SETTINGS: ProbeSettings = {
  plateZ: 0, plateX: 7, plateY: 7, endmill: 3, feedFast: 75, feedFine: 45,
  maxZ: 25, maxXY: 25, retract: 2, clearance: 5,
};
const AREA: AutolevelParams = { minX: 0, maxX: 20, minY: 0, maxY: 10, cols: 3, rows: 3, safeZ: 2, depth: 2, endZ: 12 };

// Tilted board in machine coordinates. With the work zero set at machine (10,10,-9.5),
// the surface height in work coordinates is -0.2 + 0.02 X + 0.01 Y.
const surface = (x: number, y: number) => -10 + 0.02 * x + 0.01 * y;
const workH = (X: number, Y: number) => -0.2 + 0.02 * X + 0.01 * Y;

async function setup() {
  const sim = new SimulatorTransport(60);
  const c = new GrblController();
  const p = new ProbeManager(c);
  const store = new HeightMapStore();
  p.on('heightmap', (m) => store.set(m));
  c.heightMap = () => store.map;
  await c.connect(sim, 'simulator');
  await until(() => c.status.state === 'Idle' && !!c.connection.firmware);
  c.handle({ type: 'jog', dx: 10, dy: 10, dz: -9.5, feed: 6000 });
  await until(() => c.status.mpos.z === -9.5 && c.status.mpos.x === 10);
  c.handle({ type: 'zero', axes: ['X', 'Y', 'Z'] });
  await until(() => c.status.wpos.z === 0 && c.status.wco.z === -9.5);
  sim.surfaceFn = surface;
  return { sim, c, p, store };
}

const scan = async (p: ProbeManager, area = AREA) => {
  p.start('autolevel', SETTINGS, area);
  p.confirm(p.info.id, 'confirmConnect');
  await until(() => p.info.phase === 'confirmRemove', 90000);
};

describe('autolevel scan', () => {
  it('measures the surface height at every grid point, then demands remove confirmation', async () => {
    const { c, p, store } = await setup();
    p.start('autolevel', SETTINGS, AREA);
    expect(p.info.phase).toBe('confirmConnect'); // same safety confirmation as any probe
    p.confirm(p.info.id, 'confirmConnect');
    await until(() => p.info.phase === 'confirmRemove', 90000);
    expect(p.info.error).toBeUndefined();
    expect(p.info.success).toBe(true);
    expect(p.info.progress).toEqual({ current: 9, total: 9 });

    const m = store.map!;
    expect([m.cols, m.rows]).toEqual([3, 3]);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      expect(m.z[j][i]).toBeCloseTo(workH(i * 10, j * 5), 3);
    }
    expect(m.wco).toEqual({ x: 10, y: 10, z: -9.5 });
    await until(() => c.status.state === 'Idle');
    expect(c.status.wpos.z).toBeCloseTo(AREA.endZ, 2); // raised to the end height, well clear of the board
    expect(c.lock).toBeTruthy();                        // clip still on until confirmed
    p.confirm(p.info.id, 'confirmRemove');
    expect(c.lock).toBeUndefined();
    await c.disconnect();
  }, 120000);

  it('aborts on a missed point instead of recording a fake height', async () => {
    const { sim, c, p, store } = await setup();
    sim.probeConnected = false;
    await scan(p);
    expect(p.info.success).toBe(false);
    expect(p.info.error).toMatch(/Scan failed at point 1\/9/);
    expect(store.map).toBeNull();
    p.confirm(p.info.id, 'confirmRemove');
    await c.disconnect();
  }, 120000);

  it('stops if the probe reads triggered before a point (board higher than the safe height)', async () => {
    const { sim, c, p, store } = await setup();
    sim.surfaceFn = (x, y) => (x > 15 ? 50 : surface(x, y)); // a huge bump on the right
    await scan(p);
    expect(p.info.success).toBe(false);
    expect(p.info.error).toMatch(/triggered/);
    expect(store.map).toBeNull();
    p.confirm(p.info.id, 'confirmRemove');
    await c.disconnect();
  }, 120000);

  it.each([
    ['1 column', { ...AREA, cols: 1 }],
    ['empty area', { ...AREA, maxX: 0 }],
    ['too many points', { ...AREA, cols: 31 }],
    ['unsafe height', { ...AREA, safeZ: 0.1 }],
    ['crazy depth', { ...AREA, depth: 50 }],
    ['end height below travel height', { ...AREA, endZ: 1 }],
    ['end height missing', { ...AREA, endZ: undefined as unknown as number }],
    ['NaN', { ...AREA, minY: NaN }],
  ])('rejects invalid scan settings: %s', async (_n, area) => {
    const { c, p } = await setup();
    p.start('autolevel', SETTINGS, area as AutolevelParams);
    expect(p.info.phase).toBe('idle');
    p.start('autolevel', SETTINGS); // missing entirely
    expect(p.info.phase).toBe('idle');
    await c.disconnect();
  });
});

describe('applying a height map to a job', () => {
  const map = (): HeightMap => ({
    cols: 3, rows: 3, minX: 0, maxX: 20, minY: 0, maxY: 10, scannedAt: 1,
    z: [0, 1, 2].map((j) => [0, 1, 2].map((i) => workH(i * 10, j * 5))),
    wco: { x: 10, y: 10, z: -9.5 },
  });
  const PROGRAM = ['G21', 'G90', 'G0 Z2', 'G0 X1 Y1', 'G1 Z-0.1 F100', 'G1 X19 Y9 F300', 'G0 Z2'].join('\n');

  it('creates a levelled copy, keeps the original, and can revert', async () => {
    const { c } = await setup();
    c.loadJob('board.nc', PROGRAM);
    expect(c.job.bounds).toEqual({ minX: 1, maxX: 19, minY: 1, maxY: 9 });
    c.levelJob(map());
    expect(c.job.name).toBe('board.leveled.nc');
    expect(c.job.leveled?.linesBefore).toBe(7);
    expect(c.job.leveled!.linesAfter).toBeGreaterThan(10);
    expect(c.job.leveled!.zeroChanged).toBe(false);
    expect(c.job.leveled!.outside).toBe(0);
    expect(c.jobText()).toMatch(/G1X19Y9Z/);

    // extents describe the program that will run: the levelled one has the surface added to Z
    const lvl = c.job.extents!.cut!;
    expect(lvl.minZ).toBeCloseTo(-0.1 + workH(1, 1), 3); // lowest point of the cut is at (1,1), the low corner
    c.revertJob();
    expect(c.job.extents!.cut).toMatchObject({ minX: 1, maxX: 19, minY: 1, maxY: 9, minZ: -0.1, maxZ: 0 });
    c.levelJob(map());
    c.revertJob();
    expect(c.job.name).toBe('board.nc');
    expect(c.job.leveled).toBeUndefined();
    expect(c.job.totalLines).toBe(7);
    await c.disconnect();
  });

  it('runs a levelled job on the machine and ends with the tool at the corrected depth', async () => {
    const { c } = await setup();
    c.loadJob('board.nc', ['G21', 'G90', 'G0 Z1', 'G0 X0 Y0', 'G1 Z-0.1 F600', 'G1 X20 Y10 F3000'].join('\n'));
    expect(c.job.bounds).toBeDefined();
    c.levelJob(map());
    expect(c.job.leveled).toBeDefined(); // guard: the run below must be the levelled program
    c.startJob();
    await until(() => c.job.state === 'done', 60000);
    // programmed Z -0.1 plus surface height at (20,10), in work coordinates
    expect(c.status.wpos.z).toBeCloseTo(-0.1 + workH(20, 10), 2);
    await c.disconnect();
  }, 90000);

  it('warns when the work zero has moved since the scan or the program leaves the scanned area', async () => {
    const { c } = await setup();
    c.loadJob('wide.nc', ['G0 X0 Y0 Z1', 'G1 X50 Y5 Z0 F300'].join('\n'));
    c.levelJob({ ...map(), wco: { x: 0, y: 0, z: 0 } });
    expect(c.job.leveled!.zeroChanged).toBe(true);
    expect(c.job.leveled!.outside).toBeGreaterThan(0);
    expect(c.job.leveled!.warnings.length).toBe(2);
    await c.disconnect();
  });

  it('refuses programs it cannot level correctly and leaves the job untouched', async () => {
    const { c } = await setup();
    c.loadJob('rel.nc', ['G21', 'G91', 'G0 X1'].join('\n'));
    c.levelJob(map());
    expect(c.job.leveled).toBeUndefined();
    expect(c.job.name).toBe('rel.nc');
    expect(c.job.levelError).toMatch(/Line 2.*G91/); // shown on the panel, not only in the console
    expect(c.logBuffer.some((l) => l.text.includes('Autolevel not applied') && l.text.includes('Line 2'))).toBe(true);
    await c.disconnect();
  });

  it('needs a loaded file and a height map, and will not change a running job', async () => {
    const { c } = await setup();
    c.levelJob(map());
    expect(c.logBuffer.some((l) => l.text.includes('Load a G-code file first'))).toBe(true);
    c.loadJob('a.nc', 'G0 X0 Y0 Z0\nG1 X50 F60');
    c.levelJob(null);
    expect(c.logBuffer.some((l) => l.text.includes('No height map'))).toBe(true);
    c.startJob();
    await until(() => c.status.state === 'Run');
    c.levelJob(map());
    expect(c.job.leveled).toBeUndefined();
    await c.stopJob();
    await c.disconnect();
  }, 30000);
});

describe('already-levelled files', () => {
  const map = (): HeightMap => ({
    cols: 3, rows: 3, minX: 0, maxX: 20, minY: 0, maxY: 10, scannedAt: Date.UTC(2026, 9, 4, 12, 0, 0),
    z: [0, 1, 2].map((j) => [0, 1, 2].map((i) => workH(i * 10, j * 5))),
  });
  const PROGRAM = ['G21', 'G90', 'G0 Z2', 'G0 X1 Y1', 'G1 Z-0.1 F100', 'G1 X19 Y9 F300', 'G0 Z2'].join('\n');

  it('writes a header into the downloaded levelled program, but not into what streams', async () => {
    const { c } = await setup();
    c.loadJob('board.nc', PROGRAM);
    expect(c.job.alreadyLeveled).toBeUndefined();
    c.levelJob(map());
    const text = c.jobText().split('\n');
    expect(text[0]).toMatch(/^\(DemonX autolevel v1: 3x3 points, scanned 2026-10-04T12:00:00.000Z, Z corrected .* from board\.nc\)$/);
    expect(text[1]).toBe('G21');
    expect(c.job.totalLines).toBe(c.jobText().trim().split('\n').length - 1); // the comment is not a streamed line
    await c.disconnect();
  });

  it('recognises its own header even when the file has been renamed', async () => {
    const { c } = await setup();
    c.loadJob('board.nc', PROGRAM);
    c.levelJob(map());
    const saved = c.jobText();
    c.loadJob('renamed-by-user.nc', saved); // no ".leveled." in the name
    expect(c.job.alreadyLeveled?.source).toBe('header');
    expect(c.job.alreadyLeveled?.info).toMatch(/3x3 points, scanned 2026-10-04/);
    expect(c.job.leveled).toBeUndefined(); // it was not levelled in this session
    await c.disconnect();
  });

  it('recognises older exports by a .leveled. file name', async () => {
    const { c } = await setup();
    c.loadJob('10.4.26Circuit_Iso_pass1.LEVELED.gcode', PROGRAM);
    expect(c.job.alreadyLeveled).toEqual({ source: 'filename', info: undefined });
    c.loadJob('plain.nc', PROGRAM);
    expect(c.job.alreadyLeveled).toBeUndefined();
    c.loadJob('levelled-in-name-only.nc', PROGRAM); // "leveled" without the dots is not treated as a marker
    expect(c.job.alreadyLeveled).toBeUndefined();
    await c.disconnect();
  });

  it('refuses to level a file twice, because that would correct Z twice', async () => {
    const { c } = await setup();
    c.loadJob('board.leveled.nc', PROGRAM);
    c.levelJob(map());
    expect(c.job.leveled).toBeUndefined();
    expect(c.job.name).toBe('board.leveled.nc');
    expect(c.job.levelError).toMatch(/already autolevelled/);
    expect(c.job.totalLines).toBe(7); // untouched
    await c.disconnect();
  });
});

describe('height map store', () => {
  const m: HeightMap = { cols: 2, rows: 2, minX: 0, maxX: 1, minY: 0, maxY: 1, z: [[0, 0.1], [0.2, 0.3]], scannedAt: 5 };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-'));

  it('keeps the last scan on disk but does NOT load it at startup', () => {
    const dir = tmp();
    new HeightMapStore(dir).set(m);
    const after = new HeightMapStore(dir); // a restart
    expect(after.map).toBeNull();
    expect(after.saved).toEqual({ cols: 2, rows: 2, scannedAt: 5 });
  });

  it('restores the saved scan on request', () => {
    const dir = tmp();
    new HeightMapStore(dir).set(m);
    const after = new HeightMapStore(dir);
    let announced: unknown = 'nothing';
    after.on('heightmap', (x) => { announced = x; });
    expect(after.restore()).toBe(true);
    expect(after.map).toEqual(m);
    expect(announced).toEqual(m);
    expect(new HeightMapStore(tmp()).restore()).toBe(false); // nothing saved there
  });

  it('can be told to load automatically (a PCB-only machine)', () => {
    const dir = tmp();
    new HeightMapStore(dir).set(m);
    expect(new HeightMapStore(dir, { autoload: true }).map).toEqual(m);
  });

  it('clearing forgets the saved scan too', () => {
    const dir = tmp();
    const s = new HeightMapStore(dir); s.set(m); s.set(null);
    expect(s.saved).toBeNull();
    expect(new HeightMapStore(dir).saved).toBeNull();
  });

  it('rejects malformed maps', () => {
    expect(validateHeightMap(m)).toBeNull();
    expect(validateHeightMap({ ...m, cols: 3 })).toMatch(/columns/);
    expect(validateHeightMap({ ...m, z: [[0, NaN], [0, 0]] })).toMatch(/invalid height/);
    expect(validateHeightMap({ ...m, maxX: 0 })).toMatch(/no size/);
    expect(validateHeightMap({ ...m, z: [[0, 500], [0, 0]] })).toMatch(/invalid height/);
    expect(validateHeightMap(null)).toBeTruthy();
  });
});
