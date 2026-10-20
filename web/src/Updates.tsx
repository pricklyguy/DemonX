import { useEffect, useRef, useState } from 'react';
import type { UpdateChannel, UpdateInfo } from '../../shared/updates';
import type { Machine } from './useMachine';
import { useSettings } from './settingsContext';

// The update notice: a badge in the header when a newer release exists (and was not skipped), and Settings > Updates, which
// always shows it. DemonX only reads the list of releases on GitHub. Nothing is downloaded or run, and the notes are
// text from the internet, so they are shown as plain text and the release page is only ever a link.

const HOW: Record<UpdateInfo['install'], string> = {
  git: 'On the computer that runs DemonX, open a terminal in the DemonX folder and run: bash scripts/update.sh (it fetches the latest code, rebuilds and restarts DemonX under PM2). Your settings in data/ are kept.',
  windows: 'Download the Windows zip from the release page and extract it over the DemonX folder (your settings and PIN in data\\ are kept), then start DemonX again.',
  docker: 'Get the new release from the release page, rebuild the image and recreate the container. Keep the data folder, which holds your settings.',
  other: 'Follow the install guide for your system (see the README), using the release linked here.',
};

const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : 'never');
const CHANNELS: { id: UpdateChannel; label: string }[] = [
  { id: 'auto', label: 'Automatic' }, { id: 'test', label: 'Test releases and stable' }, { id: 'stable', label: 'Stable releases only' },
];

/** Notes as text. React escapes it; the white-space style keeps the lines. */
function Notes({ text }: { text: string }) {
  return <pre className="relnotes" tabIndex={0} aria-label="Release notes">{text || 'This release has no notes.'}</pre>;
}

/**
 * Update now: installs the offered release on the DemonX computer and restarts DemonX. It only appears when the server says
 * it is available (turned on, git install run by PM2); the server checks everything again. Asks once before starting.
 */
function ApplyBox({ m }: { m: Machine }) {
  const u = m.update, a = u.apply, r = u.latest;
  const [sure, setSure] = useState(false);
  // a refusal comes back only to the browser that pressed the button: show it here, where it is looked for, until the next press
  const [asked, setAsked] = useState(m.replies.updateRefused?.n ?? 0);
  const refused = m.replies.updateRefused && m.replies.updateRefused.n > asked ? m.replies.updateRefused.data.message : '';
  const busy = a.state === 'running' || a.state === 'waiting';
  if (!r) return null;
  const can = m.auth.operator;
  return (
    <div className="applybox">
      {busy && <div role="status"><b>{a.step}</b><div className="muted small">The new screen is built aside, so reloading this page is safe: you keep the current screen until DemonX restarts. Jobs, probes and macros cannot be started meanwhile. DemonX restarts by itself when it is done, and this page reconnects.</div></div>}
      {a.state === 'done' && <div className="ok-line" role="status">{a.message}</div>}
      {refused && <div className="err" role="alert">{refused}</div>}
      {a.state === 'failed' && <div className="err" role="alert">{a.step ? `${a.step}: ` : ''}{a.message}</div>}
      {!busy && a.available && !sure && (
        <div className="row wrap">
          <button className="btn primary" disabled={!can || (a.state === 'done' && a.target === r.version)} title={can ? `Install ${r.version} on the DemonX computer and restart DemonX` : 'Sign in to update'} onClick={() => setSure(true)}>Update now</button>
          {!can && <span className="muted small">Sign in to update.</span>}
        </div>
      )}
      {!busy && a.available && sure && (
        <div className="warn-line" role="alertdialog" aria-label="Confirm update">
          Install {r.version} and restart DemonX? The machine must be idle: nothing running, no job, no probe. The screen reconnects by itself in a minute or two. Restarting closes the connection to the machine, and many GRBL boards reset when it reopens, so you may need to home again afterwards. If something fails, the version you have now is put back.
          <div className="row wrap">
            <button className="btn primary" onClick={() => { setSure(false); setAsked(m.replies.updateRefused?.n ?? 0); m.send({ type: 'updateApply', version: r.version }); }}>Yes, install and restart</button>
            <button className="btn" onClick={() => setSure(false)}>Not now</button>
          </div>
        </div>
      )}
      {!busy && !a.available && (u.install === 'git' || u.install === 'windows') && a.reason && <div className="muted small">Update now is not available: {a.reason}</div>}
    </div>
  );
}

