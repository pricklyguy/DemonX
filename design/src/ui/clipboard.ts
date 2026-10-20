// The copy / paste clipboard shared between the tabs of one browser: copy in one tab, paste in another (a different design).
// It lives in the browser's own storage for this site, so it never leaves the computer. Whatever is read back is checked again by
// the paste command before it becomes shapes.

const KEY = 'design-clipboard';

export interface Clip { stamp: number; shapes: unknown[] }

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStore = (): Store | null => { try { return window.localStorage; } catch { return null; } };

/** Share a copy with the other tabs. Returns false when it could not be stored (storage blocked, or the copy is too big). */
export function writeClip(c: Clip, store: Store | null = defaultStore()): boolean {
  if (!store) return false;
  try { store.setItem(KEY, JSON.stringify(c)); return true; } catch { return false; }
}

/** The copy another tab (or this one) left, if there is a well-formed one */
export function readClip(store: Store | null = defaultStore()): Clip | null {
  if (!store) return null;
  try {
    const v = JSON.parse(store.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object' && typeof v.stamp === 'number' && Array.isArray(v.shapes) && v.shapes.length) return { stamp: v.stamp, shapes: v.shapes };
  } catch { /* unreadable: no clipboard */ }
  return null;
}

/** Called when another tab copies something */
export function onClipChange(cb: () => void): () => void {
  const f = (e: StorageEvent) => { if (e.key === KEY || e.key === null) cb(); };
  window.addEventListener('storage', f);
  return () => window.removeEventListener('storage', f);
}
