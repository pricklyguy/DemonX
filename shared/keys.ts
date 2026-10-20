// Keyboard shortcuts: the actions, their default keys, and rebinding. Keys are stored as `KeyboardEvent.code` (the physical key,
// so a binding does not change with the keyboard layout). Pure, so it is tested without a browser (server/test/keys.test.ts).

export type KeyAction =
  | 'jogXminus' | 'jogXplus' | 'jogYplus' | 'jogYminus' | 'jogZplus' | 'jogZminus'
  | 'stepSmaller' | 'stepLarger' | 'feedHold' | 'jogStop';

export interface ActionInfo { id: KeyAction; label: string; hint: string; dir?: { x: number; y: number; z: number } }

export const ACTIONS: ActionInfo[] = [
  { id: 'jogXminus', label: 'Jog X−', hint: 'Tap: one step. Hold: keeps moving.', dir: { x: -1, y: 0, z: 0 } },
  { id: 'jogXplus', label: 'Jog X+', hint: 'Tap: one step. Hold: keeps moving.', dir: { x: 1, y: 0, z: 0 } },
  { id: 'jogYplus', label: 'Jog Y+', hint: 'Tap: one step. Hold: keeps moving.', dir: { x: 0, y: 1, z: 0 } },
  { id: 'jogYminus', label: 'Jog Y−', hint: 'Tap: one step. Hold: keeps moving.', dir: { x: 0, y: -1, z: 0 } },
  { id: 'jogZplus', label: 'Jog Z+', hint: 'Tap: one step. Hold: keeps moving (slow, and at most 20 mm).', dir: { x: 0, y: 0, z: 1 } },
  { id: 'jogZminus', label: 'Jog Z−', hint: 'Tap: one step. Hold: keeps moving (slow, and at most 20 mm).', dir: { x: 0, y: 0, z: -1 } },
  { id: 'stepSmaller', label: 'Smaller XY step', hint: 'Next smaller step in the Jog panel' },
  { id: 'stepLarger', label: 'Larger XY step', hint: 'Next larger step in the Jog panel' },
  { id: 'feedHold', label: 'Feed hold', hint: 'Pause a job or stop a move. Resume is a button on screen.' },
  { id: 'jogStop', label: 'Stop jogging', hint: 'Cancel any jog now' },
];

export const DEFAULT_KEYS: Record<KeyAction, string> = {
  jogXminus: 'ArrowLeft', jogXplus: 'ArrowRight', jogYplus: 'ArrowUp', jogYminus: 'ArrowDown', jogZplus: 'PageUp', jogZminus: 'PageDown',
  stepSmaller: 'BracketLeft', stepLarger: 'BracketRight', feedHold: 'Space', jogStop: 'Escape',
};

export type Bindings = Record<KeyAction, string>;
const IDS = ACTIONS.map((a) => a.id);

/** Saved overrides on top of the defaults. A saved empty string means "no key". Anything unknown is ignored. */
export function resolveBindings(saved: unknown): Bindings {
  const out = { ...DEFAULT_KEYS };
  if (saved && typeof saved === 'object') {
    for (const id of IDS) {
      const v = (saved as Record<string, unknown>)[id];
      if (typeof v === 'string' && v.length <= 40) out[id] = v;
    }
  }
  // two actions on one key would do both: the later one in the list loses its key
  const seen = new Set<string>();
  for (const id of IDS) { if (out[id] && seen.has(out[id])) out[id] = ''; else if (out[id]) seen.add(out[id]); }
  return out;
}

/** Bind a key to an action. If another action had that key it loses it (returned, so the page can say so). */
export function rebind(b: Bindings, action: KeyAction, code: string): { bindings: Bindings; took?: KeyAction } {
  const next = { ...b };
  let took: KeyAction | undefined;
  if (code) for (const id of IDS) if (id !== action && next[id] === code) { next[id] = ''; took = id; }
  next[action] = code;
  return { bindings: next, took };
}

/** Which action a key does, if any */
export function actionFor(b: Bindings, code: string): KeyAction | undefined {
  return code ? IDS.find((id) => b[id] === code) : undefined;
}

/** Modifier keys cannot be a shortcut by themselves */
export const isModifierCode = (code: string) => /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|NumLock|ScrollLock|Fn|ContextMenu)$/.test(code);

/** A short name to show for a key code */
export function keyLabel(code: string): string {
  if (!code) return 'none';
  const map: Record<string, string> = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`',
  };
  if (map[code]) return map[code];
  const k = /^Key([A-Z])$/.exec(code); if (k) return k[1];
  const d = /^Digit(\d)$/.exec(code); if (d) return d[1];
  const n = /^Numpad(.+)$/.exec(code); if (n) return `Num ${n[1].replace('Subtract', '−').replace('Add', '+').replace('Decimal', '.').replace('Multiply', '×').replace('Divide', '÷')}`;
  return code;
}
