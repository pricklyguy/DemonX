import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { GrblController } from './controller.js';
import type { MachineSettingsService } from './machinesettings.js';
import { bedFromFluidNc, bedFromGrbl, bedFromManual, type MachineBed, type ManualBed } from '../../shared/bed.js';

// The size of the machine, for the 3D view. It comes from the controller's own settings, read once a few seconds after connecting
// (the same read the Controller settings page does, so nothing is changed), and is kept in the data folder so it is known before the
// next connection. Numbers typed in Settings, Machine size, win over what the controller says. Failing to read it is not an error:
// the view just does not show the machine's size.

const FIRST_READ_MS = 3000, RETRY_MS = 5000, MAX_TRIES = 6;

export class BedService extends EventEmitter {
  private auto: MachineBed | null = null;
  private file?: string;
  private timer?: NodeJS.Timeout;
  private tries = 0;

  constructor(
    private ctl: GrblController,
    private settings: MachineSettingsService,
    private manual: () => ManualBed,
    /** Something else is using the controller (a probe or scan): not now */
    private busy: () => boolean,
    dataDir?: string,
    private firstReadMs = FIRST_READ_MS,
    /** Messages for the console, so a machine size that does not appear can be explained */
    private log: (kind: 'sys' | 'err', text: string) => void = () => {},
  ) {
    super();
    if (dataDir) {
      this.file = path.join(dataDir, 'machine-bed.json');
      try {
        const b = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (b && ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'].every((k) => Number.isFinite(b[k]))) this.auto = { ...b, source: b.source === 'fluidnc' ? 'fluidnc' : 'grbl' };
      } catch { /* none saved yet */ }
    }
    ctl.on('connection', (c: { connected: boolean }) => {
      clearTimeout(this.timer);
      if (c.connected) { this.tries = 0; this.later(this.firstReadMs); }
    });
  }

  /** What the view should use: the typed-in size if switched on, else what the controller said last */
  get current(): MachineBed | null { return bedFromManual(this.manual()) ?? this.auto; }

  /** The manual setting changed */
  changed() { this.emit('bed', this.current); }

  /** Read the controller again (after its settings were changed here) */
  refresh() { clearTimeout(this.timer); this.tries = 0; this.later(500); }

  private later(ms: number) { this.timer = setTimeout(() => void this.read(), ms); }

  private async read() {
    if (!this.ctl.connection.connected) return;
    let why = '';
    const retry = () => {
      if (++this.tries < MAX_TRIES) this.later(RETRY_MS);
      else this.log('err', `Machine size: could not read it from the controller (${why}). Settings, Machine size has a Read again button, and the size can be typed in.`);
    };
    if (this.busy() || this.ctl.job.state === 'running' || this.ctl.job.state === 'paused') { why = 'the machine was busy'; return retry(); }
    try {
      const s = await this.settings.read();
      const bed = s.kind === 'fluidnc' ? bedFromFluidNc(s.values) : bedFromGrbl(s.values);
      if (!bed) {                                                          // the controller does not say: nothing to show
        this.log('err', `Machine size: the controller's settings do not give the X and Y travel (${s.kind === 'fluidnc' ? 'axes/x/max_travel_mm and axes/y/max_travel_mm' : '$130 and $131'}), so it is not shown. It can be typed in at Settings, Machine size.`);
        return;
      }
      this.auto = bed;
      if (this.file) { try { fs.writeFileSync(this.file, JSON.stringify(bed)); } catch { /* the view still works */ } }
      this.log('sys', `Machine size: X ${Math.round(bed.maxX - bed.minX)} by Y ${Math.round(bed.maxY - bed.minY)} mm, from the ${s.kind === 'fluidnc' ? 'FluidNC' : 'GRBL'} settings`);
      this.emit('bed', this.current);
    } catch (e) { why = (e as Error).message || 'unknown error'; retry(); }
  }
}
