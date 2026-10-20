// One connection at a time, but of either kind: GRBL (serial, or its simulator) or Ruida (UDP). The browser asks for a
// target by name; the hub passes everything to the backend that owns it. Ruida targets only exist when DESIGN_RUIDA=1.
import { EventEmitter } from 'node:events';
import type { LogLine, PortInfo } from '../../../shared/protocol.js';
import type { LaserBackend, LaserCapabilities, LaserKind, Result } from './laserBackend.js';
import type { LaserInfo, LaserState } from './protocol.js';
import type { LaserSession } from './laserSession.js';
import type { RuidaSession } from './ruida/session.js';

export class LaserHub extends EventEmitter implements LaserBackend {
  private active: LaserBackend;

  constructor(readonly grbl: LaserSession, readonly ruida: RuidaSession) {
    super();
    this.active = grbl;
    for (const b of [grbl, ruida] as LaserBackend[]) {
      b.on('state', (s: LaserState) => { if (b === this.active) this.emit('state', s); });
      b.on('log', (l: LogLine) => { if (b === this.active) this.emit('log', l); });
    }
  }

  get kind(): LaserKind { return this.active.kind; }
  get capabilities(): LaserCapabilities { return this.active.capabilities; }
  state(): LaserState { return this.active.state(); }
  recentLog(n: number): LogLine[] { return this.active.recentLog(n); }

  async ports(): Promise<PortInfo[]> {
    return [...(await this.grbl.ports()), ...(await this.ruida.ports())];
  }

  async connect(target: string): Promise<Result> {
    if (this.grbl.state().connection.connected || this.ruida.state().connection.connected) return { ok: false, message: 'Already connected. Disconnect first.' };
    const b: LaserBackend = target.startsWith('ruida') ? this.ruida : this.grbl;
    const r = await b.connect(target);
    if (r.ok) { this.active = b; this.emit('state', b.state()); }
    return r;
  }

  async disconnect(): Promise<Result> {
    const r = await this.active.disconnect();
    if (r.ok) { this.active = this.grbl; this.emit('state', this.grbl.state()); }
    return r;
  }

  checkLaser(): Promise<LaserInfo> { return this.active.checkLaser(); }
  enableLaserMode(): Promise<Result> { return this.active.enableLaserMode(); }
  jog(dx: number, dy: number, feed: number) { return this.active.jog(dx, dy, feed); }
  moveTo(x: number, y: number, feed: number) { return this.active.moveTo(x, y, feed); }
  jogZ(dz: number, feed: number) { return this.active.jogZ(dz, feed); }
  setOrigin() { return this.active.setOrigin(); }
  goOrigin(feed: number) { return this.active.goOrigin(feed); }
  home() { return this.active.home(); }
  unlock() { return this.active.unlock(); }
  reset() { return this.active.reset(); }
  loadJob(name: string, content: string) { return this.active.loadJob(name, content); }
  frame(feed: number, shape?: 'box' | 'circle', origin?: { x: number; y: number }) { return this.active.frame(feed, shape, origin); }
  autoFocus() { return this.active.autoFocus(); }
  start(hash: string, acknowledgeUnverified?: boolean) { return this.active.start(hash, acknowledgeUnverified); }
  pause() { return this.active.pause(); }
  resume() { return this.active.resume(); }
  stop() { return this.active.stop(); }

  addController(name: string, host: string): Result { return this.ruida.addController(name, host); }
  removeController(name: string): Result { return this.ruida.removeController(name); }

  async close() { await this.grbl.close(); await this.ruida.close(); }
}
