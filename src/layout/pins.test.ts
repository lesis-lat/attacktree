import { describe, expect, it } from 'vitest';
import { parseTree } from '../model/parse';
import type { Tree } from '../model/types';
import type { Layout, PlacedEdge, PlacedNode } from './layout';
import { connector, withPins } from './pins';

const TEXT = `attacks:
- a: A
  from:
  - reality
- b: B
  from:
  - a: label
mitigations:
- m: M
  from:
  - a
- back: Sends back
  from:
  - b
`;

function node(id: string, x: number, y: number, width = 100, height = 40): PlacedNode {
  return { id, x, y, width, height, lines: [id] };
}

function fixture(): { tree: Tree; base: Layout } {
  const tree = parseTree(TEXT);
  // add a backwards edge back -> a
  tree.edges.push({ ...tree.edges[0], id: 'a:1', source: 'back', target: 'a', backwards: true, label: undefined, fromIndex: 1 });
  const nodes = new Map<string, PlacedNode>([
    ['reality', node('reality', 100, 48)],
    ['a', node('a', 100, 150)],
    ['b', node('b', 0, 250)],
    ['m', node('m', 200, 250)],
    ['back', node('back', 0, 350)],
  ]);
  const edges = new Map<string, PlacedEdge>([
    ['a:0', { id: 'a:0', path: 'M150,88 L150,150' }],
    ['b:0', { id: 'b:0', path: 'M150,190 L50,250', label: { x: 100, y: 220, width: 40, height: 20, lines: ['label'] } }],
    ['m:0', { id: 'm:0', path: 'M150,190 L250,250' }],
    ['back:0', { id: 'back:0', path: 'M50,290 L50,350' }],
    ['a:1', { id: 'a:1', path: 'M50,350 L150,190' }],
  ]);
  return { tree, base: { key: 'k', nodes, edges, bounds: { x: 0, y: 0, width: 348, height: 438 } } };
}

const nums = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);
const start = (d: string) => nums(d).slice(0, 2);
const end = (d: string) => nums(d).slice(-2);

describe('connector', () => {
  const s = { x: 0, y: 0, width: 100, height: 40 };
  const t = { x: 200, y: 200, width: 60, height: 30 };

  it('runs from the bottom of the source to the top of the target', () => {
    const { path, label } = connector(s, t, false);
    expect(start(path)).toEqual([50, 40]);
    expect(end(path)).toEqual([230, 200]);
    // rounded corners, like the ELK routes
    expect(path).toContain('Q');
    expect(label.x).toBeCloseTo(140);
    expect(label.y).toBeCloseTo(120);
  });

  it('runs from the top of the source to the bottom of the target when backwards', () => {
    const { path, label } = connector(t, s, true);
    expect(start(path)).toEqual([230, 200]);
    expect(end(path)).toEqual([50, 40]);
    expect(label.x).toBeCloseTo(140);
    expect(label.y).toBeCloseTo(120);
  });
});

