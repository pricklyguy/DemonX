import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GrblController } from '../src/controller.js';
import { SimulatorTransport } from '../src/simulator.js';
import { MachineSettingsService, SettingsError, flattenConfig, parseConfigText } from '../src/machinesettings.js';
import { checkFluidNcChange, checkGrblChange, isReadOnlyKey, sameValue } from '../../shared/machine-settings.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); }
}
const fixture = fs.readFileSync(new URL('./fixtures/demoncarve-config.yaml', import.meta.url), 'utf8');
/** The controller prints a file line by line, so compare without line-ending and trailing-space differences */
const norm = (t: string | undefined) => (t ?? '').replace(/\r/g, '').replace(/[ \t]+$/gm, '').trimEnd();

describe('config text', () => {
  it('flattens a real DemonCarve config into the paths $/… uses', () => {
    const f = parseConfigText(fixture)!;
    expect(f['axes/x/acceleration_mm_per_sec2']).toBe(800);
    expect(f['axes/y/acceleration_mm_per_sec2']).toBe(400);
    expect(f['axes/z/homing/mpos_mm']).toBe(-3);               // a value with trailing spaces
    expect(f['axes/y/motor1/limit_neg_pin']).toBe('gpio.39:low:pu');
    expect(f['10V/speed_map']).toBe('0=0.000% 1000=0.000% 24000=100.000%');
    expect(f['start/must_home']).toBe(true);
    expect(f['axes/shared_stepper_disable_pin']).toBe('NO_PIN');
    expect(f['board']).toBe('Dobermann S3');
  });

  it('rejects text that is not a config', () => {
    expect(parseConfigText('')).toBeUndefined();
    expect(parseConfigText('board: x\nname: y')).toBeUndefined();     // no axes: not a machine config
    expect(parseConfigText('axes:\n  x: [1, 2\n')).toBeUndefined();   // broken YAML
    expect(flattenConfig({ a: { b: 1, c: [1, 2], d: null } })).toEqual({ 'a/b': 1, 'a/d': '' });
  });
});

describe('what may be changed', () => {
  it('keeps hardware wiring read-only and checks the numbers', () => {
    for (const k of ['board', 'axes/x/motor0/standard_stepper/step_pin', 'axes/x/motor0/limit_neg_pin', 'probe/pin', 'uart1/baud', 'i2so/bck_pin', 'spi/miso_pin', 'stepping/engine']) {
      expect(isReadOnlyKey(k), k).toBe(true);
    }
    for (const k of ['axes/x/acceleration_mm_per_sec2', 'axes/x/homing/cycle', 'axes/x/motor0/pulloff_mm', 'coolant/delay_ms', '10V/speed_map', 'start/must_home']) {
      expect(isReadOnlyKey(k), k).toBe(false);
    }
    const acc = 'axes/x/acceleration_mm_per_sec2';
    expect(checkFluidNcChange(acc, 400, 800)).toBeUndefined();
    expect(checkFluidNcChange(acc, '400', 800)).toBeUndefined();
    expect(checkFluidNcChange(acc, 0, 800)).toMatch(/at least 1/);
    expect(checkFluidNcChange(acc, 'fast', 800)).toMatch(/must be a number/);
    expect(checkFluidNcChange(acc, NaN, 800)).toMatch(/must be a number/);
    expect(checkFluidNcChange('axes/x/steps_per_mm', 0, 133)).toMatch(/at least/);
    expect(checkFluidNcChange('axes/x/homing/cycle', 1.5, 2)).toMatch(/whole number/);
    expect(checkFluidNcChange('axes/x/soft_limits', 'yes', false)).toMatch(/on or off/);
    expect(checkFluidNcChange('axes/x/motor0/limit_neg_pin', 'gpio.1', 'gpio.2')).toMatch(/wired to the hardware/);
    expect(checkFluidNcChange('axes/q/acceleration_mm_per_sec2', 5, undefined)).toMatch(/not a setting of this machine/);
    expect(checkFluidNcChange('axes/x/../../etc', 5, 1)).toMatch(/not a setting name/);
    expect(checkFluidNcChange('10V/speed_map', 'a\nb', '0=0%')).toMatch(/one line/);
    expect(checkGrblChange('$120', 50, 10)).toBeUndefined();
    expect(checkGrblChange('$120', -1, 10)).toMatch(/out of range/);
    expect(checkGrblChange('$21', 2, 0)).toMatch(/0 \(off\) or 1/);
    expect(checkGrblChange('120', 5, 10)).toMatch(/not a \$ setting/);
    expect(sameValue(800, '800.000')).toBe(true);
    expect(sameValue('NO_PIN', 'NO_PIN')).toBe(true);
    expect(sameValue('I2SO.3', 'i2so.3')).toBe(true);        // the dump and the file may print the same thing differently
    expect(sameValue('a  b', 'A b')).toBe(true);
    expect(sameValue('0=0.00% 1000=0.00% 24000=100.00%', '0=0.000% 1000=0.000% 24000=100.000%')).toBe(true);   // seen on a real controller
    expect(sameValue('0=0.00% 24000=100.00%', '0=0.00% 24000=90.00%')).toBe(false);
    expect(sameValue('gpio.4', 'gpio.40')).toBe(false);
    expect(sameValue(true, 'true')).toBe(true);        // (a config value is a real boolean; this only matters for text typed in a box)
  });
});

