import { describe, it, expect } from 'vitest';
import { ACTIONS, DEFAULT_KEYS, resolveBindings, rebind, actionFor, isModifierCode, keyLabel } from '../../shared/keys.js';

describe('keyboard bindings', () => {
  it('start from the defaults, and every action has a distinct default key', () => {
    const b = resolveBindings(undefined);
    expect(b).toEqual(DEFAULT_KEYS);
    expect(new Set(Object.values(b)).size).toBe(ACTIONS.length);
  });
  it('saved choices override the defaults, an empty string means no key, junk is ignored', () => {
    const b = resolveBindings({ jogXplus: 'KeyD', jogXminus: '', feedHold: 42, nonsense: 'KeyQ' });
    expect(b.jogXplus).toBe('KeyD'); expect(b.jogXminus).toBe(''); expect(b.feedHold).toBe(DEFAULT_KEYS.feedHold);
    expect(Object.keys(b).length).toBe(ACTIONS.length);
  });
  it('a damaged save that puts two actions on one key leaves the key with the first', () => {
    const b = resolveBindings({ jogXplus: 'KeyD', jogYplus: 'KeyD' });
    expect(b.jogXplus).toBe('KeyD'); expect(b.jogYplus).toBe('');
  });
  it('rebinding to a key another action has takes it away from that one', () => {
    const r = rebind(DEFAULT_KEYS, 'jogXplus', 'ArrowUp');
    expect(r.took).toBe('jogYplus');
    expect(r.bindings.jogXplus).toBe('ArrowUp'); expect(r.bindings.jogYplus).toBe('');
    expect(actionFor(r.bindings, 'ArrowUp')).toBe('jogXplus');
  });
  it('clearing a binding leaves nothing on that action, and an unbound key does nothing', () => {
    const r = rebind(DEFAULT_KEYS, 'feedHold', '');
    expect(r.took).toBeUndefined(); expect(actionFor(r.bindings, 'Space')).toBeUndefined();
    expect(actionFor(DEFAULT_KEYS, '')).toBeUndefined();
  });
  it('modifier keys by themselves are not shortcuts', () => {
    for (const c of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'CapsLock']) expect(isModifierCode(c)).toBe(true);
    for (const c of ['KeyA', 'Space', 'ArrowUp', 'F5']) expect(isModifierCode(c)).toBe(false);
  });
  it('shows readable names', () => {
    expect([keyLabel('ArrowLeft'), keyLabel('KeyW'), keyLabel('Digit5'), keyLabel('Space'), keyLabel('BracketLeft'), keyLabel('NumpadAdd'), keyLabel('')]).toEqual(['←', 'W', '5', 'Space', '[', 'Num +', 'none']);
  });
});
