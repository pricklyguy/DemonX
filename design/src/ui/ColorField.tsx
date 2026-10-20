export const PRESET_COLORS: [string, string][] = [
  ['Black', '#000000'], ['Red', '#ff0000'], ['Blue', '#0000ff'], ['Green', '#00a000'], ['Yellow', '#ffd000'], ['Orange', '#ff8000'],
];

/** Any colour from the picker, with six quick choices underneath. */
export function ColorField({ value, label, onChange }: { value: string; label: string; onChange: (hex: string) => void }) {
  return (
    <span className="colorfield">
      <input type="color" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      <span className="swatches" role="group" aria-label={`${label}: quick colours`}>
        {PRESET_COLORS.map(([name, hex]) => (
          <button key={hex} type="button" className={'swatch' + (value.toLowerCase() === hex ? ' on' : '')} style={{ background: hex }} aria-label={`${label}: ${name}`} title={name} onClick={() => onChange(hex)} />
        ))}
      </span>
    </span>
  );
}
