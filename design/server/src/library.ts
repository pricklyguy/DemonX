// The material library file on the computer that runs the server (the browser asks for it over /api/library).
// The server checks what it is given before it writes: nothing but a well-formed library is ever stored.
import fs from 'node:fs';
import path from 'node:path';
import { emptyLibraries, parseLibraries, type Libraries } from '../../src/core/materials.js';

export const LIBRARY_MAX_BYTES = 4 * 1024 * 1024;

export function readLibraries(file: string): Libraries {
  try { return parseLibraries(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return emptyLibraries(); }
}

/** Throws a plain message when the text is not a library; otherwise writes it whole (never half a file). */
export function writeLibraries(file: string, body: string): Libraries {
  let parsed: Libraries;
  try { parsed = parseLibraries(JSON.parse(body)); } catch (e) { throw new Error(e instanceof SyntaxError ? 'That is not valid JSON' : (e as Error).message); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 1));
  fs.renameSync(tmp, file);
  return parsed;
}
