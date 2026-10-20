// A UDP wrapper around the simulated controller, so a driver can talk to it the way it will talk to the real one.
// Listens on 127.0.0.1 only. The real controller listens on port 50200 and answers to the sender; this one takes any port.
import dgram from 'node:dgram';
import { RuidaMachine, type MachineOptions } from './machine.js';

export class RuidaSimServer {
  readonly machine: RuidaMachine;
  private socket = dgram.createSocket('udp4');
  private timer?: NodeJS.Timeout;
  private last = 0;
  /** how much faster than real time the simulated machine runs */
  constructor(private speed = 1, opts: MachineOptions = {}) { this.machine = new RuidaMachine(opts); }

  async listen(port = 50200, host = '127.0.0.1'): Promise<number> {
    this.socket.on('message', (msg, rinfo) => {
      for (const r of this.machine.handleDatagram(msg)) this.socket.send(r, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve, reject) => { this.socket.once('error', reject); this.socket.bind(port, host, () => resolve()); });
    this.last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      this.machine.advance(((now - this.last) / 1000) * this.speed);
      this.last = now;
    }, 20);
    return this.socket.address().port;
  }

  private closed = false;
  close(): Promise<void> {
    clearInterval(this.timer);
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }
}
