import { describe, expect, it } from 'vitest';
import { ACTIONS, actionFor, assign, defaults, isValidSpec, label, overridesOf, specOf, withOverrides } from '../src/core/shortcuts';

const key = (k: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => specOf({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });

describe('shortcuts', () => {
  it('turns key presses into text, Command counting as Ctrl, capitals as lower case', () => {
    expect(key('v')).toBe('v');
    expect(key('V', { shiftKey: true })).toBe('shift+v');
    expect(key('g', { ctrlKey: true })).toBe('ctrl+g');
    expect(key('g', { metaKey: true, shiftKey: true })).toBe('ctrl+shift+g');
    expect(key('Delete')).toBe('delete');
    expect(key(' ')).toBe('space');
    expect(key('Shift')).toBeNull();
    expect(key('Control', { ctrlKey: true })).toBeNull();
  });
  it('the defaults find their actions, including the fixed extras', () => {
    const b = defaults();
    expect(actionFor('v', b)).toBe('tool.select');
    expect(actionFor('ctrl+shift+g', b)).toBe('edit.ungroup');
    expect(actionFor('ctrl+g', b)).toBe('edit.group');
    expect(actionFor('backspace', b)).toBe('edit.delete');
    expect(actionFor('ctrl+shift+z', b)).toBe('edit.redo');
    expect(actionFor('q', b)).toBeNull();
    expect(actionFor(null, b)).toBeNull();
  });
  it('no two actions share a default key', () => {
    const keys = ACTIONS.map((a) => a.key).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('a changed key moves the action, and giving a key that is taken leaves the other action with none', () => {
    const r = assign(defaults(), 'tool.rect', 'q');
    expect(actionFor('q', r.bindings)).toBe('tool.rect');
    expect(actionFor('r', r.bindings)).toBeNull();
    const t = assign(defaults(), 'tool.rect', 'c');   // c was the circle's
    expect(t.took).toBe('tool.circle');
    expect(t.bindings['tool.circle']).toBe('');
    expect(actionFor('c', t.bindings)).toBe('tool.rect');
  });
  it('saves only what differs, reads it back, and ignores nonsense', () => {
    const b = assign(defaults(), 'tool.rect', 'q').bindings;
    expect(overridesOf(b)).toEqual({ 'tool.rect': 'q' });
    expect(withOverrides(overridesOf(b))['tool.rect']).toBe('q');
    const bad = withOverrides({ 'tool.rect': 'ctrl+ctrl+q', nope: 'x', 'tool.circle': 5, 'edit.copy': 'escape', 'tool.path': 'shift+ctrl+x' });
    expect(bad).toEqual(defaults());
  });
  it('checks what a key text may look like', () => {
    expect(isValidSpec('')).toBe(true);
    expect(isValidSpec('ctrl+alt+shift+k')).toBe(true);
    expect(isValidSpec('ctrl+')).toBe(false);
    expect(isValidSpec('escape')).toBe(false);
    expect(isValidSpec('arrowup')).toBe(false);
    expect(isValidSpec('ctrl')).toBe(false);
  });
  it('shows keys the way a person reads them', () => {
    expect(label('ctrl+shift+g')).toBe('Ctrl+Shift+G');
    expect(label('v')).toBe('V');
    expect(label('delete')).toBe('Del');
    expect(label('')).toBe('');
  });
});
