import { describe, expect, it } from 'vitest';
import { nudgeStep } from '../src/core/nudge';

describe('nudgeStep', () => {
  it('is about 3 screen pixels, as 1, 2 or 5 times a power of ten', () => {
    expect(nudgeStep(3)).toBe(1);        // 3 px per mm: 1 mm
    expect(nudgeStep(1.5)).toBe(2);      // 2 mm
    expect(nudgeStep(0.6)).toBe(5);      // 5 mm
    expect(nudgeStep(30)).toBe(0.1);     // zoomed in: 0.1 mm
    expect(nudgeStep(300)).toBe(0.01);
  });
  it('gets smaller as you zoom in, and stays within 0.001 to 100 mm', () => {
    expect(nudgeStep(100)).toBeLessThan(nudgeStep(10));
    expect(nudgeStep(1e9)).toBe(0.001);
    expect(nudgeStep(1e-9)).toBe(100);
    expect(nudgeStep(0)).toBe(100);
  });
});
