import { useState } from 'react';
import type { Doc, LayerMode, Machine } from '../core/types';
import type { LaserJob } from '../core/laser';
import { FILL_MODE_NAMES, type FillMode } from '../core/fill';
import { anchorName, type OrderOptions } from '../core/laser';
import { clock, type Estimate } from '../core/jobEstimate';
import type { Anchor } from '../core/geom';
import { NumField } from './NumField';
import { AnchorGrid } from './AnchorGrid';
import { ColorField } from './ColorField';
import { allLasers, setDeviceOrigin, useDevices } from './devices';
import { LayerButtons, LayerData, LayerDeleteDialog, LayerName, useLayerTools } from './LayerTools';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

const ANCHORS: Anchor[] = ['bl', 'bc', 'br', 'ml', 'c', 'mr', 'tl', 'tc', 'tr'];

/** LightBurn's Cuts / Layers: one row per layer with Output, Show and Air, and the settings of the active layer below. */
export function LaserLayers({ doc, active, setActive, run }: { doc: Doc; active: string; setActive: (n: string) => void; run: Run }) {
  const layer = doc.layers.find((l) => l.name === active);
  const tools = useLayerTools(doc, run, active, setActive);
  return (
    <section className="panel">
      <h2><span>Cuts / Layers</span></h2>
      <div className="body">
        <div className="ltable" role="table" aria-label="Laser layers">
          <div className="lhead" role="row"><span /><span>Layer</span><span>Mode</span><span title="Burn this layer">Out</span><span title="Show on screen (a hidden layer still burns if Out is on)">Show</span><span title="Air assist on for this layer">Air</span></div>
          {doc.layers.map((l) => (
            <div key={l.name} role="row" className={'lrow' + (l.name === active ? ' active' : '') + (l.output ? '' : ' off')}>
              <ColorField value={l.color} label={`${l.name} colour`} onChange={(hex) => run('layer_set', { name: l.name, color: hex }, false)} />
              <span className="lname-cell">
                <LayerName name={l.name} tools={tools} onPick={() => setActive(l.name)} title={`${l.name}: ${l.speed} mm/s, ${l.power}%. New shapes go on the active layer. Double-click to rename.`} />
                <LayerData doc={doc} name={l.name} />
              </span>
              <select value={l.mode} aria-label={`${l.name} mode`} onChange={(e) => run('layer_set', { name: l.name, mode: e.target.value as LayerMode }, false)}>
                <option value="cut">Cut</option><option value="engrave">Engrave</option><option value="score">Score</option><option value="tool" title="Never burned. Marks an area; the job start point is measured from the outermost shapes.">Tool (T1/T2)</option>
              </select>
              <input type="checkbox" checked={l.output} aria-label={`${l.name} output`} onChange={(e) => run('layer_set', { name: l.name, output: e.target.checked }, false)} />
              <input type="checkbox" checked={l.visible} aria-label={`Show ${l.name}`} onChange={(e) => run('layer_set', { name: l.name, visible: e.target.checked }, false)} />
              <input type="checkbox" checked={l.air} aria-label={`${l.name} air`} onChange={(e) => run('layer_set', { name: l.name, air: e.target.checked }, false)} />
            </div>
          ))}
        </div>
        {layer && (
          <div className="row wrap" role="group" aria-label={`Order and name of ${layer.name}`}>
            <LayerButtons doc={doc} name={layer.name} tools={tools} labels />
          </div>
        )}
        {layer && (
          <div className="layer-settings wide">
            <div className="muted small" style={{ gridColumn: '1 / -1' }}>Settings for <b>{layer.name}</b></div>
            {layer.mode === 'tool' ? (
              <div className="muted small" style={{ gridColumn: '1 / -1' }}>A tool layer is never burned. Draw a rectangle on it around the design to mark the outer limits (the start point is measured from the outermost shapes), or use it as a place holder or keep-out area.</div>
            ) : (
              <>
                <label>Speed <NumField label="Speed" value={layer.speed} min={0.1} step={1} onCommit={(v) => run('layer_set', { name: layer.name, speed: v }, false)} /><small>mm/s</small></label>
                <label>Max power <NumField label="Max power" value={layer.power} min={0} max={100} step={1} onCommit={(v) => run('layer_set', { name: layer.name, power: v }, false)} /><small>%</small></label>
                <label>Min power <NumField label="Min power" value={layer.minPower} min={0} max={layer.power} step={1} onCommit={(v) => run('layer_set', { name: layer.name, minPower: v }, false)} /><small>%</small></label>
                <label>Passes <NumField label="Passes" value={layer.passes} min={1} step={1} onCommit={(v) => Number.isInteger(v) && run('layer_set', { name: layer.name, passes: v }, false)} /></label>
              </>
            )}
            {layer.mode === 'engrave' && (
              <>
                <label>Fill <select aria-label="Fill mode" value={layer.fillMode} title="Which shapes are filled together. Fastest tries the others, and also cuts through wide empty gaps (like a border) when that saves time." onChange={(e) => run('layer_set', { name: layer.name, fillMode: e.target.value as FillMode }, false)}>
                  {(Object.keys(FILL_MODE_NAMES) as FillMode[]).map((k) => <option key={k} value={k}>{FILL_MODE_NAMES[k]}</option>)}
                </select></label>
                <label>Interval <NumField label="Interval" value={layer.interval} min={0.01} max={10} step={0.01} onCommit={(v) => run('layer_set', { name: layer.name, interval: v }, false)} /><small>mm</small></label>
                <label>Overscan <NumField label="Overscan" value={layer.overscan} min={0} max={50} step={0.5} onCommit={(v) => run('layer_set', { name: layer.name, overscan: v }, false)} /><small>mm</small></label>
              </>
            )}
          </div>
        )}
        <p className="muted small">Cut and Score follow outlines (holes first). Engrave fills closed shapes with lines. Layers burn from the top of the list down: use ▲ ▼ to put engraving ahead of cutting.</p>
      </div>
      <LayerDeleteDialog doc={doc} tools={tools} />
    </section>
  );
}

