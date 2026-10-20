import { useEffect, useRef, useState } from 'react';
import { NumInput, useUnits } from './units';
import type { Machine } from './useMachine';

// Settings > Machine size: how big the machine is, for the 3D view. DemonX reads it from the controller after connecting
// (GRBL's $130 to $132 and $23, or FluidNC's axes max_travel_mm and homing). This page shows what it found, and lets a
// machine that does not say (or says wrongly) be described by hand.

const AXES = ['x', 'y', 'z'] as const;
// Where the machine goes when it is homed, in words. This assumes the usual directions: X grows to the right, Y grows away from you
// (towards the back), Z grows upwards. Homing at the right, the back or the top puts machine zero at the far (positive) end of that
// axis, so positions run from minus the travel up to 0 (the usual GRBL setup); at the left, the front or the bottom they run from 0 up.
const HOME: Record<typeof AXES[number], { atMax: string; atMin: string; label: string }> = {
  x: { atMax: 'Right', atMin: 'Left', label: 'X (left to right)' },
  y: { atMax: 'Back', atMin: 'Front', label: 'Y (front to back)' },
  z: { atMax: 'Top', atMin: 'Bottom', label: 'Z (up and down)' },
};

export function MachineSizePage({ m, onSaved }: { m: Machine; onSaved: () => void }) {
  const u = useUnits();
  const saved = m.config.machine.bed;
  const [on, setOn] = useState(saved.enabled);
  const [t, setT] = useState({ x: saved.x, y: saved.y, z: saved.z });
  const [far, setFar] = useState({ ...saved.zeroAtMax });
  const [err, setErr] = useState('');
  const seen = useRef(m.replies.configResult?.n ?? 0);
  const r = m.replies.configResult;
  useEffect(() => {
    if (!r || r.n === seen.current) return;
    seen.current = r.n;
    if (r.data.ok) onSaved(); else setErr(r.data.message ?? 'Not saved');
  }, [r]); // eslint-disable-line react-hooks/exhaustive-deps

  const b = m.bed;
  const found = b && b.source !== 'manual'
    ? `Read from the controller (${b.source === 'fluidnc' ? 'FluidNC' : 'GRBL'}): X ${u.len(b.maxX - b.minX, 0)}, Y ${u.len(b.maxY - b.minY, 0)}${b.maxZ - b.minZ > 0 ? `, Z ${u.len(b.maxZ - b.minZ, 0)}` : ''} ${u.lenUnit}.`
    : m.connection.connected ? 'The controller has not told DemonX its size (yet).' : 'Connect to the machine and DemonX reads its size.';

  return (
    <div className="camform">
      <div className="muted small">
        The 3D view shows the whole machine until a G-code file is loaded, then zooms to the file. DemonX reads the machine's size from the controller a few seconds after connecting.
        Use the numbers below only if the controller does not report them, or reports them wrongly.
      </div>
      <div className="small">{found}</div>
      <div className="row wrap">
        <button type="button" className="btn small" disabled={!m.connection.connected} title="Ask the controller for its size again (it is also read a few seconds after connecting)" onClick={() => m.send({ type: 'bedRead' })}>Read again</button>
        <span className="muted small">If nothing is found, the Console says why.</span>
      </div>

      <label className="chk"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />Use my own numbers instead</label>
      {on && (
        <>
          {AXES.map((a) => (
            <label key={a}><span>{HOME[a].label} travel</span>
              <NumInput mm={t[a]} onMm={(v) => setT((s) => ({ ...s, [a]: v }))} kind="len" /><span className="muted small">{u.lenUnit}</span>
            </label>
          ))}
          <div className="muted small">Where does the machine go when you home it?</div>
          {AXES.map((a) => (
            <label key={`${a}-home`}><span>{a.toUpperCase()} homes at the</span>
              <select value={far[a] ? 'max' : 'min'} aria-label={`${a.toUpperCase()} home`} onChange={(e) => setFar((s) => ({ ...s, [a]: e.target.value === 'max' }))}>
                <option value="max">{HOME[a].atMax}</option>
                <option value="min">{HOME[a].atMin}</option>
              </select>
            </label>
          ))}
          <div className="muted small">
            Most hobby machines home at the <b>front left</b> and the <b>top</b>: choose Left, Front and Top. A machine that homes at the back right chooses Right, Back and Top, which is also what GRBL does unless it was changed. Z can be left at 0 if you do not know it.
          </div>
        </>
      )}
      {err && <div className="err">{err}</div>}
      <div className="row wrap">
        <button className="btn small primary" onClick={() => { setErr(''); m.send({ type: 'configSet', update: { machine: { bed: { enabled: on, x: t.x, y: t.y, z: t.z, zeroAtMax: far } } } }); }}>Save</button>
        <span className="muted small">Saved on the machine: every browser uses it.</span>
      </div>
    </div>
  );
}
