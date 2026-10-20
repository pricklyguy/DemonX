import { useEffect, useState } from 'react';
import type { Machine } from '../core/types';
import { LASER_PRESETS } from '../core/types';
import { parseLasers } from '../core/lasers';

const STORE = 'design-devices';
const EVENT = 'design-devices-changed';

// The laser list lives on the server, so every computer that opens Design sees the same lasers. This browser keeps a copy
// (to work when the server cannot be reached, and to hand the list over the first time a server has none).
const readLocal = (): Machine[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(raw) ? raw.filter((d) => d && typeof d.name === 'string' && d.width > 0 && d.height > 0 && d.sMax > 0).map((d) => ({ rapid: 100, ...d })) : [];
  } catch { return []; }
};
let cache: Machine[] = readLocal();
const writeLocal = (list: Machine[]) => { try { localStorage.setItem(STORE, JSON.stringify(list)); } catch { /* private mode: it just will not be remembered */ } };
const notify = () => window.dispatchEvent(new Event(EVENT));

/** Lasers saved on this server, by name */
export function loadDevices(): Machine[] { return cache; }

async function push(list: Machine[]) {
  try { await fetch('/api/lasers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, lasers: list }) }); } catch { /* the copy in this browser stays */ }
}

export function saveDevices(list: Machine[]) {
  cache = list;
  writeLocal(list);
  notify();
  void push(list);
}

/** Fetch the server's list. If it has none yet and this browser has some, this browser's list becomes the server's. */
export async function syncDevices() {
  try {
    const r = await fetch('/api/lasers', { cache: 'no-store' });
    if (!r.ok) return;
    const server = parseLasers(await r.json()).lasers;
    if (server.length) { cache = server; writeLocal(server); notify(); }
    else if (cache.length) void push(cache);
  } catch { /* offline or an old server: the copy in this browser is used */ }
}

let started = false;

/** The saved lasers, kept up to date when another part of the app changes them */
export function useDevices(): Machine[] {
  const [list, setList] = useState<Machine[]>(loadDevices);
  useEffect(() => {
    const on = () => setList(loadDevices());
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', on);
    window.addEventListener('focus', syncDevices);
    if (!started) { started = true; void syncDevices(); }
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', on); window.removeEventListener('focus', syncDevices); };
  }, []);
  return list;
}

/** Built-in lasers, then the saved ones (a saved one with the same name replaces the built-in) */
export function allLasers(saved: Machine[]): Machine[] {
  const names = new Set(saved.map((d) => d.name));
  return [...LASER_PRESETS.filter((p) => !names.has(p.name)), ...saved];
}

/** Remember where a laser's 0,0 is (its ruler and Y box start there), in the saved list, so the next design with it starts the same way */
export function setDeviceOrigin(m: Machine, origin: 'tl' | 'bl') {
  const saved = loadDevices();
  const base = allLasers(saved).find((d) => d.name === m.name) ?? m;
  saveDevices([...saved.filter((d) => d.name !== m.name), { ...base, origin }]);
}
