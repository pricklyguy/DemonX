import { useEffect, useState } from 'react';

/**
 * A number box that commits on Enter or when it loses focus, and lets go of focus when the wheel turns (the wheel
 * scrolls the page, it never edits). Bad or out-of-range text snaps back to the last good value.
 * `resetOnCommit` is for "do this much now" boxes such as Rotate: the box goes back to its value after each use.
 */
export function NumField({ value, onCommit, min, max, step, width, disabled, label, resetOnCommit, decimals = 3 }: {
  value: number | null;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  disabled?: boolean;
  label?: string;
  resetOnCommit?: boolean;
  /** How many decimals are shown (and so kept when the box is left) */
  decimals?: number;
}) {
  const show = (v: number | null) => (v === null ? '' : String(Math.round(v * 10 ** decimals) / 10 ** decimals));
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]);
  const commit = () => {
    if (!resetOnCommit && text === show(value)) return;   // left as it was shown: no change (the shown number may be rounded)
    const v = Number(text);
    const bad = text.trim() === '' || !Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max);
    if (bad || (!resetOnCommit && v === value)) { setText(show(value)); return; }
    onCommit(v);
    if (resetOnCommit) setText(show(value));
  };
  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      style={width ? { width, flex: 'none' } : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onWheel={(e) => (e.target as HTMLInputElement).blur()}
    />
  );
}