/** The header badge. Everyone sees it; only a signed-in browser can skip. */
export function UpdateBadge({ m }: { m: Machine }) {
  const u = m.update;
  const [open, setOpen] = useState(false);
  if (!u.enabled || !u.newer || u.skipped || !u.latest) return null;
  return (
    <>
      <button className="btn updatebadge" onClick={() => setOpen(true)} title={`DemonX ${u.latest.version} is available (you have ${u.current})`} aria-label={`Update available: ${u.latest.version}`}>
        ⬆ {u.latest.version}
      </button>
      {open && <UpdateDialog m={m} onClose={() => setOpen(false)} />}
    </>
  );
}

function UpdateDialog({ m, onClose }: { m: Machine; onClose: () => void }) {
  const u = m.update, r = u.latest!;
  const settings = useSettings();
  // what to do by hand is written out (not hidden behind a button) unless Update now is working or is usable by this browser
  const manual = u.apply.state !== 'running' && u.apply.state !== 'waiting' && (!u.apply.available || !m.auth.operator);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog dlg-accent updatedlg" role="dialog" aria-modal="true" aria-label="Update available" onClick={(e) => e.stopPropagation()}>
        <div className="row"><div className="dlg-kind">Update available</div><div className="spacer" /><button className="btn small" onClick={onClose} aria-label="Close">✕</button></div>
        <div><b>DemonX {r.version}</b>{r.prerelease && <span className="duepill testpill">test release</span>}<div className="muted small">You have {u.current}{r.publishedAt ? ` · published ${new Date(r.publishedAt).toLocaleDateString()}` : ''}</div></div>
        <Notes text={r.notes} />
        {(u.install === 'git' || u.install === 'windows' || u.apply.state !== 'idle') && <ApplyBox m={m} />}   {/* where Update now exists it also says why it is not available */}
        {manual && <div className="muted small" role="note"><b>To update by hand:</b> {HOW[u.install]}</div>}
        <div className="row wrap">
          <a className="btn" href={u.url} target="_blank" rel="noopener noreferrer">Release page</a>
          <button className="btn" disabled={!m.auth.operator} title={m.auth.operator ? 'Stop showing this badge for this version. It stays in Settings > Updates.' : 'Sign in to skip a version'}
            onClick={() => { m.send({ type: 'updateSkip', version: r.version }); onClose(); }}>Skip this version</button>
          <div className="spacer" />
          <button className="btn small" onClick={() => { onClose(); settings.open('updates'); }}>Settings</button>
        </div>
      </div>
    </div>
  );
}

