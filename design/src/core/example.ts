import type { Doc } from './types';
import { emptyDoc } from './types';
import { execute } from './commands';

/** A small bracket: plate, two slots-and-holes cut out of it, a kerf-offset outline and an engraved label box. */
export function buildExample(base: Doc = emptyDoc()): Doc {
  let doc = base;
  const step = (id: string, args: any) => {
    const r = execute(doc, id, args);
    doc = r.doc;
    return r.ids ?? [];
  };
  step('layer_set', { name: 'Engrave', mode: 'engrave', speed: 100, power: 20 });
  const [plate] = step('add_rect', { x: 0, y: 0, w: 100, h: 60, layer: 'Layer 1' });
  const [h1] = step('add_circle', { cx: 15, cy: 15, r: 5, layer: 'Layer 1' });
  const [h2] = step('add_circle', { cx: 85, cy: 15, r: 5, layer: 'Layer 1' });
  const [slot] = step('add_path', { points: [[35, 40], [65, 40], [65, 50], [35, 50]], layer: 'Layer 1' });
  const [cutout] = step('add_circle', { cx: 65, cy: 45, r: 7, layer: 'Layer 1' });
  const [slotJoined] = step('boolean', { op: 'union', ids: [slot, cutout] });
  const [part] = step('boolean', { op: 'difference', ids: [plate, h1, h2, slotJoined] });
  step('offset', { ids: [part], distance: 3, join: 'round', keep: true, layer: 'Engrave' });
  step('add_rect', { x: 10, y: 28, w: 40, h: 8, layer: 'Engrave' });
  return doc;
}
