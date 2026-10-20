import { describe, expect, it } from 'vitest';
import { LaserSession } from '../server/src/laserSession';

const reported = async () => [{ path: '/dev/ttyUSB0', description: 'CNC controller' }, { path: '/dev/ttyUSB1', description: 'laser' }];

describe('which USB ports a laser may use', () => {
  it('offers every port when no list is set (tests only), none but the simulator for an empty list, and only the listed ones otherwise', async () => {
    const all = await new LaserSession({ listPorts: reported }).ports();
    expect(all.map((p) => p.path)).toEqual(['simulator', '/dev/ttyUSB0', '/dev/ttyUSB1']);
    const none = new LaserSession({ listPorts: reported, allowedPorts: [] });
    expect((await none.ports()).map((p) => p.path)).toEqual(['simulator']);
    const one = new LaserSession({ listPorts: reported, allowedPorts: ['/dev/ttyUSB1'] });
    expect((await one.ports()).map((p) => p.path)).toEqual(['simulator', '/dev/ttyUSB1']);
  });
  it('refuses to open a port that is not on the list, even by name', async () => {
    const s = new LaserSession({ listPorts: reported, allowedPorts: ['/dev/ttyUSB1'] });
    const r = await s.connect('/dev/ttyUSB0');
    expect(r.ok).toBe(false);
    await s.close();
  });
});
