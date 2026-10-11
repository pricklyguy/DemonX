import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HoldBus, Gesture, BEAT_MS, TAP_MS } from '../../shared/holdjog.js';
import type { ClientMessage } from '../../shared/protocol.js';

let sent: ClientMessage[], bus: HoldBus, taps: object[], g: Gesture;
beforeEach(() => {
  vi.useFakeTimers();
  sent = []; taps = [];
  bus = new HoldBus(); bus.sender = (m) => sent.push(m);
  g = new Gesture(bus, { tap: (d) => taps.push(d), speeds: () => ({ xy: 3000, z: 300 }) });
});
afterEach(() => vi.useRealTimers());

describe('HoldBus', () => {
  it('sends at once, repeats every beat while held, and releases once at the end', () => {
    bus.set('a', { x: 600, y: 0, z: 0 });
    expect(sent).toEqual([{ type: 'jogHold', x: 600, y: 0, z: 0 }]);
    vi.advanceTimersByTime(BEAT_MS * 3);
    expect(sent.length).toBe(4);
    bus.set('a', null);
    expect(sent[sent.length - 1]).toEqual({ type: 'jogRelease' });
    const n = sent.length;
    vi.advanceTimersByTime(BEAT_MS * 5);
    expect(sent.length).toBe(n);                                           // nothing more after the release
  });
  it('adds sources up, but a diagonal from two keys is not faster than the feed', () => {
    bus.set('right', { x: 3000, y: 0, z: 0 });
    bus.set('up', { x: 0, y: 3000, z: 0 });
    const hold = sent[sent.length - 1] as { x: number; y: number };
    expect(Math.hypot(hold.x, hold.y)).toBeCloseTo(3000, 0);
    expect(hold.x).toBeCloseTo(hold.y, 0);
  });
  it('opposite keys cancel, and releasing one leaves the other going', () => {
    bus.set('l', { x: -1000, y: 0, z: 0 }); bus.set('r', { x: 1000, y: 0, z: 0 });
    expect(sent[sent.length - 1]).toEqual({ type: 'jogRelease' });
    bus.set('l', null); bus.set('r', { x: 1000, y: 0, z: 0 });
    expect(sent[sent.length - 1]).toEqual({ type: 'jogHold', x: 1000, y: 0, z: 0 });
  });
  it('does not repeat itself when a source is set to the same thing again and again (a gamepad does this)', () => {
    for (let i = 0; i < 5; i++) bus.set('pad', { x: 100, y: 0, z: 0 });
    expect(sent.length).toBe(1);
  });
  it('releaseAll lets go of every source at once', () => {
    bus.set('a', { x: 600, y: 0, z: 0 }); bus.set('b', { x: 0, y: 600, z: 0 });
    bus.releaseAll();
    expect(sent[sent.length - 1]).toEqual({ type: 'jogRelease' });
    expect(bus.active).toBe(false);
  });
  it('a release is only sent if something was held', () => {
    bus.releaseAll(); bus.set('a', null);
    expect(sent).toEqual([]);
  });
});

describe('Gesture', () => {
  const right = { x: 1, y: 0, z: 0 };
  it('a quick press is a tap: one step, nothing held', () => {
    g.down('btn', right);
    vi.advanceTimersByTime(TAP_MS - 50);
    g.up('btn');
    expect(taps).toEqual([right]);
    expect(sent).toEqual([]);
  });
  it('a long press holds at the feed, and letting go stops it with no step', () => {
    g.down('btn', right);
    vi.advanceTimersByTime(TAP_MS + 10);
    expect(sent).toEqual([{ type: 'jogHold', x: 3000, y: 0, z: 0 }]);
    g.up('btn');
    expect(sent[sent.length - 1]).toEqual({ type: 'jogRelease' });
    expect(taps).toEqual([]);
  });
  it('a diagonal button holds at the feed along the diagonal, Z at the Z feed', () => {
    g.down('d', { x: 1, y: 1, z: 0 });
    vi.advanceTimersByTime(TAP_MS + 10);
    const h = sent[0] as { x: number; y: number };
    expect(Math.hypot(h.x, h.y)).toBeCloseTo(3000, 0);
    g.up('d');
    g.down('z', { x: 0, y: 0, z: -1 });
    vi.advanceTimersByTime(TAP_MS + 10);
    expect(sent[sent.length - 1]).toEqual({ type: 'jogHold', x: 0, y: 0, z: -300 });
    g.up('z');
  });
  it('key repeat does not start it twice, and a release with no press does nothing', () => {
    g.down('k', right); g.down('k', right); g.down('k', right);
    vi.advanceTimersByTime(TAP_MS + 10);
    expect(sent.length).toBe(1);
    g.up('k'); g.up('k'); g.up('other');
    expect(sent.filter((m) => m.type === 'jogRelease').length).toBe(1);
  });
  it('cancelAll (focus lost, pointer cancelled) stops a hold and does not make a tap', () => {
    g.down('btn', right);
    vi.advanceTimersByTime(TAP_MS + 10);
    g.cancelAll();
    expect(sent[sent.length - 1]).toEqual({ type: 'jogRelease' });
    expect(taps).toEqual([]);
    g.down('x', right); g.cancelAll(); vi.advanceTimersByTime(TAP_MS * 2);
    expect(sent.filter((m) => m.type === 'jogHold').length).toBe(1);      // the cancelled press never became a hold
    expect(taps).toEqual([]);
  });
});
