import { useCallback, useEffect, useRef, useState } from 'react';
import type { Doc } from '../core/types';
import { emptyDoc } from '../core/types';
import { CommandError, execute, listCommands, parseLine } from '../core/commands';

export interface LogLine {
  kind: 'in' | 'ok' | 'err' | 'info';
  text: string;
}

interface History {
  past: Doc[];
  present: Doc;
  future: Doc[];
}

const MAX_UNDO = 100;

/** The document, its undo history, the selection (in the order shapes were picked) and the console log. */
export function useDesign() {
  const [hist, setHist] = useState<History>({ past: [], present: emptyDoc(), future: [] });
  const [selection, setSelection] = useState<number[]>([]);
  const [log, setLog] = useState<LogLine[]>([{ kind: 'info', text: 'Type help for the list of commands.' }]);
  const histRef = useRef(hist);
  const selRef = useRef(selection);
  /** The selection, updated right away like the history (see below) */
  const pick = useCallback((ids: number[]) => { selRef.current = ids; setSelection(ids); }, []);

  const say = useCallback((kind: LogLine['kind'], text: string) => setLog((l) => [...l.slice(-199), { kind, text }]), []);

  /**
   * The history is updated right away (histRef), not when React next draws, so two commands sent one after the other
   * (a script, an AI tool) each see the result of the one before, and doc() is never behind.
   */
  const setHistory = useCallback((next: History) => { histRef.current = next; setHist(next); }, []);

  const commit = useCallback((doc: Doc, keepSelection: number[]) => {
    const alive = new Set(doc.shapes.map((s) => s.id));
    const h = histRef.current;
    setHistory({ past: [...h.past.slice(-(MAX_UNDO - 1)), h.present], present: doc, future: [] });
    pick(keepSelection.filter((id) => alive.has(id)));
  }, [setHistory, pick]);

  /** Run one command. Returns true when it worked. Errors go to the console, never throw. */
  const run = useCallback(
    (id: string, args: unknown, echo = true): boolean => {
      try {
        const r = execute(histRef.current.present, id, args);
        if (r.doc !== histRef.current.present) commit(r.doc, r.ids ?? selRef.current);
        if (r.data !== undefined) {
          const text = JSON.stringify(r.data, null, 1);
          say('info', text.length > 1500 ? text.slice(0, 1500) + `\n… (${text.length - 1500} more characters; scripts get all of it)` : text);
        }
        if (echo) say('ok', r.message);
        return true;
      } catch (e) {
        say('err', e instanceof CommandError ? e.message : 'Something went wrong: ' + (e as Error).message);
        return false;
      }
    },
    [commit, say],
  );

  /** The console line: typed or JSON. */
  const runLine = useCallback(
    (line: string) => {
      const text = line.trim();
      if (!text) return;
      say('in', text);
      if (text === 'help') {
        for (const c of listCommands()) say('info', `${c.id} ${c.params}\n  ${c.help}`);
        say('info', 'Short forms: rect x y w h · circle cx cy r · offset mm · union · diff · inter · move dx dy · del · inspect');
        return;
      }
      if (text === 'clear') {
        setLog([]);
        return;
      }
      try {
        const { id, args } = parseLine(text, selRef.current);
        run(id, args);
      } catch (e) {
        say('err', e instanceof CommandError ? e.message : (e as Error).message);
      }
    },
    [run, say],
  );

  const replaceDoc = useCallback((doc: Doc, message: string) => {
    commit(doc, []);
    say('ok', message);
  }, [commit, say]);

  const undo = useCallback(() => {
    const h = histRef.current;
    if (h.past.length) setHistory({ past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] });
  }, [setHistory]);
  const redo = useCallback(() => {
    const h = histRef.current;
    if (h.future.length) setHistory({ past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) });
  }, [setHistory]);

  // keep the selection to shapes that still exist after undo/redo
  useEffect(() => {
    const alive = new Set(hist.present.shapes.map((s) => s.id));
    const cur = selRef.current;
    if (!cur.every((id) => alive.has(id))) pick(cur.filter((id) => alive.has(id)));
  }, [hist.present, pick]);

  return { getDoc: () => histRef.current.present, doc: hist.present, canUndo: hist.past.length > 0, canRedo: hist.future.length > 0, selection, setSelection: pick, log, run, runLine, undo, redo, say, replaceDoc };
}
