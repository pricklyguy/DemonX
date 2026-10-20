import { useEffect, useRef, useState } from 'react';
import type { Tool } from './Canvas';
import { Icon } from './icons';
import { NumField } from './NumField';
import { MoveResize } from './MoveResize';
import { label as keyLabel } from '../core/shortcuts';
import { useBindings } from './shortcutStore';
import { shapeBounds, unionBounds } from '../core/geom';
import type { Doc, Shape } from '../core/types';
import { summary, validate, type Issue } from '../core/validate';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

export const TOOLS: { id: Tool; icon: string; key: string; name: string; hint: string }[] = [
  { id: 'select', icon: 'select', key: 'V', name: 'Select', hint: 'Select (V). Click, shift-click, or drag a box. Drag a shape to move it, drag a square handle to resize it, or type exact numbers in the bar above. Right-click for more.' },
  { id: 'rect', icon: 'rect', key: 'R', name: 'Rectangle', hint: 'Rectangle (R). Drag from one corner to the other. Right-click to go back to Select.' },
  { id: 'circle', icon: 'circle', key: 'C', name: 'Circle', hint: 'Circle (C). Drag from the centre outwards. Right-click to go back to Select.' },
  { id: 'ellipse', icon: 'ellipse', key: '', name: 'Ellipse', hint: 'Ellipse. Set the width and height in the card and click to put one down, or drag a box. Right-click to go back to Select.' },
  { id: 'polygon', icon: 'polygon', key: '', name: 'Regular polygon', hint: 'Regular polygon with any number of sides. Set the sides and size in the card and click to put one down, or drag out from the centre. Right-click to go back to Select.' },
  { id: 'star', icon: 'star', key: '', name: 'Star', hint: 'Star. Set the points, size and inner size in the card and click to put one down, or drag out from the centre. Right-click to go back to Select.' },
  { id: 'arc', icon: 'arc', key: '', name: 'Arc', hint: 'Arc. Set the radius and the start and end angles in the card and click to put one down, or drag out from the centre. Right-click to go back to Select.' },
  { id: 'measure', icon: 'measure', key: 'M', name: 'Measure', hint: 'Measure (M). Click two points, or drag from one to the other: the distance, the steps across and up, and the angle. Right-click to go back to Select.' },
  { id: 'fillet', icon: 'corners', key: 'B', name: 'Fillet', hint: 'Fillet (B). Click a corner to round it, or click the end of one line and then the end of another: they are extended or cut back to meet, joined and rounded in one step. Right-click to go back to Select.' },
  { id: 'path', icon: 'line', key: 'P', name: 'Polygon / line', hint: 'Polygon / line (P). Click points. Click the first point to close, or double-click, Enter or right-click to leave it open.' },
  { id: 'text', icon: 'text', key: 'A', name: 'Text', hint: 'Text (A). Click where the text should start (its baseline), type it, pick a font. It becomes outlines you can cut, engrave or offset.' },
  { id: 'nodes', icon: 'nodes', key: 'N', name: 'Nodes', hint: 'Nodes (N). Click a line or outline to show its points. Drag a point to move it, double-click a segment to add one, Delete removes the picked points. Right-click to go back to Select.' },
  { id: 'trim', icon: 'trim', key: 'T', name: 'Trim', hint: 'Trim (T). Hover a line or outline: the piece between two crossings turns red. Click to cut it away.' },
];

export interface OffsetState { distance: number; direction: 'outward' | 'inward' | 'both'; join: string; keep: boolean; outerOnly: boolean; select: boolean }
export interface CornerState { radius: number; style: string; onNew: boolean }

