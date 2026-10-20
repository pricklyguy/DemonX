/** Put the toolpaths of a design together into G-code files, one per tool. */
import { buildToolpath, type ToolpathResult } from './cam';
import { buildFinish3d, buildRough3d } from './cam3d';
import type { CncData, CncTool, Toolpath } from './cnc';
import { defaultCnc } from './cnc';
import { emitGcode, type Move3, type PostDef } from './post';
import type { Doc } from './types';
import { zAt } from './cam';

export const cncOf = (doc: Doc): CncData => doc.cnc ?? defaultCnc();

export interface GcodeFile {
  tool: CncTool;
  toolpaths: Toolpath[];
  gcode: string;
  warnings: string[];
  stats: { cutLength: number; rapidLength: number; seconds: number; lines: number };
}

export interface JobOptions {
  /** Which toolpaths to write (default: all that are visible) */
  only?: number[];
  home?: { x: number; y: number };
}

/** Why a canvas (a design with no machine) makes no CNC job: it has to be made a CNC job first (on the CNC tab). */
export const CNC_CANVAS_NOTE = 'This design is a canvas, not set up for a machine. Make it a CNC job (CNC tab, Job) to make toolpaths and G-code.';

/** The moves of every toolpath, for drawing and for the file. A canvas has none. */
export function buildAll(doc: Doc, only?: number[]): { tp: Toolpath; tool: CncTool; result: ToolpathResult }[] {
  if (doc.workspace.kind === 'canvas') return [];
  const cnc = cncOf(doc);
  const out: { tp: Toolpath; tool: CncTool; result: ToolpathResult }[] = [];
  for (const tp of cnc.toolpaths) {
    if (only ? !only.includes(tp.id) : !tp.visible) continue;
    const tool = cnc.tools.find((t) => t.id === tp.toolId);
    if (!tool) continue;
    out.push({ tp, tool, result: tp.kind === 'finish3d' ? buildFinish3d(doc, tp, tool) : tp.kind === 'rough3d' ? buildRough3d(doc, tp, tool) : buildToolpath(doc, tp, tool) });
  }
  return out;
}

export function generateFiles(doc: Doc, post: PostDef, opts: JobOptions = {}, prebuilt?: ReturnType<typeof buildAll>): GcodeFile[] {
  if (doc.workspace.kind === 'canvas') return [];   // nothing is written for a canvas, whatever was built before it became one
  const built = prebuilt ?? buildAll(doc, opts.only);
  const byTool = new Map<string, typeof built>();
  for (const b of built) (byTool.get(b.tool.id) ?? byTool.set(b.tool.id, []).get(b.tool.id)!).push(b);
  const files: GcodeFile[] = [];
  for (const group of byTool.values()) {
    const tool = group[0].tool;
    const moves: Move3[] = group.flatMap((g) => g.result.moves);
    if (!moves.length) continue;
    const safe = Math.max(...group.map((g) => g.tp.safeZ));
    const gcode = emitGcode(post, moves, {
      rpm: tool.rpm, feed: tool.feed, plunge: tool.plunge,
      home: { x: opts.home?.x ?? 0, y: opts.home?.y ?? 0, z: zAt(doc, -safe) },
      comments: [`Tool: ${tool.name}`, `Toolpaths: ${group.map((g) => g.tp.name).join(', ')}`, `Diameter ${tool.diameter} mm, ${tool.rpm} rpm, feed ${tool.feed} mm/min`],
    });
    files.push({
      tool, toolpaths: group.map((g) => g.tp), gcode,
      warnings: group.flatMap((g) => g.result.warnings.map((w) => `${g.tp.name}: ${w}`)),
      stats: {
        cutLength: group.reduce((n, g) => n + g.result.stats.cutLength, 0),
        rapidLength: group.reduce((n, g) => n + g.result.stats.rapidLength, 0),
        seconds: group.reduce((n, g) => n + g.result.stats.seconds, 0),
        lines: gcode.split('\n').length - 1,
      },
    });
  }
  return files;
}
