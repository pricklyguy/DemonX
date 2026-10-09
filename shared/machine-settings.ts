// Controller settings: what the Settings > Controller page shows and what the server will accept.
// Pure data and functions (no I/O), used by both sides.

export type SettingValue = string | number | boolean;

/**
 * What the controller says its settings are.
 * FluidNC: `values` is the running configuration (flattened YAML, keys like `axes/x/acceleration_mm_per_sec2`),
 *   `saved` is the config file on the controller. They differ after a change that was applied but not saved.
 * GRBL: `values` are the `$N` settings (keys like `$120`); the controller keeps them itself, so there is no `saved`.
 */
export interface MachineSettings {
  kind: 'fluidnc' | 'grbl';
  values: Record<string, SettingValue>;
  saved?: Record<string, SettingValue>;
  /** FluidNC: the config file this came from */
  file?: string;
  /** FluidNC: settings whose running value is not what the saved file says (changed here since the last save or restart) */
  unsaved?: string[];
  readAt: number;
  /** FluidNC: config files DemonX has kept (downloadable), newest first */
  backups?: string[];
}

export interface SettingChange { key: string; value: SettingValue }

/** Numbers that differ only by how they were printed (800 and 800.000) are the same */
export function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const na = Number(a), nb = Number(b);
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return Math.abs(na - nb) <= 1e-6 * Math.max(1, Math.abs(na), Math.abs(nb));
  }
  // text: a config file and the controller's own dump can differ in case and spacing (I2SO.3 / i2so.3, Z / z)
  // and numbers inside text can be printed to different precision (speed_map: 0.00% / 0.000%)
  const norm = (v: SettingValue) => String(v).trim().toLowerCase().replace(/\s+/g, ' ').replace(/-?\d+(\.\d+)?/g, (n) => String(Number(n)));
  return norm(a) === norm(b);
}

// ---------------- FluidNC ----------------

export interface FieldSpec {
  label: string;
  unit?: string;
  kind: 'number' | 'int' | 'bool';
  min?: number;
  max?: number;
  hint?: string;
}

/** The settings you adjust per axis, shown as a table with one column per axis. Keys are relative to axes/<letter>/. */
export const AXIS_FIELDS: Record<string, FieldSpec> = {
  steps_per_mm: { label: 'Steps per mm', kind: 'number', min: 0.001, max: 100_000, hint: 'Wrong values make every move the wrong length. Measure after changing.' },
  max_rate_mm_per_min: { label: 'Max speed', unit: 'mm/min', kind: 'number', min: 1, max: 200_000, hint: 'The fastest this axis may ever move' },
  acceleration_mm_per_sec2: { label: 'Acceleration', unit: 'mm/s²', kind: 'number', min: 1, max: 100_000, hint: 'Lower it when the leadscrew (not the motor) is what limits the axis: too high loses steps or shakes the machine' },
  max_travel_mm: { label: 'Travel', unit: 'mm', kind: 'number', min: 1, max: 100_000, hint: 'The length of the axis. Soft limits stop at this distance from home.' },
  soft_limits: { label: 'Soft limits', kind: 'bool', hint: 'Refuse moves beyond the travel (needs the machine to be homed)' },
  'homing/cycle': { label: 'Homing order', kind: 'int', min: 0, max: 6, hint: '0 = not homed, then 1, 2, 3…: the order axes home in' },
  'homing/positive_direction': { label: 'Homes toward +', kind: 'bool' },
  'homing/mpos_mm': { label: 'Home position', unit: 'mm', kind: 'number', min: -100_000, max: 100_000, hint: 'The machine position shown once homing is done, wherever the axis stops. It does not change with the pull-off distance (the back-off from the switch, under All other settings: axes, motor0, pulloff_mm).' },
  'homing/seek_mm_per_min': { label: 'Homing seek speed', unit: 'mm/min', kind: 'number', min: 1, max: 200_000 },
  'homing/feed_mm_per_min': { label: 'Homing slow speed', unit: 'mm/min', kind: 'number', min: 1, max: 200_000 },
  'homing/settle_ms': { label: 'Homing settle', unit: 'ms', kind: 'int', min: 0, max: 60_000 },
};

/** Anything wired to the hardware: shown, but changed only in the config file itself */
export function isReadOnlyKey(key: string): boolean {
  const parts = key.split('/');
  const last = parts[parts.length - 1];
  if (/pin$/i.test(last) || /_pins?$/i.test(last)) return true;
  if (['board', 'i2so', 'i2c', 'spi', 'sdcard'].includes(parts[0]) || /^uart/i.test(parts[0])) return true;
  if (parts[0] === 'stepping' && last === 'engine') return true;
  if (parts[0] === 'axes' && parts.some((p) => /^motor\d+$/.test(p)) && !['hard_limits', 'pulloff_mm'].includes(last)) return true;
  return false;
}

