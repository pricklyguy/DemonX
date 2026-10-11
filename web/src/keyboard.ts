import { useEffect, useRef, useState } from 'react';
import { ACTIONS, DEFAULT_KEYS, actionFor, isModifierCode, rebind, resolveBindings, type Bindings, type KeyAction } from '../../shared/keys';
import { canJog, jogGesture, stopAllJogging } from './holdJog';
import type { Machine } from './useMachine';

// Keyboard shortcuts for jogging and a few safe actions. Off until turned on in Settings > Keyboard (this browser only).
// Keys act only when you are not typing in a box, and never with Ctrl, Alt or Cmd held, so browser shortcuts keep working.
// A held jog key moves the machine only while it is held (see shared/holdjog.ts and server/src/jogHold.ts); losing focus lets go.

const KEY = 'keys';
interface Saved { enabled: boolean; keys: Partial<Bindings> }

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { enabled: raw?.enabled === true, keys: resolveBindings(raw?.keys) };
  } catch { return { enabled: false, keys: { ...DEFAULT_KEYS } }; }
}

export interface KeysState {
  enabled: boolean;
  bindings: Bindings;
  setEnabled: (on: boolean) => void;
  /** Bind a key (code) to an action; returns the action that lost the key, if any */
  setKey: (action: KeyAction, code: string) => KeyAction | undefined;
  reset: () => void;
  /** While true the keyboard is being used to pick a shortcut, so no shortcut may fire */
  capturing: { current: boolean };
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

export function useKeyboard(m: Machine): KeysState {
  const [saved, setSaved] = useState<Saved>(load);
  const capturing = useRef(false);
  const latest = useRef({ m, saved });
  latest.current = { m, saved };

  const write = (n: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* not saved in private mode */ } return n; };

  useEffect(() => {
    const handle = (e: KeyboardEvent, down: boolean) => {
      const { m: mm, saved: sv } = latest.current;
      if (!sv.enabled || capturing.current || e.ctrlKey || e.metaKey || e.altKey) return;
      const id = actionFor(sv.keys as Bindings, e.code);
      if (!id) return;
      const info = ACTIONS.find((a) => a.id === id)!;
      if (info.dir) {
        // a key already held keeps its hold even if focus has since moved into a box, so that it can be let go
        if (down && (typing(e.target) || !canJog(mm))) return;
        e.preventDefault();
        if (down) { if (!e.repeat) jogGesture.down(`key:${e.code}`, info.dir); } else jogGesture.up(`key:${e.code}`);
        return;
      }
      if (typing(e.target)) return;
      if (!down) { e.preventDefault(); return; }
      if (e.repeat) { e.preventDefault(); return; }
      if (id === 'feedHold') { if (mm.online && mm.auth.operator && mm.connection.connected) { e.preventDefault(); mm.send({ type: 'hold' }); } return; }
      if (id === 'jogStop') { if (mm.online && mm.auth.operator) { e.preventDefault(); stopAllJogging(); mm.send({ type: 'jogCancel' }); } return; }
      if (id === 'stepSmaller' || id === 'stepLarger') { e.preventDefault(); window.dispatchEvent(new CustomEvent('demonx:jogstep', { detail: id === 'stepLarger' ? 1 : -1 })); }
    };
    const d = (e: KeyboardEvent) => handle(e, true), u = (e: KeyboardEvent) => handle(e, false);
    window.addEventListener('keydown', d); window.addEventListener('keyup', u);
    return () => { window.removeEventListener('keydown', d); window.removeEventListener('keyup', u); };
  }, []);

  // turning shortcuts off lets go of anything held
  useEffect(() => { if (!saved.enabled) stopAllJogging(); }, [saved.enabled]);

  return {
    enabled: saved.enabled, bindings: saved.keys as Bindings, capturing,
    setEnabled: (on) => setSaved((s) => write({ ...s, enabled: on })),
    setKey: (action, code) => {
      const r = rebind(latest.current.saved.keys as Bindings, action, code);
      setSaved((s) => write({ ...s, keys: r.bindings }));
      return r.took;
    },
    reset: () => setSaved((s) => write({ ...s, keys: { ...DEFAULT_KEYS } })),
  };
}

export { isModifierCode };
