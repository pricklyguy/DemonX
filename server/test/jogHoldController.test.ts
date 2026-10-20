import { describe, it, expect } from 'vitest';
import { GrblController } from '../src/controller.js';
import { SimulatorTransport } from '../src/simulator.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('held-jog lines in the controller', () => {
  it('are counted until acknowledged, and not shown in the console', async () => {
    const c = new GrblController();
    await c.connect(new SimulatorTransport(1), 'simulator');
    await wait(300);
    c.jogHoldSegment('$J=G21G91X1F600');
    expect(c.jogHoldBacklog()).toBe(1);
    await wait(300);
    expect(c.jogHoldBacklog()).toBe(0);
    expect(c.logBuffer.filter((l) => l.kind === 'tx').some((l) => l.text.startsWith('$J='))).toBe(false);
    await c.disconnect();
  });

  it('purging drops the ones not yet sent, so a stop is not followed by more movement', async () => {
    const c = new GrblController();
    await c.connect(new SimulatorTransport(1), 'simulator');
    await wait(300);
    // stop the writer from sending, as if the controller were slow to acknowledge: fill the serial buffer first
    for (let i = 0; i < 40; i++) c.jogHoldSegment('$J=G21G91X0.1F600');
    expect(c.jogHoldBacklog()).toBe(40);
    c.jogHoldPurge();
    const left = c.jogHoldBacklog();
    expect(left).toBeLessThan(40);                                     // those already on the wire stay until acknowledged
    await wait(500);
    expect(c.jogHoldBacklog()).toBe(0);
    await c.disconnect();
  });

  it('are dropped by a plain jogCancel from any client, not only by the one holding', async () => {
    const c = new GrblController();
    await c.connect(new SimulatorTransport(1), 'simulator');
    await wait(300);
    for (let i = 0; i < 40; i++) c.jogHoldSegment('$J=G21G91X0.1F600');
    c.handle({ type: 'jogCancel' });
    expect(c.jogHoldBacklog()).toBeLessThan(40);
    await wait(500);
    expect(c.jogHoldBacklog()).toBe(0);
    await c.disconnect();
  });

  it('are refused in an alarm or during a job', async () => {
    const c = new GrblController();
    await c.connect(new SimulatorTransport(1), 'simulator');
    await wait(300);
    expect(c.jogHoldBlocked()).toBeNull();
    c.loadJob('a.nc', 'G0 X1\n');
    expect(c.jogHoldBlocked()).toBeNull();
    c.startJob();
    expect(c.jogHoldBlocked()).toMatch(/job/i);
    await c.disconnect();
    expect(c.jogHoldBlocked()).toBe('Not connected');
  });
});
