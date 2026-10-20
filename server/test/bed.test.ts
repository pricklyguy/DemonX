import { describe, it, expect } from 'vitest';
import { bedFromGrbl, bedFromFluidNc, bedFromManual, bedInWork, defaultManualBed } from '../../shared/bed.js';
import { applyUpdate, defaultConfig, publicView, ConfigError } from '../src/config.js';
import { parseConfigText } from '../src/machinesettings.js';
import { SIM_CONFIG_YAML } from '../src/sim-fluidnc-config.js';

describe('machine bed from GRBL settings', () => {
  it('uses the travels, with machine zero at the far end by default', () => {
    expect(bedFromGrbl({ $130: 400, $131: 300, $132: 80 })).toEqual({ minX: -400, maxX: 0, minY: -300, maxY: 0, minZ: -80, maxZ: 0, source: 'grbl' });
  });
  it('$23 flips the axes that home towards the negative end', () => {
    const b = bedFromGrbl({ $130: 400, $131: 300, $132: 80, $23: 0b001 })!;     // only X
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([0, 400, -300, 0]);
    const c = bedFromGrbl({ $130: 400, $131: 300, $132: 80, $23: 0b110 })!;     // Y and Z
    expect([c.minX, c.maxX, c.minY, c.maxY, c.minZ, c.maxZ]).toEqual([-400, 0, 0, 300, 0, 80]);
  });
  it('is unknown without X and Y travel, and Z is optional', () => {
    expect(bedFromGrbl({ $130: 400 })).toBeNull();
    expect(bedFromGrbl({})).toBeNull();
    expect(bedFromGrbl({ $130: 0, $131: 300 })).toBeNull();
    const b = bedFromGrbl({ $130: 400, $131: 300 })!;
    expect([b.minZ, b.maxZ]).toEqual([0, 0]);
  });
});

describe('machine bed from a FluidNC config', () => {
  const values = parseConfigText(SIM_CONFIG_YAML)!;
  it("reads a real machine's config: X and Y home at the near end with 10 mm at the switch, Z homes at the top", () => {
    const b = bedFromFluidNc(values)!;
    expect(b.source).toBe('fluidnc');
    expect([b.minX, b.maxX]).toEqual([10, 1229]);        // positive_direction false, mpos_mm 10, travel 1219
    expect([b.minY, b.maxY]).toEqual([10, 1320]);        // travel 1310
    expect([b.minZ, b.maxZ]).toEqual([-178, -3]);        // positive_direction true, mpos_mm -3, travel 175
  });
  it('finds the axes whatever case the controller prints them in (a real FluidNC prints X, Y, Z)', () => {
    const upper = SIM_CONFIG_YAML.replace(/^  x:$/m, '  X:').replace(/^  y:$/m, '  Y:').replace(/^  z:$/m, '  Z:');
    const vals = parseConfigText(upper)!;
    expect(Object.keys(vals).some((k) => k.startsWith('axes/X/'))).toBe(true);
    const b = bedFromFluidNc(vals)!;
    expect([b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ]).toEqual([10, 1229, 10, 1320, -178, -3]);
    // homing written as text, as some controllers print it
    const c = bedFromFluidNc({ 'axes/X/max_travel_mm': '300.000', 'axes/Y/max_travel_mm': 200, 'axes/X/homing/positive_direction': 'false', 'axes/X/homing/mpos_mm': '0' })!;
    expect([c.minX, c.maxX, c.minY, c.maxY]).toEqual([0, 300, -200, 0]);
  });
  it('defaults to homing at the far end with machine zero at the switch when the config does not say', () => {
    const b = bedFromFluidNc({ 'axes/x/max_travel_mm': 300, 'axes/y/max_travel_mm': 200 })!;
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-300, 0, -200, 0]);
  });
  it('is unknown without X and Y travel', () => {
    expect(bedFromFluidNc({ 'axes/x/max_travel_mm': 300 })).toBeNull();
  });
});

describe('manual machine size and the work-coordinate box', () => {
  it('is nothing until switched on, then uses the numbers and which end machine zero is at', () => {
    expect(bedFromManual(defaultManualBed())).toBeNull();
    const m = { enabled: true, x: 600, y: 400, z: 60, zeroAtMax: { x: false, y: true, z: true } };
    expect(bedFromManual(m)).toEqual({ minX: 0, maxX: 600, minY: -400, maxY: 0, minZ: -60, maxZ: 0, source: 'manual' });
    expect(bedFromManual({ ...m, x: 0 })).toBeNull();
  });
  it('moves to work coordinates by taking off the work offset', () => {
    const bed = bedFromGrbl({ $130: 400, $131: 300, $132: 80 })!;
    expect(bedInWork(bed, { x: -100, y: -50, z: -20 })).toEqual({ minX: -300, maxX: 100, minY: -250, maxY: 50, minZ: -60, maxZ: 20 });
  });
});

describe('machine size in the saved setup', () => {
  it('is off by default and is validated like every other setting', () => {
    const c = defaultConfig();
    expect(c.machine.bed.enabled).toBe(false);
    expect(() => applyUpdate(c, { machine: { bed: { enabled: true } } })).toThrow(ConfigError);                        // no X and Y yet
    expect(() => applyUpdate(c, { machine: { bed: { x: -5 } } })).toThrow(ConfigError);
    expect(() => applyUpdate(c, { machine: { bed: { y: 1e9 } } })).toThrow(ConfigError);
    expect(() => applyUpdate(c, { machine: { bed: { x: 'wide' as never } } })).toThrow(ConfigError);
    const n = applyUpdate(c, { machine: { bed: { enabled: true, x: 600.123, y: 400, zeroAtMax: { x: false } } } });
    expect(n.machine.bed).toEqual({ enabled: true, x: 600.12, y: 400, z: 0, zeroAtMax: { x: false, y: true, z: true } });
    expect(publicView(n).machine.bed.x).toBe(600.12);
    expect(c.machine.bed.enabled).toBe(false);                                                                          // the old one is untouched
  });
});
