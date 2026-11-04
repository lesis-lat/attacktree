import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import {
  type Diagnostic,
  type NodeKind,
  type Point,
  type Range,
  SECTION_KIND,
  type SectionKey,
  SECTIONS,
  type Tree,
  type TreeEdge,
  type TreeNode,
  KIND_LABEL,
} from './types';

const TOP_LEVEL = new Set<string>(['title', 'theme', 'dark', 'legend', 'filter', 'positions', ...SECTIONS]);
const EDGE_FLAGS = new Set(['backwards', 'ungrouped', 'implemented']);

export function defaultLabel(id: string): string {
  return id.replace(/_/g, ' ').replace(/^[a-z]/, (c) => c.toUpperCase());
}

function rangeOf(node: unknown): Range | undefined {
  const r = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return r ? { from: r[0], to: Math.max(r[1], r[0] + 1) } : undefined;
}

/** "key:" with nothing after it: yaml gives the value as an empty scalar, not as null */
function isEmpty(node: unknown): boolean {
  return node == null || (isScalar(node) && node.value == null);
}

/** where to point at a pair's value; an empty value has no text of its own, so point at its key */
function valueRange(pair: { key: unknown; value: unknown }): Range | undefined {
  return (isEmpty(pair.value) ? undefined : rangeOf(pair.value)) ?? rangeOf(pair.key);
}

/** string for scalars, null for empty values, undefined for collections */
function scalarText(node: unknown): string | null | undefined {
  if (node == null) return null;
  if (isScalar(node)) return node.value == null ? null : String(node.value);
  return undefined;
}

function firstLine(message: string): string {
  return message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
}

