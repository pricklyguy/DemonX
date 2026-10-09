import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore, AuthError, sessionToken, sameOrigin, isLocalRequest, classifyPeer, lanUrls, COOKIE } from '../src/auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-auth-'));
/** is a browser on the home network with this session an operator? */
const op = (a: AuthStore, token?: string) => a.roleFor('lan', token) === 'operator';

describe('modes and roles', () => {
  it('a fresh install is in setup: only the DemonX computer may control, nobody else', () => {
    const a = new AuthStore(tmp());
    expect(a.mode).toBe('setup');
    expect(a.roleFor('local', undefined)).toBe('operator');
    expect(a.roleFor('lan', undefined)).toBe('viewer');
    expect(a.roleFor('outside', undefined)).toBe('viewer');
    expect(a.roleFor('local', undefined, false)).toBe('viewer');     // with "trust the local computer" off
  });

  it('with a PIN, only a signed-in session controls, and the DemonX computer still does', () => {
    const a = new AuthStore(tmp());
    const mine = a.setPin('1234');
    expect(a.mode).toBe('pin');
    expect(a.roleFor('lan', mine)).toBe('operator');
    expect(a.roleFor('outside', mine)).toBe('operator');             // signed in is signed in, wherever from
    expect(a.roleFor('lan', undefined)).toBe('viewer');
    expect(a.roleFor('lan', 'made-up')).toBe('viewer');
    expect(a.roleFor('local', undefined)).toBe('operator');
    expect(a.roleFor('local', undefined, false)).toBe('viewer');
    expect(() => a.login('9999', 'x')).toThrow(AuthError);
    expect(op(a, a.login('1234', 'x'))).toBe(true);
  });

  it('running without a PIN is a choice: the home network controls, outside only watches', () => {
    const a = new AuthStore(tmp());
    a.chooseOpen();
    expect(a.mode).toBe('open');
    expect(a.roleFor('lan', undefined)).toBe('operator');
    expect(a.roleFor('local', undefined)).toBe('operator');
    expect(a.roleFor('outside', undefined)).toBe('viewer');
  });

  it('removing the PIN is that same choice', () => {
    const a = new AuthStore(tmp());
    a.setPin('1234');
    a.clearPin();
    expect(a.mode).toBe('open');
    expect(a.roleFor('outside', undefined)).toBe('viewer');
    expect(a.roleFor('lan', undefined)).toBe('operator');
  });
});

describe('the setup code', () => {
  it('exists only in setup, is 8 digits, and a wrong one is refused with a growing wait', () => {
    let now = 1_000_000;
    const a = new AuthStore(tmp(), () => now);
    const code = a.setupCode!;
    expect(code).toMatch(/^\d{8}$/);
    expect(AuthStore.formatCode(code)).toMatch(/^\d{4}-\d{4}$/);
    for (let i = 0; i < 6; i++) expect(() => a.checkCode('00000000', 'evil')).toThrow(AuthError);
    try { a.checkCode(code, 'evil'); expect.unreachable(); } catch (e) { expect((e as AuthError).retryAfterSec).toBeGreaterThan(0); }   // locked out, even with the right code
    expect(() => a.checkCode(code, 'friend')).not.toThrow();                                                                        // others are not
    now += 6000;
    expect(() => a.checkCode(code, 'evil')).not.toThrow();
  });

  it('accepts the code with or without its dash, and not a different length', () => {
    const a = new AuthStore(tmp());
    const code = a.setupCode!;
    expect(() => a.checkCode(AuthStore.formatCode(code), 'x')).not.toThrow();
    expect(() => a.checkCode(code.slice(0, 7), 'x')).toThrow(AuthError);
    expect(() => a.checkCode(undefined, 'x')).toThrow(AuthError);
  });

  it('lets a browser elsewhere set the first PIN, and only with the code', () => {
    const a = new AuthStore(tmp());
    expect(() => a.canSetPin('lan', undefined, '00000000', 'x')).toThrow(AuthError);
    expect(a.canSetPin('lan', undefined, a.setupCode, 'x')).toBe(true);
    expect(a.canSetPin('local', undefined, undefined, 'x')).toBe(true);     // the DemonX computer needs no code
    a.setPin('1234');
    expect(a.setupCode).toBeUndefined();                                     // the code is gone once a PIN exists
    expect(a.canSetPin('lan', undefined, '12345678', 'x')).toBe(false);      // and a stranger cannot change a PIN
  });

  it('is not offered, or accepted, outside setup', () => {
    const a = new AuthStore(tmp());
    a.chooseOpen();
    expect(a.setupCode).toBeUndefined();
    expect(a.canSetPin('outside', undefined, '12345678', 'x')).toBe(false);
    expect(a.canSetPin('lan', undefined, undefined, 'x')).toBe(true);        // an operator on the home network may set a PIN
  });
});