describe('FluidNC settings service', () => {
  async function setup(firmware: 'fluidnc' | 'grbl' = 'fluidnc') {
    const c = new GrblController();
    const sim = new SimulatorTransport(50, firmware);
    await c.connect(sim, 'simulator');
    await until(() => c.status.state === 'Idle' && !!c.connection.firmware);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-ms-'));
    return { c, sim, dir, svc: new MachineSettingsService(c, dir) };
  }
  const txs = (c: GrblController) => c.logBuffer.filter((l) => l.kind === 'tx').map((l) => l.text);

  it('reads the running config and the saved file, and says nothing is unsaved', async () => {
    const { c, svc } = await setup();
    const s = await svc.read();
    expect(s.kind).toBe('fluidnc');
    expect(s.file).toBe('/config.yaml');
    expect(s.values['axes/x/acceleration_mm_per_sec2']).toBe(800);
    expect(s.saved!['axes/x/acceleration_mm_per_sec2']).toBe(800);
    expect(s.unsaved).toEqual([]);
    expect(c.lock).toBeUndefined();                       // the lock is released again
    expect(c.logBuffer.some((l) => l.text.includes('Dobermann'))).toBe(false);   // the dump did not flood the console
    await c.disconnect();
  });

  it('does not report wiring or print-format differences as unsaved changes', async () => {
    const { c, sim, svc } = await setup();
    // the file spells pins and an enum differently from the controller's own dump
    sim.settings.setFile('/config.yaml', sim.settings.file('/config.yaml')!.replace('24000=100.000%', '24000=100.0%').replace('I2SO.3', 'i2so.3').replace('I2S_STATIC', 'i2s_static').replace('gpio.42:low:pu', 'GPIO.42:LOW:PU'));
    const s = await svc.read();
    expect(s.unsaved).toEqual([]);
    await c.disconnect();
  });

  it('applies a change at once but leaves the file alone, and reports it as unsaved', async () => {
    const { c, sim, svc } = await setup();
    const before = sim.settings.file('/config.yaml');
    const s = await svc.apply([{ key: 'axes/x/acceleration_mm_per_sec2', value: 400 }]);
    expect(s.values['axes/x/acceleration_mm_per_sec2']).toBe(400);
    expect(s.saved!['axes/x/acceleration_mm_per_sec2']).toBe(800);
    expect(s.unsaved).toEqual(['axes/x/acceleration_mm_per_sec2']);
    expect(sim.settings.file('/config.yaml')).toBe(before);
    expect(txs(c)).toContain('$/axes/x/acceleration_mm_per_sec2=400');
    await c.disconnect();
  });

  it('refuses bad changes before sending anything', async () => {
    const { c, svc } = await setup();
    await expect(svc.apply([{ key: 'axes/x/acceleration_mm_per_sec2', value: 0 }])).rejects.toThrow(/at least 1/);
    await expect(svc.apply([{ key: 'axes/x/motor0/limit_neg_pin', value: 'gpio.1' }])).rejects.toThrow(/wired to the hardware/);
    await expect(svc.apply([{ key: 'axes/x/acceleration_mm_per_sec2', value: 400 }, { key: 'axes/q/steps_per_mm', value: 5 }])).rejects.toThrow(/not a setting/);
    expect(txs(c).some((t) => t.startsWith('$/'))).toBe(false);          // none of the valid ones went out either
    await c.disconnect();
  });

  it('puts back what it changed when the controller refuses one', async () => {
    const { c, sim, svc } = await setup();
    sim.settings.refuse.add('axes/y/acceleration_mm_per_sec2');
    await expect(svc.apply([
      { key: 'axes/x/acceleration_mm_per_sec2', value: 400 }, { key: 'axes/y/acceleration_mm_per_sec2', value: 300 },
    ])).rejects.toThrow(/refused axes\/y\/acceleration_mm_per_sec2.*put back/);
    sim.settings.refuse.clear();
    const s = await svc.read();
    expect(s.values['axes/x/acceleration_mm_per_sec2']).toBe(800);
    await c.disconnect();
  });

  it('saves: backs up the old file, writes a checked new one, and keeps the old on the controller', async () => {
    const { c, sim, svc, dir } = await setup();
    await svc.apply([{ key: 'axes/x/acceleration_mm_per_sec2', value: 400 }, { key: 'axes/y/acceleration_mm_per_sec2', value: 300 }]);
    const r = await svc.save();
    expect(r.settings.unsaved).toEqual([]);
    expect(parseConfigText(sim.settings.file('/config.yaml')!)!['axes/x/acceleration_mm_per_sec2']).toBe(400);
    expect(parseConfigText(sim.settings.file('/config.yaml')!)!['axes/y/acceleration_mm_per_sec2']).toBe(300);
    expect(norm(sim.settings.file('/config.backup.yaml'))).toBe(norm(fixture));      // the old file, on the controller
    expect(sim.settings.file('/config.new.yaml')).toBeUndefined();                   // no leftovers
    expect(r.backup).toMatch(/^config-.*\.yaml$/);
    expect(norm(fs.readFileSync(path.join(dir, 'fluidnc-backups', r.backup!), 'utf8'))).toBe(norm(fixture));   // ...and here, with its comments
    expect(svc.backups()).toEqual([r.backup]);
    expect(svc.backupText(r.backup!)).toMatch(/# Home Assistant Pendant UART/);
    expect(svc.backupText('../../etc/passwd.yaml')).toBeUndefined();
    await c.disconnect();
  });

  it('leaves config.yaml untouched when the new file does not read back right', async () => {
    const { c, sim, svc } = await setup();
    await svc.apply([{ key: 'axes/x/acceleration_mm_per_sec2', value: 400 }]);
    sim.settings.failNextDump = true;                                                  // the dump stops half way
    await expect(svc.save()).rejects.toThrow(/did not read back correctly.*not changed/);
    expect(norm(sim.settings.file('/config.yaml'))).toBe(norm(fixture));
    expect(sim.settings.file('/config.new.yaml')).toBeUndefined();                    // the broken temp file is removed
    // and it can be tried again
    expect((await svc.save()).settings.unsaved).toEqual([]);
    await c.disconnect();
  });

  it('a restart brings back the saved values, and Unsaved is cleared', async () => {
    const { c, sim, svc } = await setup();
    await svc.apply([{ key: 'axes/x/acceleration_mm_per_sec2', value: 400 }]);
    await svc.restart();
    await until(() => sim.settings.file('/config.yaml') !== undefined && c.status.state === 'Idle');
    await wait(300);
    const s = await svc.read();
    expect(s.values['axes/x/acceleration_mm_per_sec2']).toBe(800);
    expect(s.unsaved).toEqual([]);
    await c.disconnect();
  });

  it('will not run during a job, while not idle, or during another operation', async () => {
    const { c, svc } = await setup();
    c.loadJob('j.nc', 'G0 X1\nG0 X2'); c.startJob();
    await expect(svc.read()).rejects.toThrow(/Not while a job/);
    c.softReset(); await wait(300);
    c.lock = 'A probe is running';
    await expect(svc.read()).rejects.toThrow(/Blocked: A probe is running/);
    c.lock = undefined;
    await c.disconnect();
    await expect(svc.read()).rejects.toThrow(SettingsError);
  });

  it('GRBL: lists $ settings, changes them, refuses nonsense; nothing to save', async () => {
    const { c, svc } = await setup('grbl');
    const s = await svc.read();
    expect(s.kind).toBe('grbl');
    expect(s.values['$120']).toBe(10);
    expect(s.saved).toBeUndefined();
    const after = await svc.apply([{ key: '$120', value: 50 }]);
    expect(after.values['$120']).toBe(50);
    await expect(svc.apply([{ key: '$21', value: 2 }])).rejects.toThrow(/0 \(off\) or 1/);
    await expect(svc.apply([{ key: '$999', value: 1 }])).rejects.toThrow(/not a setting/);
    await expect(svc.save()).rejects.toThrow(/Only FluidNC keeps a config file/);
    await c.disconnect();
  });
});
