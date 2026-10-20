// The rotary settings file on the computer that runs the server (the browser asks for it over /api/rotary).
import fs from 'node:fs';
import path from 'node:path';
import { emptyRotary, parseRotary, type RotaryList } from '../../src/core/rotary.js';

export const ROTARY_MAX_BYTES = 64 * 1024;

export function readRotary(file: string): RotaryList {
  try { return parseRotary(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return emptyRotary(); }
}

/** Is rotary switched on for this laser (by its connection name)? Unreadable settings count as off. */
export function rotaryOn(file: string, target: string): boolean {
  return readRotary(file).sets[target]?.enabled === true;
}

/** Throws a plain message when the text is not rotary settings; otherwise writes it whole (never half a file). */
export function writeRotary(file: string, body: string): RotaryList {
  let parsed: RotaryList;
  try { parsed = parseRotary(JSON.parse(body)); } catch (e) { throw new Error(e instanceof SyntaxError ? 'That is not valid JSON' : (e as Error).message); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 1));
  fs.renameSync(tmp, file);
  return parsed;
}
