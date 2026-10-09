import { describe, it, expect } from 'vitest';
import { parseStatus, cleanGcode } from '../src/parser.js';
import { GrblController } from '../src/controller.js';
import { SimulatorTransport } from '../src/simulator.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); }
}

describe('parser', () => {
  it('parses status with MPos and derives WPos from WCO', () => {
    const s = parseStatus('<Run|MPos:10.000,20.000,-1.000|FS:500,8000|WCO:5,5,0|Ov:90,100,100>')!;
    expect(s.state).toBe('Run');
    expect(s.wpos).toEqual({ x: 5, y: 15, z: -1 });
    expect(s.feed).toBe(500);
    expect(s.ov.feed).toBe(90);
  });
  it('carries WCO forward when omitted', () => {
    const a = parseStatus('<Idle|MPos:1,1,1|WCO:1,0,0>')!;
    const b = parseStatus('<Idle|MPos:3,1,1>', a)!;
    expect(b.wpos.x).toBe(2);
  });
  it('parses hold substate and rejects non-status', () => {
    expect(parseStatus('<Hold:0|MPos:0,0,0>')!.substate).toBe(0);
    expect(parseStatus('ok')).toBeNull();
  });
  it('cleans gcode', () => {
    expect(cleanGcode('g1 x1.0 (move) y2 ; hi')).toBe('G1X1.0Y2');
    expect(cleanGcode('; only comment')).toBe('');
  });
});

describe('firmware name', () => {
  it('is asked for with $I when no banner named it', async () => {
    const c = new GrblController();
    c.firmwareAskMs = 60_000;                       // not by the timer: this test asks itself
    await c.connect(new SimulatorTransport(50), 'simulator');
    await until(() => c.status.state === 'Idle' && !!c.connection.firmware);
    c.connection = { ...c.connection, firmware: undefined };   // as if the board never printed its banner
    await c.askFirmware();
    expect(c.connection.firmware).toBe('1.1h.20190825');
    await c.disconnect();
  }, 20000);
});

