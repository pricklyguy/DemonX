import { describe, it, expect } from 'vitest';
import { makeUnits, toMm, fromMm, MM_PER_INCH } from '../../web/src/unitsCore.js';

describe('units (display only; everything stored is millimetres)', () => {
  it('shows millimetres as they are', () => {
    const u = makeUnits('mm');
    expect(u.len(12.5)).toBe('12.500');
    expect(u.len(12.5, 1)).toBe('12.5');
    expect(u.feed(3000.4)).toBe('3000');
    expect([u.lenUnit, u.feedUnit]).toEqual(['mm', 'mm/min']);
  });

  it('shows inches with one more decimal and converts feeds', () => {
    const u = makeUnits('in');
    expect(u.len(25.4)).toBe('1.0000');
    expect(u.len(12.7, 2)).toBe('0.500');
    expect(u.len(-6.35, 1)).toBe('-0.25');
    expect(u.feed(3048)).toBe('120.0');
    expect([u.lenUnit, u.feedUnit]).toEqual(['in', 'in/min']);
  });

  it('typed values go back to millimetres; plain counts are never converted', () => {
    expect(toMm(0.5, 'in', 'len')).toBeCloseTo(12.7, 9);
    expect(toMm(120, 'in', 'feed')).toBeCloseTo(3048, 9);
    expect(toMm(7, 'in', 'raw')).toBe(7);
    expect(toMm(5, 'mm', 'len')).toBe(5);
    expect(fromMm(MM_PER_INCH * 2, 'in', 'len')).toBeCloseTo(2, 12);
    expect(fromMm(5, 'in', 'raw')).toBe(5);
  });

  it('a value survives a round trip through inches', () => {
    for (const mm of [0.01, 6.35, 25.05, 3000]) expect(toMm(fromMm(mm, 'in', 'len'), 'in', 'len')).toBeCloseTo(mm, 9);
  });
});
