// Messages exchanged between the DemonX server and browser clients over WebSocket.
// Shared by server/ and web/ so both sides stay in sync.

import type { MachineSettings, SettingChange } from './machine-settings';

export type MachineState =
  | 'Disconnected'
  | 'Idle'
  | 'Run'
  | 'Hold'
  | 'Jog'
  | 'Alarm'
  | 'Door'
  | 'Check'
  | 'Home'
  | 'Sleep';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MachineStatus {
  state: MachineState;
  /** GRBL sub-state, e.g. Hold:0 / Hold:1 */
  substate?: number;
  mpos: Vec3;
  wpos: Vec3;
  wco: Vec3;
  feed: number;
  spindle: number;
  /** Overrides in percent: feed, rapid, spindle */
  ov: { feed: number; rapid: number; spindle: number };
  /** Pin state letters from GRBL "Pn:" e.g. "XYZP" */
  pins: string;
  /** What is switched on, from GRBL "A:": S spindle clockwise, C counter-clockwise, F flood, M mist. Empty when all are off. */
  accessories: string;
  /** Planner blocks / RX bytes available, from "Bf:" */
  buffer?: { planner: number; rx: number };
}

export type JobState = 'none' | 'loaded' | 'running' | 'paused' | 'done' | 'error';

export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
export type { Box3, Extents } from './toolpath.js';
import type { Extents } from './toolpath.js';

/** Result of applying a height map to a program */
export interface LevelSummary {
  cols: number;
  rows: number;
  linesBefore: number;
  linesAfter: number;
  /** Smallest and largest Z correction added to the program, mm */
  minDelta: number;
  maxDelta: number;
  /** Cutting/rapid endpoints outside the scanned area (clamped to its edge) */
  outside: number;
  /** Work zero moved since the scan: heights may no longer match the surface */
  zeroChanged: boolean;
  scannedAt: number;
  /** Things worth a look, e.g. Z moves that could not be corrected */
  warnings: string[];
}

export interface JobInfo {
  state: JobState;
  name: string;
  totalLines: number;
  /** Lines sent to the controller */
  sentLines: number;
  /** Lines the controller has acknowledged (ok/error) */
  doneLines: number;
  startedAt?: number;
  elapsedMs: number;
  error?: string;
  /** XY extent of the cutting moves (work coordinates), used to size an autolevel scan */
  bounds?: Bounds;
  /** Min/max of each axis for the program that will run (after autolevel, if applied) */
  extents?: Extents;
  /** Set when the running program is an autolevelled version of the loaded file */
  leveled?: LevelSummary;
  /** Why the last attempt to apply autolevel was refused (the loaded program is unchanged) */
  levelError?: string;
  /**
   * The loaded file was already levelled before it was loaded (found from the header comment
   * DemonX writes, or a ".leveled." file name). Levelling it again would correct the Z twice.
   */
  alreadyLeveled?: { source: 'header' | 'filename'; info?: string };
}

export interface ConnectionInfo {
  connected: boolean;
  /** e.g. "/dev/ttyUSB0", "COM3", "ws://192.168.1.50:81", "simulator" */
  target: string;
  firmware?: string;
  /**
   * A gentle nudge to home (or unlock, if you mean not to): set on connect, cleared when
   * Home or Unlock is sent from anywhere, so every browser agrees and the Home button
   * stops pulsing on all of them.
   */
  homeReminder?: boolean;
  /** PCB Home has been done since PCB mode was switched on (work X0 Y0 is at the fixture) */
  pcbHomed?: boolean;
  /** Z0 was set on the board by the PCB Z probe since PCB mode was switched on */
  pcbZSet?: boolean;
}

export interface PortInfo {
  path: string;
  manufacturer?: string;
  description?: string;
}

export type LogKind = 'tx' | 'rx' | 'sys' | 'err';

export interface LogLine {
  t: number;
  kind: LogKind;
  text: string;
}

export type ProbeKind = 'z' | 'xyz' | 'pcb' | 'autolevel';
/**
 * idle -> confirmConnect (user must confirm the probe is connected)
 *      -> running (server drives the probe cycle)
 *      -> confirmRemove (user must confirm the probe/clip is removed)
 *      -> idle
 */
export type ProbePhase = 'idle' | 'confirmConnect' | 'running' | 'confirmRemove';

export interface ProbeSettings {
  /** Height of the touch plate/block: work Z is set to this at contact (0 for PCB) */
  plateZ: number;
  /** XYZ block wall thickness on X and Y */
  plateX: number;
  plateY: number;
  /** Endmill diameter (XYZ probe only) */
  endmill: number;
  feedFast: number;
  feedFine: number;
  maxZ: number;
  maxXY: number;
  /** Retract between the fast and fine pass */
  retract: number;
  /** Final Z retract after probing */
  clearance: number;
}

