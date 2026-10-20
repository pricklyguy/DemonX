import { importDxf } from './dxf';

// Runs in a Web Worker: reading a big DXF file (thousands of lines, splines, blocks) must not freeze the page.
self.onmessage = (e: MessageEvent<{ text: string }>) => {
  try {
    (self as unknown as Worker).postMessage({ ok: true, result: importDxf(e.data.text) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
