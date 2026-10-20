// The tool library file on the computer that runs the server (the browser asks for it over /api/toollib).
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_LIBRARY, parseToolLibrary, type ToolLibrary } from '../../src/core/toollib.js';

export const TOOLLIB_MAX_BYTES = 2 * 1024 * 1024;

export function readToolLib(file: string): ToolLibrary {
  try { return parseToolLibrary(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { ...EMPTY_LIBRARY, tools: [] }; }
}

/** Throws a plain message when the text is not a tool library; otherwise writes it whole (never half a file). */
export function writeToolLib(file: string, body: string): ToolLibrary {
  let parsed: ToolLibrary;
  try { parsed = parseToolLibrary(JSON.parse(body)); } catch (e) { throw new Error(e instanceof SyntaxError ? 'That is not valid JSON' : (e as Error).message); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 1));
  fs.renameSync(tmp, file);
  return parsed;
}
