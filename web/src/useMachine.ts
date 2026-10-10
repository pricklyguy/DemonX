import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CameraState, ClientMessage, Macro, Snapshot, ConnectionInfo, HaCamera, HeightMap, HeightMapSummary, JobInfo, LogLine, MachineStatus, PortInfo, ProbeInfo, PublicConfig, ServerMessage, StatsInfo,
} from '../../shared/protocol';
import type { MachineSettings } from '../../shared/machine-settings';
import { emptyJob, emptyProbe, emptyPublicConfig, emptyStats, emptyStatus } from '../../shared/protocol';

export interface Replies {
  haCameras?: { n: number; data: { cameras: HaCamera[] } | { error: string } };
  cameraTest?: { n: number; data: { ok: boolean; message: string; image?: string } };
  mqttResult?: { n: number; data: { ok: boolean; message: string } };
  haShareResult?: { n: number; data: { ok: boolean; message: string } };
  configResult?: { n: number; data: { ok: boolean; message?: string } };
  macroResult?: { n: number; data: { ok: boolean; message?: string } };
  statsResult?: { n: number; data: { ok: boolean; message?: string } };
  machineSettings?: { n: number; data: MachineSettings };
  machineSettingsResult?: { n: number; data: { ok: boolean; message: string } };
}

export interface Machine {
  online: boolean; // websocket to server is up
  connection: ConnectionInfo;
  status: MachineStatus;
  job: JobInfo;
  probe: ProbeInfo;
  heightmap: HeightMap | null;
  heightmapSaved: HeightMapSummary | null;
  config: PublicConfig;
  camera: CameraState;
  macros: Macro[];
  stats: StatsInfo;
  /** Answers to one-off requests (camera list, test, save). `n` changes with every new answer. */
  replies: Replies;
  clients: number;
  log: LogLine[];
  ports: PortInfo[];
  /** required: the machine has a PIN. operator: this browser may control it. */
  auth: Snapshot['auth'];
  /** Addresses other devices can open DemonX at */
  addresses: string[];
  send: (m: ClientMessage) => void;
}

export function useMachine(): Machine {
  const [online, setOnline] = useState(false);
  const [connection, setConnection] = useState<ConnectionInfo>({ connected: false, target: '' });
  const [status, setStatus] = useState<MachineStatus>(emptyStatus());
  const [job, setJob] = useState<JobInfo>(emptyJob());
  const [probe, setProbe] = useState<ProbeInfo>(emptyProbe());
  const [heightmap, setHeightmap] = useState<HeightMap | null>(null);
  const [heightmapSaved, setHeightmapSaved] = useState<HeightMapSummary | null>(null);
  const [config, setConfig] = useState<PublicConfig>(emptyPublicConfig());
  const [camera, setCamera] = useState<CameraState>({ running: false, viewers: 0, fps: 0 });
  const [macros, setMacros] = useState<Macro[]>([]);
  const [stats, setStats] = useState<StatsInfo>(emptyStats());
  const [replies, setReplies] = useState<Replies>({});
  const [clients, setClients] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [auth, setAuth] = useState<Snapshot['auth']>({ required: false, operator: true, local: false, mode: 'open', peer: 'lan' });
  const [addresses, setAddresses] = useState<string[]>([]);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => { setOnline(true); sock.send(JSON.stringify({ type: 'listPorts' })); };
      sock.onclose = () => {
        setOnline(false);
        if (!closed) retry = window.setTimeout(open, 1500);
      };
      sock.onmessage = (ev) => {
        const m: ServerMessage = JSON.parse(ev.data);
        switch (m.type) {
          case 'snapshot':
            setConnection(m.data.connection); setStatus(m.data.status); setJob(m.data.job); setProbe(m.data.probe); setHeightmap(m.data.heightmap); setHeightmapSaved(m.data.heightmapSaved); setConfig(m.data.config); setCamera(m.data.camera); setMacros(m.data.macros); setStats(m.data.stats ?? emptyStats());
            setClients(m.data.clients); setLog(m.data.log); setAuth(m.data.auth); setAddresses(m.data.addresses ?? []); break;
          case 'status': setStatus(m.data); break;
          case 'job': setJob(m.data); break;
          case 'probe': setProbe(m.data); break;
          case 'heightmap': setHeightmap(m.data); break;
          case 'heightmapSaved': setHeightmapSaved(m.data); break;
          case 'config': setConfig(m.data); break;
          case 'camera': setCamera(m.data); break;
          case 'macros': setMacros(m.data); break;
          case 'stats': setStats(m.data); break;
          case 'haCameras': case 'haShareResult': case 'mqttResult': case 'cameraTest': case 'configResult': case 'macroResult': case 'statsResult': case 'machineSettings': case 'machineSettingsResult':
            setReplies((r) => ({ ...r, [m.type]: { n: (r[m.type]?.n ?? 0) + 1, data: m.data } }));
            break;
          case 'connection': setConnection(m.data); break;
          case 'clients': setClients(m.data); break;
          case 'log': setLog((l) => [...l.slice(-299), m.data]); break;
          case 'ports': setPorts(m.data); break;
          case 'denied': setLog((l) => [...l.slice(-299), { t: Date.now(), kind: 'err', text: m.data.message }]); break;
        }
      };
    };
    open();
    return () => { closed = true; window.clearTimeout(retry); ws.current?.close(); };
  }, []);

  const send = useCallback((m: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  }, []);

  return { online, connection, status, job, probe, heightmap, heightmapSaved, config, camera, macros, stats, replies, clients, log, ports, auth, addresses, send };
}
