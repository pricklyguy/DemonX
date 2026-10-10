import type { PadState } from './gamepad';
import { SPEED_MAX, SPEED_MIN, SPEED_STEP } from '../../shared/gamepad';

// Settings > Gamepad (this browser only)

export function GamepadPage({ pad }: { pad: PadState }) {
  return (
    <div className="camform">
      <div className="muted small">Jog the machine with a game controller plugged into this computer or phone. It only works in this browser, and only while the page is in front.</div>
      {!pad.supported && <div className="err">This browser does not support game controllers.</div>}
      <label className="chk"><input type="checkbox" checked={pad.enabled} disabled={!pad.supported} onChange={(e) => pad.setEnabled(e.target.checked)} />Use a gamepad in this browser</label>
      {pad.enabled && (
        <div className="muted small">
          {pad.name ? <>Found: <b>{pad.name}</b>. {pad.armed ? 'Armed: the sticks move the machine.' : 'Not armed yet: press Start with both sticks centred.'}</> : 'No controller seen yet. Plug one in and press any button on it.'}
        </div>
      )}

      <div className="menu-h">Speed</div>
      <div className="row">
        <input type="range" min={SPEED_MIN} max={SPEED_MAX} step={SPEED_STEP} value={pad.speed} onChange={(e) => pad.setSpeed(Number(e.target.value))} aria-label="Gamepad speed" />
        <b style={{ minWidth: '3.5em' }}>{pad.speed}%</b>
      </div>
      <div className="muted small">Full push on a stick moves at this share of the XY and Z feeds set in the Jog panel. A gentle push moves slower.</div>

      <div className="menu-h">Controls</div>
      <table className="ext">
        <tbody>
          <tr><td><b>Start</b></td><td>Arm. Nothing moves until you press it, and both sticks must be in the middle</td></tr>
          <tr><td><b>Left stick</b></td><td>X and Y (up is Y+)</td></tr>
          <tr><td><b>Right stick</b></td><td>Z (up is Z+)</td></tr>
          <tr><td><b>LB / RB</b></td><td>Slower / faster</td></tr>
          <tr><td><b>B</b></td><td>Stop: stops the jog, feed hold, disarm</td></tr>
          <tr><td><b>Back</b></td><td>Disarm</td></tr>
        </tbody>
      </table>

      <div className="menu-h">Safety</div>
      <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
        <li>The machine moves only while a stick is pushed. Let go and it stops.</li>
        <li>It disarms by itself when the page loses focus, the controller is unplugged, the connection drops, a job starts, or the machine alarms.</li>
        <li>If DemonX stops hearing from this browser for a moment, it stops the machine.</li>
        <li>One hold lasts at most 30 seconds, and Z moves at most 20 mm per hold. Let go and push again to continue.</li>
        <li>You must be signed in (PIN) like for any other control.</li>
      </ul>
      <div className="muted small">Controllers that the browser reports as a "standard" gamepad (Xbox style, PlayStation, most USB pads) should work. Tell us which one you use and how it went.</div>
    </div>
  );
}
