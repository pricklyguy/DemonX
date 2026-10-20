import { createContext, useContext, useState, type ReactNode } from 'react';
import type { CncTool, ToolKind } from '../core/cnc';
import type { ToolLibrary } from '../core/toollib';
import { ToolDatabase } from './ToolDatabase';

/** What the toolpath panels need to offer the tool library: the library, the job's machine and material, and a way to put a tool in the job. */
export interface ToolPickContext {
  lib: ToolLibrary;
  machine: string;
  material: string;
  setFilters: (f: { machine?: string; material?: string }) => void;
  /** Add (or update) a tool in the job. Returns false when the job refused it. */
  addTool: (t: CncTool) => boolean;
  say: (kind: 'ok' | 'err' | 'info', text: string) => void;
}
const Ctx = createContext<ToolPickContext | null>(null);
export const ToolPickProvider = ({ value, children }: { value: ToolPickContext; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useToolPick = () => useContext(Ctx);

/** A tool choice for a toolpath panel: the job's tools in a list, and a button for the tool library when there is one. */
export function ToolField({ label, value, tools, accept, onChange }: {
  label: string;
  value: string;
  /** The tools of the job this toolpath can use */
  tools: CncTool[];
  accept: (kind: ToolKind) => boolean;
  onChange: (id: string) => void;
}) {
  const ctx = useToolPick();
  const [open, setOpen] = useState(false);
  const cur = tools.find((t) => t.id === value);
  return (
    <>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {tools.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {cur && <span className="small muted">⌀ {Math.round(cur.diameter * 1000) / 1000} mm · {cur.rpm} rpm · feed {Math.round(cur.feed)} · plunge {Math.round(cur.plunge)} mm/min · {cur.stepdown} mm/pass</span>}
      {ctx && ctx.lib.tools.length > 0 && <button type="button" className="btn small" onClick={() => setOpen(true)} title="Open the tool library to pick a cutter and change its numbers for this cut">Select from the library…</button>}
      {open && ctx && <ToolDatabase mode="pick" lib={ctx.lib} machine={ctx.machine} material={ctx.material} setFilters={ctx.setFilters} accept={accept} jobTools={tools}
        onUse={(t) => { if (ctx.addTool(t)) { onChange(t.id); return true; } return false; }} onClose={() => setOpen(false)} say={ctx.say} />}
    </>
  );
}
