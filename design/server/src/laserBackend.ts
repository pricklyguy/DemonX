// What a laser connection must offer so the Design Laser panel can drive it, whatever the controller speaks.
// `LaserSession` (GRBL) is the first implementation; a Ruida backend is the second.
//
// The rules every backend must keep, because the browser is never trusted for safety:
//   - Only a target the computer itself reports (or the simulator) may be opened; the browser does not name addresses or paths freely.
//   - The job is checked on the server before it is accepted: only the commands that backend understands, power within the
//     controller's range, every point inside the machine's work area, and the laser off at the end.
//   - `start` refuses unless the job on the machine is exactly the one on screen (`hash`), the machine is idle, and any
//     controller-specific precondition holds (GRBL: laser mode on).
//   - While a job runs, jogging, homing, loading and disconnecting are refused.
//   - `stop` always works and leaves the laser off. Losing the connection or an error must also leave it off or stop the job.
import type { EventEmitter } from 'node:events';
import type { LogLine, PortInfo } from '../../../shared/protocol.js';
import type { LaserInfo, LaserState } from './protocol.js';

export interface Result { ok: boolean; message: string; code?: string }

/** Which controller family a backend talks to. */
export type LaserKind = 'grbl' | 'ruida';

/** What the job text passed to `loadJob` is made of. GRBL takes laser G-code; Ruida will take a JSON plan. */
export type JobFormat = 'gcode' | 'ruida-plan';

export interface LaserCapabilities {
  jobFormat: JobFormat;
  /** Can the machine be homed from here? */
  home: boolean;
  /** Can the head be moved up and down (Z) from here? */
  z?: boolean;
  /** Can the work zero be set to the head's current position? */
  setOrigin: boolean;
  /** Does a pause keep the laser off and allow resuming? Must be proven on the machine before this is true for Ruida. */
  pause: boolean;
  /** Settings the user has to confirm themselves because the controller cannot report them (GRBL laser mode on FluidNC). */
  needsLaserModeCheck: boolean;
}

/**
 * Events: 'state' (LaserState), 'log' (LogLine).
 * Methods may answer at once or after talking to the machine, so they return a Result or a promise of one.
 */
export interface LaserBackend extends EventEmitter {
  readonly kind: LaserKind;
  readonly capabilities: LaserCapabilities;

  state(): LaserState;
  /** Recent log lines for a client that has just connected. */
  recentLog(n: number): LogLine[];

  /** Targets that may be passed to `connect` (always includes the simulator). */
  ports(): Promise<PortInfo[]>;
  connect(target: string): Promise<Result>;
  disconnect(): Promise<Result>;

  /** Read the controller-specific precondition for firing (GRBL: laser mode and S max) and publish it in the state. */
  checkLaser(): Promise<LaserInfo>;
  /** Switch that precondition on, when the controller allows it. */
  enableLaserMode(): Promise<Result>;

  /** Relative move with the laser off. dx, dy in mm, feed in mm/min. */
  jog(dx: number, dy: number, feed: number): Result | Promise<Result>;
  /** Absolute move with the laser off, to x, y in the controller's own coordinates (mm), feed in mm/min. */
  moveTo(x: number, y: number, feed: number): Result | Promise<Result>;
  /** Move Z by dz mm (laser off), at feed mm/min. */
  jogZ(dz: number, feed: number): Result | Promise<Result>;
  /** Make the head's current position the job's zero. */
  setOrigin(): Result | Promise<Result>;
  goOrigin(feed: number): Result | Promise<Result>;
  home(): Result | Promise<Result>;
  unlock(): Result | Promise<Result>;
  /** Stop motion and switch the laser off, at once. Always allowed. */
  reset(): Result | Promise<Result>;

  /** `content` is in the backend's `capabilities.jobFormat`. Validated here, not in the browser. */
  loadJob(name: string, content: string): Result | Promise<Result>;
  /** Trace the loaded job's outline with the laser off. */
  frame(feed: number, shape?: 'box' | 'circle', origin?: { x: number; y: number }): Result | Promise<Result>;
  /** Run the controller's auto focus (Ruida, when Z moves are switched on). */
  autoFocus(): Result | Promise<Result>;
  start(hash: string, acknowledgeUnverified?: boolean): Promise<Result>;
  pause(): Result | Promise<Result>;
  resume(): Result | Promise<Result>;
  stop(): Promise<Result>;

  close(): Promise<void>;

  /** Controllers that are reached over the network are added by name and address in the panel; serial ports need none. */
  addController?(name: string, host: string): Result;
  removeController?(name: string): Result;
}
