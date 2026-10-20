import { describe, it, expect } from 'vitest';
import { PadSession, speeds, stick, BTN, DEADZONE, type PadInput } from '../../shared/gamepad.js';

const S = { speed: 50, xyFeed: 3000, zFeed: 300 };
const btns = (...on: number[]) => { const b = new Array(16).fill(false); for (const n of on) b[n] = true; return b; };
const input = (over: Partial<PadInput> = {}): PadInput => ({ active: true, focused: true, allowed: true, axes: [0, 0, 0, 0], buttons: btns(), ...over });
/** a session that is armed */
const armed = () => { const p = new PadSession(); p.update(input({ buttons: btns(BTN.START) }), S); p.update(input(), S); return p; };

describe('sticks', () => {
  it('ignore small movements and drift', () => {
    expect(stick(0.1, 0.1)).toEqual({ x: 0, y: 0 });
    expect(stick(DEADZONE - 0.01, 0)).toEqual({ x: 0, y: 0 });
    expect(stick(NaN, 0)).toEqual({ x: 0, y: 0 });
  });
  it('reach full speed at full push, and ease in near the middle', () => {
    expect(stick(1, 0).x).toBeCloseTo(1);
    expect(stick(0.5, 0).x).toBeLessThan(0.25);
    expect(Math.hypot(stick(1, 1).x, stick(1, 1).y)).toBeLessThanOrEqual(1.0001);
  });
  it('speeds: up is Y+ and Z+, scaled by the feed and the speed setting', () => {
    expect(speeds([0, -1, 0, 0], S)).toEqual({ x: 0, y: 1500, z: 0 });
    expect(speeds([1, 0, 0, -1], S)).toEqual({ x: 1500, y: 0, z: 150 });
    expect(speeds([-1, 0, 0, 1], { ...S, speed: 100 })).toEqual({ x: -3000, y: 0, z: -300 });
  });
  it('the speed setting is kept between 10% and 100%', () => {
    expect(speeds([1, 0, 0, 0], { ...S, speed: 500 }).x).toBe(3000);
    expect(speeds([1, 0, 0, 0], { ...S, speed: 0 }).x).toBe(300);
  });
});

describe('PadSession', () => {
  it('does nothing until armed, even with the stick pushed', () => {
    const p = new PadSession();
    expect(p.update(input({ axes: [1, 0, 0, 0] }), S)).toEqual([]);
    expect(p.armed).toBe(false);
  });
  it('arms on Start, but only with both sticks centred', () => {
    const p = new PadSession();
    p.update(input({ axes: [1, 0, 0, 0], buttons: btns(BTN.START) }), S);
    expect(p.armed).toBe(false);
    p.update(input(), S);                                                  // released
    p.update(input({ axes: [0, 0, 0, 1], buttons: btns(BTN.START) }), S);  // right stick pushed
    expect(p.armed).toBe(false);
    p.update(input(), S);
    p.update(input({ buttons: btns(BTN.START) }), S);
    expect(p.armed).toBe(true);
  });
  it('a button held down while the pad is plugged in does not arm it by itself', () => {
    const p = new PadSession();
    p.update(input({ buttons: btns(BTN.START) }), S);                      // first look: pressed counts, edge from nothing
    expect(p.armed).toBe(true);                                            // (arming is a deliberate press)
    const q = new PadSession();
    q.update(input({ allowed: false, buttons: btns(BTN.START) }), S);
    q.update(input({ allowed: true, buttons: btns(BTN.START) }), S);       // still held when it becomes allowed
    expect(q.armed).toBe(false);
  });
  it('sends the wanted speeds while pushed, and a release once when the stick returns', () => {
    const p = armed();
    expect(p.update(input({ axes: [1, 0, 0, 0] }), S)).toEqual([{ type: 'hold', x: 1500, y: 0, z: 0 }]);
    expect(p.update(input({ axes: [1, 0, 0, 0] }), S)).toEqual([{ type: 'hold', x: 1500, y: 0, z: 0 }]);
    expect(p.update(input(), S)).toEqual([{ type: 'release' }]);
    expect(p.update(input(), S)).toEqual([]);
  });
  it('B stops: release, feed hold and disarm', () => {
    const p = armed();
    p.update(input({ axes: [1, 0, 0, 0] }), S);
    expect(p.update(input({ axes: [1, 0, 0, 0], buttons: btns(BTN.B) }), S)).toEqual([{ type: 'stop' }]);
    expect(p.armed).toBe(false);
    expect(p.update(input({ axes: [1, 0, 0, 0] }), S)).toEqual([]);
  });
  it('Back disarms and releases', () => {
    const p = armed();
    p.update(input({ axes: [0, -1, 0, 0] }), S);
    expect(p.update(input({ axes: [0, -1, 0, 0], buttons: btns(BTN.BACK) }), S)).toEqual([{ type: 'release' }]);
    expect(p.armed).toBe(false);
  });
  it('losing focus, unplugging or not being allowed disarms and releases', () => {
    for (const lose of [{ focused: false }, { active: false }, { allowed: false }] as Partial<PadInput>[]) {
      const p = armed();
      p.update(input({ axes: [1, 0, 0, 0] }), S);
      expect(p.update(input({ axes: [1, 0, 0, 0], ...lose }), S)).toEqual([{ type: 'release' }]);
      expect(p.armed).toBe(false);
      expect(p.update(input({ axes: [1, 0, 0, 0] }), S)).toEqual([]);   // coming back needs arming again
    }
  });
  it('lost() stops at once', () => {
    const p = armed();
    p.update(input({ axes: [1, 0, 0, 0] }), S);
    expect(p.lost()).toEqual([{ type: 'release' }]);
    expect(p.armed).toBe(false);
  });
  it('LB and RB change the speed in steps of 10 within 10 to 100', () => {
    const p = armed();
    expect(p.update(input({ buttons: btns(BTN.RB) }), S)).toEqual([{ type: 'speed', speed: 60 }]);
    p.update(input(), S);
    expect(p.update(input({ buttons: btns(BTN.LB) }), { ...S, speed: 10 })).toEqual([{ type: 'speed', speed: 10 }]);
    p.update(input(), S);
    expect(p.update(input({ buttons: btns(BTN.RB) }), { ...S, speed: 100 })).toEqual([{ type: 'speed', speed: 100 }]);
  });
});
