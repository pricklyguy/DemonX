import { computeJobs, toWire, type JobInput } from './jobBuild';

// Runs in a Web Worker: the page sends the drawing, this works out the job and sends it back.
self.onmessage = (e: MessageEvent<{ id: number; input: JobInput }>) => {
  try {
    const { wire, transfer } = toWire(computeJobs(e.data.input));
    (self as unknown as Worker).postMessage({ id: e.data.id, out: wire }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: e.data.id, error: err instanceof Error ? err.message : String(err) });
  }
};