/**
 * Surface heights measured by an autolevel scan, in work coordinates.
 * z[row][col] is the surface height relative to work Z0; row 0 is minY.
 */
export interface HeightMap {
  cols: number;
  rows: number;
  minX: number; maxX: number; minY: number; maxY: number;
  z: number[][];
  scannedAt: number;
  /** Work coordinate offset when scanned, to detect a moved zero later */
  wco?: Vec3;
}

/** What a saved height map on disk looks like, without loading it */
export interface HeightMapSummary { cols: number; rows: number; scannedAt: number }

export interface AutolevelParams extends Bounds {
  cols: number;
  rows: number;
  /** Height above Z0 the tool travels at between points */
  safeZ: number;
  /** How far below Z0 a probe may travel before the scan fails */
  depth: number;
  /** Height above Z0 to raise to after the final point, so the clip can be removed safely */
  endZ: number;
}

export interface ProbeInfo {
  /** Increments per probe run; confirmations must quote it so stale clicks are ignored */
  id: number;
  phase: ProbePhase;
  kind?: ProbeKind;
  title?: string;
  checklist?: string[];
  /** Current step while running */
  step?: string;
  /** Autolevel scan progress */
  progress?: { current: number; total: number };
  /** Machine-position contact points recorded so far */
  result?: Partial<Vec3>;
  success?: boolean;
  error?: string;
}

/**
 * PCB mode: the machine is set up for circuit boards on a fixture bolted to the wasteboard. The fixture position is in
 * MACHINE coordinates (they never change once the machine is homed), so a board can be put back in exactly the same place.
 * While the mode is on, normal homing is refused and a PCB Home button takes its place.
 */
export interface PcbConfig {
  enabled: boolean;
  /** The fixture position and the safe height were entered (by hand or captured) */
  configured: boolean;
  /** Fixture X and Y, machine coordinates, mm */
  x: number;
  y: number;
  /** Height the tool is raised to before moving across, machine coordinates, mm. Must clear the tallest clamp. */
  safeZ: number;
}
export const defaultPcb = (): PcbConfig => ({ enabled: false, configured: false, x: 0, y: 0, safeZ: 0 });

export const SPINDLE_COMMANDS = ['M3', 'M4', 'M5', 'M7', 'M8', 'M9'] as const;
export type SpindleCommand = (typeof SPINDLE_COMMANDS)[number];
/** What the Spindle panel offers. Machine-wide: it describes the machine (a vacuum on M7), not a browser. */
export interface SpindleConfig {
  /** Which command buttons the panel shows (M5, spindle off, is always there) */
  commands: SpindleCommand[];
  /** The speeds in the RPM picker */
  speeds: number[];
  /** The highest RPM the panel will send */
  maxRpm: number;
}
export const defaultSpindle = (): SpindleConfig => ({ commands: ['M3', 'M5'], speeds: [1000, 5000, 10000, 18000, 24000], maxRpm: 24000 });

export const emptyPublicConfig = (): PublicConfig => ({
  homeAssistant: { url: '', hasToken: false, insecureTls: false, share: false },
  mqtt: { enabled: false, host: '', port: 1883, user: '', hasPassword: false, tls: false, name: 'DemonX' },
  spindle: defaultSpindle(),
  pcb: defaultPcb(),
  camera: {
    source: 'none', haEntity: '', url: '', host: '', channel: 1, scheme: 'https', mode: 'snapshot', quality: 'sub',
    user: '', hasPassword: false, fps: 5, insecureTls: true,
  },
});

export const emptyProbe = (): ProbeInfo => ({ id: 0, phase: 'idle' });

// ---- configuration and camera ----

export type CameraSource = 'none' | 'ha' | 'hastream' | 'reolink' | 'http' | 'rtsp' | 'direct';

/**
 * What a browser is told about the setup. It never contains a secret: whether a token or
 * password is saved is a flag, and URLs have their credentials removed.
 */
export interface PublicConfig {
  /** share: tell Home Assistant about job and machine events and keep DemonX sensors there */
  homeAssistant: { url: string; hasToken: boolean; insecureTls: boolean; share: boolean };
  /** The MQTT broker DemonX shares the machine through (discovered by Home Assistant) */
  mqtt: { enabled: boolean; host: string; port: number; user: string; hasPassword: boolean; tls: boolean; name: string };
  spindle: SpindleConfig;
  pcb: PcbConfig;
  camera: {
    source: CameraSource;
    /** Home Assistant camera entity, e.g. camera.workshop_cnc */
    haEntity: string;
    /** http / rtsp / direct URL, without credentials */
    url: string;
    /** Reolink camera or NVR */
    host: string;
    /** As numbered in the Reolink app, starting at 1 */
    channel: number;
    scheme: 'https' | 'http';
    mode: 'snapshot' | 'rtsp';
    quality: 'main' | 'sub';
    user: string;
    hasPassword: boolean;
    fps: number;
    /** Accept a self-signed certificate (Reolink NVRs and many cameras use one) */
    insecureTls: boolean;
  };
}

