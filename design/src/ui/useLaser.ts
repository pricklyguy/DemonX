import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLine, PortInfo } from '../../../shared/protocol';
import type { ClientMessage, LaserState, ServerMessage } from '../../server/src/protocol';

export interface Notice { ok: boolean; message: string; code?: string; at: number }

/**
 * The connection to the Design server, which owns the laser. The server decides what may happen; this only asks and
 * shows. `enabled` keeps it from connecting until the Laser tab is first opened.
 */
export function useLaser(enabled: boolean) {
  const [online, setOnline] = useState(false);
  const [state, setState] = useState<LaserState | null>(null);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [role, setRole] = useState<{ mode: 'pin' | 'open' | 'setup'; operator: boolean; peer: 'local' | 'lan' | 'outside' } | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => { setOnline(true); sock.send(JSON.stringify({ type: 'listPorts' } satisfies ClientMessage)); };
      sock.onmessage = (e) => {
        let m: ServerMessage;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'state') setState(m.data);
        else if (m.type === 'ports') setPorts(m.data);
        else if (m.type === 'log') setLog((l) => [...l.slice(-199), m.data]);
        else if (m.type === 'logs') setLog(m.data);
        else if (m.type === 'notice') setNotice({ ...m.data, at: Date.now() });
        else if (m.type === 'role') setRole(m.data);
        else if (m.type === 'denied') setNotice({ ok: false, message: m.data.message, at: Date.now() });
      };
      sock.onclose = () => {
        setOnline(false);
        setState(null);
        if (!closed) retry.current = setTimeout(open, 2000);
      };
      sock.onerror = () => sock.close();
    };
    open();
    return () => { closed = true; clearTimeout(retry.current); ws.current?.close(); };
  }, [enabled]);

  const send = useCallback((m: ClientMessage): boolean => {
    if (ws.current?.readyState !== WebSocket.OPEN) { setNotice({ ok: false, message: 'Not connected to the DemonX Design server', at: Date.now() }); return false; }
    ws.current.send(JSON.stringify(m));
    return true;
  }, []);

  return { online, state, ports, log, notice, role, send, clearNotice: () => setNotice(null) };
}

export type Laser = ReturnType<typeof useLaser>;