interface JobProps {
  /** A Ruida controller is connected: the notes about GRBL laser mode and G-code do not apply */
  ruida?: boolean;
  doc: Doc;
  job: LaserJob;
  anchor: Anchor;
  setAnchor: (a: Anchor) => void;
  startFrom: 'user' | 'absolute';
  setStartFrom: (v: 'user' | 'absolute') => void;
  onSetup: () => void;
  onLaserSetup: () => void;
  onlySelected: boolean;
  setOnlySelected: (v: boolean) => void;
  hasSelection: boolean;
  preview: boolean;
  setPreview: (v: boolean) => void;
  run: Run;
  onSave: () => void;
  /** the time and distances of the job on screen (both controllers) */
  order: OrderOptions;
  setOrder: (o: OrderOptions) => void;
  est: Estimate;
  /** what the program chose for the user (a faster fill layout) */
  info: string[];
  onPreview: () => void;
}

export function JobPanel({ ruida, doc, job, anchor, setAnchor, startFrom, setStartFrom, onSetup, onLaserSetup, onlySelected, setOnlySelected, hasSelection, preview, setPreview, run, onSave, order, setOrder, est, info, onPreview }: JobProps) {
  const m: Machine = doc.machine;
  const list = allLasers(useDevices());
  // for a canvas: the laser it will become, the smallest bed that holds the page, else the first
  const [convertTo, setConvertTo] = useState('');
  const fitting = list.find((d) => d.width >= doc.workspace.width && d.height >= doc.workspace.height) ?? list[0];
  const target = convertTo || fitting?.name || '';
  return (
    <section className="panel">
      <h2><span>Laser job</span></h2>
      <div className="body">
        <div className="row wrap">
          <label className="inline small">Laser
            <select value={list.some((d) => d.name === m.name) ? m.name : ''} aria-label="Laser" onChange={(e) => { const d = list.find((x) => x.name === e.target.value); if (d) run('machine_set', { name: d.name, width: d.width, height: d.height, sMax: d.sMax, rapid: d.rapid, origin: d.origin ?? 'tl' }, false); }}>
              {!list.some((d) => d.name === m.name) && <option value="">{m.name} (not in the list)</option>}
              {list.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.width} × {d.height})</option>)}
            </select>
          </label>
          <button className="btn small" onClick={onLaserSetup} title="Add, remove or edit lasers">Laser setup…</button>
        </div>
        <div className="radios" role="radiogroup" aria-label="Where 0,0 is on this laser">
          <span className="rhead">0,0 (rulers and Y) is the</span>
          <div className="row">
            {([['tl', 'Top-left'], ['bl', 'Bottom-left']] as const).map(([v, t]) => (
              <label key={v} className="inline"><input type="radio" name="laser-origin" checked={(m.origin ?? 'tl') === v} onChange={() => { run('machine_set', { origin: v }, false); setDeviceOrigin(m, v); }} /> {t}</label>
            ))}
          </div>
        </div>
        {doc.workspace.kind === 'canvas' && (
          <div className="notice" role="group" aria-label="This design is a canvas">
            <span className="small">This design is a canvas (no machine). Nothing is made for the laser until you make it a laser job. Your drawing stays exactly as it is.</span>
            <div className="row wrap">
              <select aria-label="Laser for this design" value={target} onChange={(e) => setConvertTo(e.target.value)}>
                {list.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.width} × {d.height})</option>)}
              </select>
              <button className="btn small primary" disabled={!list.some((d) => d.name === target)} onClick={() => { const d = list.find((x) => x.name === target); if (d) run('workspace_set', { kind: 'laser', width: d.width, height: d.height, machine: { name: d.name, sMax: d.sMax, rapid: d.rapid, ...(d.origin ? { origin: d.origin } : {}) } }); }}>Make it a laser job</button>
            </div>
          </div>
        )}
        <div className="muted small">
          Bed {m.width} × {m.height} mm.{doc.workspace.kind === 'laser' ? '' : <> This design's page is {doc.workspace.kind === 'free' ? 'not limited' : `${doc.workspace.width} × ${doc.workspace.height} mm`} <button className="btn small" onClick={onSetup}>Work area…</button></>}
        </div>
        {!ruida && (
          <div className="layer-settings wide">
            <label>S max <NumField label="S max" value={m.sMax} min={1} step={1} onCommit={(v) => run('machine_set', { sMax: v }, false)} /><small>$30</small></label>
          </div>
        )}
        {ruida ? (
          <>
            <p className="muted small">The job starts where the head is now (LightBurn's Current Position). Park the head where the job should begin.</p>
            <div className="row"><AnchorGrid value={anchor} onChange={setAnchor} label="Start point" /><span className="small">The head sits at the <b>{anchorName(anchor)}</b> of the job</span></div>
            <p className="muted small">With the head at the rear-left corner of the machine, choose top-left: the job then extends to the right and toward the front.</p>
          </>
        ) : (
          <>
            <label className="inline">Start from
              <select value={startFrom} aria-label="Start from" onChange={(e) => setStartFrom(e.target.value as 'user' | 'absolute')}>
                <option value="user">User origin (a point of the job)</option>
                <option value="absolute">Absolute coordinates</option>
              </select>
            </label>
            {startFrom === 'user' ? (
              <div className="row"><AnchorGrid value={anchor} onChange={setAnchor} label="Start point" /><span className="small">Work zero at the <b>{anchorName(anchor)}</b> of the job</span></div>
            ) : (
              <p className="muted small">The drawing's 0,0 is the machine's 0,0 (bottom-left of the work area). Home the machine first, and only use this if your origin is at the bottom-left.</p>
            )}
          </>
        )}
        <label className="inline"><input type="checkbox" checked={onlySelected} disabled={!hasSelection} onChange={(e) => setOnlySelected(e.target.checked)} /> Burn selected shapes only</label>
        <label className="inline" title="Line layers: cut the shapes inside others before the ones around them"><input type="checkbox" checked={order.innerFirst !== false} onChange={(e) => setOrder({ ...order, innerFirst: e.target.checked })} /> Cut inner shapes first</label>
        <label className="inline" title="Line layers: choose the order, start points and directions that keep the empty travel short"><input type="checkbox" checked={order.reduceTravel !== false} onChange={(e) => setOrder({ ...order, reduceTravel: e.target.checked })} /> Reduce travel moves</label>
        <label className="inline"><input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> Show the burn path on the drawing</label>

        <div className="stats mono small" aria-live="polite">
          {job.empty ? 'Nothing to burn yet.' : (
            <>
              {job.stats.layers} layer{job.stats.layers === 1 ? '' : 's'} · burn {Math.round(job.stats.burnLength)} mm · est. {clock(est.totalSeconds)}
            </>
          )}
        </div>
        {info.map((t, i) => <div key={'i' + i} className="small" role="status">✔ {t}</div>)}
        {job.stats.warnings.map((w, i) => <div key={i} className="warn small">⚠ {w}</div>)}

        <div className="row wrap">
          <button className="btn" disabled={ruida ? !est.at.length : job.empty} onClick={onPreview} title="See the burn path and the time before sending it">Preview…</button>
          <button className="btn primary" disabled={job.empty} onClick={onSave}>Save G-code</button>
        </div>
        <p className="muted small">{ruida ? 'Do the first run at low power on scrap, with eye protection, watching the machine.' : 'The G-code needs GRBL laser mode ($32=1). Do the first run at low power on scrap, with eye protection, watching the machine.'}</p>
      </div>
    </section>
  );
}
