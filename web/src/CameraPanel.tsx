import { useEffect, useRef, useState } from 'react';
import type { CameraSource, ConfigUpdate } from '../../shared/protocol';
import { Panel } from './Dock';
import type { Machine } from './useMachine';
import { useSettings } from './settingsContext';

const TYPES: { id: CameraSource; label: string; hint: string }[] = [
  { id: 'none', label: 'No camera', hint: '' },
  { id: 'ha', label: 'Home Assistant camera', hint: 'Pick any camera that Home Assistant already has. DemonX asks Home Assistant for pictures, so the camera needs no login of its own.' },
  { id: 'hastream', label: 'Home Assistant camera (smooth video)', hint: 'The same live video as the Home Assistant dashboard, so it looks smooth. A few seconds behind real time. The camera must have streaming working in Home Assistant.' },
  { id: 'reolink', label: 'Reolink camera or NVR', hint: 'Enter the address of the camera, or of the NVR and the channel number. No web addresses to build.' },
  { id: 'http', label: 'Web camera address (MJPEG or picture)', hint: 'The address of a camera that serves a video stream (MJPEG) or a single picture that refreshes. DemonX works out which.' },
  { id: 'rtsp', label: 'RTSP stream (needs ffmpeg)', hint: 'For cameras that only offer RTSP. The computer running DemonX needs ffmpeg installed.' },
  { id: 'direct', label: 'Direct: this browser connects itself', hint: 'The camera address is opened by your own browser, not by DemonX. It only works for browsers that can reach the camera, and only for http (not https) pages and cameras.' },
];

/** The newest answer to a request, ignoring answers that were already there when the form opened. */
function useReply<T>(reply: { n: number; data: T } | undefined): T | undefined {
  const first = useRef(reply?.n ?? 0);
  return reply && reply.n !== first.current ? reply.data : undefined;
}

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

/**
 * The live picture. Removing an <img> does not make the browser hang up an MJPEG stream (it can keep
 * pulling video from the server until the page is closed), so point it at a blank image first: that
 * is what really ends the connection, and lets the server stop the camera when nobody is watching.
 */
function LiveImage({ src, onError }: { src: string; onError: () => void }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = ref.current;
    return () => { if (el) el.src = BLANK; };
  }, []);
  return <img ref={ref} alt="Camera" src={src} onError={onError} />;
}

/** Home Assistant's live video (HLS), played by the browser itself so it is as smooth as HA's own dashboard */
function HlsVideo({ onError }: { onError: (message: string) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [info, setInfo] = useState('Asking Home Assistant for the stream…');
  useEffect(() => {
    const v = ref.current!;
    let dead = false;
    let hls: { destroy(): void } | undefined;
    const say = (t: string) => { if (!dead) setInfo(t); };
    const onPlaying = () => say('');
    v.addEventListener('playing', onPlaying);
    (async () => {
      try {
        const r = await fetch('/api/camera/hls-start');
        if (!r.ok) throw new Error(await r.text());
        const { src } = await r.json() as { src: string };
        say('Waiting for video from Home Assistant…');
        const { default: Hls } = await import('hls.js');
        if (dead) return;
        if (Hls.isSupported()) {
          const h = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, maxBufferLength: 6 });
          hls = h;
          let recovered = 0, looked = false, pinned = false;
          const note = (t: string) => { if (!pinned) say(t); };
          h.on(Hls.Events.MANIFEST_PARSED, (_e, d) => say(`Stream found (${d.levels.map((l) => `${l.width}x${l.height} ${l.videoCodec ?? '?'}`).join(', ')}); loading…`));
          h.on(Hls.Events.ERROR, (_e, d) => {
            if (d.details === 'manifestParsingError' && !looked) {
              // say what actually came back, since "could not parse" alone does not tell what was wrong
              looked = true;
              fetch(src).then(async (r) => { pinned = true; say(`The stream list could not be read. Answer: ${r.status} ${r.headers.get('content-type') ?? ''} "${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}"`); }).catch(() => undefined);
            }
            if (!d.fatal) { if (d.details) note(`Trouble with the stream (${d.details}); retrying…`); return; }
            if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { note(`Network trouble (${d.details}); retrying…`); h.startLoad(); }
            else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recovered++ < 2) { note(`Video problem (${d.details}); retrying…`); h.recoverMediaError(); }
            else onError(`This browser could not play the video (${d.details}). If the camera sends H.265, try its Fluent (sub) stream, which is usually H.264.`);
          });
          h.loadSource(src);
          h.attachMedia(v);
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = src; // Safari
        else throw new Error('This browser cannot play the video.');
        void v.play().catch(() => { /* muted autoplay is allowed; ignore the rest */ });
      } catch (e) { if (!dead) onError((e as Error).message); }
    })();
    return () => { dead = true; v.removeEventListener('playing', onPlaying); hls?.destroy(); v.removeAttribute('src'); v.load(); };
  }, []);
  return <><video ref={ref} muted playsInline autoPlay />{info && <div className="cam-msg muted small">{info}</div>}</>;
}