/** Why a value cannot be sent, or undefined when it is fine. `current` is the value now (its type tells what is expected). */
export function checkFluidNcChange(key: string, value: SettingValue, current: SettingValue | undefined): string | undefined {
  if (!/^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/.test(key)) return `"${key}" is not a setting name`;
  if (isReadOnlyKey(key)) return `${key} is wired to the hardware: change it in the config file`;
  if (current === undefined) return `${key} is not a setting of this machine`;
  const m = /^axes\/[^/]+\/(.+)$/.exec(key);
  const spec = m ? AXIS_FIELDS[m[1]] : undefined;
  const kind = spec?.kind ?? (typeof current === 'boolean' ? 'bool' : typeof current === 'number' ? 'number' : 'text');
  if (kind === 'bool') return typeof value === 'boolean' ? undefined : `${key} is on or off`;
  if (kind === 'text') {
    if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 200) return `${key} must be one line of text`;
    return undefined;
  }
  if (typeof value === 'boolean' || String(value).trim() === '' || !Number.isFinite(Number(value))) return `${key} must be a number`;
  const n = Number(value);
  if (kind === 'int' && !Number.isInteger(n)) return `${key} must be a whole number`;
  if (spec?.min !== undefined && n < spec.min) return `${spec.label} must be at least ${spec.min}`;
  if (spec?.max !== undefined && n > spec.max) return `${spec.label} can be at most ${spec.max}`;
  return undefined;
}

// ---------------- GRBL $N settings ----------------

export interface GrblSetting { label: string; unit?: string; kind: 'number' | 'int' | 'bool' | 'mask'; hint?: string }

export const GRBL_SETTINGS: Record<number, GrblSetting> = {
  0: { label: 'Step pulse time', unit: 'µs', kind: 'int' },
  1: { label: 'Step idle delay', unit: 'ms', kind: 'int', hint: '255 keeps the motors powered' },
  2: { label: 'Step pulse invert', kind: 'mask' },
  3: { label: 'Direction invert', kind: 'mask', hint: 'Bit 0 = X, 1 = Y, 2 = Z: flips an axis that moves the wrong way' },
  4: { label: 'Invert step enable pin', kind: 'bool' },
  5: { label: 'Invert limit pins', kind: 'bool' },
  6: { label: 'Invert probe pin', kind: 'bool' },
  10: { label: 'Status report options', kind: 'mask' },
  11: { label: 'Junction deviation', unit: 'mm', kind: 'number' },
  12: { label: 'Arc tolerance', unit: 'mm', kind: 'number' },
  13: { label: 'Report in inches', kind: 'bool' },
  20: { label: 'Soft limits', kind: 'bool' },
  21: { label: 'Hard limits', kind: 'bool' },
  22: { label: 'Homing cycle', kind: 'bool' },
  23: { label: 'Homing direction invert', kind: 'mask' },
  24: { label: 'Homing slow speed', unit: 'mm/min', kind: 'number' },
  25: { label: 'Homing seek speed', unit: 'mm/min', kind: 'number' },
  26: { label: 'Homing debounce', unit: 'ms', kind: 'int' },
  27: { label: 'Homing pull-off', unit: 'mm', kind: 'number' },
  30: { label: 'Max spindle speed', unit: 'RPM', kind: 'number' },
  31: { label: 'Min spindle speed', unit: 'RPM', kind: 'number' },
  32: { label: 'Laser mode', kind: 'bool' },
  100: { label: 'X steps per mm', kind: 'number' }, 101: { label: 'Y steps per mm', kind: 'number' }, 102: { label: 'Z steps per mm', kind: 'number' },
  110: { label: 'X max speed', unit: 'mm/min', kind: 'number' }, 111: { label: 'Y max speed', unit: 'mm/min', kind: 'number' }, 112: { label: 'Z max speed', unit: 'mm/min', kind: 'number' },
  120: { label: 'X acceleration', unit: 'mm/s²', kind: 'number' }, 121: { label: 'Y acceleration', unit: 'mm/s²', kind: 'number' }, 122: { label: 'Z acceleration', unit: 'mm/s²', kind: 'number' },
  130: { label: 'X travel', unit: 'mm', kind: 'number' }, 131: { label: 'Y travel', unit: 'mm', kind: 'number' }, 132: { label: 'Z travel', unit: 'mm', kind: 'number' },
};

export function checkGrblChange(key: string, value: SettingValue, current: SettingValue | undefined): string | undefined {
  const m = /^\$(\d{1,3})$/.exec(key);
  if (!m) return `"${key}" is not a $ setting`;
  if (current === undefined) return `${key} is not a setting of this machine`;
  if (typeof value === 'boolean' || String(value).trim() === '' || !Number.isFinite(Number(value))) return `${key} must be a number`;
  const n = Number(value), spec = GRBL_SETTINGS[Number(m[1])];
  if (n < 0 || n > 1e7) return `${key} is out of range`;
  if (spec && (spec.kind === 'int' || spec.kind === 'mask' || spec.kind === 'bool') && !Number.isInteger(n)) return `${spec.label} must be a whole number`;
  if (spec?.kind === 'bool' && n !== 0 && n !== 1) return `${spec.label} is 0 (off) or 1 (on)`;
  return undefined;
}
