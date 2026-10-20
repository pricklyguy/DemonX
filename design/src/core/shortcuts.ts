/**
 * Keyboard shortcuts as data: every action has a default key, the owner's changes are kept as overrides, and a key press is turned into
 * a short text ("ctrl+shift+g", "v", "delete") that is looked up. Nothing here touches the browser, so it can be tested.
 */
export interface ShortcutAction {
  id: string;
  label: string;
  /** What is it for, as the settings list groups them */
  group: 'Tools' | 'Edit' | 'File' | 'View';
  /** The default key ('' for none) */
  key: string;
  /** Keys that always work for this action as well and cannot be changed */
  fixed?: string[];
}

export const ACTIONS: ShortcutAction[] = [
  { id: 'tool.select', label: 'Select', group: 'Tools', key: 'v' },
  { id: 'tool.rect', label: 'Rectangle', group: 'Tools', key: 'r' },
  { id: 'tool.circle', label: 'Circle', group: 'Tools', key: 'c' },
  { id: 'tool.path', label: 'Polygon / line', group: 'Tools', key: 'p' },
  { id: 'tool.text', label: 'Text', group: 'Tools', key: 'a' },
  { id: 'tool.nodes', label: 'Nodes', group: 'Tools', key: 'n' },
  { id: 'tool.trim', label: 'Trim', group: 'Tools', key: 't' },
  { id: 'tool.fillet', label: 'Fillet', group: 'Tools', key: 'b' },
  { id: 'tool.measure', label: 'Measure', group: 'Tools', key: 'm' },
  { id: 'tool.pan', label: 'Pan', group: 'Tools', key: 'h' },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', key: 'ctrl+c' },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', key: 'ctrl+x' },
  { id: 'edit.paste', label: 'Paste', group: 'Edit', key: 'ctrl+v' },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', key: 'ctrl+d' },
  { id: 'edit.delete', label: 'Delete', group: 'Edit', key: 'delete', fixed: ['backspace'] },
  { id: 'edit.group', label: 'Group', group: 'Edit', key: 'ctrl+g' },
  { id: 'edit.ungroup', label: 'Ungroup', group: 'Edit', key: 'ctrl+shift+g' },
  { id: 'edit.selectAll', label: 'Select all', group: 'Edit', key: 'ctrl+a' },
  { id: 'edit.undo', label: 'Undo', group: 'Edit', key: 'ctrl+z' },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', key: 'ctrl+y', fixed: ['ctrl+shift+z'] },
  { id: 'file.save', label: 'Save', group: 'File', key: 'ctrl+s' },
  { id: 'file.saveAs', label: 'Save as', group: 'File', key: 'ctrl+shift+s' },
  { id: 'file.open', label: 'Open', group: 'File', key: 'ctrl+o' },
  { id: 'view.fit', label: 'Fit the drawing in the window', group: 'View', key: 'f' },
];

/** Keys that mean something fixed and cannot be given to an action: Escape (drop / cancel), Enter, Space (hold to pan), the arrows (nudge). */
export const RESERVED = ['escape', 'enter', 'space', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'tab'];

export type Bindings = Record<string, string>;

export const defaults = (): Bindings => Object.fromEntries(ACTIONS.map((a) => [a.id, a.key]));

/** The saved changes laid over the defaults. Anything that is not a known action with a text key is ignored. */
export function withOverrides(saved: unknown): Bindings {
  const out = defaults();
  if (saved && typeof saved === 'object') {
    for (const [id, v] of Object.entries(saved as Record<string, unknown>)) {
      if (id in out && typeof v === 'string' && v.length <= 40 && isValidSpec(v)) out[id] = v;
    }
  }
  return out;
}

/** What differs from the defaults (this is what is saved). */
export function overridesOf(b: Bindings): Bindings {
  const d = defaults();
  return Object.fromEntries(Object.entries(b).filter(([id, v]) => d[id] !== v));
}

const MODS = ['ctrl', 'alt', 'shift'];
export function isValidSpec(spec: string): boolean {
  if (spec === '') return true;
  const parts = spec.split('+');
  const key = parts[parts.length - 1];
  if (!key || MODS.includes(key)) return false;
  const mods = parts.slice(0, -1);
  return mods.every((m, i) => MODS.includes(m) && mods.indexOf(m) === i) && mods.join('+') === MODS.filter((m) => mods.includes(m)).join('+') && !RESERVED.includes(key);
}

/** A key press as text, or null when it is only a modifier key. The Command key counts as Ctrl. */
export function specOf(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return null;
  let key = e.key === ' ' ? 'space' : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (key === 'del') key = 'delete';
  const mods = [(e.ctrlKey || e.metaKey) && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift'].filter(Boolean) as string[];
  // Shift is part of a letter already typed in capitals, but it still matters for a shortcut like Ctrl+Shift+G; a lone Shift+letter is kept too
  return [...mods, key].join('+');
}

/** Which action a key press is for, given the current bindings. */
export function actionFor(spec: string | null, b: Bindings): string | null {
  if (!spec) return null;
  for (const a of ACTIONS) if (b[a.id] === spec || a.fixed?.includes(spec)) return a.id;
  return null;
}

/** Give `spec` to an action. If another action had it, that one is left with no key (and reported). */
export function assign(b: Bindings, id: string, spec: string): { bindings: Bindings; took?: string } {
  const next = { ...b, [id]: spec };
  let took: string | undefined;
  if (spec) for (const a of ACTIONS) if (a.id !== id && next[a.id] === spec) { next[a.id] = ''; took = a.id; }
  return { bindings: next, took };
}

/** "ctrl+shift+g" -> "Ctrl+Shift+G". */
export function label(spec: string): string {
  if (!spec) return '';
  return spec.split('+').map((p) => (p.length === 1 ? p.toUpperCase() : p === 'delete' ? 'Del' : p.charAt(0).toUpperCase() + p.slice(1))).join('+');
}

export const labelOf = (id: string) => ACTIONS.find((a) => a.id === id)?.label ?? id;