function article(kind: NodeKind): string {
  const word = KIND_LABEL[kind].toLowerCase();
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

export function parseTree(text: string): Tree {
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<string, TreeNode>();
  const rawEdges: TreeEdge[] = [];
  const filter: string[] = [];
  const filterRefs: Array<{ id: string; range: Range }> = [];
  // no prototype: "__proto__" or "constructor" are valid node ids
  const positions: Record<string, Point> = Object.create(null);
  const positionRefs: Array<{ id: string; range?: Range }> = [];
  const refs: Array<{ id: string; range?: Range }> = [];
  let title = '';
  let theme: string | undefined;

  const fallback: Range = { from: 0, to: Math.min(1, text.length) };
  const report = (severity: Diagnostic['severity'], range: Range | undefined, message: string) => {
    diagnostics.push({ ...(range ?? fallback), severity, message });
  };

  const doc = parseDocument(text, { prettyErrors: false });
  for (const e of doc.errors) {
    report('error', { from: e.pos[0], to: Math.max(e.pos[1], e.pos[0] + 1) }, firstLine(e.message));
  }
  for (const w of doc.warnings) {
    report('warning', { from: w.pos[0], to: Math.max(w.pos[1], w.pos[0] + 1) }, firstLine(w.message));
  }
  const syntaxCount = diagnostics.length;

  const parseFrom = (target: string, value: unknown) => {
    if (isEmpty(value)) return;
    if (!isSeq(value)) {
      report('error', rangeOf(value), '"from" must be a list of node ids');
      return;
    }
    value.items.forEach((entry, index) => {
      let source: string | null | undefined;
      let sourceRange: Range | undefined;
      let label: string | undefined;
      let backwards = false;
      let implemented = true;
      let ungrouped = false;

      if (isScalar(entry)) {
        source = scalarText(entry);
        sourceRange = rangeOf(entry);
      } else if (isMap(entry) && entry.items.length > 0) {
        const [head, ...siblings] = entry.items;
        source = scalarText(head.key);
        sourceRange = rangeOf(head.key);
        // Deciduous writes flags beside the id; "- id: {backwards: true}" (flags nested under it) is accepted too.
        const nested = isMap(head.value) ? head.value.items : [];
        const text = nested.length ? undefined : scalarText(head.value);
        if (typeof text === 'string' && text !== '') label = text;
        else if (text === undefined && !nested.length) report('warning', rangeOf(head.value), 'Edge labels should be plain text');
        for (const pair of [...nested, ...siblings]) {
          const key = scalarText(pair.key);
          if (key === 'label' && nested.includes(pair)) {
            const v = scalarText(pair.value);
            if (typeof v === 'string' && v !== '') label = v;
          } else if (typeof key === 'string' && EDGE_FLAGS.has(key)) {
            const flag = isScalar(pair.value) ? pair.value.value : undefined;
            if (typeof flag !== 'boolean') {
              report('error', valueRange(pair), `"${key}" must be true or false`);
            } else if (key === 'backwards') backwards = flag;
            else if (key === 'implemented') implemented = flag;
            else ungrouped = flag;
          } else {
            report('warning', rangeOf(pair.key), `Unknown edge property "${key}"`);
          }
        }
      } else {
        report('error', rangeOf(entry), 'Each "from" entry must be a node id');
        return;
      }

      if (typeof source !== 'string' || source === '') {
        report('error', rangeOf(entry), 'Missing node id');
        return;
      }
      if (source === target) {
        report('warning', sourceRange, `"${target}" cannot come from itself`);
        return;
      }
      rawEdges.push({
        id: `${target}:${index}`,
        source,
        target,
        label,
        backwards,
        implemented,
        ungrouped,
        fromIndex: index,
        range: rangeOf(entry),
        sourceRange,
      });
      refs.push({ id: source, range: sourceRange });
    });
  };

  const declare = (item: unknown, section: SectionKey) => {
    if (!isMap(item) || item.items.length === 0) {
      report('error', rangeOf(item), 'Each node is written as "- id: label"');
      return;
    }
    const [head, ...rest] = item.items;
    const id = scalarText(head.key);
    if (typeof id !== 'string' || id === '') {
      report('error', rangeOf(head.key) ?? rangeOf(item), 'Missing node id');
      return;
    }
    if (id === 'from') {
      report('error', rangeOf(head.key), 'The first key of a node is its id; "from" goes after it');
      return;
    }
    const existing = nodes.get(id);
    if (existing) {
      report('error', rangeOf(head.key), `"${id}" is already declared as ${article(existing.kind)}`);
      return;
    }
    const rawLabel = scalarText(head.value);
    if (rawLabel === undefined) report('warning', rangeOf(head.value), 'Node labels should be plain text');
    const isReality = id === 'reality';
    const label =
      typeof rawLabel === 'string' && rawLabel.trim() !== ''
        ? rawLabel
        : isReality
          ? 'Reality'
          : defaultLabel(id);

    nodes.set(id, {
      id,
      kind: isReality ? 'reality' : SECTION_KIND[section],
      label,
      declared: true,
      range: rangeOf(item),
      keyRange: rangeOf(head.key),
    });

    for (const pair of rest) {
      const key = scalarText(pair.key);
      if (key === 'from') parseFrom(id, pair.value);
      else report('warning', rangeOf(pair.key), `Unknown node property "${key}"`);
    }
  };

  const root = doc.contents;
  if (root != null && !isMap(root)) {
    report('error', rangeOf(root), 'The document must be a mapping (title, facts, attacks, mitigations, goals)');
  }
  if (isMap(root)) {
    for (const pair of root.items) {
      const key = scalarText(pair.key);
      const keyRange = rangeOf(pair.key);
      if (typeof key !== 'string') continue;
      if (!TOP_LEVEL.has(key)) {
        report('warning', keyRange, `Unknown section "${key}"`);
        continue;
      }
      const value = pair.value;
      switch (key) {
        case 'title': {
          const v = scalarText(value);
          if (typeof v === 'string') title = v;
          else if (v === undefined) report('error', rangeOf(value), 'The title must be text');
          break;
        }
        case 'theme': {
          const v = scalarText(value);
          if (typeof v === 'string') theme = v;
          break;
        }
        case 'filter': {
          if (isEmpty(value)) break;
          if (!isSeq(value)) {
            report('error', rangeOf(value), '"filter" must be a list of node ids');
            break;
          }
          for (const entry of value.items) {
            const v = scalarText(entry);
            if (typeof v === 'string' && v !== '') {
              filter.push(v);
              refs.push({ id: v, range: rangeOf(entry) });
              const range = rangeOf(entry);
              if (range) filterRefs.push({ id: v, range });
            } else {
              report('error', rangeOf(entry), 'Each filter entry must be a node id');
            }
          }
          break;
        }
        case 'positions': {
          if (isEmpty(value)) break;
          if (!isMap(value)) {
            report('error', rangeOf(value), '"positions" maps node ids to [x, y]');
            break;
          }
          for (const entry of value.items) {
            const id = scalarText(entry.key);
            const xy = isSeq(entry.value) ? entry.value.items.map((n) => (isScalar(n) ? n.value : null)) : [];
            if (typeof id !== 'string' || xy.length !== 2 || !xy.every((n) => typeof n === 'number' && Number.isFinite(n))) {
              report('error', valueRange(entry), 'Write a position as "id: [x, y]"');
              continue;
            }
            positions[id] = { x: xy[0] as number, y: xy[1] as number };
            positionRefs.push({ id, range: rangeOf(entry.key) });
          }
          break;
        }
        case 'dark':
        case 'legend':
          break;
        default: {
          if (isEmpty(value)) break;
          if (!isSeq(value)) {
            report('error', rangeOf(value) ?? keyRange, `"${key}" must be a list`);
            break;
          }
          for (const item of value.items) declare(item, key as SectionKey);
        }
      }
    }
  }

  // Resolve references: the implicit root and anything used but never declared.
  for (const ref of refs) {
    if (nodes.has(ref.id)) continue;
    nodes.set(
      ref.id,
      ref.id === 'reality'
        ? { id: 'reality', kind: 'reality', label: 'Reality', declared: false }
        : { id: ref.id, kind: 'fact', label: defaultLabel(ref.id), declared: false },
    );
  }
  for (const ref of refs) {
    const node = nodes.get(ref.id)!;
    if (!node.declared && node.kind !== 'reality') {
      report('warning', ref.range, `"${ref.id}" is not declared in facts, attacks, mitigations or goals`);
    }
  }

  for (const ref of positionRefs) {
    if (!nodes.has(ref.id)) report('warning', ref.range, `"${ref.id}" has a position but is not a node`);
  }

  // Drop exact duplicates so the graph stays clean, but say so.
  const seen = new Set<string>();
  const edges: TreeEdge[] = [];
  for (const edge of rawEdges) {
    if (!nodes.has(edge.target)) continue;
    const key = `${edge.source}->${edge.target}:${edge.backwards}`;
    if (seen.has(key)) {
      report('warning', edge.sourceRange, `"${edge.target}" already comes from "${edge.source}"`);
      continue;
    }
    seen.add(key);
    edges.push(edge);
  }

  const ordered = [...nodes.values()].sort((a, b) => Number(b.kind === 'reality') - Number(a.kind === 'reality'));
  const syntaxError = doc.errors.length > 0;
  // While the YAML itself is broken, only its own errors matter; the rest is noise.
  const shown = syntaxError ? diagnostics.slice(0, syntaxCount) : diagnostics;
  shown.sort((a, b) => a.from - b.from);

  return {
    title,
    theme,
    nodes: ordered,
    edges,
    filter,
    filterRefs,
    positions,
    diagnostics: shown,
    syntaxError,
  };
}
