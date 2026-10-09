import { describe, it, expect } from 'vitest';
import { ACCENT_PRESETS, DEFAULTS, buildVars, contrast, mix, parseHex, problems, readableOn, sanitizeOverrides, toHex } from '../../shared/colors.js';

describe('colour maths', () => {
  it('parses and prints hex colours', () => {
    expect(parseHex('#6aa84f')).toEqual([106, 168, 79]);
    expect(parseHex('FFF')).toEqual([255, 255, 255]);
    expect(parseHex('#12345')).toBeUndefined();
    expect(parseHex('red')).toBeUndefined();
    expect(parseHex(42)).toBeUndefined();
    expect(toHex([106, 168, 79])).toBe('#6aa84f');
    expect(toHex([300, -5, 12.4])).toBe('#ff000c');
  });

  it('mixes and measures contrast like WCAG', () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([127.5, 127.5, 127.5]);
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    expect(readableOn([255, 255, 255])).toBe('#0e0e0e');
    expect(readableOn([20, 20, 20])).toBe('#ffffff');
  });

  it('the built-in text is readable on the built-in panels in both modes', () => {
    for (const m of ['dark', 'light'] as const) {
      const d = DEFAULTS[m];
      expect(contrast(parseHex(d.text)!, parseHex(d.panel)!), m).toBeGreaterThan(7);
      expect(problems(m, {}), m).toEqual([]);
    }
  });

  it('every accent preset is visible on the panels in the mode it is meant for', () => {
    for (const p of ACCENT_PRESETS) {
      expect(contrast(parseHex(p.dark)!, parseHex(DEFAULTS.dark.panel)!), `${p.name} dark`).toBeGreaterThan(3);
      expect(contrast(parseHex(p.light)!, parseHex(DEFAULTS.light.panel)!), `${p.name} light`).toBeGreaterThan(3);
    }
  });
});

describe('buildVars', () => {
  it('sets nothing when nothing is overridden', () => { expect(buildVars('dark', {})).toEqual({}); });

  it('an accent brings readable button text with it', () => {
    const v = buildVars('dark', { accent: '#ffee00' });
    expect(v['--accent']).toBe('#ffee00');
    expect(v['--accent-text']).toBe('#0e0e0e');
    expect(buildVars('dark', { accent: '#102030' })['--accent-text']).toBe('#ffffff');
  });

  it('a custom panel and text colour bring the in-between colours with them', () => {
    const v = buildVars('dark', { panel: '#101820', text: '#e0f0ff' });
    expect(Object.keys(v).sort()).toEqual(['--line', '--muted', '--panel', '--panel2', '--text']);
    // the in-between colours lie between panel and text
    const p = parseHex(v['--panel'])!, t = parseHex(v['--text'])!, l = parseHex(v['--line'])!;
    for (let i = 0; i < 3; i++) expect(l[i]).toBeGreaterThanOrEqual(Math.min(p[i], t[i]));
  });

  it('changing only the text still re-derives the muted and line colours from the default panel', () => {
    const v = buildVars('light', { text: '#000000' });
    expect(v['--text']).toBe('#000000');
    expect(v['--panel']).toBeUndefined();
    expect(v['--muted']).toBeDefined();
  });

  it('ignores anything that is not a known colour', () => {
    expect(sanitizeOverrides({ accent: '#abc', nope: '#fff', bg: 'blue', text: 5 })).toEqual({ accent: '#aabbcc' });
    expect(buildVars('dark', { accent: 'javascript:alert(1)' as string })).toEqual({});
  });
});

describe('problems', () => {
  it('warns about unreadable combinations, and only about what was changed', () => {
    expect(problems('dark', { text: '#1e1d17' }).join()).toMatch(/text is hard to read on the panels/);
    expect(problems('dark', { panel: '#ece8d8' }).join()).toMatch(/hard to read/);
    expect(problems('dark', { accent: '#1e1d17' }).join()).toMatch(/accent colour is hard to see/);
    expect(problems('dark', { accent: '#ffee00', text: '#ffffff' })).toEqual([]);
  });
});
