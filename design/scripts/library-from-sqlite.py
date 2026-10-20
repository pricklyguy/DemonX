#!/usr/bin/env python3
"""Turn the DemonX CNC Master tool library (SQLite) into the JSON file DemonX Design imports.

  python3 -I scripts/library-from-sqlite.py DemonX_CNC_Master.sqlite tool-library.json

Reads the file read-only. Uses owned_tools, curated_tool_status and curated_recipes. Geometry (kind, diameter, V angle) is
taken only from what those tables say; a tool without a diameter or a kind is written as "pending" and is not usable in a
job until it is filled in in Design. Nothing is guessed from the big Vectric catalogue tables.
"""
import json, re, sqlite3, sys

IN = 25.4
KINDS = [('drill', 'drill'), ('ball', 'ball'), ('v-bit', 'vbit'), ('vbit', 'vbit')]
OTHER_WORDS = ('drag', 'keyhole', 'key hole', 't-slot', 'slot cutter')
FLAT_WORDS = ('end mill', 'downcut', 'upcut', 'compression', 'roughing', 'surfacing', 'o-flute', 'o flute')


def frac(s):
    s = s.strip()
    if '/' in s:
        a, b = s.split('/')
        return float(a) / float(b)
    return float(s)


NUM = r'(\d+/\d+|\d*\.\d+|\d+)'


def from_notes(text):
    """Pull 'N inch ball tip' / 'N in cutter' / 'N inch face' out of the geometry notes. Returns (kind, diameter_mm)."""
    t = (text or '').lower()
    m = re.search(NUM + r'\s*(?:inch|in)\s+ball tip', t)
    if m: return 'ball', frac(m.group(1)) * IN
    m = re.search(NUM + r'\s*(?:inch|in)\s+(?:cutter|face|shank and cutter|o-flute)', t)
    if m: return None, frac(m.group(1)) * IN
    return None, None


def norm(model):
    """The recipes say PCB-1.0MM where the tool list says PCB-1MM."""
    return re.sub(r'(\d+)\.0MM$', r'\1MM', (model or '').replace('°', ' degrees'))


def build(db):
    c = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
    c.row_factory = sqlite3.Row
    status = {r['model']: r for r in c.execute('select * from curated_tool_status')}
    recipes = {}
    for r in c.execute('select * from curated_recipes order by id'):
        inch = (r['units'] or '').startswith('IPM')
        k = IN if inch else 1.0
        rec = {'machine': r['machine'], 'material': r['material'], 'status': r['status']}
        for key, val, scale in (('rpm', r['rpm'], 1), ('feed', r['feed'], k), ('plunge', r['plunge'], k), ('passDepth', r['pass_depth'], k), ('stepoverMm', r['stepover'], k)):
            if val is not None: rec[key] = round(val * scale, 4)
        notes = ' '.join(x for x in (r['provenance'], r['notes']) if x)
        if notes: rec['notes'] = notes
        recipes.setdefault(norm(r['model']), []).append(rec)
    tools = []
    for o in c.execute('select * from owned_tools order by tool_id'):
        part = o['part_number']
        st = None
        for key in dict.fromkeys([part] + (part or '').split(' / ')):
            if key in status: st = status[key]; break
        name = o['name'] or part or o['tool_id']
        low = (name + ' ' + (o['notes'] or '') + ' ' + ((st['geometry_notes'] or '') + ' ' + (st['workflow_notes'] or '') if st else '')).lower()
        kind = None
        for word, k in KINDS:
            if word in low: kind = k; break
        if any(w in low for w in OTHER_WORDS): kind = 'other'   # cutters Design has no toolpath for (drags, keyholes)
        if kind is None and o['angle_deg']: kind = 'vbit'
        if kind is None and o['tip_mm'] and 'taper' in low: kind = 'ball'
        if kind is None and any(w in low for w in FLAT_WORDS): kind = 'flat'
        dia = o['cutter_in'] * IN if o['cutter_in'] else None
        if o['tip_mm'] and kind == 'ball': dia = o['tip_mm']
        n_kind, n_dia = from_notes(st['geometry_notes'] if st else '')
        if kind is None and n_kind: kind = n_kind
        if dia is None and n_dia: dia = n_dia
        if kind in ('vbit',) and dia is None: dia = None   # a V-bit's widest cut is not in the library: left pending
        tool = {'id': o['tool_id'], 'name': name}
        if o['manufacturer']: tool['manufacturer'] = o['manufacturer']
        if part: tool['part'] = part
        tool['kind'] = kind
        if dia: tool['diameter'] = round(dia, 4)
        if o['angle_deg']: tool['vAngle'] = o['angle_deg']
        if o['flutes']: tool['flutes'] = o['flutes']
        if o['shank_in']: tool['shank'] = round(o['shank_in'] * IN, 4)
        if st:
            if st['usage_priority']: tool['priority'] = st['usage_priority']
            if st['ownership']: tool['ownership'] = st['ownership']
            note = ' '.join(x for x in (st['geometry_notes'], st['workflow_notes']) if x)
            if note: tool['notes'] = note
        elif o['notes']:
            tool['notes'] = o['notes']
        rs = []
        for key in dict.fromkeys([norm(part), norm(o['name'])] + (part or '').split(' / ')):
            rs += recipes.pop(key, [])
        tool['recipes'] = rs
        tools.append(tool)
    for model, left in recipes.items():
        print('Recipes for %s were not matched to a tool and are left out (%d)' % (model, len(left)), file=sys.stderr)
    return {'v': 1, 'tools': tools}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    lib = build(sys.argv[1])
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump(lib, f, indent=1, ensure_ascii=False)
        f.write('\n')
    ok = sum(1 for t in lib['tools'] if t['kind'] and t.get('diameter'))
    print('%d tools, %d with a kind and a diameter, %d recipes' % (len(lib['tools']), ok, sum(len(t['recipes']) for t in lib['tools'])))
