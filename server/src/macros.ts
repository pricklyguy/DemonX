import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Macro } from '../../shared/protocol.js';

// Macros: saved lists of G-code lines that run with one tap. They go through the same
// protections as the console, and probing (G38) is refused: the Probe panel asks the
// safety questions (is the probe connected, remove it afterwards), and a macro must not
// be a way around them.

export class MacroError extends Error {}

const MAX_MACROS = 50, MAX_LINES = 200, MAX_NAME = 40, MAX_CONTENT = 8000, MAX_LINE = 100;

export type Step = { kind: 'line'; text: string } | { kind: 'wait' };

/** The program's extents, for [xmin] and friends */
export interface Vars { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
const VAR_NAMES: Record<string, keyof Vars> = { xmin: 'minX', xmax: 'maxX', ymin: 'minY', ymax: 'maxY', zmin: 'minZ', zmax: 'maxZ' };

/** What the macro will actually send. `vars` are the loaded program's extents (undefined when none is loaded). */
export function compileMacro(content: string, vars?: Vars): Step[] {
  const steps: Step[] = [];
  content.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    // comments: ; to the end of the line, and (...) anywhere
    let line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
    if (!line) return;
    if (line.startsWith('%')) {
      if (/^%wait$/i.test(line)) { steps.push({ kind: 'wait' }); return; }
      throw new MacroError(`Line ${n}: only %wait is supported after a %`);
    }
    line = line.replace(/\[([^\]]*)\]/g, (_m, name: string) => {
      const key = VAR_NAMES[name.trim().toLowerCase()];
      if (!key) throw new MacroError(`Line ${n}: [${name}] is not known. Use [xmin] [xmax] [ymin] [ymax] [zmin] [zmax]`);
      if (!vars) throw new MacroError(`Line ${n}: uses [${name.trim()}] but no G-code file is loaded`);
      return vars[key].toFixed(3);
    });
    if (/(^|[^A-Z0-9.])G0*3[78](?![0-9])/i.test(line)) {
      throw new MacroError(`Line ${n}: probing (G38) is not allowed in a macro. Use the Probe panel: it asks the safety questions`);
    }
    if (line.length > MAX_LINE) throw new MacroError(`Line ${n} is too long`);
    steps.push({ kind: 'line', text: line });
  });
  if (steps.length > MAX_LINES) throw new MacroError(`A macro can have up to ${MAX_LINES} lines`);
  return steps;
}

/** Check a macro as it is saved: names, size, and that it compiles (variables are checked with sample values) */
export function validateMacro(m: { name?: unknown; content?: unknown }): { name: string; content: string } {
  if (typeof m.name !== 'string' || !m.name.trim()) throw new MacroError('Give the macro a name');
  if (typeof m.content !== 'string') throw new MacroError('The macro has no G-code');
  const name = m.name.trim();
  if (name.length > MAX_NAME) throw new MacroError(`The name can be up to ${MAX_NAME} characters`);
  if (m.content.length > MAX_CONTENT) throw new MacroError('The macro is too long');
  const sample: Vars = { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };
  if (!compileMacro(m.content, sample).length) throw new MacroError('The macro has no commands');
  return { name, content: m.content };
}

const SEED: Macro[] = [{
  id: 'move-to-back', name: 'Move to Back',
  content: '; Park the gantry at the back to get at a large piece\nG90\nG0 X0 Y90\n',
}];

/** The saved macros, kept in the data folder */
export class MacroStore extends EventEmitter {
  private macros: Macro[] = [];
  private file?: string;

  constructor(dataDir?: string) {
    super();
    if (!dataDir) { this.macros = SEED.map((m) => ({ ...m })); return; }
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'macros.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved)) {
        for (const m of saved) {
          try { this.macros.push({ id: String(m.id), ...validateMacro(m) }); } catch { /* skip a damaged entry */ }
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { this.macros = SEED.map((m) => ({ ...m })); this.write(); }
      else console.error(`Could not read ${this.file}: ${(e as Error).message}`);
    }
  }

  get list(): Macro[] { return this.macros; }
  find(id: string): Macro | undefined { return this.macros.find((m) => m.id === id); }

  save(m: { id?: unknown; name?: unknown; content?: unknown }) {
    const ok = validateMacro(m);
    const id = typeof m.id === 'string' ? m.id : undefined;
    const at = id ? this.macros.findIndex((x) => x.id === id) : -1;
    if (at >= 0) this.macros[at] = { id: id!, ...ok };
    else {
      if (this.macros.length >= MAX_MACROS) throw new MacroError(`Up to ${MAX_MACROS} macros`);
      this.macros.push({ id: crypto.randomUUID(), ...ok });
    }
    this.changed();
  }

  remove(id: string) {
    this.macros = this.macros.filter((m) => m.id !== id);
    this.changed();
  }

  private changed() { this.write(); this.emit('macros', this.macros); }

  private write() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify(this.macros, null, 2)); }
    catch (e) { console.error(`Could not save ${this.file}: ${(e as Error).message}`); }
  }
}
