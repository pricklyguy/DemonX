import { useSyncExternalStore } from 'react';
import { assign, defaults, overridesOf, withOverrides, type Bindings } from '../core/shortcuts';

const KEY = 'design-shortcuts';

function load(): Bindings {
  try { return withOverrides(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return defaults(); }
}

let current: Bindings = load();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(overridesOf(current))); } catch { /* it just will not be remembered */ } };

export const getBindings = (): Bindings => current;
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Give an action a key (or '' for none). Returns the id of the action that lost the key, if there was one. */
export function setKey(id: string, spec: string): string | undefined {
  const r = assign(current, id, spec);
  current = r.bindings; save(); notify();
  return r.took;
}
export function resetKey(id: string) {
  const d = defaults();
  const r = assign(current, id, d[id]);
  current = r.bindings; save(); notify();
}
export function resetAll() { current = defaults(); save(); notify(); }

/** The current keys; the component renders again when they change. */
export const useBindings = (): Bindings => useSyncExternalStore(subscribe, getBindings);