interface Props {
  tool: Tool;
  setTool: (t: Tool) => void;
  selection: number[];
  selShapes: Shape[];
  closedCount: number;
  hasClip: boolean;
  hasWork: boolean;
  run: Run;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  duplicate: () => void;
  openArray: () => void;
  offset: OffsetState;
  setOffset: (o: OffsetState) => void;
  corner: CornerState;
  setCorner: (c: CornerState) => void;
  snap: boolean;
  setSnap: (v: boolean) => void;
  objectSnap: boolean;
  setObjectSnap: (v: boolean) => void;
  /** The file buttons at the top (the same actions as the File menu) */
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onImport: () => void;
  onBitmap?: () => void;
  /** The gear: keyboard shortcuts */
  onSettings?: () => void;
  /** The design, for the Check card, and a way to pick the shapes it points out */
  doc?: Doc;
  onSelect?: (ids: number[]) => void;
  /** One piece of editable text is picked: Edit text and Text to lines work */
  canEditText?: boolean;
  onEditText?: () => void;
  /** When set, Y counts down from this height (the top of the page), as the Y boxes do */
  yTop?: number | null;
}

type PopKind = 'offset' | 'corners' | 'align' | 'join' | 'moveresize' | 'boundary' | 'check' | 'fit';

/** The tool bar on the left: drawing and editing tools, then the actions on the selection. */
export function ToolBar(p: Props) {
  const n = p.selection.length;
  const [pop, setPop] = useState<{ kind: PopKind; top: number } | null>(null);
  // Align to: the work area (material), the box around the selection, or the first object picked (it stays)
  const [alignTo, setAlignTo] = useState<'work' | 'selection' | 'first'>('selection');
  const [gap, setGap] = useState(5);
  const [sizeLink, setSizeLink] = useState(true);
  // the Check card: what is wrong with the picked shapes (or all of them), looked for when the card opens and when asked again
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [pickedOnly, setPickedOnly] = useState(true);
  const [fit, setFit] = useState({ tolerance: 0.05, corner: 40 });
  const checkScope = n > 0 && pickedOnly ? p.selection : undefined;
  const latest = useRef({ p, pickedOnly });
  latest.current = { p, pickedOnly };
  // looked up when it runs, not when it was asked for: after a fix the drawing has changed
  const runCheck = () => { setIssues(null); setTimeout(() => { const { p: q, pickedOnly: only } = latest.current; setIssues(q.doc ? validate(q.doc, only && q.selection.length > 0 ? q.selection : undefined) : []); }, 0); };
  useEffect(() => { if (pop?.kind === 'check') runCheck(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pop?.kind]);
  const [bound, setBound] = useState<{ mode: 'all' | 'each' | 'hull'; distance: number; join: 'round' | 'miter' | 'square'; keep: boolean }>({ mode: 'all', distance: 2, join: 'round', keep: true });
  const card = useRef<HTMLDivElement>(null);
  // the card can be dragged by its title and keeps its place until another card opens
  const [moved, setMoved] = useState({ x: 0, y: 0 });
  useEffect(() => { setMoved({ x: 0, y: 0 }); }, [pop?.kind]);
  const startMove = (e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).closest('h3')) return;
    e.preventDefault();
    const sx = e.clientX - moved.x, sy = e.clientY - moved.y;
    const move = (m: PointerEvent) => setMoved({ x: m.clientX - sx, y: m.clientY - sy });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    if (!pop) return;
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (card.current?.contains(t) || t.closest('[data-pop]')) return;
      setPop(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPop(null); } };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); };
  }, [pop]);

  const popBtn = (kind: PopKind, icon: string, label: string, disabled: boolean) => (
    <button key={kind} data-pop className={'tb' + (pop?.kind === kind ? ' on' : '')} disabled={disabled} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={pop?.kind === kind}
      onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPop(pop?.kind === kind ? null : { kind, top: r.top }); }}>
      <Icon name={icon} />
    </button>
  );
  const act = (icon: string, label: string, onClick: () => void, disabled: boolean, danger = false) => (
    <button key={label} className={'tb' + (danger ? ' danger' : '')} disabled={disabled} aria-label={label} title={label} onClick={onClick}><Icon name={icon} size={icon === 'group' || icon === 'ungroup' ? 22 : 18} /></button>
  );
  const ids = p.selection;
  const grouped = p.selShapes.some((s) => s.group !== undefined);
  const openLines = p.selShapes.filter((s) => s.kind === 'path' && !s.closed).length;
  const hasPath = p.selShapes.some((s) => s.kind === 'path');
  // a group counts as one object
  const objects = new Set(p.selShapes.map((s) => (s.group === undefined ? `s${s.id}` : `g${s.group}`))).size;
  const toTarget: 'work' | 'selection' | 'first' = objects < 2 || (alignTo === 'work' && !p.hasWork) ? (p.hasWork && objects < 2 ? 'work' : 'selection') : alignTo;
  // the keys are the owner's to change (the gear), so the names and the small letters follow them
  const keys = useBindings();
  const keyed = (name: string, id: string) => (keys[id] ? `${name} (${keyLabel(keys[id])})` : name);
  const toolBtn = (t: (typeof TOOLS)[number]) => {
    const k = t.key ? keys[`tool.${t.id}`] : undefined;
    const name = t.key ? keyed(t.name, `tool.${t.id}`) : t.hint.split('.')[0];
    const hint = t.key ? t.hint.replace(/^[^(]*\([A-Z]\)/, name) : t.hint;
    return (
      <button key={t.id} className={'tb' + (p.tool === t.id ? ' on' : '')} onClick={() => p.setTool(t.id)} title={hint} aria-label={name} aria-pressed={p.tool === t.id}>
        <Icon name={t.icon} /><small>{k ? keyLabel(k) : ''}</small>
      </button>
    );
  };
  const selBox = n > 0 ? unionBounds(p.selShapes.map((s) => shapeBounds(s)!).filter(Boolean)) : null;
  const canAlign = n > 0 && (toTarget === 'work' ? p.hasWork : objects > 1);

  return (
    <nav className="tools" aria-label="Tools">
      <div className="tsnap" role="group" aria-label="Snap">
        <label title="Snap new points to the grid"><input type="checkbox" checked={p.snap} onChange={(e) => p.setSnap(e.target.checked)} /> Grid</label>
        <label title="Jump to the ends, middles, centres and crossings of existing shapes, with a marker"><input type="checkbox" checked={p.objectSnap} onChange={(e) => p.setObjectSnap(e.target.checked)} /> Points</label>
      </div>
      <div className="tgroup" role="group" aria-label="File operations">
        <h4>File Operations</h4>
        {act('new', 'New design (File, New)', p.onNew, false)}
        {act('open', keyed('Open a saved design', 'file.open'), p.onOpen, false)}
        {act('save', keyed('Save', 'file.save'), p.onSave, false)}
        {act('import', 'Import a vector file (DXF)', p.onImport, false)}
        {act('bitmap', 'Import a bitmap and trace it into vectors', () => p.onBitmap?.(), !p.onBitmap)}
        {act('settings', 'Keyboard shortcuts (the gear)', () => p.onSettings?.(), !p.onSettings)}
      </div>
      <div className="tgroup" role="group" aria-label="Create vectors">
        <h4>Create Vectors</h4>
        {TOOLS.filter((t) => ['rect', 'circle', 'ellipse', 'polygon', 'star', 'arc', 'path', 'text'].includes(t.id)).map(toolBtn)}
        {act('textedit', 'Edit text: the words, font, size, spacing, or along a curve (pick the text first)', () => p.onEditText?.(), !p.canEditText)}
        {act('textlines', 'Text to lines: plain outlines that can no longer be edited as text', () => p.run('text_to_lines', { ids }), !p.canEditText)}
      </div>
      <div className="tgroup" role="group" aria-label="Edit objects">
        <h4>Edit Objects</h4>
        {TOOLS.filter((t) => ['select', 'nodes', 'trim', 'fillet', 'measure'].includes(t.id)).map(toolBtn)}
        {popBtn('join', 'join', 'Join open lines', openLines === 0)}
        {act('extend', 'Extend two open lines to where they meet', () => p.run('extend', { ids }), !(n === 2 && openLines === 2))}
        {act('union', 'Union: join the shapes into one', () => p.run('boolean', { op: 'union', ids }), p.closedCount < 2)}
        {act('subtract', 'Subtract: the first shape you picked minus the others', () => p.run('boolean', { op: 'difference', ids }), p.closedCount < 2)}
        {act('intersect', 'Intersect: only the part they share', () => p.run('boolean', { op: 'intersection', ids }), p.closedCount < 2)}
        {act('group', keyed('Group', 'edit.group'), () => p.run('group', { ids }), n < 2)}
        {act('ungroup', keyed('Ungroup', 'edit.ungroup'), () => p.run('ungroup', { ids }), !grouped)}
        <hr className="tsep" aria-hidden="true" />
        {act('copy', keyed('Copy', 'edit.copy'), p.copy, n === 0)}
        {act('paste', keyed('Paste', 'edit.paste'), p.paste, !p.hasClip)}
        {act('cut', keyed('Cut', 'edit.cut'), p.cut, n === 0)}
        {act('duplicate', keyed('Duplicate', 'edit.duplicate'), p.duplicate, n === 0)}
        {act('delete', keyed('Delete', 'edit.delete'), () => p.run('delete', { ids }), n === 0, true)}
      </div>
      <div className="tgroup" role="group" aria-label="Offset and layout">
        <h4>Offset and Layout</h4>
        {act('array', 'Array: repeat in a grid or around a centre', p.openArray, n === 0)}
        {popBtn('offset', 'offset', 'Offset: grow or shrink', n === 0)}
        {popBtn('corners', 'corners', 'Corners: round, scoop or chamfer', !hasPath)}
        {popBtn('fit', 'fit', 'Fit curves: smooth lines made of many small segments', !hasPath)}
        {popBtn('check', 'check', 'Check the vectors for problems before cutting', false)}
        {popBtn('boundary', 'boundary', 'Boundary: draw an outline round the selected shapes', n === 0)}
        {popBtn('moveresize', 'move', 'Move and resize the selection', n === 0)}
        {popBtn('align', 'align', 'Align and space evenly', n === 0)}
      </div>

      {pop && (
        <div className={'popcard' + (pop.kind === 'offset' ? ' wide' : '')} ref={card} role="dialog" aria-label={pop.kind === 'offset' ? 'Offset' : pop.kind === 'corners' ? 'Corners' : pop.kind === 'align' ? 'Align' : pop.kind === 'moveresize' ? 'Move and resize' : pop.kind === 'boundary' ? 'Boundary' : pop.kind === 'check' ? 'Check vectors' : pop.kind === 'fit' ? 'Fit curves' : 'Join lines'} style={{ top: Math.max(8, Math.min(pop.top, window.innerHeight - (pop.kind === 'align' ? 470 : pop.kind === 'moveresize' ? 430 : pop.kind === 'boundary' ? 330 : pop.kind === 'check' ? 420 : pop.kind === 'fit' ? 300 : pop.kind === 'offset' ? 300 : 260))), transform: `translate(${moved.x}px, ${moved.y}px)` }} onPointerDown={startMove}>
          {pop.kind === 'offset' && (
            <>
              <h3 title="Drag the title to move this card">Offset</h3>
              <label className="inline">Distance <NumField label="Offset distance" value={p.offset.distance} min={0.001} step={0.1} width={80} onCommit={(v) => p.setOffset({ ...p.offset, distance: v })} /><small>mm</small></label>
              <div className="offset-cols">
              <div className="radios" role="radiogroup" aria-label="Offset direction">
                <span className="rhead">Direction</span>
                {([['outward', 'Outward'], ['inward', 'Inward'], ['both', 'Both']] as const).map(([v, t]) => (
                  <label key={v} className="inline"><input type="radio" name="offset-direction" checked={p.offset.direction === v} onChange={() => p.setOffset({ ...p.offset, direction: v })} /> {t}</label>
                ))}
              </div>
              <div className="radios" role="radiogroup" aria-label="Corner style">
                <span className="rhead">Corner style</span>
                {([['round', 'Round'], ['square', 'Beveled'], ['miter', 'Square']] as const).map(([v, t]) => (
                  <label key={v} className="inline"><input type="radio" name="offset-join" checked={p.offset.join === v} onChange={() => p.setOffset({ ...p.offset, join: v })} /> {t}</label>
                ))}
              </div>
              <div className="radios">
                <span className="rhead">Options</span>
                <label className="inline"><input type="checkbox" checked={p.offset.outerOnly} onChange={(e) => p.setOffset({ ...p.offset, outerOnly: e.target.checked })} /> Outer shapes only</label>
                <label className="inline"><input type="checkbox" checked={p.offset.select} onChange={(e) => p.setOffset({ ...p.offset, select: e.target.checked })} /> Select resulting objects</label>
                <label className="inline"><input type="checkbox" checked={!p.offset.keep} onChange={(e) => p.setOffset({ ...p.offset, keep: !e.target.checked })} /> Delete original objects</label>
              </div>
              </div>
              <button className="btn small primary" onClick={() => { if (p.run('offset', { ids, distance: p.offset.distance, direction: p.offset.direction, join: p.offset.join, keep: p.offset.keep, outerOnly: p.offset.outerOnly, select: p.offset.select })) setPop(null); }}>OK</button>
            </>
          )}
          {pop.kind === 'corners' && (
            <>
              <h3>Corners</h3>
              <label className="inline">Radius <NumField label="Round by" value={p.corner.radius} min={0.01} step={0.5} width={70} onCommit={(v) => p.setCorner({ ...p.corner, radius: v })} /><small>mm</small></label>
              <select value={p.corner.style} aria-label="Corner type" onChange={(e) => p.setCorner({ ...p.corner, style: e.target.value })}>
                <option value="round">Round (outside)</option><option value="cove">Inside scoop</option><option value="chamfer">Chamfer</option>
              </select>
              <label className="inline"><input type="checkbox" checked={p.corner.onNew} onChange={(e) => p.setCorner({ ...p.corner, onNew: e.target.checked })} /> new rectangles</label>
              <button className="btn small primary" disabled={!hasPath} onClick={() => { if (p.run('fillet', { ids, radius: p.corner.radius, style: p.corner.style })) setPop(null); }}>Apply</button>
            </>
          )}
          {pop.kind === 'align' && (
            <div role="group" aria-label="Align">
              <h3>Align and space</h3>
              <div className="rhead small muted">Align to</div>
              <div className="row wrap" role="radiogroup" aria-label="Align to">
                <label className="inline"><input type="radio" name="align-to" disabled={!p.hasWork} checked={toTarget === 'work'} onChange={() => setAlignTo('work')} /> Material</label>
                <label className="inline"><input type="radio" name="align-to" disabled={objects < 2} checked={toTarget === 'selection'} onChange={() => setAlignTo('selection')} /> Selection</label>
                <label className="inline"><input type="radio" name="align-to" disabled={objects < 2} checked={toTarget === 'first'} onChange={() => setAlignTo('first')} title="The first object you picked stays where it is" /> First picked</label>
              </div>
              {objects !== p.selShapes.length && <p className="muted small">A group moves as one object.</p>}
              <div className="rhead small muted">Horizontal</div>
              <div className="row wrap">
                {([['left', 'Align left edges', 'Left'], ['hcenter', 'Centre horizontally', 'Centre'], ['right', 'Align right edges', 'Right']] as const).map(([edge, tip, text]) => (
                  <button key={edge} className="btn small" disabled={!canAlign} aria-label={tip} title={tip + (toTarget === 'work' ? ' to the material' : toTarget === 'first' ? ' to the first object picked' : ' of the selection')} onClick={() => p.run('align', { ids, edge, to: toTarget })}>{ALIGN_GLYPH[edge]} {text}</button>
                ))}
              </div>
              <div className="rhead small muted">Vertical</div>
              <div className="row wrap">
                {([['top', 'Align top edges', 'Top'], ['vcenter', 'Centre vertically', 'Centre'], ['bottom', 'Align bottom edges', 'Bottom']] as const).map(([edge, tip, text]) => (
                  <button key={edge} className="btn small" disabled={!canAlign} aria-label={tip} title={tip + (toTarget === 'work' ? ' to the material' : toTarget === 'first' ? ' to the first object picked' : ' of the selection')} onClick={() => p.run('align', { ids, edge, to: toTarget })}>{ALIGN_GLYPH[edge]} {text}</button>
                ))}
              </div>
              <div className="row"><button className="btn small" disabled={!canAlign} aria-label="Centre on both" title="Centre both ways" onClick={() => p.run('align', { ids, edge: 'center', to: toTarget })}>✛ Centre both ways</button></div>
              <div className="rhead small muted">Spacing</div>
              <div className="row wrap">
                <button className="btn small" disabled={objects < 3} aria-label="Space evenly across" title="Equal gaps between three or more objects, left to right (the outer two stay)" onClick={() => p.run('distribute', { ids, axis: 'x' })}>⇹ Evenly across</button>
                <button className="btn small" disabled={objects < 3} aria-label="Space evenly down" title="Equal gaps between three or more objects, bottom to top (the outer two stay)" onClick={() => p.run('distribute', { ids, axis: 'y' })}>⥯ Evenly down</button>
              </div>
              <div className="row wrap">
                <label className="inline">Gap <NumField label="Space between objects" value={gap} min={0} step={1} width={70} onCommit={setGap} /> <small>mm</small></label>
                <button className="btn small" disabled={objects < 2} aria-label="Set the gap across" title="Put this much space between the objects, left to right (the first stays)" onClick={() => p.run('distribute', { ids, axis: 'x', gap })}>Across</button>
                <button className="btn small" disabled={objects < 2} aria-label="Set the gap down" title="Put this much space between the objects, bottom to top (the first stays)" onClick={() => p.run('distribute', { ids, axis: 'y', gap })}>Up</button>
              </div>
            </div>
          )}
          {pop.kind === 'moveresize' && selBox && (
            <MoveResize key={[selBox.maxX - selBox.minX, selBox.maxY - selBox.minY].map((v) => v.toFixed(3)).join()} ids={ids} box={selBox} allCircles={p.selShapes.length > 0 && p.selShapes.every((s) => s.kind === 'circle')} yTop={p.yTop ?? null} link={sizeLink} setLink={setSizeLink} run={p.run} onDone={() => undefined} />
          )}
          {pop.kind === 'fit' && (
            <div role="group" aria-label="Fit curves">
              <h3 title="Drag the title to move this card">Fit curves</h3>
              <p className="muted small">Smooths lines made of many small segments (a traced picture, a rough import) into curves with far fewer points. Sharp corners stay sharp.</p>
              <label className="inline">Tolerance <NumField label="Fit tolerance" value={fit.tolerance} min={0.001} step={0.01} width={80} onCommit={(v) => setFit({ ...fit, tolerance: v })} /><small>mm (how far it may stray)</small></label>
              <label className="inline">Corners <NumField label="Fit corner angle" value={fit.corner} min={1} max={179} step={5} width={70} onCommit={(v) => setFit({ ...fit, corner: v })} /><small>° or sharper stay corners</small></label>
              <button className="btn small primary" disabled={!hasPath} onClick={() => { if (p.run('fit_curves', { ids, tolerance: fit.tolerance, corner: fit.corner })) setPop(null); }}>Fit</button>
            </div>
          )}
          {pop.kind === 'check' && (
            <div role="group" aria-label="Check vectors">
              <h3 title="Drag the title to move this card">Check vectors</h3>
              <p className="muted small">{checkScope ? `Looking at the ${n} picked shape${n === 1 ? '' : 's'}.` : 'Looking at every shape on a visible layer.'}</p>
              {n > 0 && <label className="inline small"><input type="checkbox" checked={pickedOnly} onChange={(e) => { latest.current = { p, pickedOnly: e.target.checked }; setPickedOnly(e.target.checked); runCheck(); }} /> only the picked shapes</label>}
              {issues === null && <p className="small" role="status">Checking…</p>}
              {issues && <p className="small" role="status" aria-label="Check result"><b>{summary(issues)}</b></p>}
              {issues && issues.length > 0 && (
                <ul className="issues" aria-label="Problems">
                  {issues.map((i) => (
                    <li key={i.code} className={i.severity}>
                      <span>{i.severity === 'error' ? '✖' : '⚠'} {i.message}{i.fixable ? ' (can be fixed)' : ''}</span>
                      <button className="btn small" onClick={() => p.onSelect?.(i.ids)} aria-label={`Show ${i.code}`}>Show</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row">
                <button className="btn small primary" disabled={!issues?.some((i) => i.fixable)} onClick={() => { if (p.run('validate_fix', checkScope ? { ids: checkScope } : {})) runCheck(); }}>Fix what can be fixed</button>
                <button className="btn small" onClick={runCheck}>Check again</button>
              </div>
            </div>
          )}
          {pop.kind === 'boundary' && (
            <div role="group" aria-label="Boundary">
              <h3 title="Drag the title to move this card">Boundary</h3>
              <p className="muted small">Draws an outline round the selected shapes.</p>
              <div className="radios" role="radiogroup" aria-label="Boundary kind">
                <label className="inline"><input type="radio" name="bound-mode" checked={bound.mode === 'all'} onChange={() => setBound({ ...bound, mode: 'all' })} /> One round each group that touches</label>
                <label className="inline"><input type="radio" name="bound-mode" checked={bound.mode === 'each'} onChange={() => setBound({ ...bound, mode: 'each' })} /> One round every shape</label>
                <label className="inline"><input type="radio" name="bound-mode" checked={bound.mode === 'hull'} onChange={() => setBound({ ...bound, mode: 'hull' })} /> One convex outline round everything</label>
              </div>
              <label className="inline">Gap <NumField label="Boundary gap" value={bound.distance} min={0} step={0.5} width={80} onCommit={(v) => setBound({ ...bound, distance: v })} /><small>mm out</small></label>
              <label className="inline">Corners
                <select aria-label="Boundary corners" value={bound.join} onChange={(e) => setBound({ ...bound, join: e.target.value as 'round' | 'miter' | 'square' })}>
                  <option value="round">round</option><option value="miter">sharp</option><option value="square">square</option>
                </select>
              </label>
              <label className="inline"><input type="checkbox" checked={bound.keep} onChange={(e) => setBound({ ...bound, keep: e.target.checked })} /> keep the shapes</label>
              <button className="btn small primary" disabled={n === 0} onClick={() => { if (p.run('boundary', { ids, mode: bound.mode, distance: bound.distance, join: bound.join, keep: bound.keep })) setPop(null); }}>Create</button>
            </div>
          )}
          {pop.kind === 'join' && (
            <>
              <h3>Join lines</h3>
              <p className="muted small">{n === 1 ? 'Closes the line by joining its own two ends.' : 'Joins the nearest ends of the selected open lines into one.'}</p>
              <button className="btn small" onClick={() => { if (p.run('join', { ids, mode: 'line' })) setPop(null); }}>With a line</button>
              <button className="btn small" onClick={() => { if (p.run('join', { ids, mode: 'curve' })) setPop(null); }}>With a smooth curve</button>
              <button className="btn small" onClick={() => { if (p.run('join', { ids, mode: 'move' })) setPop(null); }}>Move end points</button>
            </>
          )}
        </div>
      )}
    </nav>
  );
}

const ALIGN_GLYPH = { left: '⇤', hcenter: '↔', right: '⇥', top: '⤒', vcenter: '↕', bottom: '⤓' } as const;
