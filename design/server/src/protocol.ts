// Messages between the Design server (which owns the laser's connection) and the browser.
import type { ConnectionInfo, JobInfo, LogLine, MachineStatus, PortInfo } from '../../../shared/protocol.js';

export interface LaserInfo {
  /** Is the controller in laser mode ($32=1)? "unknown" when it could not be read (some firmware). */
  mode: 'on' | 'off' | 'unknown';
  /** $30, the value that means 100% power */
  sMax: number | null;
  checkedAt: number | null;
  note?: string;
}

export interface LoadedJob {
  name: string;
  /** Fingerprint of the G-code, so the browser can tell whether the machine has the job that is on screen */
  hash: string;
  lines: number;
  maxS: number;
}

export interface LaserState {
  /** Which kind of controller is connected (GRBL when omitted) */
  kind?: 'grbl' | 'ruida';
  capabilities?: import('./laserBackend.js').LaserCapabilities;
  /** The machine's work area in mm, when the controller knows it (Ruida) */
  workArea?: { width: number; height: number };
  connection: ConnectionInfo;
  status: MachineStatus;
  job: JobInfo;
  laser: LaserInfo;
  loaded: LoadedJob | null;
}

export type ClientMessage =
  | { type: 'listPorts' }
  | { type: 'connect'; target: string }
  | { type: 'disconnect' }
  | { type: 'checkLaser' }
  | { type: 'enableLaserMode' }
  | { type: 'jog'; dx: number; dy: number; feed: number }
  /** Absolute move, laser off: x, y in the controller's own coordinates (mm), feed in mm/min */
  | { type: 'moveTo'; x: number; y: number; feed: number }
  /** Move Z (height) by dz mm, laser off, at feed mm/min (Ruida only, when switched on) */
  | { type: 'jogZ'; dz: number; feed: number }
  /** Ruida: the controller's own auto focus (the same command as LightBurn's button), when Z moves are switched on */
  | { type: 'autoFocus' }
  | { type: 'setOrigin' }
  | { type: 'goOrigin'; feed: number }
  | { type: 'home' }
  | { type: 'unlock' }
  | { type: 'reset' }
  | { type: 'loadJob'; name: string; content: string }
  /** `content` (Ruida): the job is checked and held first, so Frame needs no separate Send */
  | { type: 'frame'; feed: number; name?: string; content?: string; /** 'circle' (Ruida): trace a circle round the job, through its corners */ shape?: 'box' | 'circle';
      /** Ruida: where the job's start point is on the machine, mm from the rear-left corner (Absolute coordinates, User origin). Without it the frame is traced from where the head is. */
      origin?: { x: number; y: number } }
  | { type: 'start'; hash: string; acknowledgeUnverified?: boolean; name?: string; content?: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'ruidaAdd'; name: string; host: string }
  | { type: 'ruidaRemove'; name: string };

export type ServerMessage =
  | { type: 'state'; data: LaserState }
  | { type: 'ports'; data: PortInfo[] }
  | { type: 'log'; data: LogLine }
  | { type: 'logs'; data: LogLine[] }
  | { type: 'notice'; data: { ok: boolean; message: string; code?: string } }
  /** Who this browser is to the server: the PIN state, whether it may control, and where it connects from */
  | { type: 'role'; data: { mode: 'pin' | 'open' | 'setup'; operator: boolean; peer: 'local' | 'lan' | 'outside' } }
  | { type: 'denied'; data: { message: string } };

export const SIMULATOR = 'simulator';