export function UpdatesPage({ m, onSaved }: { m: Machine; onSaved: () => void }) {
  const u = m.update, s = m.config.updates, can = m.auth.operator;
  const [error, setError] = useState('');
  const seen = useRef(m.replies.configResult?.n ?? 0);
  useEffect(() => {
    const r = m.replies.configResult;
    if (!r || r.n === seen.current) return;
    seen.current = r.n;
    if (r.data.ok) { setError(''); onSaved(); } else setError(r.data.message ?? 'Not saved');
  }, [m.replies.configResult, onSaved]);
  const set = (updates: Partial<typeof s>) => { setError(''); m.send({ type: 'configSet', update: { updates } }); };
  const r = u.latest;
  const status = !u.enabled ? 'Checking is turned off.'
    : !r ? (u.checkedAt ? 'No release found for the kind you follow.' : 'Not checked yet.')
    : u.newer ? (u.skipped ? `${r.version} is available (you skipped it).` : `${r.version} is available.`)
    : 'You are up to date.';

  return (
    <div className="camform">
      <div className="muted small">DemonX looks for a newer release on GitHub when it starts and about once a day. That check is the only thing DemonX sends to the internet by itself, and it sends nothing about you or your machine. It reads the list of releases and never downloads or runs anything. Kept on the DemonX computer, so every browser shows the same.</div>

      <div className="statgrid">
        <div><b>{u.current || '?'}</b><span className="muted small">your version</span></div>
        <div><b>{u.enabled && r ? r.version : '–'}</b><span className="muted small">newest version</span></div>
        <div><b className="small">{when(u.checkedAt)}</b><span className="muted small">last checked</span></div>
      </div>
      <div className={u.newer && u.enabled ? 'warn-line' : 'ok-line'} role="status">{status}</div>
      {u.error && <div className="muted small">The last try failed: {u.error}. {u.checkedAt ? 'The last good answer is kept.' : ''}</div>}
      <div className="row wrap">
        <button className="btn small primary" disabled={!can || !u.enabled || u.checking} title={can ? 'Ask GitHub now' : 'Sign in to check now'} onClick={() => m.send({ type: 'updateCheck' })}>{u.checking ? 'Checking…' : 'Check now'}</button>
        {u.enabled && u.newer && u.url && <>
          <a className="btn small" href={u.url} target="_blank" rel="noopener noreferrer">Release page</a>
          {u.skipped
            ? <button className="btn small" disabled={!can} onClick={() => set({ skipped: '' })}>Stop skipping {r?.version}</button>
            : <button className="btn small" disabled={!can} onClick={() => m.send({ type: 'updateSkip', version: r!.version })}>Skip this version</button>}
        </>}
      </div>
      {u.enabled && u.newer && !u.apply.available && u.apply.state === 'idle' && <div className="muted small" role="note"><b>To update by hand:</b> {HOW[u.install]}</div>}
      {u.enabled && r && (<>
        <div className="menu-h">Release notes for {r.version}{r.prerelease && <span className="duepill testpill">test release</span>}</div>
        <Notes text={r.notes} />
      </>)}
      {u.apply.state !== 'idle' ? <ApplyBox m={m} /> : u.enabled && u.newer && u.apply.available && <ApplyBox m={m} />}   {/* the outcome stays visible after the restart, when nothing is newer any more */}

      <div className="menu-h">Settings</div>
      <label className="chk"><input type="checkbox" checked={s.check} disabled={!can} onChange={(e) => set({ check: e.target.checked })} />Look for new versions on GitHub</label>
      <div className="menu-h">Which versions to follow</div>
      {CHANNELS.map((c) => (
        <label key={c.id} className="chk"><input type="radio" name="channel" checked={s.channel === c.id} disabled={!can || !s.check} onChange={() => set({ channel: c.id })} />{c.label}</label>
      ))}
      <div className="muted small">Automatic follows test releases while the version you run is a test release, and stable releases only otherwise.</div>
      {(u.install === 'git' || u.install === 'windows') && (<>
        <div className="menu-h">Update now</div>
        <label className="chk"><input type="checkbox" checked={s.apply} disabled={!can} onChange={(e) => set({ apply: e.target.checked })} />Allow Update now on this page</label>
        <div className="muted small">{u.install === 'windows'
          ? "When on, a signed-in browser can install the release shown here: DemonX downloads that release's Windows zip from the DemonX repository on GitHub, checks it against the checksum published with it, unpacks it beside the version you run, and restarts itself into the new one, but only when the machine is idle. Your settings stay where they are, and the version you had is kept: if the new one will not start, it is put back by itself. It needs DemonX to have been started with Start DemonX.bat. It has not been tried on real hardware, so it is off until you turn it on."
          : 'When on, a signed-in browser can install the release shown here: DemonX fetches that release from the DemonX repository on GitHub, runs npm install and npm run build in its folder, and asks PM2 to restart it, but only when the machine is idle. If a step fails, the version you have is put back. It needs a git install that PM2 runs (bash scripts/update.sh sets that up). It has not been tried on real hardware, so it is off until you turn it on.'}{!u.apply.available && u.apply.reason ? ` Right now: ${u.apply.reason}` : ''}</div>
      </>)}
      {s.skipped && <div className="row wrap"><span className="muted small">Skipped version: {s.skipped}</span><button className="btn small" disabled={!can} onClick={() => set({ skipped: '' })}>Stop skipping</button></div>}
      {!can && <div className="warn-line">Sign in (the bar at the top of the page) to check now, skip a version or change these.</div>}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
