import { describe, it, expect, beforeEach } from 'vitest';
import { JogHold, BEAT_TIMEOUT_MS, SEGMENT_MS, MAX_HOLD_MS, MAX_XY_SPEED, MAX_Z_SPEED, MAX_Z_TRAVEL } from '../src/jogHold.js';

let lines: string[], cancels: number, logs: string[], blocked: string | null, jog: JogHold, backlog: number;
const A = { id: 'a' }, B = { id: 'b' };
beforeEach(() => {
  lines = []; cancels = 0; logs = []; blocked = null; backlog = 0;
  jog = new JogHold({ blocked: () => blocked, backlog: () => backlog, segment: (l) => lines.push(l), cancel: () => { cancels++; }, log: (_k, t) => logs.push(t) });
});
/** hold at the same speed every 100 ms for `ms` */
const beat = (owner: object, v: { x: number; y: number; z: number }, from: number, ms: number) => { for (let t = from; t <= from + ms; t += 100) jog.hold(owner, v, t); };

describe('JogHold', () => {
  it('turns a held speed into short jog moves, a quarter of a second of travel each', () => {
    jog.hold(A, { x: 1200, y: 0, z: 0 }, 0);
    expect(lines).toEqual(['$J=G21G91X5F1200']);                       // 1200 mm/min for 0.25 s = 5 mm
    expect(SEGMENT_MS).toBe(250);
  });

  it('never queues much ahead: about four moves a second, not one per beat', () => {
    beat(A, { x: 600, y: 0, z: 0 }, 0, 1000);                          // 11 beats over one second
    expect(lines.length).toBeLessThanOrEqual(6);                       // two at the start, then about four a second
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps the moves coming on its own clock when a heartbeat is late, so the machine does not slow down', () => {
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);                            // one heartbeat, then a gap
    for (let t = 50; t <= 350; t += 50) jog.tick(t);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const n = lines.length;
    jog.tick(600);                                                     // past the silence limit: it stops, and does not feed any more
    expect(jog.holding).toBe(false); expect(cancels).toBe(1);
    jog.tick(650);
    expect(lines.length).toBe(n);
  });

  it('letting go cancels at once', () => {
    beat(A, { x: 600, y: 0, z: 0 }, 0, 300);
    jog.release(A);
    expect(cancels).toBe(1);
    expect(jog.holding).toBe(false);
  });

  it('a zero speed on every axis counts as letting go', () => {
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    jog.hold(A, { x: 0, y: 0, z: 0 }, 100);
    expect(cancels).toBe(1); expect(jog.holding).toBe(false);
  });

  it('silence stops it: nothing heard for 0.4 s cancels', () => {
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    jog.tick(BEAT_TIMEOUT_MS - 10);
    expect(cancels).toBe(0);
    jog.tick(BEAT_TIMEOUT_MS + 10);
    expect(cancels).toBe(1); expect(jog.holding).toBe(false);
    expect(logs.some((l) => /lost contact/.test(l))).toBe(true);
  });

  it('after a stop it did not choose, the browser must let go before it can jog again', () => {
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    jog.tick(1000);                                                    // lost contact
    lines.length = 0;
    jog.hold(A, { x: 600, y: 0, z: 0 }, 1100);                         // beats come back with the stick still pushed
    expect(lines).toEqual([]); expect(jog.holding).toBe(false);
    jog.hold(A, { x: 0, y: 0, z: 0 }, 1200);                           // let go
    jog.hold(A, { x: 600, y: 0, z: 0 }, 1300);
    expect(lines.length).toBe(1);
  });

  it('a browser that disconnects while holding stops the machine', () => {
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    jog.drop(A);
    expect(cancels).toBe(1); expect(jog.holding).toBe(false);
  });

  it('only one browser holds at a time, and another cannot let go for it', () => {
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    jog.hold(B, { x: 0, y: 600, z: 0 }, 50);
    expect(lines.length).toBe(1);
    jog.release(B);
    expect(cancels).toBe(0); expect(jog.holding).toBe(true);
  });

  it('is refused while blocked (alarm, job, not connected), and stops if it becomes blocked', () => {
    blocked = 'A job is running';
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    expect(lines).toEqual([]); expect(logs[0]).toMatch(/Cannot jog: A job is running/);
    blocked = null;
    jog.hold(A, { x: 0, y: 0, z: 0 }, 50);                             // let go, then push again
    jog.hold(A, { x: 600, y: 0, z: 0 }, 100);
    expect(lines.length).toBe(1);
    blocked = 'The machine is in Alarm';
    jog.tick(150);
    expect(cancels).toBe(1); expect(jog.holding).toBe(false);
  });

  it('caps the speeds: XY at the limit, Z lower', () => {
    jog.hold(A, { x: 20000, y: 0, z: 0 }, 0);
    expect(lines[0]).toBe(`$J=G21G91X${(MAX_XY_SPEED * SEGMENT_MS) / 60000}F${MAX_XY_SPEED}`);
    jog.release(A); lines.length = 0;
    jog.hold(A, { x: 0, y: 0, z: -5000 }, 1000);
    expect(lines[0]).toBe(`$J=G21G91Z${-(MAX_Z_SPEED * SEGMENT_MS) / 60000}F${MAX_Z_SPEED}`);
  });

  it('refuses nonsense speeds', () => {
    jog.hold(A, { x: NaN, y: 0, z: 0 }, 0);
    jog.hold(A, { x: Infinity, y: 0, z: 0 }, 0);
    expect(lines).toEqual([]);
  });

  it('a sharp change of direction stops first, waits a moment, then follows the new direction', () => {
    jog.hold(A, { x: 1000, y: 0, z: 0 }, 0);
    jog.hold(A, { x: -1000, y: 0, z: 0 }, 100);
    expect(cancels).toBe(1);
    expect(lines.length).toBe(1);                                      // nothing sent in the new direction yet
    jog.hold(A, { x: -1000, y: 0, z: 0 }, 200);
    expect(lines.length).toBe(1);                                      // still settling
    jog.hold(A, { x: -1000, y: 0, z: 0 }, 300);
    expect(lines[1]).toMatch(/X-/);
  });

  it('a big drop in speed also stops first, but a small change does not', () => {
    jog.hold(A, { x: 1000, y: 0, z: 0 }, 0);
    jog.hold(A, { x: 900, y: 0, z: 0 }, 100);
    expect(cancels).toBe(0);
    jog.hold(A, { x: 300, y: 0, z: 0 }, 200);
    expect(cancels).toBe(1);
  });

  it('ends one hold after 30 seconds, and the browser must let go to continue', () => {
    jog.hold(A, { x: 300, y: 0, z: 0 }, 0);
    jog.hold(A, { x: 300, y: 0, z: 0 }, MAX_HOLD_MS + 50);
    expect(cancels).toBe(1); expect(logs.some((l) => /30 seconds/.test(l))).toBe(true);
    const n = lines.length;
    jog.hold(A, { x: 300, y: 0, z: 0 }, MAX_HOLD_MS + 150);
    expect(lines.length).toBe(n);
  });

  it('Z travel in one hold is capped at 20 mm, like a single Z jog', () => {
    let z = 0;
    for (let t = 0; t < 200_000 && !logs.length; t += 100) {
      const before = lines.length;
      jog.hold(A, { x: 0, y: 0, z: -MAX_Z_SPEED }, t);
      if (lines.length > before) z += Math.abs(Number(/Z(-?[\d.]+)/.exec(lines[lines.length - 1])![1]));
      if (t > 20_000) break;      // the 30 s limit is tested separately
    }
    expect(z).toBeLessThanOrEqual(MAX_Z_TRAVEL + 0.0001);
    expect(z).toBeGreaterThan(MAX_Z_TRAVEL - 3);
  });

  it('does not pile up moves when the controller is slow to acknowledge them', () => {
    backlog = 2;                                                       // two moves still waiting
    beat(A, { x: 600, y: 0, z: 0 }, 0, 2000);
    expect(lines).toEqual([]);
    backlog = 0;
    jog.hold(A, { x: 600, y: 0, z: 0 }, 2100);
    expect(lines.length).toBe(1);
  });

  it('a refused hold stays refused until the browser lets go, even after the block clears', () => {
    blocked = 'The machine is in Alarm';
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    blocked = null;                                                    // the alarm was cleared while the stick or button was still held
    beat(A, { x: 600, y: 0, z: 0 }, 100, 500);
    expect(lines).toEqual([]); expect(jog.holding).toBe(false);
    jog.hold(A, { x: 0, y: 0, z: 0 }, 700);                            // let go
    jog.hold(A, { x: 600, y: 0, z: 0 }, 800);                          // a new press
    expect(lines.length).toBe(1);
  });

  it('two browsers refused at the same time are both kept waiting for a release', () => {
    blocked = 'The machine is in Alarm';
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    jog.hold(B, { x: 600, y: 0, z: 0 }, 10);                           // the second refusal must not forget the first
    blocked = null;
    jog.hold(A, { x: 600, y: 0, z: 0 }, 100);
    jog.hold(B, { x: 600, y: 0, z: 0 }, 110);
    expect(lines).toEqual([]); expect(jog.holding).toBe(false);
    jog.hold(A, { x: 0, y: 0, z: 0 }, 200);
    jog.hold(A, { x: 600, y: 0, z: 0 }, 300);
    expect(lines.length).toBe(1);                                      // A let go and pushed again; B still has not
  });

  it('the jog stop button ends a hold, and the holder must let go before the next', () => {
    jog.hold(A, { x: 600, y: 0, z: 0 }, 0);
    jog.abort();
    expect(jog.holding).toBe(false);
    lines.length = 0;
    jog.hold(A, { x: 600, y: 0, z: 0 }, 100);
    expect(lines).toEqual([]);
  });
});
