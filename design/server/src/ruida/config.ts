// Ruida support is OFF unless the owner turns it on, because nothing here has been tried on a real machine.
//   DESIGN_RUIDA=1                    list Ruida targets in the Laser panel
//   DESIGN_RUIDA_HOSTS=laser=192.168.1.50   controllers the browser may pick by name (never by address); LAN addresses only
//   DESIGN_RUIDA_BED=1000x600         work area in mm (the controller's own answer may only make it smaller)
//   DESIGN_RUIDA_MAX_POWER=30         highest power any layer may ask for, percent (default 100)
//   DESIGN_RUIDA_MAX_SPEED=600        highest speed, mm/s
//   DESIGN_RUIDA_PAUSE=1              allow Pause / Resume (whether the laser stays off while paused is not yet proven)
//   DESIGN_RUIDA_HOME=1               allow Home (the head goes to the machine's limits and then to 0,0; seen once from LightBurn, not tried from here)
//   DESIGN_RUIDA_Z=1                  allow Z moves (one short step at a time; seen from LightBurn, not tried from here)

export interface RuidaConfig {
  enabled: boolean;
  controllers: Record<string, string>;
  bedW: number;
  bedH: number;
  maxPower: number;
  maxSpeed: number;
  pause: boolean;
  /** Home is allowed (DESIGN_RUIDA_HOME=1) */
  home?: boolean;
  /** Z moves are allowed (DESIGN_RUIDA_Z=1) */
  z?: boolean;
}

/** 10.x, 172.16-31.x, 192.168.x, 169.254.x: the controller sits on the local network, never on the internet */
export function isLanAddress(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}

export const CONTROLLER_NAME = /^[\w .-]{1,30}$/;

/** Plain-language reason a controller entry cannot be used, or null */
export function controllerProblem(name: string, host: string): string | null {
  if (!CONTROLLER_NAME.test(name.trim())) return 'The name may use letters, digits, spaces, dots and dashes (up to 30).';
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host.trim())) return 'The address must be four numbers separated by dots, like the one LightBurn shows for the laser.';
  if (!isLanAddress(host.trim())) return 'That address is not on a local network (it must start 10., 172.16-31., 192.168. or 169.254.). DemonX Design only talks to lasers on your own network.';
  return null;
}

export function ruidaConfigFromEnv(env: Record<string, string | undefined>): RuidaConfig {
  const controllers: Record<string, string> = {};
  for (const part of (env.DESIGN_RUIDA_HOSTS ?? '').split(',')) {
    const [name, ip] = part.split('=').map((s) => s.trim());
    if (!name || !ip) continue;
    if (!/^[\w .-]{1,30}$/.test(name)) { console.warn(`DESIGN_RUIDA_HOSTS: ignoring "${name}" (use letters, digits, space, dot, dash)`); continue; }
    if (!isLanAddress(ip)) { console.warn(`DESIGN_RUIDA_HOSTS: ignoring ${name}, ${ip} is not a local-network address`); continue; }
    controllers[name] = ip;
  }
  const bed = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(env.DESIGN_RUIDA_BED ?? '1000x600');
  const num = (v: string | undefined, d: number) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? n : d; };
  return {
    enabled: env.DESIGN_RUIDA === '1',
    controllers,
    bedW: bed ? Number(bed[1]) : 1000,
    bedH: bed ? Number(bed[2]) : 600,
    maxPower: Math.min(100, num(env.DESIGN_RUIDA_MAX_POWER, 100)),
    maxSpeed: num(env.DESIGN_RUIDA_MAX_SPEED, 600),
    pause: env.DESIGN_RUIDA_PAUSE === '1',
    home: env.DESIGN_RUIDA_HOME === '1',
    z: env.DESIGN_RUIDA_Z === '1',
  };
}
