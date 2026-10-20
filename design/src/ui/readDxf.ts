import { importDxf, type ImportResult } from '../core/dxf';

/** Reads a DXF file's text into shapes in a worker, so the page stays usable while a big file is read. Without workers it is read here. */
export function readDxf(text: string): Promise<ImportResult> {
  if (typeof Worker === 'undefined') {
    try { return Promise.resolve(importDxf(text)); } catch (e) { return Promise.reject(e); }
  }
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../core/dxfWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ ok: boolean; result?: ImportResult; error?: string }>) => {
      w.terminate();
      if (e.data.ok && e.data.result) resolve(e.data.result); else reject(new Error(e.data.error ?? 'Could not read this DXF'));
    };
    w.onerror = () => { w.terminate(); reject(new Error('Could not read this DXF')); };
    w.postMessage({ text });
  });
}