/** A change to the setup. Omitted fields keep their value; an empty secret clears it. */
export interface ConfigUpdate {
  homeAssistant?: { url?: string; token?: string; insecureTls?: boolean; share?: boolean };
  mqtt?: { enabled?: boolean; host?: string; port?: number; user?: string; password?: string; tls?: boolean; name?: string };
  spindle?: Partial<SpindleConfig>;
  /** (`configured` is worked out: it becomes true when a position or height is given) */
  pcb?: Partial<Omit<PcbConfig, 'configured'>>;
  camera?: Partial<Omit<PublicConfig['camera'], 'hasPassword'>> & { password?: string };
}

export interface CameraState {
  /** The server is pulling video from the camera right now (someone is watching) */
  running: boolean;
  viewers: number;
  fps: number;
  error?: string;
}

/** One finished (or stopped) run of a job, for the stats page */
export interface RunRecord {
  id: string;
  name: string;
  startedAt: number;
  /** Time actually running: pauses are not counted */
  runMs: number;
  result: 'done' | 'stopped' | 'error';
  lines: number;
}

/** A recurring maintenance task, due after so many hours of machine running time */
export interface MaintTask {
  id: string;
  name: string;
  everyHours: number;
  /** Running hours at the last service, and when that was (ms since 1970) */
  doneAtHours: number;
  doneAt?: number;
  /** Worked out by the server from the running time now */
  sinceHours: number;
  dueInHours: number;
  due: boolean;
}

/** Job statistics and maintenance, kept on the server (see server/src/stats.ts) */
export interface StatsInfo {
  totalHours: number;
  jobs: number;
  done: number;
  stopped: number;
  errors: number;
  /** Newest first */
  recent: RunRecord[];
  tasks: MaintTask[];
}

/** A saved macro: lines of G-code run with one tap (see server/src/macros.ts) */
export interface Macro { id: string; name: string; content: string }

export interface HaCamera { entity_id: string; name: string }

export interface Snapshot {
  connection: ConnectionInfo;
  status: MachineStatus;
  job: JobInfo;
  probe: ProbeInfo;
  heightmap: HeightMap | null;
  /** A map saved on the server but not loaded (loading is manual unless DEMONX_AUTOLOAD_MAP=1) */
  heightmapSaved: HeightMapSummary | null;
  config: PublicConfig;
  camera: CameraState;
  macros: Macro[];
  stats: StatsInfo;
  clients: number;
  log: LogLine[];
  /** mode: pin (a PIN is set), setup (no PIN yet, nobody but the DemonX computer may control), open (no PIN, chosen on purpose). peer: where this browser connects from. required: a PIN is set. operator: this browser may control the machine (always true while no PIN is set). local: it is on the DemonX computer itself, which never needs the PIN. */
  auth: { required: boolean; operator: boolean; local: boolean; mode: 'pin' | 'open' | 'setup'; peer: 'local' | 'lan' | 'outside' };
  /** Addresses other devices on the network can open DemonX at, best guess first (from this computer's network cards) */
  addresses: string[];
}

// ---- server -> client ----
export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'status'; data: MachineStatus }
  | { type: 'job'; data: JobInfo }
  | { type: 'probe'; data: ProbeInfo }
  | { type: 'heightmap'; data: HeightMap | null }
  | { type: 'heightmapSaved'; data: HeightMapSummary | null }
  | { type: 'config'; data: PublicConfig }
  | { type: 'macros'; data: Macro[] }
  | { type: 'stats'; data: StatsInfo }
  /** The answer to a stats or maintenance change, to the browser that sent it */
  | { type: 'statsResult'; data: { ok: boolean; message?: string } }
  /** The controller's settings, to the browser that asked */
  | { type: 'machineSettings'; data: MachineSettings }
  | { type: 'machineSettingsResult'; data: { ok: boolean; message: string } }
  /** The answer to a macroSave, to the browser that sent it */
  | { type: 'macroResult'; data: { ok: boolean; message?: string } }
  | { type: 'camera'; data: CameraState }
  | { type: 'haCameras'; data: { cameras: HaCamera[] } | { error: string } }
  | { type: 'cameraTest'; data: { ok: boolean; message: string; image?: string } }
  /** The answer to a configSet, to the browser that sent it */
  | { type: 'configResult'; data: { ok: boolean; message?: string } }
  | { type: 'haShareResult'; data: { ok: boolean; message: string } }
  | { type: 'mqttResult'; data: { ok: boolean; message: string } }
  | { type: 'connection'; data: ConnectionInfo }
  | { type: 'clients'; data: number }
  | { type: 'log'; data: LogLine }
  | { type: 'ports'; data: PortInfo[] }
  /** A request was refused because the browser has not signed in */
  | { type: 'denied'; data: { message: string } };