describe('PINs and sessions', () => {
  it('refuses a short or huge PIN', () => {
    const a = new AuthStore(tmp());
    expect(() => a.setPin('123')).toThrow(/at least/);
    expect(() => a.setPin('x'.repeat(65))).toThrow(/at most/);
    expect(() => a.setPin(1234 as unknown)).toThrow(AuthError);
    expect(a.mode).toBe('setup');
  });

  it('keeps the PIN across restarts, hashed, in a private file', () => {
    const dir = tmp();
    new AuthStore(dir).setPin('open sesame');
    const file = path.join(dir, 'auth.json');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('open sesame');
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    const b = new AuthStore(dir);
    expect(b.mode).toBe('pin');
    expect(op(b, b.login('open sesame', 'x'))).toBe(true);
  });

  it('keeps the choice to run without a PIN across restarts', () => {
    const dir = tmp();
    new AuthStore(dir).chooseOpen();
    expect(new AuthStore(dir).mode).toBe('open');
  });

  it('changing the PIN signs everybody else out; removing it deletes nothing but the PIN', () => {
    const dir = tmp();
    const a = new AuthStore(dir);
    a.setPin('1234');
    const other = a.login('1234', 'x');
    const changed: number[] = [];
    a.on('changed', () => changed.push(1));
    const fresh = a.setPin('5678');
    expect(op(a, other)).toBe(false);
    expect(op(a, fresh)).toBe(true);
    expect(() => a.login('1234', 'x')).toThrow(AuthError);
    a.clearPin();
    expect(a.mode).toBe('open');
    expect(changed.length).toBe(2);
  });

  it('logout ends that session only', () => {
    const a = new AuthStore(tmp());
    a.setPin('1234');
    const s1 = a.login('1234', 'x'), s2 = a.login('1234', 'y');
    a.logout(s1);
    expect(op(a, s1)).toBe(false);
    expect(op(a, s2)).toBe(true);
  });

  it('a remembered sign-in survives a restart; a plain one does not; neither is stored as a plain token', () => {
    const dir = tmp();
    const a = new AuthStore(dir);
    a.setPin('1234');
    const kept = a.login('1234', 'x', true), plain = a.login('1234', 'x', false);
    expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).not.toContain(kept);
    const b = new AuthStore(dir);
    expect(op(b, kept)).toBe(true);
    expect(op(b, plain)).toBe(false);
    b.logout(kept);
    expect(op(new AuthStore(dir), kept)).toBe(false);
  });

  it('a plain sign-in lasts hours, a remembered one months', () => {
    let now = 1_000_000;
    const a = new AuthStore(tmp(), () => now);
    a.setPin('1234');
    const plain = a.login('1234', 'x', false), kept = a.login('1234', 'x', true);
    now += 13 * 3600_000;
    expect(op(a, plain)).toBe(false);
    expect(op(a, kept)).toBe(true);
    now += 91 * 24 * 3600_000;
    expect(op(a, kept)).toBe(false);
  });

  it('locks an address out after repeated wrong PINs, with a growing wait, but not others', () => {
    let now = 1_000_000;
    const a = new AuthStore(tmp(), () => now);
    a.setPin('1234');
    for (let i = 0; i < 5; i++) expect(() => a.login('bad', 'evil')).toThrow('Wrong PIN');
    expect(() => a.login('bad', 'evil')).toThrow('Wrong PIN');   // the 6th wrong try starts the wait
    try { a.login('1234', 'evil'); expect.unreachable(); } catch (e) { expect((e as AuthError).retryAfterSec).toBeGreaterThan(0); }
    expect(op(a, a.login('1234', 'friend'))).toBe(true);
    now += 6000;
    expect(op(a, a.login('1234', 'evil'))).toBe(true);
  });
});

describe('a change made by another program (the set-pin command)', () => {
  it('a running server notices a PIN set from outside, and the file being deleted', () => {
    let now = 1_000_000;
    const dir = tmp();
    const server = new AuthStore(dir, () => now);
    expect(server.mode).toBe('setup');
    const changed: number[] = [];
    server.on('changed', () => changed.push(1));
    const cli = new AuthStore(dir, () => now);        // what `npm run set-pin` does
    cli.setPin('1234');
    now += 1500;
    expect(server.mode).toBe('pin');
    expect(server.setupCode).toBeUndefined();
    expect(changed.length).toBe(1);
    fs.rmSync(path.join(dir, 'auth.json'));
    now += 1500;
    expect(server.mode).toBe('setup');
    expect(server.setupCode).toMatch(/^\d{8}$/);
  });
});

