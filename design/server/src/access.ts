// Who may talk to the Design server, and who may control the laser through it.
//
// The same rules as DemonX CNC (it shares its sign-in code, ../../../server/src/auth.ts):
//   - the computer that runs the server is always an operator (unless trustLocal is off);
//   - other computers on the home network can look, and control once they have signed in with the PIN;
//   - anything from outside the network (a public address, a VPN, a proxy or tunnel) is refused outright.
// Nothing here trusts the browser: every message is checked again on the server.
import http from 'node:http';
import { AuthError, AuthStore, classifyPeer, clearedCookie, sameOrigin, sessionCookie, sessionToken, type Peer, type Role } from '../../../server/src/auth.js';

/**
 * Names the browser may use for this server. An address that means this computer or the home network, never a name from the
 * internet: a page on another site that is pointed at the laser server (DNS rebinding) arrives with its own name and is refused.
 */
export function hostOk(host: string | undefined): boolean {
  if (!host) return false;
  const m = /^(\[[0-9a-f:.]+\]|[^:/\s]+)(:\d+)?$/i.exec(host);
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (name === 'localhost' || name === '[::1]') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    const [a, b] = name.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (name.startsWith('[')) return /^\[(fe[89ab]|f[cd])/i.test(name);   // link-local and unique-local IPv6
  return !name.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(name);
}

export interface Access {
  auth: AuthStore;
  trustLocal: boolean;
  peerOf: (req: http.IncomingMessage) => Peer;
  roleOf: (req: http.IncomingMessage) => Role;
  /** May this request reach the server at all (a real peer, a name we accept)? */
  admits: (req: http.IncomingMessage) => boolean;
  /** Answers /api/auth/* ; true when it handled the request */
  handleAuth: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => boolean;
}

const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));

const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => { try { const j = JSON.parse(body || '{}'); resolve(j && typeof j === 'object' ? j : {}); } catch { resolve({}); } });
  req.on('error', () => resolve({}));
});

export function makeAccess(auth: AuthStore, trustLocal = true): Access {
  const peerOf = (req: http.IncomingMessage) => classifyPeer(req.socket.remoteAddress, req.headers, undefined, trustLocal);
  const roleOf = (req: http.IncomingMessage) => auth.roleFor(peerOf(req), sessionToken(req.headers.cookie), trustLocal);
  const admits = (req: http.IncomingMessage) => peerOf(req) !== 'outside' && hostOk(req.headers.host);
  const addressOf = (req: http.IncomingMessage) => req.socket.remoteAddress ?? '?';

  const handleAuth = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean => {
    if (!pathname.startsWith('/api/auth/')) return false;
    const token = sessionToken(req.headers.cookie);
    if (pathname === '/api/auth/status' && req.method === 'GET') {
      json(res, 200, { mode: auth.mode, operator: roleOf(req) === 'operator', peer: peerOf(req) });
      return true;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return true; }
    if (!sameOrigin(req.headers.origin, req.headers.host)) { json(res, 403, { error: 'Not allowed from another site' }); return true; }
    void (async () => {
      const body = await readJson(req);
      try {
        switch (pathname) {
          case '/api/auth/login': {
            const remember = body.remember === true;
            const t = auth.login(body.pin, addressOf(req), remember);
            return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(t, remember) });
          }
          case '/api/auth/logout':
            auth.logout(token);
            return json(res, 200, { ok: true }, { 'set-cookie': clearedCookie() });
          case '/api/auth/set-pin': {
            // changing the PIN needs a signed-in session; the first PIN needs this computer, or the setup code printed in its console
            if (!auth.canSetPin(peerOf(req), token, body.code, addressOf(req), trustLocal)) {
              return json(res, 401, { error: auth.mode === 'pin' ? 'Sign in first' : 'Set the first PIN on the computer that runs DemonX Design, or enter the setup code it shows' });
            }
            const t = auth.setPin(body.pin);
            return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(t) });
          }
          case '/api/auth/clear-pin':
            if (roleOf(req) !== 'operator') return json(res, 401, { error: 'Sign in first' });
            auth.clearPin();
            return json(res, 200, { ok: true }, { 'set-cookie': clearedCookie() });
          default: return json(res, 404, { error: 'Not found' });
        }
      } catch (e) {
        if (e instanceof AuthError) return json(res, e.retryAfterSec ? 429 : 400, { error: e.message, retryAfterSec: e.retryAfterSec });
        return json(res, 500, { error: 'Server error' });
      }
    })();
    return true;
  };

  return { auth, trustLocal, peerOf, roleOf, admits, handleAuth };
}