// ---- client -> server ----
export type JogAxis = 'X' | 'Y' | 'Z';

export type ClientMessage =
  | { type: 'listPorts' }
  | { type: 'macroSave'; macro: { id?: string; name: string; content: string } }
  | { type: 'macroDelete'; id: string }
  | { type: 'macroRun'; id: string }
  | { type: 'maintSave'; task: { id?: string; name: string; everyHours: number } }
  | { type: 'maintDelete'; id: string }
  /** A task was done: start counting its hours again from now */
  | { type: 'maintServiced'; id: string }
  /** Set the machine's total running hours (for a machine that has run before DemonX) */
  | { type: 'statsSetHours'; hours: number }
  | { type: 'settingsRead' }
  | { type: 'settingsApply'; changes: SettingChange[] }
  | { type: 'settingsSave' }
  | { type: 'controllerRestart' }
  | { type: 'connect'; target: string; baud?: number }
  | { type: 'disconnect' }
  | { type: 'send'; line: string }
  | { type: 'jog'; dx?: number; dy?: number; dz?: number; feed: number }
  | { type: 'jogCancel' }
  | { type: 'home' }
  | { type: 'unlock' }
  | { type: 'zero'; axes: JogAxis[] }
  /** Move to work Z0 or work X0 Y0 at the given feed (mm/min) */
  /** M3/M4 start (with the speed), M5 off, M7/M8/M9 coolant or vacuum. Only commands enabled in the spindle setup are accepted. */
  | { type: 'spindle'; command: SpindleCommand; rpm?: number }
  | { type: 'goto'; target: 'z0' | 'xy0'; feed: number }
  /** Trace the outline of the loaded G-code (all its moves) a little above the current height, then return to where it started */
  | { type: 'frame'; feed: number; zFeed: number }
  /** PCB mode: raise to the safe height (machine coordinates), move to the fixture, and set work X0 Y0 there */
  | { type: 'pcbHome' }
  | { type: 'reset' }
  | { type: 'hold' }
  | { type: 'resume' }
  | { type: 'override'; kind: 'feed' | 'rapid' | 'spindle'; action: 'reset' | 'plus10' | 'minus10' | 'plus1' | 'minus1' | 'half' | 'quarter' }
  | { type: 'jobLoad'; name: string; content: string }
  | { type: 'jobStart' }
  | { type: 'jobPause' }
  | { type: 'jobResume' }
  | { type: 'jobStop' }
  | { type: 'probeStart'; kind: ProbeKind; settings: ProbeSettings; autolevel?: AutolevelParams }
  | { type: 'heightmapLoad'; map: HeightMap }
  | { type: 'heightmapClear' }
  /** Load the map saved on the server by the last scan */
  | { type: 'heightmapRestore' }
  | { type: 'configSet'; update: ConfigUpdate }
  /** List Home Assistant cameras; optional unsaved connection details are tried first */
  /** Send a test event and the sensors to Home Assistant (needs sharing on or not: it always tries) */
  | { type: 'haShareTest' }
  /** Try the MQTT broker settings (optionally unsaved ones) */
  | { type: 'mqttTest'; mqtt?: NonNullable<ConfigUpdate['mqtt']> }
  | { type: 'haCameras'; homeAssistant?: NonNullable<ConfigUpdate['homeAssistant']> }
  /** Fetch one frame from the (optionally unsaved) camera setup and report what happened */
  | { type: 'cameraTest'; update?: ConfigUpdate }
  /** Rewrite the loaded program with the current height map applied */
  | { type: 'jobLevel' }
  /** Go back to the program as loaded from file */
  | { type: 'jobRevert' }
  | { type: 'probeConfirm'; id: number; phase: ProbePhase }
  | { type: 'probeCancel'; id: number };

export const emptyVec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export const emptyStatus = (): MachineStatus => ({
  state: 'Disconnected',
  mpos: emptyVec(),
  wpos: emptyVec(),
  wco: emptyVec(),
  feed: 0,
  spindle: 0,
  ov: { feed: 100, rapid: 100, spindle: 100 },
  pins: '',
  accessories: '',
});

export const emptyJob = (): JobInfo => ({
  state: 'none',
  name: '',
  totalLines: 0,
  sentLines: 0,
  doneLines: 0,
  elapsedMs: 0,
});

export const emptyStats = (): StatsInfo => ({ totalHours: 0, jobs: 0, done: 0, stopped: 0, errors: 0, recent: [], tasks: [] });
