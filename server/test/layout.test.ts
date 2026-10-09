import { describe, it, expect } from 'vitest';
import {
  COLS, COLLAPSED_H, PANEL_IDS, PRESETS, applyGridChange, applyMine, applyPreset, presetState, sanitize, saveMine,
  setLocked, stackOrder, toggleCollapsed, toggleHidden, undoPreset, visibleIds, type Item, type LayoutState, type PresetId,
} from '../../shared/layout.js';

const overlaps = (a: Item, b: Item) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('presets', () => {
  it.each(Object.keys(PRESETS) as PresetId[])('%s places every panel exactly once, inside the grid, and never overlapping', (id) => {
    const s = presetState(id);
    expect(s.items.map((x) => x.i).sort()).toEqual([...PANEL_IDS].sort());
    for (const it of s.items) { expect(it.x + it.w).toBeLessThanOrEqual(COLS); expect(it.w).toBeGreaterThan(0); expect(it.h).toBeGreaterThan(0); }
    for (const a of s.items) for (const b of s.items) if (a !== b) expect(overlaps(a, b), `${a.i} overlaps ${b.i} in ${id}`).toBe(false);
  });

  it('Run hides the setup panels and gives the visualizer the most room; Setup keeps jog, probe and autolevel', () => {
    const run = presetState('run'), setup = presetState('setup');
    expect(run.hidden).toEqual(expect.arrayContaining(['jog', 'probe', 'autolevel']));
    const area = (s: typeof run, id: string) => { const x = s.items.find((i) => i.i === id)!; return x.w * x.h; };
    expect(area(run, 'visualizer')).toBeGreaterThan(area(setup, 'visualizer'));
    for (const id of ['jog', 'probe', 'autolevel', 'job', 'position'] as const) expect(visibleIds(setup)).toContain(id);
    expect(visibleIds(presetState('all'))).toEqual(PANEL_IDS);
  });

  it('keeps the lock setting when a preset is applied', () => {
    expect(presetState('run', true).locked).toBe(true);
  });
});

