import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { HeightMap, HeightMapSummary } from '../../shared/protocol.js';

/** Validate a height map from a file or client: shape, sizes and finite numbers. */
export function validateHeightMap(m: unknown): string | null {
  const h = m as HeightMap;
  if (!h || typeof h !== 'object') return 'not a height map';
  const ints = [h.cols, h.rows];
  if (!ints.every((v) => Number.isInteger(v) && v >= 2 && v <= 60)) return 'grid must be between 2 and 60 points each way';
  const nums = [h.minX, h.maxX, h.minY, h.maxY];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'invalid scan area';
  if (!(h.maxX > h.minX) || !(h.maxY > h.minY)) return 'scan area has no size';
  if (!Array.isArray(h.z) || h.z.length !== h.rows) return 'height rows do not match the grid';
  for (const row of h.z) {
    if (!Array.isArray(row) || row.length !== h.cols) return 'height columns do not match the grid';
    if (!row.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100)) return 'invalid height value';
  }
  return null;
}

/**
 * Holds the current height map and keeps a copy of the last scan on disk.
 *
 * The saved copy is NOT loaded at startup unless `autoload` is set: a map belongs
 * to one board in one position, so quietly loading last week's map for this week's
 * job (or for a wood job) would be a trap. It is offered as a "restore last scan"
 * action instead. A machine that only ever cuts PCBs can opt in with autoload.
 */
export class HeightMapStore extends EventEmitter {
  map: HeightMap | null = null;
  /** The map saved on disk, if there is a valid one (loaded or not) */
  saved: HeightMapSummary | null = null;
  private file?: string;
  private savedMap: HeightMap | null = null;

  constructor(dataDir?: string, opts: { autoload?: boolean } = {}) {
    super();
    if (!dataDir) return;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'heightmap.json');
    try {
      const m = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const bad = validateHeightMap(m);
      if (bad) console.error(`Saved height map ignored (${this.file}): ${bad}`);
      else { this.savedMap = m; this.saved = summarize(m); if (opts.autoload) this.map = m; }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Could not read saved height map (${this.file}): ${(e as Error).message}`);
    }
  }

  set(map: HeightMap | null) {
    this.map = map;
    if (this.file) {
      try {
        if (map) fs.writeFileSync(this.file, JSON.stringify(map));
        else fs.rmSync(this.file, { force: true });
        this.savedMap = map; this.saved = map ? summarize(map) : null;
      } catch (e) { console.error(`Could not save the height map to ${this.file}: ${(e as Error).message}`); }
    }
    this.emit('heightmap', map);
    this.emit('saved', this.saved);
  }

  /** Load the saved copy. Returns false if there is none. */
  restore(): boolean {
    if (!this.savedMap) return false;
    this.map = this.savedMap;
    this.emit('heightmap', this.map);
    return true;
  }
}

const summarize = (m: HeightMap): HeightMapSummary => ({ cols: m.cols, rows: m.rows, scannedAt: m.scannedAt });
