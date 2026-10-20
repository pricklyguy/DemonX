// The saved positions file on the computer that runs the server (the browser asks for it over /api/positions).
import fs from 'node:fs';
import path from 'node:path';
import { emptyPositions, parsePositions, type PositionList } from '../../src/core/positions.js';

export const POSITIONS_MAX_BYTES = 256 * 1024;

export function readPositions(file: string): PositionList {
  try { return parsePositions(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return emptyPositions(); }
}

/** Throws a plain message when the text is not a list of positions; otherwise writes it whole (never half a file). */
export function writePositions(file: string, body: string): PositionList {
  let parsed: PositionList;
  try { parsed = parsePositions(JSON.parse(body)); } catch (e) { throw new Error(e instanceof SyntaxError ? 'That is not valid JSON' : (e as Error).message); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 1));
  fs.renameSync(tmp, file);
  return parsed;
}
