import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileMacro, validateMacro, MacroStore, MacroError } from '../src/macros.js';
import { GrblController } from '../src/controller.js';
import { SimulatorTransport } from '../src/simulator.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); }
}
const vars = { minX: 133.402, maxX: 1085.797, minY: 36.561, maxY: 1182.641, minZ: -10.5, maxZ: 20.32 };

describe('compileMacro', () => {
  it('strips comments, keeps %wait, and fills in the program extents', () => {
    const steps = compileMacro('; frame\n%wait\nG90 ; absolute\nG0 X[xmin] Y[YMIN] (corner)\n\nG1 X[xmax]Y[ymax]', vars);
    expect(steps).toEqual([
      { kind: 'wait' }, { kind: 'line', text: 'G90' }, { kind: 'line', text: 'G0 X133.402 Y36.561' }, { kind: 'line', text: 'G1 X1085.797Y1182.641' },
    ]);
  });

  it('refuses probing in every spelling, so a macro cannot get around the probe safety questions', () => {
    for (const l of ['G38.2 Z-25 F75', 'g38.3 X10', 'G91 G38.2 Z-5', 'G038.2 Z-1', 'G38.5 Z-1', 'G37']) {
      expect(() => compileMacro(l), l).toThrow(/probing \(G38\) is not allowed/);
    }
    expect(() => compileMacro('G0 Z3.8')).not.toThrow();           // 3.8 is not G38
    expect(() => compileMacro('G0 X138 Y37')).not.toThrow();
    expect(() => compileMacro('G90 ; G38.2 in a comment is only a comment')).not.toThrow();
  });

  it('explains what it cannot do', () => {
    expect(() => compileMacro('G0 X[xmin]')).toThrow(/no G-code file is loaded/);
    expect(() => compileMacro('G0 X[foo]', vars)).toThrow(/\[foo\] is not known/);
    expect(() => compileMacro('%ENDMILL = 3', vars)).toThrow(/only %wait/);
    expect(() => compileMacro('G0 X' + '1'.repeat(200))).toThrow(/too long/);
  });
});

describe('validateMacro and MacroStore', () => {
  it('needs a name and some commands, and checks variables with sample values', () => {
    expect(() => validateMacro({ name: ' ', content: 'G0 X1' })).toThrow(MacroError);
    expect(() => validateMacro({ name: 'x', content: '; only a comment' })).toThrow(/no commands/);
    expect(validateMacro({ name: ' Frame ', content: 'G0 X[xmin]' })).toEqual({ name: 'Frame', content: 'G0 X[xmin]' });
    expect(() => validateMacro({ name: 'p', content: 'G38.2 Z-5' })).toThrow(/probing/);
  });

  it('starts with Move to Back, keeps changes in a file, and survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-macros-'));
    const a = new MacroStore(dir);
    expect(a.list.map((m) => m.name)).toEqual(['Move to Back']);
    expect(a.list[0].content).toMatch(/G0 X0 Y90/);
    const seen: number[] = [];
    a.on('macros', (l) => seen.push(l.length));
    a.save({ name: 'Park', content: 'G0 X0 Y0' });
    a.save({ id: a.list[0].id, name: 'Back', content: 'G0 Y90' });
    expect(a.list.map((m) => m.name)).toEqual(['Back', 'Park']);
    expect(seen).toEqual([2, 2]);
    const b = new MacroStore(dir);
    expect(b.list.map((m) => m.name)).toEqual(['Back', 'Park']);
    b.remove(b.list[0].id);
    expect(new MacroStore(dir).list.map((m) => m.name)).toEqual(['Park']);
  });

  it('skips a damaged entry in the file instead of failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-macros-'));
    fs.writeFileSync(path.join(dir, 'macros.json'), JSON.stringify([{ id: 'a', name: 'ok', content: 'G0 X1' }, { id: 'b', name: 'probe', content: 'G38.2 Z-5' }, 7]));
    expect(new MacroStore(dir).list.map((m) => m.name)).toEqual(['ok']);
  });
});

describe('running a macro', () => {
  async function setup() {
    const c = new GrblController();
    await c.connect(new SimulatorTransport(50), 'simulator');
    await until(() => c.status.state === 'Idle' && !!c.connection.firmware);
    return c;
  }

  it('sends the lines, locks other commands while it runs, then unlocks', async () => {
    const c = await setup();
    const run = c.runMacro('Back', 'G90\nG0 X0 Y40\n%wait\nG0 X5');
    expect(c.lock).toMatch(/macro "Back" is running/);
    c.handle({ type: 'jog', dx: 1, feed: 3000 });
    expect(c.logBuffer.some((l) => l.kind === 'err' && l.text.includes('Blocked'))).toBe(true);
    await run;
    expect(c.lock).toBeUndefined();
    expect(c.status.wpos).toMatchObject({ x: 5, y: 40 });
    expect(c.logBuffer.some((l) => l.text.includes('Macro "Back" finished'))).toBe(true);
    await c.disconnect();
  });

  it('is refused during a job, when not idle, and for a probing line; nothing is sent', async () => {
    const c = await setup();
    c.loadJob('j.nc', 'G0 X1\nG0 X2');
    c.startJob();
    await c.runMacro('m', 'G0 X9');
    expect(c.logBuffer.some((l) => l.text.includes('Cannot run a macro during a job'))).toBe(true);
    c.softReset(); await wait(300);
    await c.runMacro('p', 'G0 X9\nG38.2 Z-5 F50');
    expect(c.logBuffer.some((l) => l.text.includes('probing (G38) is not allowed'))).toBe(true);
    expect(c.logBuffer.filter((l) => l.kind === 'tx').some((l) => l.text === 'G0 X9')).toBe(false);   // the whole macro was refused, not half run
    await c.disconnect();
  });

  it('stops when the machine is reset part way', async () => {
    const c = await setup();
    const run = c.runMacro('long', 'G0 X0 Y100\n%wait\nG0 X50');
    await wait(150);
    c.softReset();
    await run;
    expect(c.logBuffer.some((l) => l.kind === 'err' && l.text.includes('Macro "long" stopped'))).toBe(true);
    expect(c.logBuffer.filter((l) => l.kind === 'tx').some((l) => l.text === 'G0 X50')).toBe(false);
    expect(c.lock).toBeUndefined();
    await c.disconnect();
  });
});