describe('controller + simulator', () => {
  async function setup(speed = 50) {
    const c = new GrblController();
    await c.connect(new SimulatorTransport(speed), 'simulator');
    await until(() => c.status.state === 'Idle' && !!c.connection.firmware);
    return c;
  }

  it('streams a job larger than the RX buffer and completes', async () => {
    const c = await setup();
    const lines = ['G21', 'G90', 'G0 X0 Y0', ...Array.from({ length: 200 }, (_, i) => `G1 X${i % 20} Y${(i * 3) % 20} F1000`)];
    c.loadJob('test.nc', lines.join('\n'));
    c.startJob();
    await until(() => c.job.state === 'done', 20000);
    expect(c.job.doneLines).toBe(203);
    await c.disconnect();
  }, 30000);

  it('jogs and zeroes', async () => {
    const c = await setup();
    c.handle({ type: 'jog', dx: 10, feed: 6000 });
    await until(() => c.status.mpos.x === 10);
    c.handle({ type: 'zero', axes: ['X'] });
    await until(() => c.status.wpos.x === 0 && c.status.wco.x === 10);
    await c.disconnect();
  });

  it('goes to Z0 and XY0, refusing XY0 while below the work surface', async () => {
    const c = await setup();
    c.handle({ type: 'jog', dx: 30, dy: 20, feed: 6000 });
    await until(() => c.status.mpos.x === 30 && c.status.mpos.y === 20);
    c.handle({ type: 'zero', axes: ['X', 'Y', 'Z'] });
    c.handle({ type: 'jog', dx: 7, dy: 7, feed: 6000 });
    await until(() => c.status.wpos.x === 7 && c.status.wpos.y === 7);
    c.handle({ type: 'jog', dz: -5, feed: 3000 });
    await until(() => c.status.wpos.z === -5);
    c.handle({ type: 'goto', target: 'xy0', feed: 6000 });
    await wait(300);
    expect(c.status.wpos.x).toBe(7); // refused: tool is below Z0
    expect(c.logBuffer.some((l) => l.text.includes('Raise Z'))).toBe(true);
    c.handle({ type: 'goto', target: 'z0', feed: 3000 });
    await until(() => c.status.wpos.z === 0);
    c.handle({ type: 'goto', target: 'xy0', feed: 6000 });
    await until(() => c.status.wpos.x === 0 && c.status.wpos.y === 0);
    c.handle({ type: 'goto', target: 'z0', feed: 0 }); // invalid feed is rejected
    expect(c.logBuffer.some((l) => l.text.includes('Invalid feed'))).toBe(true);
    await c.disconnect();
  });

  it('frames the loaded program: traces its full outline above the surface and returns to the start', async () => {
    const c = await setup();
    c.handle({ type: 'frame', feed: 3000, zFeed: 500 });
    expect(c.logBuffer.some((l) => l.text.includes('Load a G-code file'))).toBe(true);   // nothing loaded yet
    // cutting is only in 20..30 x 20..30, but a rapid goes out to X0 Y0: the frame uses every move
    c.loadJob('f.nc', ['G21 G90', 'G0 X0 Y0 Z5', 'G0 X20 Y20', 'G1 Z-1 F300', 'G1 X30 F500', 'G1 Y30', 'G0 Z5'].join('\n'));
    c.handle({ type: 'jog', dx: 7, dy: 8, feed: 6000 });
    await until(() => c.status.wpos.x === 7 && c.status.wpos.y === 8);
    c.handle({ type: 'frame', feed: 3000, zFeed: 500 });
    const sent = () => c.logBuffer.filter((l) => l.kind === 'tx').map((l) => l.text);
    await until(() => sent().includes('G1Z0.000F500') && c.status.state === 'Idle' && c.status.wpos.z === 0 && c.status.wpos.x === 7);
    const frame = sent().slice(sent().indexOf('G21G90'));
    expect(frame).toEqual([
      'G21G90', 'G1Z5.000F500', 'G1X0.000Y0.000F3000', 'G1X30.000Y0.000', 'G1X30.000Y30.000', 'G1X0.000Y30.000', 'G1X0.000Y0.000',
      'G1X7.000Y8.000', 'G1Z0.000F500',
    ]);
    expect(c.status.wpos).toMatchObject({ x: 7, y: 8, z: 0 });
    await c.disconnect();
  });

  it('refuses to frame while the tool is below the surface, during a job, or with a bad feed', async () => {
    const c = await setup();
    c.loadJob('f.nc', 'G0 X10 Y10\nG1 X20 F500');
    c.handle({ type: 'jog', dz: -2, feed: 3000 });
    await until(() => c.status.wpos.z === -2);
    c.handle({ type: 'frame', feed: 3000, zFeed: 500 });
    expect(c.logBuffer.some((l) => l.text.includes('below the work surface'))).toBe(true);
    c.handle({ type: 'frame', feed: 0, zFeed: 500 });
    expect(c.logBuffer.some((l) => l.text.includes('Invalid feed for the frame'))).toBe(true);
    await wait(300);
    expect(c.logBuffer.filter((l) => l.kind === 'tx').some((l) => l.text.startsWith('G1X10'))).toBe(false);
    await c.disconnect();
  });

  it('spindle: only enabled commands, only allowed speeds, and the status says what is on', async () => {
    const c = await setup();
    const sent = () => c.logBuffer.filter((l) => l.kind === 'tx').map((l) => l.text);
    c.spindleConfig = () => ({ commands: ['M3', 'M5', 'M7', 'M9'], speeds: [1000, 24000], maxRpm: 24000 });
    c.handle({ type: 'spindle', command: 'M4', rpm: 5000 });        // CCW is not enabled here
    expect(c.logBuffer.some((l) => l.text.includes('M4 is not enabled'))).toBe(true);
    c.handle({ type: 'spindle', command: 'M3', rpm: 30000 });       // above the highest speed
    c.handle({ type: 'spindle', command: 'M3' });                   // no speed at all
    c.handle({ type: 'spindle', command: 'M3', rpm: NaN });
    expect(c.logBuffer.filter((l) => l.text.includes('Spindle speed must be from 1 to 24000')).length).toBe(3);
    expect(sent().some((l) => l.startsWith('M3') || l.startsWith('M4'))).toBe(false);

    c.handle({ type: 'spindle', command: 'M3', rpm: 18000 });
    await until(() => c.status.spindle === 18000 && c.status.accessories === 'S');
    c.handle({ type: 'spindle', command: 'M7' });                   // the vacuum
    await until(() => c.status.accessories === 'SM');
    c.handle({ type: 'spindle', command: 'M9' });
    await until(() => c.status.accessories === 'S');
    c.handle({ type: 'spindle', command: 'M5' });
    await until(() => c.status.spindle === 0 && c.status.accessories === '');
    expect(sent()).toEqual(expect.arrayContaining(['M3 S18000', 'M7', 'M9', 'M5']));
    await c.disconnect();
  });

  it('spindle: will not start in alarm or during a probe, but off always works while idle', async () => {
    const c = await setup();
    c.lock = 'A probe is running';
    c.handle({ type: 'spindle', command: 'M3', rpm: 1000 });
    expect(c.logBuffer.some((l) => l.text.includes('Blocked: A probe is running'))).toBe(true);
    c.lock = undefined;
    c.status = { ...c.status, state: 'Alarm' };
    c.handle({ type: 'spindle', command: 'M3', rpm: 1000 });
    expect(c.logBuffer.some((l) => l.text.includes('clear it before starting the spindle'))).toBe(true);
    await c.disconnect();
  });

  describe('PCB mode', () => {
    const cfg = { enabled: true, configured: true, x: 100, y: 50, safeZ: -10 };
    const sent = (c: GrblController) => c.logBuffer.filter((l) => l.kind === 'tx').map((l) => l.text);
    async function homed() {
      const c = await setup();
      c.handle({ type: 'home' });                       // (before the mode is on) so the fixture position means something
      await until(() => !c.connection.homeReminder && c.status.state === 'Idle');
      c.pcbConfig = () => cfg;
      return c;
    }

    it('PCB Home goes to the fixture in machine coordinates and makes that work X0 Y0', async () => {
      const c = await homed();
      c.handle({ type: 'jog', dx: 7, dy: 8, feed: 6000 });
      await until(() => c.status.mpos.x === 7 && c.status.mpos.y === 8);
      c.handle({ type: 'pcbHome' });
      await until(() => c.connection.pcbHomed === true);
      expect(c.status.mpos).toMatchObject({ x: 100, y: 50 });
      await until(() => c.status.wpos.x === 0 && c.status.wpos.y === 0);
      expect(sent(c)).toEqual(expect.arrayContaining(['G21G90G54', 'G53G0X100.000Y50.000', 'G10L20P1X0Y0']));
      expect(sent(c).some((l) => l.startsWith('G53G0Z'))).toBe(false);    // already above the safe height: no Z move at all
      expect(c.lock).toBeUndefined();
      await c.disconnect();
    });

    it('raises to the safe height first when the tool is lower, and never lowers to it', async () => {
      const c = await homed();
      c.handle({ type: 'jog', dz: -20, feed: 3000 });
      await until(() => c.status.mpos.z === -20);
      c.handle({ type: 'pcbHome' });
      await until(() => c.connection.pcbHomed === true);
      const lines = sent(c);
      expect(lines.indexOf('G53G0Z-10.000')).toBeGreaterThan(-1);
      expect(lines.indexOf('G53G0Z-10.000')).toBeLessThan(lines.indexOf('G53G0X100.000Y50.000'));   // Z up before any XY move
      expect(c.status.mpos.z).toBe(-10);
      c.clearPcbHomed();
      expect(c.connection.pcbHomed).toBe(false);
      await c.disconnect();
    });

    it('refuses when the mode is off, before homing, or during a job', async () => {
      const c = await setup();
      c.pcbConfig = () => ({ ...cfg, enabled: false });
      c.handle({ type: 'pcbHome' }); await wait(100);
      expect(c.logBuffer.some((l) => l.text.includes('PCB mode is off'))).toBe(true);
      c.pcbConfig = () => cfg;
      c.handle({ type: 'pcbHome' }); await wait(100);                                  // connected but not homed yet
      expect(c.logBuffer.some((l) => l.text.includes('Home the machine first'))).toBe(true);
      c.pcbConfig = () => ({ ...cfg, enabled: false });
      c.handle({ type: 'home' });
      await until(() => !c.connection.homeReminder);
      c.pcbConfig = () => cfg;
      c.loadJob('j.nc', 'G0 X1\nG0 X2'); c.startJob();
      c.handle({ type: 'pcbHome' }); await wait(100);
      expect(c.logBuffer.some((l) => l.text.includes('Cannot do PCB Home during a job'))).toBe(true);
      expect(sent(c).some((l) => l.startsWith('G53'))).toBe(false);
      await c.disconnect();
    });

    it('turns normal homing off, from the button and from the console, while the mode is on', async () => {
      const c = await setup();
      c.pcbConfig = () => cfg;
      c.handle({ type: 'home' });
      c.handle({ type: 'send', line: '$H' });
      c.handle({ type: 'send', line: '$hx' });
      expect(c.logBuffer.filter((l) => l.text.includes('PCB mode is on: turn it off to home the machine')).length).toBe(3);
      expect(sent(c).some((l) => /^\$H/i.test(l))).toBe(false);
      c.handle({ type: 'send', line: '$X' });                                           // unlocking is still fine
      await wait(100);
      expect(sent(c)).toContain('$X');
      c.pcbConfig = () => ({ ...cfg, enabled: false });
      c.handle({ type: 'home' }); await wait(100);
      expect(sent(c)).toContain('$H');                                                  // and homing works again once the mode is off
      await c.disconnect();
    });
  });

  it('reminds you to home after connecting, until Home or Unlock is sent', async () => {
    for (const how of ['home button', 'unlock button', 'console $H', 'console $X'] as const) {
      const c = await setup();
      expect(c.connection.homeReminder, `${how}: set on connect`).toBe(true);
      c.handle({ type: 'jog', dx: 1, feed: 6000 });     // moving about does not end it
      c.handle({ type: 'zero', axes: ['X'] });
      expect(c.connection.homeReminder, `${how}: still on after jog and zero`).toBe(true);
      const announced: boolean[] = [];
      c.on('connection', (i) => announced.push(!!i.homeReminder));
      if (how === 'home button') c.handle({ type: 'home' });
      else if (how === 'unlock button') c.handle({ type: 'unlock' });
      else c.handle({ type: 'send', line: how === 'console $H' ? '$h' : '$X' });
      expect(c.connection.homeReminder, `${how}: cleared`).toBe(false);
      expect(announced, `${how}: every browser is told`).toEqual([false]);
      await c.disconnect();
    }
  });

  it('does not clear the reminder when the command was refused, and starts again on the next connection', async () => {
    const c = await setup();
    c.lock = 'Probe in progress';
    c.handle({ type: 'home' });
    expect(c.connection.homeReminder).toBe(true);        // blocked, so nothing was homed
    c.lock = undefined;
    c.handle({ type: 'home' });
    expect(c.connection.homeReminder).toBe(false);
    await c.disconnect();
    expect(c.connection.homeReminder).toBeFalsy();       // nothing to remind when disconnected
    await c.connect(new SimulatorTransport(50), 'simulator');
    expect(c.connection.homeReminder).toBe(true);        // a fresh connection reminds again
    await c.disconnect();
  });

  it('limits Z jog to 20 mm', async () => {
    const c = await setup();
    c.handle({ type: 'jog', dz: 100, feed: 300 });
    await until(() => c.status.mpos.z === 20);
    c.handle({ type: 'jog', dz: -100, feed: 300 });
    await until(() => c.status.mpos.z === 0);
    await c.disconnect();
  });

  it('pauses, resumes and stops a job', async () => {
    const c = await setup(1);
    c.loadJob('slow.nc', 'G21\nG90\nG1 X100 F600\nG1 X0 F600');
    c.startJob();
    await until(() => c.status.state === 'Run');
    c.handle({ type: 'jobPause' });
    await until(() => c.status.state === 'Hold');
    expect(c.job.state).toBe('paused');
    c.handle({ type: 'jobResume' });
    await until(() => c.status.state === 'Run');
    await c.stopJob();
    expect(c.job.state).toBe('loaded');
    await until(() => c.status.state === 'Idle');
    await c.disconnect();
  }, 20000);

  it('blocks manual commands during a job', async () => {
    const c = await setup(1);
    c.loadJob('a.nc', 'G21\nG1 X50 F600');
    c.startJob();
    c.sendLine('G0 X1');
    expect(c.logBuffer.some((l) => l.text.includes('blocked'))).toBe(true);
    await c.stopJob();
    await c.disconnect();
  }, 15000);
});