export function CameraPanel({ m }: { m: Machine }) {
  return (
    <Panel id="camera" title="Camera">
      <Camera m={m} />
    </Panel>
  );
}

function Camera({ m }: { m: Machine }) {
  const cfg = m.config.camera;
  const direct = cfg.source === 'direct';
  const ha = cfg.source === 'hastream';
  const [watching, setWatching] = useState(false);
  const [nonce, setNonce] = useState(0);
  const settings = useSettings();
  const [problem, setProblem] = useState('');
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem('demonx.cameraAuto') === '1'; } catch { return false; } });
  const autoDone = useRef(false);

  const start = () => { setProblem(''); setNonce((n) => n + 1); setWatching(true); };
  const stop = () => setWatching(false);

  // "start when this page opens", once the setup has arrived from the server
  useEffect(() => {
    if (auto && !autoDone.current && cfg.source !== 'none') { autoDone.current = true; start(); }
  }, [auto, cfg.source]);

  const toggleAuto = (on: boolean) => {
    setAuto(on);
    try { localStorage.setItem('demonx.cameraAuto', on ? '1' : '0'); } catch { /* not saved in private mode */ }
  };

  /** An <img> cannot say why it failed, so ask the server what it would have said. */
  const explain = async () => {
    const ac = new AbortController();
    try {
      const r = await fetch('/api/camera/stream', { signal: ac.signal });
      if (r.ok) { ac.abort(); setProblem('The picture stopped. Check the camera in Setup.'); } else setProblem(await r.text());
    } catch { setProblem('Could not reach DemonX.'); }
  };

  const k = m.camera;
  const status = cfg.source === 'none' ? 'Not set up'
    : direct ? (watching ? 'Direct from the camera' : 'Stopped')
    : ha ? (watching ? (problem ? 'Stopped' : 'Streaming from Home Assistant') : 'Stopped')
    : k.error ? k.error
    : k.running ? `Streaming · ${k.fps.toFixed(1)} fps · ${k.viewers} viewer${k.viewers === 1 ? '' : 's'}`
    : 'Stopped';
  const bad = !direct && !ha && !!k.error && cfg.source !== 'none';

  return (
    <div className="cam">
      <div className="row wrap cam-bar">
        {watching
          ? <button className="btn small danger" onClick={stop}>■ Stop</button>
          : <button className="btn small primary" disabled={cfg.source === 'none'} onClick={start}>▶ Start camera</button>}
        <button className="btn small" title="Camera settings" onClick={() => settings.open('camera')}>⚙ Setup</button>
        <label className="muted small chk" title="Only this browser: other computers keep their own choice">
          <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />Start when this page opens
        </label>
      </div>
      <div className={`small ${bad ? 'warn-line' : 'muted'}`}>{status}{!watching && !direct && !ha && k.viewers > 0 ? ` · ${k.viewers} watching elsewhere` : ''}</div>

      {(
        <div className="cam-view">
          {watching && ha && !problem && <HlsVideo key={nonce} onError={setProblem} />}
          {watching && cfg.source !== 'none' && !ha && !problem && (
            <LiveImage key={nonce} src={direct ? cfg.url : `/api/camera/stream?c=${nonce}`} onError={() => { if (direct) setProblem('Your browser could not load that address.'); else void explain(); }} />
          )}
          {problem && <div className="cam-msg"><span className="warn-line">{problem}</span><button className="btn small" onClick={start}>Try again</button></div>}
          {!watching && !problem && (
            <div className="cam-msg muted">
              {cfg.source === 'none' ? 'No camera is set up yet. Open Setup to add one.' : 'The camera is stopped. Press Start camera to watch.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The camera form. Lives in Settings; Home Assistant's own address and token are on the Home Assistant page. */
export function CameraSetup({ m, onClose, onSaved, onGoHa }: { m: Machine; onClose: () => void; onSaved: () => void; onGoHa: () => void }) {
  const c = m.config.camera, ha = m.config.homeAssistant;
  const [d, setD] = useState({
    source: c.source, haEntity: c.haEntity, url: c.url, host: c.host, channel: c.channel,
    scheme: c.scheme, mode: c.mode, quality: c.quality, user: c.user, fps: c.fps, insecure: c.insecureTls,
  });
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const set = <K extends keyof typeof d>(key: K, v: (typeof d)[K]) => setD((x) => ({ ...x, [key]: v }));

  const list = useReply(m.replies.haCameras);
  const test = useReply(m.replies.cameraTest);
  const saved = useReply(m.replies.configResult);
  useEffect(() => { if (list) setLoading(false); }, [list]);
  useEffect(() => { if (test) setTesting(false); }, [test]);
  useEffect(() => {
    if (!saved) return;
    if (saved.ok) onSaved(); else setSaveError(saved.message ?? 'Not saved');
  }, [saved]);

  /** What the form says, as a change. Secrets are only included when typed or cleared on purpose. */
  const update = (): ConfigUpdate => ({
    camera: {
      source: d.source, haEntity: d.haEntity, url: d.url, host: d.host, channel: Number(d.channel), scheme: d.scheme,
      mode: d.mode, quality: d.quality, user: d.user, fps: Number(d.fps), insecureTls: d.insecure,
      ...(password ? { password } : clearPassword ? { password: '' } : {}),
    },
  });

  const type = TYPES.find((t) => t.id === d.source)!;
  const haReady = !!ha.url && ha.hasToken;
  const hasPassword = c.hasPassword && !clearPassword;
  const savedNote = <span className="muted small"> (saved)</span>;

  const secret = (label: string, value: string, setValue: (v: string) => void, has: boolean, clear: () => void) => (
    <label>
      <span>{label}{has && !value && savedNote}</span>
      <input type="password" autoComplete="new-password" value={value} placeholder={has ? 'leave empty to keep' : ''} onChange={(e) => setValue(e.target.value)} />
      {has && !value ? <button type="button" className="btn small" onClick={clear}>Remove</button> : <span />}
    </label>
  );

  return (
    <div className="camform">
      <label>
        <span>Camera type</span>
        <select value={d.source} onChange={(e) => set('source', e.target.value as CameraSource)}>
          {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <span />
      </label>
      {type.hint && <div className="muted small">{type.hint}</div>}

      {(d.source === 'ha' || d.source === 'hastream') && (
        <>
          {!haReady && (
            <div className="warn-line">Home Assistant is not set up yet. <button type="button" className="btn small" onClick={onGoHa}>Set up Home Assistant</button></div>
          )}
          <label>
            <span>Camera</span>
            <input list="ha-cams" value={d.haEntity} placeholder="camera.workshop_cnc" onChange={(e) => set('haEntity', e.target.value.trim())} />
            <button type="button" className="btn small" disabled={loading || !haReady} onClick={() => { setLoading(true); m.send({ type: 'haCameras' }); }}>{loading ? '…' : 'Load list'}</button>
          </label>
          <datalist id="ha-cams">{list && 'cameras' in list && list.cameras.map((x) => <option key={x.entity_id} value={x.entity_id}>{x.name}</option>)}</datalist>
          {list && 'error' in list && <div className="warn-line">{list.error}</div>}
          {list && 'cameras' in list && <div className="muted small">{list.cameras.length} camera{list.cameras.length === 1 ? '' : 's'} found: click the Camera box and pick one.</div>}
        </>
      )}

      {d.source === 'reolink' && (
        <>
          <label><span>Camera or NVR address</span><input value={d.host} placeholder="10.20.30.98" onChange={(e) => set('host', e.target.value)} /><span /></label>
          <label><span>Channel</span><input type="number" min={1} max={64} value={d.channel} onChange={(e) => set('channel', Number(e.target.value))} /><span className="muted small">1 for a single camera; on an NVR, the camera number</span></label>
          <label><span>User name</span><input value={d.user} autoComplete="off" onChange={(e) => set('user', e.target.value)} /><span /></label>
          {secret('Password', password, setPassword, hasPassword, () => setClearPassword(true))}
          <label>
            <span>Picture source</span>
            <select value={d.mode} onChange={(e) => set('mode', e.target.value as 'snapshot' | 'rtsp')}>
              <option value="snapshot">Snapshots (works everywhere)</option>
              <option value="rtsp">Smooth video (needs ffmpeg)</option>
            </select><span />
          </label>
          {d.mode === 'rtsp'
            ? <label><span>Quality</span><select value={d.quality} onChange={(e) => set('quality', e.target.value as 'main' | 'sub')}><option value="sub">Fluent (light)</option><option value="main">Clear (heavy)</option></select><span /></label>
            : <label><span>Connection</span><select value={d.scheme} onChange={(e) => set('scheme', e.target.value as 'https' | 'http')}><option value="https">https</option><option value="http">http</option></select><span /></label>}
          {d.mode === 'snapshot' && <label className="chk"><input type="checkbox" checked={d.insecure} onChange={(e) => set('insecure', e.target.checked)} />Accept a self-signed certificate (Reolink devices use one)</label>}
        </>
      )}

      {(d.source === 'http' || d.source === 'rtsp' || d.source === 'direct') && (
        <label><span>Address</span><input value={d.url} placeholder={d.source === 'rtsp' ? 'rtsp://10.0.0.5:554/stream1' : 'http://10.0.0.5/video.mjpg'} onChange={(e) => set('url', e.target.value)} /><span /></label>
      )}
      {(d.source === 'http' || d.source === 'rtsp') && (
        <>
          <label><span>User name (if any)</span><input value={d.user} autoComplete="off" onChange={(e) => set('user', e.target.value)} /><span /></label>
          {secret('Password', password, setPassword, hasPassword, () => setClearPassword(true))}
        </>
      )}
      {d.source === 'http' && <label className="chk"><input type="checkbox" checked={d.insecure} onChange={(e) => set('insecure', e.target.checked)} />Accept a self-signed certificate</label>}

      {d.source !== 'none' && d.source !== 'direct' && d.source !== 'hastream' && (
        <label><span>Frames per second</span><input type="number" min={1} max={30} value={d.fps} onChange={(e) => set('fps', Number(e.target.value))} /><span className="muted small">RTSP video: 10 to 15 looks smooth; snapshots: 3 to 5</span></label>
      )}

      {test && (
        <div className="camtest">
          <div className={test.ok ? 'ok-line' : 'warn-line'}>{test.ok ? '✓ ' : '⚠ '}{test.message}</div>
          {test.image && <img alt="Test picture" src={test.image} />}
        </div>
      )}
      {saveError && <div className="err">{saveError}</div>}
      <div className="row wrap">
        <button className="btn small" disabled={testing || d.source === 'none' || d.source === 'direct'} onClick={() => { setTesting(true); m.send({ type: 'cameraTest', update: update() }); }}>{testing ? 'Testing…' : 'Test'}</button>
        <button className="btn small primary" onClick={() => { setSaveError(''); m.send({ type: 'configSet', update: update() }); }}>Save</button>
        <button className="btn small" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
