import { describe, expect, it } from 'vitest';
import { measure, fmt } from '../src/core/measure';

describe('measure', () => {
  it('a 3-4-5 triangle', () => {
    expect(measure([0, 0], [3, 4])).toEqual({ distance: 5, dx: 3, dy: 4, angle: 53.130102 });
  });
  it('angles run anticlockwise from the right, 0 to 360', () => {
    expect(measure([0, 0], [0, 5]).angle).toBe(90);
    expect(measure([0, 0], [-5, 0]).angle).toBe(180);
    expect(measure([0, 0], [0, -5]).angle).toBe(270);
    expect(measure([0, 0], [5, -5]).angle).toBe(315);
  });
  it('yDown makes the vertical change count the way a laser page does, and leaves the angle as it looks', () => {
    const m = measure([10, 10], [10, 30], true);
    expect(m.dy).toBe(-20);
    expect(m.angle).toBe(90);
  });
  it('two equal points are a zero distance at angle 0, never -0 or NaN', () => {
    const m = measure([5, 5], [5, 5]);
    expect(m).toEqual({ distance: 0, dx: 0, dy: 0, angle: 0 });
    expect(Object.is(measure([1, 1], [2, 1]).dy, 0)).toBe(true);
  });
  it('fmt rounds and never shows -0.000', () => {
    expect(fmt(42.5, 2)).toBe('42.50');
    expect(fmt(-0.00001, 3)).toBe('0.000');
  });
});
