import type { ProbeKind, ProbeSettings } from '../../shared/protocol';

// The probe and autolevel settings as the person last entered them (kept in this browser), shared by the Probe,
// Autolevel and PCB panels so they all start a cycle with the same values. Everything here is in millimetres.

export const PROBE_DEFAULTS = {
  plateZ_z: 25.05, plateZ_xyz: 22, plateX: 7, plateY: 7, endmill: 6.35,
  feedFast: 75, feedFine: 45, maxZ: 25, maxXY: 25, retract: 2, clearance_z: 10, clearance_pcb: 5, clearance_xyz: 10,
};
export type ProbeForm = typeof PROBE_DEFAULTS;

export function loadProbeForm(): ProbeForm {
  try { return { ...PROBE_DEFAULTS, ...JSON.parse(localStorage.getItem('probeForm') ?? '{}') }; } catch { return PROBE_DEFAULTS; }
}

export function toSettings(f: ProbeForm, kind: ProbeKind): ProbeSettings {
  return {
    plateZ: kind === 'xyz' ? f.plateZ_xyz : kind === 'z' ? f.plateZ_z : 0,
    plateX: f.plateX, plateY: f.plateY, endmill: f.endmill,
    feedFast: f.feedFast, feedFine: f.feedFine, maxZ: f.maxZ, maxXY: f.maxXY, retract: f.retract,
    clearance: kind === 'xyz' ? f.clearance_xyz : kind === 'z' ? f.clearance_z : f.clearance_pcb,
  };
}

export const AL_DEFAULTS = { minX: 0, maxX: 50, minY: 0, maxY: 50, cols: 5, rows: 5, safeZ: 2, depth: 2, endZ: 10 };
export type AlForm = typeof AL_DEFAULTS;
export function loadAlForm(): AlForm {
  try { return { ...AL_DEFAULTS, ...JSON.parse(localStorage.getItem('alForm') ?? '{}') }; } catch { return AL_DEFAULTS; }
}
