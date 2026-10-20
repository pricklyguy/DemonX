import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GrblController } from '../src/controller.js';
import { SimulatorTransport } from '../src/simulator.js';
import { MachineSettingsService } from '../src/machinesettings.js';
import { BedService } from '../src/bed.js';
import { defaultManualBed, type MachineBed, type ManualBed } from '../../shared/bed.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); } }

async function setup(kind: 'grbl' | 'fluidnc', manual: () => ManualBed = defaultManualBed, dataDir?: string) {
  const c = new GrblController();
  const s = new MachineSettingsService(c);
  const b = new BedService(c, s, manual, () => false, dataDir, 100);
  const got: (MachineBed | null)[] = [];
  b.on('bed', (d) => got.push(d));
  await c.connect(new SimulatorTransport(1, kind), 'simulator');
  return { c, b, got };
}

describe('BedService', () => {
  it('reads the size from a GRBL controller a moment after connecting', async () => {
    const { c, b, got } = await setup('grbl');
    expect(b.current).toBeNull();
    await until(() => got.length > 0);
    expect(b.current).toMatchObject({ minX: -200, maxX: 0, minY: -200, maxY: 0, source: 'grbl' });   // the simulator's $130 to $132 are 200
    await c.disconnect();
  });

  it('reads a FluidNC config the same way', async () => {
    const { c, b, got } = await setup('fluidnc');
    await until(() => got.length > 0);
    expect(b.current).toMatchObject({ minX: 10, maxX: 1229, minY: 10, maxY: 1320, source: 'fluidnc' });
    await c.disconnect();
  });

  it('typed-in numbers win over the controller, and going back to the controller works', async () => {
    let manual: ManualBed = { ...defaultManualBed(), enabled: true, x: 500, y: 400, z: 50 };
    const { c, b, got } = await setup('grbl', () => manual);
    expect(b.current).toMatchObject({ maxX: 0, minX: -500, source: 'manual' });
    await until(() => got.length > 0);
    expect(b.current?.source).toBe('manual');
    manual = defaultManualBed(); b.changed();
    expect(b.current?.source).toBe('grbl');
    await c.disconnect();
  });

  it('keeps what it read for the next start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-bed-'));
    const one = await setup('fluidnc', defaultManualBed, dir);
    await until(() => one.got.length > 0);
    await one.c.disconnect();
    const c2 = new GrblController();
    const b2 = new BedService(c2, new MachineSettingsService(c2), defaultManualBed, () => false, dir);
    expect(b2.current).toMatchObject({ maxX: 1229, source: 'fluidnc' });          // known before any connection
  });
});
