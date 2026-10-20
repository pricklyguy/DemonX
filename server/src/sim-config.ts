import YAML from 'yaml';
import { SIM_CONFIG_YAML } from './sim-fluidnc-config.js';

// The settings side of the simulated controller: just enough of FluidNC (config file, runtime changes, a few
// file commands) or classic GRBL ($$) to develop and test the Controller settings page without hardware.
// It answers with the same kind of lines the real firmware prints; the details of the real ones are only
// as good as the FluidNC source this was written from, so first runs on real hardware should be supervised.

export type SimFirmware = 'grbl' | 'fluidnc';

export const SIM_BANNER: Record<SimFirmware, string> = {
  grbl: "Grbl 1.1h ['$' for help]",
  fluidnc: "Grbl 3.7 [FluidNC v3.7.13 (wifi) '$' for help]",
};

const GRBL_DEFAULTS: Record<number, number> = {
  0: 10, 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 10: 1, 11: 0.01, 12: 0.002, 13: 0, 20: 0, 21: 0, 22: 0, 23: 0, 24: 25, 25: 500, 26: 250, 27: 1,
  30: 1000, 31: 0, 32: 0, 100: 250, 101: 250, 102: 250, 110: 500, 111: 500, 112: 500, 120: 10, 121: 10, 122: 10, 130: 200, 131: 200, 132: 200,
};

export class SimConfig {
  private grbl: Record<number, number> = { ...GRBL_DEFAULTS };
  private cfg: Record<string, unknown> = YAML.parse(SIM_CONFIG_YAML);
  private files = new Map<string, string>([['/config.yaml', SIM_CONFIG_YAML]]);
  /** Set when a reply says the controller restarts ($Bye) */
  onRestart?: () => void;
  /** Test hook: the next write of a config file stops half way, like a failing dump */
  failNextDump = false;
  /** Test hook: settings the simulated controller refuses (like FluidNC rejecting a value) */
  refuse = new Set<string>();

  constructor(readonly firmware: SimFirmware) {}

  /** A restart loads the saved config file again, forgetting runtime changes */
  reload() { this.cfg = YAML.parse(this.files.get('/config.yaml') ?? SIM_CONFIG_YAML); }

  /** The text of a file on the simulated controller (for tests) */
  file(path: string): string | undefined { return this.files.get(path); }
  setFile(path: string, text: string) { this.files.set(path, text); }

  /** Lines to send back, ending with ok or error:N; undefined when this is not a settings command. */
  handle(raw: string): string[] | undefined {
    const line = raw.trim();
    if (!line.startsWith('$')) return undefined;
    if (/^\$I$/i.test(line)) {
      return this.firmware === 'fluidnc' ? ['[VER:3.7.13 FluidNC v3.7.13:]', '[MSG:Machine: DemonX]', 'ok'] : ['[VER:1.1h.20190825:]', '[OPT:V,15,128]', 'ok'];
    }
    return this.firmware === 'fluidnc' ? this.fluidnc(line) : this.grblSettings(line);
  }

  // ---------- GRBL ----------
  private grblSettings(line: string): string[] | undefined {
    if (line === '$$') return [...Object.entries(this.grbl).map(([k, v]) => `$${k}=${v}`), 'ok'];
    const m = /^\$(\d+)=(.*)$/.exec(line);
    if (!m) return undefined;
    const n = Number(m[1]), v = Number(m[2]);
    if (!(n in this.grbl)) return ['error:3'];
    if (!Number.isFinite(v) || m[2].trim() === '') return ['error:3'];
    if (v < 0) return ['error:4'];
    this.grbl[n] = v;
    return ['ok'];
  }

  // ---------- FluidNC ----------
  private fluidnc(line: string): string[] | undefined {
    let m: RegExpExecArray | null;
    if (/^\$CD$/i.test(line)) return [...YAML.stringify(this.cfg).trimEnd().split('\n'), 'ok'];
    if ((m = /^\$CD=(.+)$/i.exec(line))) {
      if (this.failNextDump) { this.failNextDump = false; this.files.set(path(m[1]), 'board: Dobermann S3\nname: Dem'); return ['error:60']; }
      this.files.set(path(m[1]), YAML.stringify(this.cfg));
      return ['ok'];
    }
    if ((m = /^\$\/(.+?)=(.*)$/.exec(line))) return this.set(m[1], m[2]);
    if (/^\$Config\/Filename$/i.test(line)) return ['$Config/Filename=config.yaml', 'ok'];
    if ((m = /^\$LocalFS\/Show=(.+)$/i.exec(line))) {
      const t = this.files.get(path(m[1]));
      return t === undefined ? ['[MSG:ERR: Cannot open file]', 'error:60'] : [...t.trimEnd().split('\n'), 'ok'];
    }
    if ((m = /^\$LocalFS\/Rename=(.+)>(.+)$/i.exec(line))) {
      const from = path(m[1]), to = path(m[2]), t = this.files.get(from);
      if (t === undefined) return ['error:60'];
      this.files.delete(from); this.files.set(to, t);
      return ['ok'];
    }
    if ((m = /^\$LocalFS\/Delete=(.+)$/i.exec(line))) {
      return this.files.delete(path(m[1])) ? ['ok'] : ['error:60'];
    }
    if (/^\$Bye$/i.test(line)) { setTimeout(() => this.onRestart?.(), 50); return ['ok']; }
    return undefined;
  }

  private set(key: string, value: string): string[] {
    if (this.refuse.has(key)) return ['error:3'];
    const parts = key.split('/');
    let node: any = this.cfg;
    for (const p of parts.slice(0, -1)) { node = node?.[p]; if (node === null || typeof node !== 'object') return ['error:3']; }
    const last = parts[parts.length - 1], cur = node[last];
    if (cur === undefined || (cur !== null && typeof cur === 'object')) return ['error:3'];
    if (typeof cur === 'number') {
      if (value.trim() === '' || !Number.isFinite(Number(value))) return ['error:3'];
      node[last] = Number(value);
    } else if (typeof cur === 'boolean') {
      if (!/^(true|false)$/i.test(value)) return ['error:3'];
      node[last] = /^true$/i.test(value);
    } else node[last] = value;
    return ['ok'];
  }
}

const path = (p: string) => (p.trim().startsWith('/') ? p.trim() : `/${p.trim()}`);
