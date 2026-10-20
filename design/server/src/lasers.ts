// The laser list file on the computer that runs the server (the browser asks for it over /api/lasers).
import fs from 'node:fs';
import path from 'node:path';
import { parseLasers, type LaserList } from '../../src/core/lasers.js';

export const LASERS_MAX_BYTES = 256 * 1024;

export function readLasers(file: string): LaserList {
  try { return parseLasers(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { v: 1, lasers: [] }; }
}

/** Throws a plain message when the text is not a laser list; otherwise writes it whole (never half a file). */
export function writeLasers(file: string, body: string): LaserList {
  let parsed: LaserList;
  try { parsed = parseLasers(JSON.parse(body)); } catch (e) { throw new Error(e instanceof SyntaxError ? 'That is not valid JSON' : (e as Error).message); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 1));
  fs.renameSync(tmp, file);
  return parsed;
}
