import { useEffect, useState } from 'react';
import { EMPTY_LIBRARY, parseToolLibrary, type ToolLibrary } from '../core/toollib';

const STORE = 'design-tool-library';
const EVENT = 'design-tool-library-changed';

// The library lives on the server, so every computer that opens Design sees the same cutters. This browser keeps a copy (to work
// when the server cannot be reached, and to hand the library over the first time a server has none).
const readLocal = (): ToolLibrary => {
  try { return parseToolLibrary(JSON.parse(localStorage.getItem(STORE) ?? 'null')); } catch { return { ...EMPTY_LIBRARY, tools: [] }; }
};
let cache: ToolLibrary = readLocal();
const writeLocal = (lib: ToolLibrary) => { try { localStorage.setItem(STORE, JSON.stringify(lib)); } catch { /* private mode, or too big: it just will not be remembered here */ } };
const notify = () => window.dispatchEvent(new Event(EVENT));

export const loadToolLibrary = (): ToolLibrary => cache;

async function push(lib: ToolLibrary): Promise<string> {
  try {
    const r = await fetch('/api/toollib', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lib) });
    if (r.ok) return '';
    const j = await r.json().catch(() => ({}));
    return j.error ?? `The server said ${r.status}`;
  } catch { return ''; /* offline: the copy in this browser stays */ }
}

/** Save the library here and on the server. Returns a message when the server refused it (empty when saved or when it could not be reached). */
export async function saveToolLibrary(lib: ToolLibrary): Promise<string> {
  cache = lib;
  writeLocal(lib);
  notify();
  return push(lib);
}

/** Fetch the server's library. If it has none yet and this browser has one, this browser's becomes the server's. */
export async function syncToolLibrary() {
  try {
    const r = await fetch('/api/toollib', { cache: 'no-store' });
    if (!r.ok) return;
    const server = parseToolLibrary(await r.json());
    if (server.tools.length) { cache = server; writeLocal(server); notify(); }
    else if (cache.tools.length) void push(cache);
  } catch { /* offline or an old server: the copy in this browser is used */ }
}

let started = false;

/** The tool library, kept up to date when another part of the app changes it */
export function useToolLibrary(): ToolLibrary {
  const [lib, setLib] = useState(loadToolLibrary);
  useEffect(() => {
    const on = () => setLib(loadToolLibrary());
    window.addEventListener(EVENT, on);
    if (!started) { started = true; void syncToolLibrary(); }
    on();
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return lib;
}
