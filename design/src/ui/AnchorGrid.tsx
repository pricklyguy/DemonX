import type { Anchor } from '../core/geom';

const ORDER: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];
const NAMES: Record<Anchor, string> = { tl: 'top-left', tc: 'top-middle', tr: 'top-right', ml: 'left-middle', c: 'centre', mr: 'right-middle', bl: 'bottom-left', bc: 'bottom-middle', br: 'bottom-right' };

/** The nine-dot point picker (the same one as beside X and Y in the tool header). */
export function AnchorGrid({ value, onChange, label }: { value: Anchor; onChange: (a: Anchor) => void; label: string }) {
  return (
    <div className="anchors" role="radiogroup" aria-label={label}>
      {ORDER.map((a) => (
        <button key={a} type="button" role="radio" aria-checked={value === a} aria-label={`${label}: ${NAMES[a]}`} className={'dot' + (value === a ? ' on' : '')} onClick={() => onChange(a)} title={NAMES[a]} />
      ))}
    </div>
  );
}
