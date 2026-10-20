import { useEffect, useState, type ReactNode } from 'react';

export interface SideTab { key: string; label: string; node: ReactNode }

const read = (id: string, tabs: SideTab[]): string => {
  try { const v = localStorage.getItem('design-sidebox-' + id); if (v && tabs.some((t) => t.key === v)) return v; } catch { /* no saved choice */ }
  return tabs[0].key;
};

/** One of the two main boxes of the Laser tab: the page on the left, its tabs down the right edge (the selected one in colour). */
export function SideBox({ id, label, tabs, focus }: { id: string; label: string; tabs: SideTab[]; /** change `n` to switch to the tab `key` from outside */ focus?: { key: string; n: number } }) {
  const [sel, setSel] = useState(() => read(id, tabs));
  const current = tabs.find((t) => t.key === sel) ?? tabs[0];
  useEffect(() => { if (focus && focus.n > 0 && tabs.some((t) => t.key === focus.key)) setSel(focus.key); }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (k: string) => { setSel(k); try { localStorage.setItem('design-sidebox-' + id, k); } catch { /* not remembered */ } };
  return (
    <section className="sidebox" aria-label={label}>
      <div className="sidebox-body" role="tabpanel" aria-label={current.label}>{current.node}</div>
      <div className="sidetabs" role="tablist" aria-orientation="vertical" aria-label={`${label} pages`}>
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === current.key} className={'vtab' + (t.key === current.key ? ' on' : '')} onClick={() => pick(t.key)}>{t.label}</button>
        ))}
      </div>
    </section>
  );
}
