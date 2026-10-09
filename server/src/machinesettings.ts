import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { GrblController } from './controller.js';
import {
  checkFluidNcChange, checkGrblChange, isReadOnlyKey, sameValue,
  type MachineSettings, type SettingChange, type SettingValue,
} from '../../shared/machine-settings.js';

// Reading and changing the controller's own settings.
//
// FluidNC keeps its settings in a YAML config file. A change sent to a running FluidNC (`$/axes/x/…=value`) takes
// effect at once but is forgotten at the next restart. To keep it, the running configuration is written to a new
// file, checked by reading it back, and only then swapped in for config.yaml, with the old file kept beside it and
// a copy kept in DemonX's data folder. Writing the file also drops its comments and re-orders it (FluidNC writes it).
// Classic GRBL stores `$N` settings itself, so a change there is permanent straight away.

export class SettingsError extends Error {}

type Flat = Record<string, SettingValue>;

/** { axes: { x: { steps_per_mm: 133 } } } -> { 'axes/x/steps_per_mm': 133 } (the same paths `$/…` uses) */
export function flattenConfig(tree: unknown, prefix = '', out: Flat = {}): Flat {
  if (tree && typeof tree === 'object' && !Array.isArray(tree)) {
    for (const [k, v] of Object.entries(tree)) flattenConfig(v, prefix ? `${prefix}/${k}` : String(k), out);
  } else if (prefix && !Array.isArray(tree)) {
    out[prefix] = tree === null || tree === undefined ? '' : (tree as SettingValue);
  }
  return out;
}

/** Parse config text into flat settings, or undefined when it is not a usable config */
export function parseConfigText(text: string): Flat | undefined {
  try {
    const tree = YAML.parse(text);
    if (!tree || typeof tree !== 'object') return undefined;
    const flat = flattenConfig(tree);
    return Object.keys(flat).some((k) => k.startsWith('axes/')) ? flat : undefined;
  } catch { return undefined; }
}

