import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { label: string; onClick?: () => void; shortcut?: string; disabled?: boolean; checked?: boolean; children?: MenuItem[] }
  | 'separator';

/** A submenu: opens to the right of its item, but is moved up or to the left when it would run off the window. */
function Sub({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let top = -5, left: number | null = null;
    if (r.bottom > window.innerHeight - 4) top -= r.bottom - window.innerHeight + 4;
    if (r.right > window.innerWidth - 4) left = -r.width - 8;
    el.style.top = top + 'px';
    if (left !== null) { el.style.left = left + 'px'; }
  }, []);
  return <div className="submenu" ref={ref}>{children}</div>;
}

/** A list of items. An item with `children` opens a submenu to its right when hovered, clicked or reached with the arrow keys. */
function List({ items, label, onDone, autoFocus }: { items: MenuItem[]; label: string; onDone: () => void; autoFocus?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  useEffect(() => { if (autoFocus) box.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus(); }, [autoFocus]);

  const onKey = (e: React.KeyboardEvent) => {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>(':scope > [role=menuitem]:not(:disabled)') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'ArrowRight') {
      const idx = Number((document.activeElement as HTMLElement | null)?.dataset.index);
      if (items[idx] && items[idx] !== 'separator' && (items[idx] as any).children) { e.preventDefault(); e.stopPropagation(); setOpenSub(idx); }
    } else if (e.key === 'ArrowLeft' && openSub !== null) { e.preventDefault(); e.stopPropagation(); setOpenSub(null); }
  };

  return (
    <div className="menu" role="menu" aria-label={label} ref={box} onKeyDown={onKey}>
      {items.map((it, i) => {
        if (it === 'separator') return <div key={i} className="sep" role="separator" />;
        const sub = it.children;
        return (
          <div key={i} className="mrow" onMouseEnter={() => setOpenSub(sub ? i : null)}>
            <button role="menuitem" data-index={i} className={'item' + (sub && openSub === i ? ' open' : '')} disabled={it.disabled} aria-haspopup={sub ? 'menu' : undefined} aria-expanded={sub ? openSub === i : undefined}
              onClick={() => { if (sub) { setOpenSub(openSub === i ? null : i); return; } onDone(); it.onClick?.(); }}>
              <span>{it.checked !== undefined && <i className="tick">{it.checked ? '✓' : ''}</i>}{it.label}</span>
              {sub ? <span className="arrow">▸</span> : it.shortcut && <kbd>{it.shortcut}</kbd>}
            </button>
            {sub && openSub === i && !it.disabled && <Sub><List items={sub} label={it.label} onDone={onDone} /></Sub>}
          </div>
        );
      })}
    </div>
  );
}

/** A button that drops a list down. Escape or a click elsewhere closes it; the arrow keys move through it. */
export function DropMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); (box.current?.querySelector('.file-btn') as HTMLElement | null)?.focus(); }
  };
  return (
    <div className="filemenu" ref={box} onKeyDown={onKey}>
      <button className="btn file-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label} ▾</button>
      {open && <List items={items} label={label} onDone={() => setOpen(false)} autoFocus />}
    </div>
  );
}

/** The right-click menu: opens at the cursor, stays inside the window. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    // at the cursor; if it does not fit below, above it; only if it fits neither is it pushed against the window's edge
    const below = y + r.height <= window.innerHeight - 4;
    const top = below ? y : y - r.height >= 4 ? y - r.height : Math.max(4, window.innerHeight - r.height - 4);
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top });
  }, [x, y]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => { document.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); };
  }, [onClose]);
  return (
    <div className="ctxmenu" ref={box} style={pos} onContextMenu={(e) => e.preventDefault()}>
      <List items={items} label="Context menu" onDone={onClose} autoFocus />
    </div>
  );
}
