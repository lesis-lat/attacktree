/**
 * Canvas edits are applied to the YAML document itself (not to a separate model),
 * so the text stays the single source of truth and keeps the user's comments.
 */
import { type Document, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { type DeclaredKind, KIND_SECTION, type Point, type SectionKey, SECTIONS } from './types';

const ROOT_ORDER = ['title', 'theme', 'facts', 'attacks', 'mitigations', 'goals', 'filter', 'positions'];

export class MutationError extends Error {}

type Doc = Document.Parsed;

function load(text: string): Doc {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new MutationError('Fix the YAML errors before editing on the canvas');
  return doc;
}

/** deciduous files write list items flush with their key ("facts:\n- a: b"); keep whichever style is in use */
function usesIndentedSeqs(text: string): boolean {
  const flush = /^[A-Za-z_][\w-]*:[ \t]*\r?\n-[ \t]/m.test(text);
  const indented = /^[A-Za-z_][\w-]*:[ \t]*\r?\n[ \t]+-[ \t]/m.test(text);
  return indented || !flush;
}

function dump(doc: Doc, original: string): string {
  return doc.toString({ indentSeq: usesIndentedSeqs(original), lineWidth: 0, nullStr: '', singleQuote: true });
}

function keyOf(node: unknown): string | null {
  return isScalar(node) && node.value != null ? String(node.value) : null;
}

function rootMap(doc: Doc): YAMLMap {
  if (doc.contents == null) doc.contents = new YAMLMap() as never;
  if (!isMap(doc.contents)) throw new MutationError('The document must be a mapping');
  return doc.contents as YAMLMap;
}

interface Located {
  section: SectionKey;
  seq: YAMLSeq;
  index: number;
  item: YAMLMap;
}

function* declarations(doc: Doc): Generator<Located> {
  const root = rootMap(doc);
  for (const section of SECTIONS) {
    const seq = root.get(section, true);
    if (!isSeq(seq)) continue;
    for (let index = 0; index < seq.items.length; index++) {
      const item = seq.items[index];
      if (isMap(item) && item.items.length > 0) yield { section, seq, index, item };
    }
  }
}

function locate(doc: Doc, id: string): Located | null {
  for (const d of declarations(doc)) if (keyOf(d.item.items[0].key) === id) return d;
  return null;
}

function mustLocate(doc: Doc, id: string): Located {
  const found = locate(doc, id);
  if (!found) throw new MutationError(`"${id}" is not declared`);
  return found;
}

function sectionSeq(doc: Doc, section: SectionKey): YAMLSeq {
  const root = rootMap(doc);
  const existing = root.items.find((p) => keyOf(p.key) === section);
  if (existing && isSeq(existing.value)) {
    existing.value.flow = false;
    return existing.value;
  }
  const seq = new YAMLSeq();
  if (existing) {
    existing.value = seq;
    return seq;
  }
  const key = new Scalar(section);
  key.spaceBefore = root.items.length > 0;
  const pair = doc.createPair(key, seq);
  const order = ROOT_ORDER.indexOf(section);
  let at = root.items.length;
  for (let i = 0; i < root.items.length; i++) {
    const o = ROOT_ORDER.indexOf(keyOf(root.items[i].key) ?? '');
    if (o > order) {
      at = i;
      break;
    }
  }
  root.items.splice(at, 0, pair);
  return seq;
}

function fromSeq(item: YAMLMap): YAMLSeq | null {
  const value = item.get('from', true);
  return isSeq(value) ? value : null;
}

function entrySource(entry: unknown): string | null {
  if (isScalar(entry)) return entry.value == null ? null : String(entry.value);
  if (isMap(entry) && entry.items.length > 0) return keyOf(entry.items[0].key);
  return null;
}

export interface EdgeProps {
  label?: string;
  backwards: boolean;
  implemented: boolean;
  ungrouped: boolean;
}

function entryProps(entry: unknown): EdgeProps {
  const props: EdgeProps = { backwards: false, implemented: true, ungrouped: false };
  if (isMap(entry)) {
    const [head, ...siblings] = entry.items;
    const nested = isMap(head?.value) ? head.value.items : [];
    const label = isScalar(head?.value) ? head.value.value : null;
    if (typeof label === 'string' && label !== '') props.label = label;
    for (const pair of [...nested, ...siblings]) {
      const key = keyOf(pair.key);
      if (key === 'label' && isScalar(pair.value) && typeof pair.value.value === 'string') props.label = pair.value.value;
      const value = isScalar(pair.value) ? pair.value.value : undefined;
      if (typeof value !== 'boolean') continue;
      if (key === 'backwards') props.backwards = value;
      if (key === 'implemented') props.implemented = value;
      if (key === 'ungrouped') props.ungrouped = value;
    }
  }
  return props;
}

function makeEntry(doc: Doc, source: string, props: EdgeProps): unknown {
  if (!props.label && !props.backwards && props.implemented && !props.ungrouped) return doc.createNode(source);
  const map = new YAMLMap();
  map.add(doc.createPair(source, props.label ? props.label : null));
  if (props.backwards) map.add(doc.createPair('backwards', true));
  if (!props.implemented) map.add(doc.createPair('implemented', false));
  if (props.ungrouped) map.add(doc.createPair('ungrouped', true));
  return map;
}

function dropEmptyFrom(item: YAMLMap) {
  const seq = fromSeq(item);
  if (seq && seq.items.length === 0) item.delete('from');
}

export function slugify(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  return slug === '' || /^\d/.test(slug) ? `node_${slug}`.replace(/_+$/, '') : slug;
}

function usedIds(doc: Doc): Set<string> {
  const ids = new Set<string>(['reality', 'from']);
  for (const d of declarations(doc)) {
    const id = keyOf(d.item.items[0].key);
    if (id) ids.add(id);
  }
  return ids;
}

function uniqueId(doc: Doc, base: string): string {
  const used = usedIds(doc);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

// ---------------------------------------------------------------------------

export function addNode(
  text: string,
  options: { kind: DeclaredKind; label: string; from?: string[] },
): { text: string; id: string } {
  const doc = load(text);
  const id = uniqueId(doc, slugify(options.label));
  const map = new YAMLMap();
  map.add(doc.createPair(id, options.label));
  if (options.from && options.from.length > 0) map.add(doc.createPair('from', doc.createNode(options.from)));
  sectionSeq(doc, KIND_SECTION[options.kind]).items.push(map);
  return { text: dump(doc, text), id };
}

export function connect(text: string, source: string, target: string, backwards = false): string {
  if (source === target) throw new MutationError('A node cannot come from itself');
  if (target === 'reality') throw new MutationError('Nothing can lead into Reality');
  const doc = load(text);
  const { item } = mustLocate(doc, target);
  let seq = fromSeq(item);
  if (!seq) {
    seq = new YAMLSeq();
    item.set('from', seq);
  }
  seq.flow = false;
  for (const entry of seq.items) {
    if (entrySource(entry) === source && entryProps(entry).backwards === backwards) return text;
  }
  seq.items.push(makeEntry(doc, source, { backwards, implemented: true, ungrouped: false }));
  return dump(doc, text);
}

export function removeEdge(text: string, target: string, fromIndex: number): string {
  const doc = load(text);
  const { item } = mustLocate(doc, target);
  const seq = fromSeq(item);
  if (!seq || fromIndex >= seq.items.length) return text;
  seq.items.splice(fromIndex, 1);
  dropEmptyFrom(item);
  return dump(doc, text);
}

export function updateEdge(text: string, target: string, fromIndex: number, patch: Partial<EdgeProps>): string {
  const doc = load(text);
  const { item } = mustLocate(doc, target);
  const seq = fromSeq(item);
  const entry = seq?.items[fromIndex];
  const source = entrySource(entry);
  if (!seq || !source) throw new MutationError('That connection no longer exists');
  const props = { ...entryProps(entry), ...patch };
  if (patch.label !== undefined && patch.label.trim() === '') props.label = undefined;
  seq.items[fromIndex] = makeEntry(doc, source, props);
  return dump(doc, text);
}

export function removeNodes(text: string, ids: string[]): string {
  const doomed = new Set(ids.filter((id) => id !== 'reality'));
  if (doomed.size === 0) return text;
  const doc = load(text);
  for (const id of doomed) {
    const found = locate(doc, id);
    if (found) found.seq.items.splice(found.index, 1);
  }
  for (const { item } of declarations(doc)) {
    const seq = fromSeq(item);
    if (!seq) continue;
    seq.items = seq.items.filter((entry) => !doomed.has(entrySource(entry) ?? ''));
    dropEmptyFrom(item);
  }
  const filter = rootMap(doc).get('filter', true);
  if (isSeq(filter)) filter.items = filter.items.filter((e) => !doomed.has(entrySource(e) ?? ''));
  const positions = positionsMap(doc);
  if (positions) {
    positions.items = positions.items.filter((p) => !doomed.has(keyOf(p.key) ?? ''));
    dropEmptyPositions(doc);
  }
  return dump(doc, text);
}

export function setLabel(text: string, id: string, label: string): string {
  const doc = load(text);
  const { item } = mustLocate(doc, id);
  item.items[0].value = doc.createNode(label);
  return dump(doc, text);
}

export function setKind(text: string, id: string, kind: DeclaredKind): string {
  const doc = load(text);
  const found = mustLocate(doc, id);
  const section = KIND_SECTION[kind];
  if (found.section === section) return text;
  found.seq.items.splice(found.index, 1);
  sectionSeq(doc, section).items.push(found.item);
  return dump(doc, text);
}

export function validateId(text: string, oldId: string, newId: string): string | null {
  if (newId === oldId) return null;
  if (!/^[A-Za-z_][\w-]*$/.test(newId)) return 'Use letters, digits, "_" or "-", starting with a letter';
  const doc = parseDocument(text);
  if (usedIds(doc).has(newId)) return `"${newId}" is already taken`;
  return null;
}

export function renameId(text: string, oldId: string, newId: string): string {
  const problem = validateId(text, oldId, newId);
  if (problem) throw new MutationError(problem);
  if (newId === oldId) return text;
  const doc = load(text);
  const { item } = mustLocate(doc, oldId);
  item.items[0].key = doc.createNode(newId);
  const rename = (entry: unknown) => {
    if (isScalar(entry) && String(entry.value) === oldId) entry.value = newId;
    else if (isMap(entry) && keyOf(entry.items[0]?.key) === oldId) entry.items[0].key = doc.createNode(newId);
  };
  for (const d of declarations(doc)) fromSeq(d.item)?.items.forEach(rename);
  const filter = rootMap(doc).get('filter', true);
  if (isSeq(filter)) filter.items.forEach(rename);
  for (const pair of positionsMap(doc)?.items ?? []) {
    if (keyOf(pair.key) === oldId) pair.key = doc.createNode(newId);
  }
  return dump(doc, text);
}

// --- manual positions --------------------------------------------------------------

const POSITIONS_NOTE = ' Where nodes were dragged on the canvas. Remove a line to lay that node out automatically again.';

function positionsMap(doc: Doc): YAMLMap | null {
  const value = rootMap(doc).get('positions', true);
  return isMap(value) ? value : null;
}

function dropEmptyPositions(doc: Doc) {
  const map = positionsMap(doc);
  if (map && map.items.length === 0) rootMap(doc).delete('positions');
}

export function setPositions(text: string, moved: Record<string, Point>): string {
  const ids = Object.keys(moved);
  if (ids.length === 0) return text;
  const doc = load(text);
  const root = rootMap(doc);
  let map = positionsMap(doc);
  if (!map) {
    map = new YAMLMap();
    const key = new Scalar('positions');
    key.spaceBefore = root.items.length > 0;
    key.commentBefore = POSITIONS_NOTE;
    root.items = root.items.filter((p) => keyOf(p.key) !== 'positions');
    root.items.push(doc.createPair(key, map));
  }
  map.flow = false;
  for (const id of ids) {
    const xy = doc.createNode([Math.round(moved[id].x), Math.round(moved[id].y)]) as YAMLSeq;
    xy.flow = true;
    const existing = map.items.find((p) => keyOf(p.key) === id);
    if (existing) existing.value = xy;
    else map.items.push(doc.createPair(id, xy));
  }
  return dump(doc, text);
}

/** Forget manual positions: for the given ids, or all of them. */
export function clearPositions(text: string, ids?: string[]): string {
  const doc = load(text);
  const map = positionsMap(doc);
  if (!map) return text;
  if (ids) map.items = map.items.filter((p) => !ids.includes(keyOf(p.key) ?? ''));
  else map.items = [];
  dropEmptyPositions(doc);
  return dump(doc, text);
}
