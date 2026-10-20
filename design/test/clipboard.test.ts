import { describe, expect, it } from 'vitest';
import { readClip, writeClip } from '../src/ui/clipboard';

const fake = (limit = Infinity) => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (v.length > limit) throw new Error('quota'); m.set(k, v); } };
};

describe('clipboard shared between tabs', () => {
  it('hands a copy to another reader', () => {
    const s = fake();
    expect(readClip(s)).toBeNull();
    expect(writeClip({ stamp: 5, shapes: [{ kind: 'path' }] }, s)).toBe(true);
    expect(readClip(s)).toEqual({ stamp: 5, shapes: [{ kind: 'path' }] });
  });
  it('says so when the copy is too big to share, and keeps the old one', () => {
    const s = fake(100);
    expect(writeClip({ stamp: 1, shapes: [1] }, s)).toBe(true);
    expect(writeClip({ stamp: 2, shapes: ['x'.repeat(500)] }, s)).toBe(false);
    expect(readClip(s)?.stamp).toBe(1);
  });
  it('ignores anything that is not a copy, and works without storage', () => {
    const s = fake();
    s.setItem('design-clipboard', '{"stamp":"no"}');
    expect(readClip(s)).toBeNull();
    s.setItem('design-clipboard', 'not json');
    expect(readClip(s)).toBeNull();
    s.setItem('design-clipboard', '{"stamp":1,"shapes":[]}');
    expect(readClip(s)).toBeNull();
    expect(readClip(null)).toBeNull();
    expect(writeClip({ stamp: 1, shapes: [1] }, null)).toBe(false);
  });
});