describe('helpers', () => {
  it('reads the session cookie among others', () => {
    expect(sessionToken(`a=1; ${COOKIE}=abc; b=2`)).toBe('abc');
    expect(sessionToken('a=1')).toBeUndefined();
    expect(sessionToken(undefined)).toBeUndefined();
  });
  it('accepts a request from this site and refuses another', () => {
    expect(sameOrigin('http://demonx.local:8080', 'demonx.local:8080')).toBe(true);
    expect(sameOrigin('http://evil.example', 'demonx.local:8080')).toBe(false);
    expect(sameOrigin('null', 'demonx.local:8080')).toBe(false);
    expect(sameOrigin(undefined, 'demonx.local:8080')).toBe(true);
  });
});

describe('isLocalRequest', () => {
  const own = new Set(['10.20.30.20']);
  it('trusts the computer itself, by loopback or by its own address', () => {
    expect(isLocalRequest('127.0.0.1', {}, own)).toBe(true);
    expect(isLocalRequest('::ffff:127.0.0.1', {}, own)).toBe(true);
    expect(isLocalRequest('::1', {}, own)).toBe(true);
    expect(isLocalRequest('::ffff:10.20.30.20', {}, own)).toBe(true);
  });
  it('does not trust other computers, or a request that came through a proxy', () => {
    expect(isLocalRequest('10.20.30.55', {}, own)).toBe(false);
    expect(isLocalRequest(undefined, {}, own)).toBe(false);
    expect(isLocalRequest('127.0.0.1', { 'x-forwarded-for': '10.20.30.55' }, own)).toBe(false);
    expect(isLocalRequest('127.0.0.1', { forwarded: 'for=10.20.30.55' }, own)).toBe(false);
  });
});

const nic = (address: string, over: Record<string, unknown> = {}) => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', internal: false, netmask: '', mac: '', cidr: null, ...over });
const NETS = {
  lo: [nic('127.0.0.1', { internal: true, cidr: '127.0.0.1/8' })],
  eth0: [nic('10.20.30.43', { cidr: '10.20.30.43/24' }), nic('2601:abcd:1:2::43', { cidr: '2601:abcd:1:2::43/64' })],
  tailscale0: [nic('100.101.102.103', { cidr: '100.101.102.103/32' })],
  odd: [nic('203.0.113.9', { cidr: '203.0.113.9/24' })],     // an address range that is not a private one but is on a card of this computer
} as never;

describe('classifyPeer', () => {
  const c = (remote: string | undefined, headers = {}, trustLocal = true) => classifyPeer(remote, headers, NETS, trustLocal);
  it('this computer', () => {
    expect(c('127.0.0.1')).toBe('local');
    expect(c('::1')).toBe('local');
    expect(c('::ffff:127.0.0.1')).toBe('local');
    expect(c('10.20.30.43')).toBe('local');                    // its own address
    expect(c('100.101.102.103')).toBe('local');               // its own Tailscale address, from itself
    expect(c('127.0.0.1', {}, false)).toBe('lan');           // trust off: an ordinary home-network browser
  });
  it('the home network: private ranges, link-local, and the same subnet as a card', () => {
    for (const ip of ['10.0.0.5', '10.20.30.99', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.3.3', '::ffff:192.168.0.9', 'fe80::1%eth0', 'fd12:3456::1']) expect(c(ip), ip).toBe('lan');
    expect(c('2601:abcd:1:2::99')).toBe('lan');              // a global IPv6 address on the same network as the card
    expect(c('203.0.113.77')).toBe('lan');                   // same subnet as a card, even though the range is public
  });
  it('outside: public addresses, VPNs such as Tailscale, other private-looking ranges that are not private', () => {
    for (const ip of ['8.8.8.8', '203.0.114.5', '2606:4700::1111', '100.64.0.1', '100.127.255.254', '100.100.1.1', '172.32.0.1', '172.15.0.1', '11.0.0.1']) expect(c(ip), ip).toBe('outside');
    expect(c(undefined)).toBe('outside');
    expect(c('not an address')).toBe('outside');
  });
  it('anything that came through a proxy or tunnel is outside, even from this computer', () => {
    expect(c('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' })).toBe('outside');
    expect(c('192.168.1.5', { 'cf-connecting-ip': '8.8.8.8' })).toBe('outside');
    expect(c('127.0.0.1', { forwarded: 'for=8.8.8.8' })).toBe('outside');
    expect(c('127.0.0.1', { 'x-real-ip': '8.8.8.8' })).toBe('outside');
  });
});

describe('lanUrls', () => {
  it('lists the network addresses, home ranges first, without loopback or link-local', () => {
    const urls = lanUrls(8080, {
      lo: [nic('127.0.0.1', { internal: true })],
      vpn: [nic('100.64.1.2')],
      eth0: [nic('10.20.30.20'), nic('fe80::1')],
      wifi: [nic('192.168.1.20')],
      auto: [nic('169.254.9.9')],
    } as never);
    expect(urls).toEqual(['http://192.168.1.20:8080', 'http://10.20.30.20:8080', 'http://100.64.1.2:8080']);
    expect(lanUrls(8080, {} as never)).toEqual([]);
  });
});