describe('withPins', () => {
  it('returns the layout untouched without pins', () => {
    const { tree, base } = fixture();
    expect(withPins(base, tree, {})).toBe(base);
  });

  it('ignores pins for nodes that are not in the layout', () => {
    const { tree, base } = fixture();
    expect(withPins(base, tree, { ghost: { x: 1, y: 2 }, hidden: { x: 3, y: 4 } })).toBe(base);
  });

  it('moves pinned nodes and reroutes only the edges that touch them', () => {
    const { tree, base } = fixture();
    const out = withPins(base, tree, { b: { x: 400, y: 500 }, nowhere: { x: 0, y: 0 } });
    expect(out).not.toBe(base);
    expect(out.key).toBe(base.key);
    expect(out.nodes.get('b')).toEqual({ ...base.nodes.get('b'), x: 400, y: 500 });
    for (const id of ['reality', 'a', 'm', 'back']) expect(out.nodes.get(id)).toBe(base.nodes.get(id));
    expect(out.nodes.has('nowhere')).toBe(false);
    // the base layout is not mutated
    expect(base.nodes.get('b')).toMatchObject({ x: 0, y: 250 });

    for (const id of ['a:0', 'm:0', 'a:1']) expect(out.edges.get(id)).toBe(base.edges.get(id));
    const into = out.edges.get('b:0')!;
    const fromB = out.edges.get('back:0')!;
    const a = out.nodes.get('a')!;
    const b = out.nodes.get('b')!;
    const back = out.nodes.get('back')!;
    expect(into).toEqual({ id: 'b:0', free: true, ...connector(a, b, false), label: expect.any(Object) });
    expect(start(into.path)).toEqual([a.x + a.width / 2, a.y + a.height]);
    expect(end(into.path)).toEqual([b.x + b.width / 2, b.y]);
    // the label keeps its box and sits halfway along the new connector
    const mid = connector(a, b, false).label;
    expect(into.label).toEqual({ x: mid.x, y: mid.y, width: 40, height: 20, lines: ['label'] });
    expect(fromB).toEqual({ id: 'back:0', path: connector(b, back, false).path, free: true, label: undefined });
  });

  it('reroutes backwards edges with a backwards connector', () => {
    const { tree, base } = fixture();
    const out = withPins(base, tree, { back: { x: 300, y: 600 } });
    const e = out.edges.get('a:1')!;
    expect(e.free).toBe(true);
    expect(e.path).toBe(connector(out.nodes.get('back')!, out.nodes.get('a')!, true).path);
    expect(start(e.path)).toEqual([350, 600]);
    expect(end(e.path)).toEqual([150, 190]);
  });

  it('recomputes the bounds around nodes and labels, with padding', () => {
    const { tree, base } = fixture();
    const out = withPins(base, tree, { reality: { x: -200, y: -100 } });
    // reality at (-200,-100) .. (-100,-60); back reaches y 390; m reaches x 300
    expect(out.bounds).toEqual({ x: -248, y: -148, width: 300 + 200 + 96, height: 390 + 100 + 96 });

    // a label far from every node grows the bounds too
    const far = fixture();
    far.base.edges.set('b:0', { ...far.base.edges.get('b:0')!, label: { x: 0, y: 0, width: 10, height: 10, lines: [] } });
    const moved = withPins(far.base, far.tree, { m: { x: 1000, y: 0 } });
    // b:0 does not touch m, so its label stays put at (-5,-5)..(5,5)
    expect(moved.bounds).toEqual({ x: -5 - 48, y: -5 - 48, width: 1100 + 5 + 96, height: 390 + 5 + 96 });
  });

  it('leaves an edge alone when the layout does not know it or one of its ends', () => {
    const { tree, base } = fixture();
    base.edges.delete('b:0');
    // a stale layout: the edge exists but its source does not
    base.nodes.delete('m');
    base.edges.set('back:0', { id: 'back:0', path: 'stale' });
    const t: Tree = { ...tree, edges: tree.edges.map((e) => (e.id === 'back:0' ? { ...e, source: 'm' } : e)) };
    const out = withPins(base, t, { back: { x: 0, y: 0 }, b: { x: 5, y: 5 } });
    expect(out.edges.has('b:0')).toBe(false);
    expect(out.edges.get('back:0')).toEqual({ id: 'back:0', path: 'stale' });
  });

  it('only counts real pins, not names that every object has', () => {
    const tree = parseTree(`attacks:
- constructor: Build the payload
  from:
  - reality
- toString: Another
  from:
  - constructor
- a: A
  from:
  - reality
`);
    const nodes = new Map<string, PlacedNode>(tree.nodes.map((n, i) => [n.id, node(n.id, i * 150, i * 100)]));
    const edges = new Map<string, PlacedEdge>(tree.edges.map((e) => [e.id, { id: e.id, path: `route ${e.id}` }]));
    const base: Layout = { key: 'k', nodes, edges, bounds: { x: 0, y: 0, width: 1, height: 1 } };
    const out = withPins(base, tree, { a: { x: 900, y: 900 } });
    expect(out.edges.get('a:0')!.free).toBe(true);
    // nobody dragged constructor or toString
    expect(out.edges.get('constructor:0')).toBe(edges.get('constructor:0'));
    expect(out.edges.get('toString:0')).toBe(edges.get('toString:0'));
  });
});
