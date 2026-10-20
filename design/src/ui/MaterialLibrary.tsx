import { useEffect, useMemo, useState } from 'react';
import type { Doc } from '../core/types';
import { entryFromLayer, freeName, groupOf, importClb, layerPatch, putEntry, type Library, type LibraryEntry } from '../core/materials';
import { NumField } from './NumField';
import { useLibraries } from './libraryStore';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;
interface Pick { m: number; e: number }

/** LightBurn-style material library: one library per laser, materials, then the cut settings that can be assigned to a layer. */
export function MaterialLibrary({ doc, active, run }: { doc: Doc; active: string; run: Run }) {
  const { data, ready, error, save } = useLibraries();
  const layer = doc.layers.find((l) => l.name === active);
  const [libName, setLibName] = useState('');
  const [pick, setPick] = useState<Pick | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [form, setForm] = useState({ material: '', thickness: '', group: 'Engraving', name: '' });
  const [msg, setMsg] = useState('');

  // follow the design's laser by default
  const wanted = data.libraries.find((l) => l.name === doc.machine.name)?.name ?? data.libraries[0]?.name ?? '';
  const lib: Library | undefined = data.libraries.find((l) => l.name === libName) ?? data.libraries.find((l) => l.name === wanted);
  useEffect(() => { setPick(null); }, [lib?.name]);
  const entry: LibraryEntry | undefined = pick && lib ? lib.materials[pick.m]?.entries[pick.e] : undefined;

  const change = (next: Library) => lib && save({ ...data, libraries: data.libraries.map((l) => (l.name === lib.name ? next : l)) });
  const setEntry = (patch: Partial<LibraryEntry>) => {
    if (!lib || !pick || !entry) return;
    const next: LibraryEntry = { ...entry, ...patch };
    if (next.minPower > next.power) next.minPower = next.power;
    change({ ...lib, materials: lib.materials.map((m, i) => (i !== pick.m ? m : { ...m, entries: m.entries.map((e, j) => (j === pick.e ? next : e)) })) });
  };
  const addLibrary = (l: Library) => { save({ ...data, libraries: [...data.libraries.filter((x) => x.name !== l.name), l] }); setLibName(l.name); };
  const forLaser = () => addLibrary({ name: doc.machine.name, materials: [] });
  const doImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const l = importClb(await f.text(), f.name.replace(/\.clb$/i, ''));
      const exists = data.libraries.some((x) => x.name === l.name);
      if (exists && !window.confirm(`A library called "${l.name}" is already here. Replace it with the one from the file?`)) return;
      addLibrary(l); setMsg(`Imported "${l.name}": ${l.materials.length} materials.`);
    } catch (e) { setMsg((e as Error).message); }
  };
  const createFromLayer = () => {
    if (!lib || !layer) return;
    const material = form.material.trim(), name = form.name.trim();
    const t = form.thickness.trim() === '' ? null : Number(form.thickness);
    if (!material || !name) { setMsg('Give the material and a name for the settings.'); return; }
    if (t !== null && !(t > 0)) { setMsg('Thickness must be more than 0 mm, or empty.'); return; }
    const e = entryFromLayer(layer, name, t, form.group.trim() || 'General');
    const m = lib.materials.find((x) => x.name === material);
    const taken = m?.entries.some((x) => x.name === name && groupOf(x) === groupOf(e));
    if (taken && !window.confirm(`"${name}" already exists under ${material}. Replace it with the settings of ${layer.name}?`)) return;
    change(putEntry(lib, material, e));
    setAdding(false); setMsg(`Saved "${name}" under ${material}.`);
    setPick(null);
  };

  const sorted = useMemo(() => (lib ? lib.materials.map((m, mi) => ({ m, mi, groups: [...new Set(m.entries.map(groupOf))].map((g) => ({ g, items: m.entries.map((e, ei) => ({ e, ei })).filter((x) => groupOf(x.e) === g) })) })) : []), [lib]);

  return (
    <section className="panel">
      <h2><span>Material library</span></h2>
      <div className="body">
        {error && <div className="warn small" role="alert">{error}</div>}
        <div className="row wrap">
          <label className="inline small">Library
            <select aria-label="Library" value={lib?.name ?? ''} onChange={(e) => setLibName(e.target.value)}>
              {!data.libraries.length && <option value="">{ready ? '(none yet)' : 'loading…'}</option>}
              {data.libraries.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
            </select>
          </label>
          {!data.libraries.some((l) => l.name === doc.machine.name) && <button className="btn small" onClick={forLaser}>New library for {doc.machine.name}</button>}
          {lib && <button className="btn small" onClick={() => setRenaming(true)}>Rename</button>}
          {lib && <button className="btn small" onClick={() => { if (window.confirm(`Delete the library "${lib.name}" with all its settings?`)) { save({ ...data, libraries: data.libraries.filter((l) => l.name !== lib.name) }); setLibName(''); } }}>Delete library</button>}
          <label className="btn small" style={{ cursor: 'pointer' }}>Import .clb…
            <input type="file" accept=".clb" hidden aria-label="Import a LightBurn library" onChange={(e) => { void doImport(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
        {renaming && lib && (
          <form className="row wrap" onSubmit={(ev) => { ev.preventDefault(); const v = String(new FormData(ev.currentTarget).get('n') ?? '').trim(); if (v && (v === lib.name || !data.libraries.some((l) => l.name === v))) { save({ ...data, libraries: data.libraries.map((l) => (l.name === lib.name ? { ...l, name: v } : l)) }); setLibName(v); setRenaming(false); } else setMsg('Pick a name no other library has.'); }}>
            <input name="n" defaultValue={lib.name} aria-label="Library name" autoFocus />
            <button className="btn small primary" type="submit">OK</button>
            <button className="btn small" type="button" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        )}
        {lib && (
          <div className="mat-tree" role="tree" aria-label="Materials">
            {!lib.materials.length && <p className="muted small">Empty. Set up a layer, then use <b>New from layer</b>, or import a LightBurn library.</p>}
            {sorted.map(({ m, mi, groups }) => (
              <details key={m.name + mi} open={pick?.m === mi}>
                <summary>{m.name}</summary>
                {groups.map(({ g, items }) => (
                  <details key={g} open={pick?.m === mi && items.some((x) => x.ei === pick.e)} className="mat-group">
                    <summary>{g}</summary>
                    {items.map(({ e, ei }) => (
                      <button key={ei} role="treeitem" aria-selected={pick?.m === mi && pick.e === ei} className={'mat-entry' + (pick?.m === mi && pick.e === ei ? ' on' : '')} onClick={() => setPick({ m: mi, e: ei })} title={`${e.mode}, ${e.speed} mm/s, ${e.minPower}–${e.power}%, ${e.passes} pass${e.passes === 1 ? '' : 'es'}, air ${e.air ? 'on' : 'off'}`}>{e.name}</button>
                    ))}
                  </details>
                ))}
              </details>
            ))}
          </div>
        )}
        {lib && (
          <div className="row wrap" role="group" aria-label="Library actions">
            <button className="btn small primary" disabled={!entry || !layer} title="Copy these settings to the active layer" onClick={() => { if (entry && layer) { run('layer_set', { name: layer.name, ...layerPatch(entry) }, false); setMsg(`${layer.name} now uses "${entry.name}".`); } }}>Assign to {layer?.name ?? 'layer'}</button>
            <button className="btn small" disabled={!layer || layer.mode === 'tool'} onClick={() => { setAdding(true); const cur = pick && lib.materials[pick.m]; setForm({ material: cur?.name ?? '', thickness: '', group: layer?.mode === 'engrave' ? 'Engraving' : 'Line', name: '' }); }}>New from layer</button>
            <button className="btn small" disabled={!entry || !layer || layer.mode === 'tool'} title="Replace the selected settings with the active layer's" onClick={() => { if (lib && pick && entry && layer && window.confirm(`Replace "${entry.name}" with the settings of ${layer.name}?`)) { const n = entryFromLayer(layer, entry.name, entry.thickness, entry.group); setEntry({ ...n }); setMsg(`"${entry.name}" updated from ${layer.name}.`); } }}>Update</button>
            <button className="btn small" disabled={!entry} onClick={() => { if (lib && pick && entry) { const copy = { ...entry, name: freeName(lib.materials[pick.m], entry.name, groupOf(entry)) }; change({ ...lib, materials: lib.materials.map((m, i) => (i === pick.m ? { ...m, entries: [...m.entries, copy] } : m)) }); setPick({ m: pick.m, e: lib.materials[pick.m].entries.length }); } }}>Duplicate</button>
            <button className="btn small" disabled={!entry} onClick={() => { if (lib && pick && entry && window.confirm(`Delete "${entry.name}"?`)) { change({ ...lib, materials: lib.materials.map((m, i) => (i === pick.m ? { ...m, entries: m.entries.filter((_, j) => j !== pick.e) } : m)).filter((m) => m.entries.length) }); setPick(null); } }}>Delete</button>
          </div>
        )}
        {adding && lib && layer && (
          <div className="layer-settings wide" role="group" aria-label="New settings from the layer">
            <div className="muted small" style={{ gridColumn: '1 / -1' }}>Save the settings of <b>{layer.name}</b> as:</div>
            <label>Material <input list="mat-names" aria-label="Material" value={form.material} onChange={(e) => setForm({ ...form, material: e.target.value })} /></label>
            <datalist id="mat-names">{lib.materials.map((m) => <option key={m.name} value={m.name} />)}</datalist>
            <label>Thickness <input aria-label="Thickness" inputMode="decimal" placeholder="none" size={5} value={form.thickness} onChange={(e) => setForm({ ...form, thickness: e.target.value })} /><small>mm (a cut-out)</small></label>
            {form.thickness.trim() === '' && <label>Heading <input aria-label="Heading" value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} /></label>}
            <label>Name <input aria-label="Settings name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <div className="row" style={{ gridColumn: '1 / -1' }}>
              <button className="btn small primary" onClick={createFromLayer}>Save</button>
              <button className="btn small" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}
        {entry && (
          <div className="layer-settings wide" role="group" aria-label={`Edit ${entry.name}`}>
            <div className="muted small" style={{ gridColumn: '1 / -1' }}>Edit <b>{entry.name}</b> ({groupOf(entry)}). Changes are saved at once; the layer only changes when you press Assign.</div>
            <label>Name <input aria-label="Entry name" defaultValue={entry.name} key={pick?.m + ':' + pick?.e + ':n'} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== entry.name) setEntry({ name: v }); else e.target.value = entry.name; }} /></label>
            <label>Mode <select aria-label="Entry mode" value={entry.mode} onChange={(e) => setEntry({ mode: e.target.value as LibraryEntry['mode'] })}><option value="cut">Cut</option><option value="engrave">Engrave</option><option value="score">Score</option></select></label>
            <label>Speed <NumField label="Entry speed" value={entry.speed} min={0.1} step={1} onCommit={(v) => setEntry({ speed: v })} /><small>mm/s</small></label>
            <label>Max power <NumField label="Entry max power" value={entry.power} min={0} max={100} step={1} onCommit={(v) => setEntry({ power: v })} /><small>%</small></label>
            <label>Min power <NumField label="Entry min power" value={entry.minPower} min={0} max={entry.power} step={1} onCommit={(v) => setEntry({ minPower: v })} /><small>%</small></label>
            <label>Passes <NumField label="Entry passes" value={entry.passes} min={1} step={1} onCommit={(v) => Number.isInteger(v) && setEntry({ passes: v })} /></label>
            {entry.mode === 'engrave' && (
              <>
                <label>Interval <NumField label="Entry interval" value={entry.interval ?? 0.1} min={0.01} max={10} step={0.01} onCommit={(v) => setEntry({ interval: v })} /><small>mm</small></label>
                <label>Overscan <NumField label="Entry overscan" value={entry.overscan ?? 1} min={0} max={50} step={0.5} onCommit={(v) => setEntry({ overscan: v })} /><small>mm</small></label>
              </>
            )}
            <label className="inline" style={{ gridColumn: '1 / -1' }} title="Switches the layer's Air on when this setting is assigned (high air pressure on the Ruida)"><input type="checkbox" checked={entry.air} onChange={(e) => setEntry({ air: e.target.checked })} aria-label="Entry air" /> <b>Air assist</b> on when assigned{entry.air ? ' (on)' : ' (off)'}</label>
          </div>
        )}
        {msg && <div className="muted small" role="status">{msg}</div>}
        <p className="muted small">Kept on the computer that runs DemonX Design, one library per laser. Assigning copies the values into the layer, so a saved design does not depend on the library.</p>
      </div>
    </section>
  );
}