describe('sanitize (what was saved in the browser)', () => {
  it('survives garbage and old versions by falling back to the default', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { items: 'no' }]) expect(sanitize(bad).items.length).toBe(PANEL_IDS.length);
    expect(sanitize(null).preset).toBe('all');
  });

  it('round-trips a saved layout', () => {
    const s = toggleHidden(toggleCollapsed(presetState('setup'), 'job'), 'console');
    expect(sanitize(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('drops unknown panels and duplicates, and adds panels missing from an older save', () => {
    const r = sanitize({ items: [{ i: 'jog', x: 0, y: 0, w: 4, h: 10 }, { i: 'jog', x: 5, y: 5, w: 3, h: 3 }, { i: 'bogus', x: 0, y: 0, w: 3, h: 3 }], hidden: ['bogus', 'probe', 'probe'] });
    expect(r.items.filter((x) => x.i === 'jog')).toEqual([{ i: 'jog', x: 0, y: 0, w: 4, h: 10 }]);
    expect(r.items.map((x) => x.i).sort()).toEqual([...PANEL_IDS].sort());
    expect(r.hidden).toEqual(['probe']);
  });

  it('puts a panel that is missing from an older save at the bottom, not on top of the arrangement', () => {
    const old = { items: presetState('all').items.filter((x) => x.i !== 'camera'), hidden: [] };
    const r = sanitize(old);
    const cam = r.items.find((x) => x.i === 'camera')!;
    const bottom = Math.max(...r.items.filter((x) => x.i !== 'camera').map((x) => x.y + x.h));
    expect(cam.y).toBe(bottom);
    expect(cam.x).toBe(0);
    expect(visibleIds(r)).toContain('camera');
    for (const a of r.items) for (const b of r.items) if (a !== b) expect(overlaps(a, b), `${a.i}/${b.i}`).toBe(false);
  });

  it('rejects items that would hang off the grid, be too small, or be nonsense numbers', () => {
    const r = sanitize({ items: [
      { i: 'jog', x: 10, y: 0, w: 4, h: 10 },        // past the right edge
      { i: 'position', x: 0, y: 0, w: 1, h: 10 },    // narrower than the minimum
      { i: 'job', x: 0, y: 0, w: 3.5, h: 10 },       // not whole columns
      { i: 'probe', x: 0, y: 0, w: 3, h: NaN },
    ] });
    const d = presetState('all').items;
    for (const id of ['jog', 'position', 'job', 'probe'] as const) expect(r.items.find((x) => x.i === id)).toEqual(d.find((x) => x.i === id));
  });

  it('draws a collapsed panel at title height, even if the save said otherwise', () => {
    const r = sanitize({ items: [{ i: 'job', x: 9, y: 0, w: 3, h: 21 }], collapsed: { job: 21, nope: 5 } });
    expect(r.items.find((x) => x.i === 'job')!.h).toBe(COLLAPSED_H);
    expect(r.collapsed).toEqual({ job: 21 });
  });

  it('preserves the lock and only trusts known preset names', () => {
    expect(sanitize({ locked: true }).locked).toBe(true);
    expect(sanitize({ locked: 'yes' }).locked).toBe(false);
    expect(sanitize({ preset: 'run' }).preset).toBe('run');
    expect(sanitize({ preset: 'hacked' }).preset).toBe('custom');
  });
});

describe('changing the layout', () => {
  it('collapsing shrinks to the title bar and expanding restores the previous height', () => {
    const s0 = presetState('all');
    const h0 = s0.items.find((x) => x.i === 'job')!.h;
    const s1 = toggleCollapsed(s0, 'job');
    expect(s1.items.find((x) => x.i === 'job')!.h).toBe(COLLAPSED_H);
    expect(s1.collapsed.job).toBe(h0);
    const s2 = toggleCollapsed(s1, 'job');
    expect(s2.items.find((x) => x.i === 'job')!.h).toBe(h0);
    expect(s2.collapsed.job).toBeUndefined();
  });

  it('hiding keeps the panel position so it comes back where it was', () => {
    const s0 = presetState('all');
    const pos = s0.items.find((x) => x.i === 'probe')!;
    const hidden = toggleHidden(s0, 'probe');
    expect(visibleIds(hidden)).not.toContain('probe');
    expect(hidden.items.find((x) => x.i === 'probe')).toEqual(pos);
    expect(visibleIds(toggleHidden(hidden, 'probe'))).toContain('probe');
    expect(hidden.preset).toBe('custom');
  });

  it('merges what the grid reports, leaving hidden panels alone, and notes it is now custom', () => {
    const s = toggleHidden(presetState('all'), 'probe');
    const probe = s.items.find((x) => x.i === 'probe')!;
    const moved = applyGridChange(s, [{ i: 'jog', x: 3, y: 30, w: 4, h: 12 }]);
    expect(moved.items.find((x) => x.i === 'jog')).toEqual({ i: 'jog', x: 3, y: 30, w: 4, h: 12 });
    expect(moved.items.find((x) => x.i === 'probe')).toEqual(probe);
    expect(moved.preset).toBe('custom');
  });

  it('does not turn a preset into "custom" when the grid just reports the same positions back', () => {
    const s = presetState('run');
    expect(applyGridChange(s, s.items.filter((x) => visibleIds(s).includes(x.i)))).toBe(s);
  });

  it('keeps collapsed panels at title height whatever the grid reports', () => {
    const s = toggleCollapsed(presetState('all'), 'job');
    const r = applyGridChange(s, [{ i: 'job', x: 9, y: 0, w: 3, h: 30 }]);
    expect(r.items.find((x) => x.i === 'job')!.h).toBe(COLLAPSED_H);
  });

  it('orders panels for a narrow screen top to bottom, then left to right', () => {
    const order = stackOrder(presetState('all'));
    expect(order[0]).toBe('connection');
    expect(order).toEqual(order.filter((id) => visibleIds(presetState('all')).includes(id)));
    expect(stackOrder(toggleHidden(presetState('all'), 'console'))).not.toContain('console');
  });

  it('locking is a plain flag', () => {
    expect(setLocked(presetState('all'), true).locked).toBe(true);
  });
});

describe('getting your own layout back after a preset', () => {
  /** A hand-arranged layout: jog moved, probe hidden, locked */
  const arranged = (): LayoutState => {
    let s = presetState('all', true);
    s = applyGridChange(s, [{ i: 'jog', x: 3, y: 30, w: 4, h: 12 }]);
    return toggleHidden(s, 'probe');
  };
  const sameArrangement = (a: LayoutState, b: LayoutState) =>
    JSON.stringify([a.items, a.hidden, a.collapsed]) === JSON.stringify([b.items, b.hidden, b.collapsed]);

  it('a preset click keeps what you had, and Undo brings it back exactly', () => {
    const mine = arranged();
    const run = applyPreset(mine, 'run');
    expect(run.preset).toBe('run');
    expect(sameArrangement(run, presetState('run'))).toBe(true);
    expect(run.previous).toBeDefined();
    const back = undoPreset(run);
    expect(sameArrangement(back, mine)).toBe(true);
    expect(back.previous).toBeUndefined();
  });

  it('the lock stays as it was through presets and undo', () => {
    const mine = arranged();
    expect(mine.locked).toBe(true);
    expect(applyPreset(mine, 'setup').locked).toBe(true);
    expect(undoPreset(applyPreset(mine, 'setup')).locked).toBe(true);
  });

  it('moving between pristine presets does not bury your layout: Undo still returns to the hand-made one', () => {
    const mine = arranged();
    const afterThree = applyPreset(applyPreset(applyPreset(mine, 'run'), 'setup'), 'all');
    expect(sameArrangement(undoPreset(afterThree), mine)).toBe(true);
  });

  it('a layout tweaked on top of a preset is hand-made too, so the next preset click keeps it', () => {
    const tweaked = toggleCollapsed(presetState('run'), 'job');
    expect(tweaked.preset).toBe('custom');
    expect(sameArrangement(undoPreset(applyPreset(tweaked, 'setup')), tweaked)).toBe(true);
  });

  it('Save as My layout is a durable slot that presets never touch', () => {
    const saved = saveMine(arranged());
    expect(saved.preset).toBe('mine');
    const viaPresets = applyPreset(applyPreset(saved, 'run'), 'setup');
    expect(sameArrangement({ ...viaPresets, ...viaPresets.mine! } as LayoutState, saved)).toBe(true); // slot unchanged
    const back = applyMine(viaPresets);
    expect(back.preset).toBe('mine');
    expect(sameArrangement(back, saved)).toBe(true);
  });

  it('later tweaks do not overwrite My layout until you save again', () => {
    const saved = saveMine(arranged());
    const tweaked = toggleHidden(saved, 'console');
    expect(tweaked.preset).toBe('custom');
    expect(sameArrangement({ ...tweaked, ...tweaked.mine! } as LayoutState, saved)).toBe(true);
    expect(sameArrangement(applyMine(applyPreset(tweaked, 'run')), saved)).toBe(true);
    // and saving again replaces it
    const resaved = saveMine(tweaked);
    expect(resaved.mine!.hidden).toContain('console');
  });

  it('Undo and My layout do nothing when there is nothing to go back to', () => {
    const s = presetState('all');
    expect(undoPreset(s)).toBe(s);
    expect(applyMine(s)).toBe(s);
  });

  it('survives being saved in the browser, and a damaged copy is dropped without harm', () => {
    const s = applyPreset(saveMine(arranged()), 'run');
    expect(sanitize(JSON.parse(JSON.stringify(s)))).toEqual(s);
    const broken = sanitize({ ...JSON.parse(JSON.stringify(s)), mine: 'junk', previous: { items: 5 }, preset: 'mine' });
    expect(broken.mine).toBeUndefined();
    expect(broken.preset).toBe('custom'); // 'mine' with nothing saved is not a real state
    expect(broken.items.length).toBe(PANEL_IDS.length);
  });
});