const LOCK = 'The controller settings are being read or changed';
const text = (lines: string[]) => lines.filter((l) => !/^\[(MSG|GC|VER|OPT)/.test(l)).join('\n');

export class MachineSettingsService {
  /** Settings changed since the last save or restart (a change to a setting the file does not mention cannot be seen by comparing) */
  private dirty = new Set<string>();
  private busy = false;

  constructor(private ctl: GrblController, private dataDir?: string) {
    ctl.on('reset', () => this.dirty.clear());   // a restart loads the saved file again
  }

  /** Run one settings operation with the controller locked against everything else */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const c = this.ctl;
    if (!c.connection.connected) throw new SettingsError('Connect to the machine first');
    if (c.job.state === 'running' || c.job.state === 'paused') throw new SettingsError('Not while a job is running');
    if (c.status.state !== 'Idle' && c.status.state !== 'Alarm') throw new SettingsError(`The machine must be Idle (it is ${c.status.state})`);
    if (c.lock || this.busy) throw new SettingsError(`Blocked: ${c.lock ?? 'another settings operation is running'}`);
    this.busy = true; c.lock = LOCK;
    try { return await fn(); } finally { c.lock = undefined; this.busy = false; }
  }

  private async detect(): Promise<'fluidnc' | 'grbl'> {
    const r = await this.ctl.runCommand('$I');
    if (!r.ok) throw new SettingsError(`The controller did not answer $I${r.error ? ` (${r.error})` : ''}`);
    return /fluidnc/i.test(r.lines.join(' ')) ? 'fluidnc' : 'grbl';
  }

  read(): Promise<MachineSettings> { return this.exclusive(() => this.readNow()); }

  private async readNow(): Promise<MachineSettings> {
    const kind = await this.detect();
    return kind === 'fluidnc' ? this.readFluidNc() : this.readGrbl();
  }

  private async readGrbl(): Promise<MachineSettings> {
    const r = await this.ctl.runCommand('$$');
    if (!r.ok) throw new SettingsError(`The controller would not list its settings${r.error ? ` (${r.error})` : ''}`);
    const values: Flat = {};
    for (const l of r.lines) {
      const m = /^\$(\d+)=([-+0-9.eE]+)/.exec(l);
      if (m) values[`$${m[1]}`] = Number(m[2]);
    }
    if (!Object.keys(values).length) throw new SettingsError('The controller listed no settings');
    return { kind: 'grbl', values, readAt: Date.now() };
  }

  /** Which file the controller loads its config from, as a path on its own flash. undefined when it is on the SD card. */
  private async configPath(): Promise<string | undefined> {
    const r = await this.ctl.runCommand('$Config/Filename');
    const name = r.ok ? r.lines.map((l) => /Config\/Filename\s*=\s*(\S+)/i.exec(l)?.[1]).find(Boolean) : undefined;
    const p = name ?? 'config.yaml';
    if (/^\/?sd\//i.test(p)) return undefined;
    return p.startsWith('/') ? p : `/${p}`;
  }

  private async showFile(file: string): Promise<string | undefined> {
    const r = await this.ctl.runCommand(`$LocalFS/Show=${file}`);
    return r.ok ? text(r.lines) : undefined;
  }

  private async readFluidNc(): Promise<MachineSettings> {
    const dump = await this.ctl.runCommand('$CD');
    if (!dump.ok) throw new SettingsError(`The controller would not dump its configuration${dump.error ? ` (${dump.error})` : ''}`);
    const values = parseConfigText(text(dump.lines));
    if (!values) throw new SettingsError('The configuration the controller printed could not be read');
    const file = await this.configPath();
    const savedText = file ? await this.showFile(file) : undefined;
    const saved = savedText ? parseConfigText(savedText) : undefined;
    const unsaved = new Set(this.dirty);
    // (wiring is skipped: the dump may print pins and enums differently from the file without anything having changed)
    if (saved) for (const [k, v] of Object.entries(saved)) if (k in values && !isReadOnlyKey(k) && !sameValue(values[k], v)) unsaved.add(k);
    return { kind: 'fluidnc', values, saved, file, unsaved: [...unsaved].sort(), readAt: Date.now() };
  }

  /** Change settings on the controller. All or nothing: a refusal puts back what was already changed. */
  apply(changes: SettingChange[]): Promise<MachineSettings> {
    return this.exclusive(async () => {
      if (!Array.isArray(changes) || !changes.length || changes.length > 200) throw new SettingsError('Nothing to change');
      const before = await this.readNow();
      const check = before.kind === 'fluidnc' ? checkFluidNcChange : checkGrblChange;
      const problems: string[] = [];
      const todo: SettingChange[] = [];
      for (const c of changes) {
        const why = check(c.key, c.value, before.values[c.key]);
        if (why) problems.push(why);
        else if (!sameValue(before.values[c.key], c.value)) todo.push(c);
      }
      if (problems.length) throw new SettingsError(problems.join('. '));
      if (!todo.length) return before;

      const send = (key: string, value: SettingValue) => this.ctl.runCommand(before.kind === 'fluidnc' ? `$/${key}=${fmt(value)}` : `${key}=${fmt(value)}`);
      const done: SettingChange[] = [];
      for (const c of todo) {
        const r = await send(c.key, c.value);
        if (!r.ok) {
          for (const d of done.reverse()) await send(d.key, before.values[d.key]);   // best effort: put back what was changed
          throw new SettingsError(`The controller refused ${c.key}${r.error ? ` (${r.error})` : ''}. ${done.length ? 'The earlier changes were put back.' : 'Nothing was changed.'}`);
        }
        done.push(c);
      }
      if (before.kind === 'fluidnc') for (const c of todo) this.dirty.add(c.key);
      const after = await this.readNow();
      const off = todo.filter((c) => !sameValue(after.values[c.key], c.value));
      if (off.length) throw new SettingsError(`The controller accepted ${off.map((c) => c.key).join(', ')} but is not using the value (it may have limited it)`);
      return after;
    });
  }

  /** FluidNC: make the running configuration the saved one. See the note at the top of this file. */
  save(): Promise<{ settings: MachineSettings; backup?: string }> {
    return this.exclusive(async () => {
      if (await this.detect() !== 'fluidnc') throw new SettingsError('Only FluidNC keeps a config file: GRBL settings are already saved');
      const file = await this.configPath();
      if (!file) throw new SettingsError('This machine loads its config from the SD card, which DemonX does not write');
      const runtime = parseConfigText(text((await this.ctl.runCommand('$CD')).lines));
      if (!runtime) throw new SettingsError('Could not read the running configuration');

      // 1. keep the file as it is now, here, before anything is touched
      const old = await this.showFile(file);
      if (!old || !parseConfigText(old)) throw new SettingsError(`Could not read ${file} from the controller, so it was not changed`);
      const backup = this.backup(old);

      // 2. write the new one beside it and check it reads back as the running configuration
      const tmp = file.replace(/\.ya?ml$/i, '') + '.new.yaml', bak = file.replace(/\.ya?ml$/i, '') + '.backup.yaml';
      const del = (f: string) => this.ctl.runCommand(`$LocalFS/Delete=${f}`);
      const w = await this.ctl.runCommand(`$CD=${tmp}`);
      const written = w.ok ? await this.showFile(tmp) : undefined;
      const flat = written ? parseConfigText(written) : undefined;
      if (!flat || !sameFlat(flat, runtime)) {
        await del(tmp);
        throw new SettingsError(`The new config file did not read back correctly${w.error ? ` (${w.error})` : ''}. ${file} was not changed.`);
      }

      // 3. swap it in, keeping the old one on the controller too; undo if the result is not right
      if (!(await this.ctl.runCommand(`$LocalFS/Rename=${file}>${bak}`)).ok) { await del(tmp); throw new SettingsError(`Could not set ${file} aside, so it was not changed`); }
      const moved = await this.ctl.runCommand(`$LocalFS/Rename=${tmp}>${file}`);
      const final = moved.ok ? await this.showFile(file) : undefined;
      const finalFlat = final ? parseConfigText(final) : undefined;
      if (!finalFlat || !sameFlat(finalFlat, runtime)) {
        await this.ctl.runCommand(`$LocalFS/Rename=${bak}>${file}`);
        throw new SettingsError(`The saved file did not check out, so the old ${file} was put back`);
      }
      this.dirty.clear();
      return { settings: await this.readNow(), backup };
    });
  }

  /** Restart the controller (it comes back with its saved configuration) */
  restart(): Promise<void> {
    return this.exclusive(async () => {
      if (await this.detect() !== 'fluidnc') throw new SettingsError('Only FluidNC can be restarted from here');
      const r = await this.ctl.runCommand('$Bye', 5000);
      if (!r.ok) throw new SettingsError(`The controller would not restart${r.error ? ` (${r.error})` : ''}`);
    });
  }

  /** The config files DemonX has kept, newest first */
  backups(): string[] {
    if (!this.dataDir) return [];
    try { return fs.readdirSync(path.join(this.dataDir, 'fluidnc-backups')).filter((f) => f.endsWith('.yaml')).sort().reverse(); } catch { return []; }
  }

  backupText(name: string): string | undefined {
    if (!this.dataDir || !/^[\w.\-]+\.yaml$/.test(name)) return undefined;
    try { return fs.readFileSync(path.join(this.dataDir, 'fluidnc-backups', name), 'utf8'); } catch { return undefined; }
  }

  private backup(content: string): string | undefined {
    if (!this.dataDir) return undefined;
    const dir = path.join(this.dataDir, 'fluidnc-backups');
    fs.mkdirSync(dir, { recursive: true });
    const name = `config-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`;
    fs.writeFileSync(path.join(dir, name), content);
    return name;
  }
}

const fmt = (v: SettingValue) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));

function sameFlat(a: Flat, b: Flat): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && sameValue(a[k], b[k]));
}
