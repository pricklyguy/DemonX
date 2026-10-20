import { useState } from 'react';
import { setTouchHold, touchHoldOn } from './holdJog';

// Settings > Jog buttons (this browser only)

export function JogButtonsPage() {
  const [touch, setTouch] = useState(touchHoldOn);
  return (
    <div className="camform">
      <div className="muted small">How the buttons in the Jog panel behave in this browser. A quick tap is always one step. Holding a button with the mouse (or a pen) keeps the machine moving until you let go.</div>

      <div className="menu-h">Touch screens</div>
      <label className="chk"><input type="checkbox" checked={touch} onChange={(e) => { setTouchHold(e.target.checked); setTouch(e.target.checked); }} />Holding a finger on a button keeps the machine moving</label>
      <div className="muted small">
        Off by default. How well this works depends a great deal on the touch screen and the computer: on an older computer or a cheap touch panel the machine can move in short jerks while you hold, and it may take a few tries to settle. It is safe either way (the machine stops when you lift your finger), but it may not feel smooth. With this off, touching a button for any length of time is one step. The mouse and the keyboard shortcuts are not affected.
      </div>
    </div>
  );
}
