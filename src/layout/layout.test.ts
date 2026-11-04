import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleIds } from '../model/analysis';
import { parseTree } from '../model/parse';
import type { Tree } from '../model/types';
import { computeLayout, layoutKey, type Layout } from './layout';
import { measureEdgeLabel, measureNode } from './measure';

// Run the real ELK engine in-process instead of in a worker. Tests can swap in a canned
// result to exercise how degenerate engine output is handled.
const elk = vi.hoisted(() => ({
  ctorArgs: [] as unknown[],
  graphs: [] as ElkNode[],
  results: [] as ElkNode[],
  override: null as null | ((graph: ElkNode) => ElkNode),
}));

vi.mock('elkjs/lib/elk-worker.min.js?url', () => ({ default: '/elk-worker.min.js' }));
vi.mock('elkjs/lib/elk-api.js', async () => {
  const { default: Real } = await import('elkjs/lib/elk.bundled.js');
  class ELK {
    real = new Real();
    constructor(options: unknown) {
      elk.ctorArgs.push(options);
    }
    async layout(graph: ElkNode) {
      elk.graphs.push(structuredClone(graph));
      const result = elk.override ? elk.override(graph) : await this.real.layout(graph);
      elk.results.push(structuredClone(result));
      return result;
    }
  }
  return { default: ELK };
});

beforeEach(() => {
  // jsdom has no 2D canvas; measure.ts falls back to a fixed width per character
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  elk.graphs = [];
  elk.results = [];
  elk.override = null;
});
afterEach(() => {
  elk.override = null;
});

const lastGraph = () => elk.graphs[elk.graphs.length - 1];
const lastResult = () => elk.results[elk.results.length - 1];

const READING = `title: Reading a tree
facts:
- public_api: The login API is on the internet
  from:
  - reality
attacks:
- stuffing: Credential stuffing on /login
  from:
  - public_api
- buy_session: Buy a stolen session token
  from:
  - rate_limit: 'then what?'
mitigations:
- rate_limit: Rate limiting and breached-password checks
  from:
  - stuffing
goals:
- takeover: Take over a customer account
  from:
  - stuffing
  - buy_session
`;

const BACKWARDS = `title: Review sends the attacker back
attacks:
- phish: Phish an engineer's password
  from:
  - reality
  - code_review:
    backwards: true
- push_backdoor: Push a backdoor to main
  from:
  - phish
mitigations:
- code_review: Required code review on main
  from:
  - push_backdoor
goals:
- shipped: Backdoor ships to production
  from:
  - push_backdoor
`;

type Pt = { x: number; y: number };

/** every coordinate pair of an SVG path made of M / L / Q commands */
function pathPoints(d: string): Pt[] {
  const nums = d.match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
  const pts: Pt[] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}
const first = (d: string) => pathPoints(d)[0];
const last = (d: string) => pathPoints(d).at(-1)!;

function distToPolyline(points: Pt[], p: Pt): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
  }
  return best;
}

function elkPolyline(result: ElkNode, edgeId: string): Pt[] {
  const e = result.edges!.find((x) => x.id === edgeId)!;
  const s = e.sections![0];
  return [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
}

const overlaps = (a: Pt & { width: number; height: number }, b: Pt & { width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('layoutKey', () => {
  const key = (text: string, visible: Set<string> | null = null) => layoutKey(parseTree(text), visible);
  const base = key(READING);

  it('ignores what does not change geometry', () => {
    expect(key(`# a comment\n${READING}`)).toBe(base);
    expect(key(READING.replace('title: Reading a tree', 'title: Another title'))).toBe(base);
    // implemented: false only changes the dash pattern
    expect(key(READING.replace('  - stuffing\ngoals', '  - stuffing:\n    implemented: false\ngoals'))).toBe(base);
    // positions are applied on top of the layout, they never trigger a new one
    expect(key(`${READING}positions:\n  stuffing: [10, 20]\n`)).toBe(base);
    expect(key(`${READING}filter:\n- takeover\n`)).toBe(base);
  });

  it('changes with everything that does change geometry', () => {
    const variants = [
      READING.replace('Credential stuffing on /login', 'Credential stuffing'),
      // same label, different kind
      READING.replace('mitigations:\n- rate_limit', 'facts:\n- rate_limit'),
      READING.replace("'then what?'", "'and then?'"),
      READING.replace("  - rate_limit: 'then what?'", '  - rate_limit'),
      READING.replace('  - stuffing\ngoals', '  - stuffing:\n    backwards: true\ngoals'),
      READING.replace('  - buy_session\n', '  - buy_session\n  - public_api\n'),
      READING.replace('- buy_session: Buy', '- buy_token: Buy').replace('  - buy_session\n', '  - buy_token\n'),
      `${READING}- other: Another goal\n  from:\n  - reality\n`,
    ];
    const keys = variants.map((v) => key(v));
    for (const k of keys) expect(k).not.toBe(base);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('depends on node order (ELK keeps the model order)', () => {
    const a = parseTree(READING);
    const b = { ...a, nodes: [...a.nodes].reverse() };
    expect(layoutKey(b, null)).not.toBe(layoutKey(a, null));
  });

  it('only looks at the visible nodes', () => {
    const visible = new Set(['reality', 'public_api', 'stuffing', 'takeover']);
    const k = key(READING, visible);
    expect(k).not.toBe(base);
    expect(key(READING.replace('Buy a stolen session token', 'Buy a cookie'), visible)).toBe(k);
    expect(key(READING, new Set([...visible, 'buy_session']))).not.toBe(k);
  });

  it('ignores edges between hidden nodes', () => {
    const visible = new Set(['reality', 'public_api', 'stuffing', 'takeover']);
    const k = key(READING, visible);
    // rate_limit -> buy_session is not drawn, its label cannot change the layout
    expect(key(READING.replace("'then what?'", "'a much longer label that wraps'"), visible)).toBe(k);
    expect(key(READING.replace("  - rate_limit: 'then what?'", '  - rate_limit:\n    backwards: true'), visible)).toBe(k);
  });
});

describe('computeLayout', () => {
  it('runs ELK in a worker', () => {
    expect(elk.ctorArgs).toEqual([{ workerUrl: '/elk-worker.min.js' }]);
  });

  it('places every node with its measured box, without overlaps', async () => {
    const tree = parseTree(READING);
    const layout = await computeLayout(tree, null);
    expect(layout.key).toBe(layoutKey(tree, null));
    expect([...layout.nodes.keys()].sort()).toEqual(tree.nodes.map((n) => n.id).sort());
    for (const n of tree.nodes) {
      const p = layout.nodes.get(n.id)!;
      const box = measureNode(n);
      expect(p).toMatchObject({ id: n.id, width: box.width, height: box.height, lines: box.lines });
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    const placed = [...layout.nodes.values()];
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false);
    }
  });

  it('lays the tree out top-down and keeps everything inside the bounds', async () => {
    const tree = parseTree(READING);
    const layout = await computeLayout(tree, null);
    const at = (id: string) => layout.nodes.get(id)!;
    for (const e of tree.edges) expect(at(e.source).y + at(e.source).height).toBeLessThan(at(e.target).y);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: lastResult().width, height: lastResult().height });
    for (const p of layout.nodes.values()) {
      expect(p.x).toBeGreaterThanOrEqual(48);
      expect(p.y).toBeGreaterThanOrEqual(48);
      expect(p.x + p.width).toBeLessThanOrEqual(layout.bounds.width - 48 + 0.001);
      expect(p.y + p.height).toBeLessThanOrEqual(layout.bounds.height - 48 + 0.001);
    }
  });

  it('routes every edge from the bottom of its source to the top of its target', async () => {
    const tree = parseTree(READING);
    const layout = await computeLayout(tree, null);
    expect([...layout.edges.keys()].sort()).toEqual(tree.edges.map((e) => e.id).sort());
    for (const e of tree.edges) {
      const placed = layout.edges.get(e.id)!;
      expect(placed.id).toBe(e.id);
      expect(placed.free).toBeUndefined();
      expect(placed.path).toMatch(/^M[-\d.]+,[-\d.]+( (L|Q)[-\d.]+,[-\d.]+( [-\d.]+,[-\d.]+)?)+$/);
      const s = layout.nodes.get(e.source)!;
      const t = layout.nodes.get(e.target)!;
      const a = first(placed.path);
      const b = last(placed.path);
      expect(a.y).toBeCloseTo(s.y + s.height, 3);
      expect(a.x).toBeGreaterThanOrEqual(s.x);
      expect(a.x).toBeLessThanOrEqual(s.x + s.width);
      expect(b.y).toBeCloseTo(t.y, 3);
      expect(b.x).toBeGreaterThanOrEqual(t.x);
      expect(b.x).toBeLessThanOrEqual(t.x + t.width);
    }
  });

  it('routes a backwards edge downwards and flips it, so it is drawn up the tree', async () => {
    const tree = parseTree(BACKWARDS);
    const layout = await computeLayout(tree, null);
    const back = tree.edges.find((e) => e.backwards)!;
    expect(back).toMatchObject({ source: 'code_review', target: 'phish' });
    // laid out as phish -> code_review
    const routed = lastGraph().edges!.find((e) => e.id === back.id)!;
    expect(routed.sources).toEqual(['phish']);
    expect(routed.targets).toEqual(['code_review']);
    const forward = lastGraph().edges!.find((e) => e.id === 'push_backdoor:0')!;
    expect(forward.sources).toEqual(['phish']);
    expect(forward.targets).toEqual(['push_backdoor']);

    const s = layout.nodes.get('code_review')!;
    const t = layout.nodes.get('phish')!;
    expect(s.y).toBeGreaterThan(t.y + t.height);
    const path = layout.edges.get(back.id)!.path;
    // starts on top of the mitigation, ends under the attack it sends the attacker back to
    expect(first(path).y).toBeCloseTo(s.y, 3);
    expect(last(path).y).toBeCloseTo(t.y + t.height, 3);
    const raw = elkPolyline(lastResult(), back.id);
    expect(first(path)).toEqual(raw.at(-1));
    expect(last(path)).toEqual(raw[0]);
  });

  it('keeps reality first and goals last', async () => {
    const text = `attacks:
- a1: Step one
  from:
  - reality
- a2: Step two
  from:
  - a1
- a3: Step three
  from:
  - a2
goals:
- quick: Reached directly from reality
  from:
  - reality
- deep: Reached at the end
  from:
  - a3
`;
    const tree = parseTree(text);
    const layout = await computeLayout(tree, null);
    const constraint = (id: string) => lastGraph().children!.find((c) => c.id === id)!.layoutOptions;
    expect(constraint('reality')).toEqual({ 'elk.layered.layering.layerConstraint': 'FIRST' });
    expect(constraint('quick')).toEqual({ 'elk.layered.layering.layerConstraint': 'LAST' });
    expect(constraint('deep')).toEqual({ 'elk.layered.layering.layerConstraint': 'LAST' });
    expect(constraint('a2')).toEqual({});
    const y = (id: string) => layout.nodes.get(id)!.y;
    // a goal one step from reality is still drawn at the bottom
    expect(y('quick')).toBe(y('deep'));
    for (const id of ['a1', 'a2', 'a3']) {
      expect(y('reality')).toBeLessThan(y(id));
      expect(y(id)).toBeLessThan(y('quick'));
    }
  });

  it('does not pin reality or goals when edges make that impossible', async () => {
    const text = `facts:
- reality: The world
  from:
  - g
attacks:
- a: Attack
  from:
  - reality
- after_goal: Keep going after the goal
  from:
  - g
goals:
- g: Goal
  from:
  - a
`;
    const tree = parseTree(text);
    const layout = await computeLayout(tree, null);
    const constraint = (id: string) => lastGraph().children!.find((c) => c.id === id)!.layoutOptions;
    expect(constraint('reality')).toEqual({});
    expect(constraint('g')).toEqual({});
    expect(layout.nodes.size).toBe(4);
  });

  it('keeps reality first when only a backwards edge points at it', async () => {
    const text = `attacks:
- a: Attack
  from:
  - reality
mitigations:
- m: Mitigation
  from:
  - a
facts:
- f: Fact
  from:
  - reality
`;
    const tree = parseTree(text);
    // a backwards edge m -> reality is laid out as reality -> m
    const withBack: Tree = {
      ...tree,
      edges: [...tree.edges, { ...tree.edges[0], id: 'reality:0', source: 'm', target: 'reality', backwards: true }],
    };
    await computeLayout(withBack, null);
    const constraint = (id: string) => lastGraph().children!.find((c) => c.id === id)!.layoutOptions;
    expect(constraint('reality')).toEqual({ 'elk.layered.layering.layerConstraint': 'FIRST' });
  });

  it('sits edge labels on the route, where ELK made room for them', async () => {
    const tree = parseTree(READING);
    const layout = await computeLayout(tree, null);
    const labelled = tree.edges.find((e) => e.label)!;
    const placed = layout.edges.get(labelled.id)!;
    const box = measureEdgeLabel(labelled.label!);
    expect(placed.label).toMatchObject({ width: box.width, height: box.height, lines: box.lines });
    const graphEdge = lastGraph().edges!.find((e) => e.id === labelled.id)!;
    expect(graphEdge.labels).toEqual([{ id: `${labelled.id}#label`, text: 'then what?', width: box.width, height: box.height }]);

    const route = elkPolyline(lastResult(), labelled.id);
    const center = { x: placed.label!.x, y: placed.label!.y };
    expect(distToPolyline(route, center)).toBeLessThan(1e-6);
    // the closest point of the route to the spot ELK reserved
    const l = lastResult().edges!.find((e) => e.id === labelled.id)!.labels![0];
    const reserved = { x: l.x! + box.width / 2, y: l.y! + box.height / 2 };
    const d = Math.hypot(center.x - reserved.x, center.y - reserved.y);
    expect(d).toBeCloseTo(distToPolyline(route, reserved), 6);
    // unlabelled edges have no label box and no ELK label
    for (const e of tree.edges.filter((x) => !x.label)) {
      expect(layout.edges.get(e.id)!.label).toBeUndefined();
      expect(lastGraph().edges!.find((g) => g.id === e.id)!.labels).toEqual([]);
    }
  });

  it('lays out only the visible subset', async () => {
    const tree = parseTree(`${READING}filter:\n- buy_session\n`);
    const visible = visibleIds(tree)!;
    expect(visible.has('public_api')).toBe(true);
    const hidden = new Set(['reality', 'public_api', 'stuffing', 'rate_limit', 'buy_session', 'takeover']);
    expect(visible).toEqual(hidden);

    const subset = new Set(['reality', 'public_api', 'stuffing', 'takeover']);
    const layout = await computeLayout(tree, subset);
    expect([...layout.nodes.keys()].sort()).toEqual([...subset].sort());
    expect([...layout.edges.keys()].sort()).toEqual(['public_api:0', 'stuffing:0', 'takeover:0']);
    expect(lastGraph().children!.map((c) => c.id).sort()).toEqual([...subset].sort());
    expect(layout.key).toBe(layoutKey(tree, subset));
  });

  it('lays out an empty tree', async () => {
    const tree = parseTree('title: Empty\n');
    const layout = await computeLayout(tree, null);
    expect(layout.nodes.size).toBe(0);
    expect(layout.edges.size).toBe(0);
    expect(layout.bounds.x).toBe(0);
    expect(layout.bounds.y).toBe(0);
  });

  it('copes with cycles that are not marked backwards', async () => {
    const tree = parseTree(`attacks:
- a: A
  from:
  - reality
  - b
- b: B
  from:
  - a
`);
    const layout = await computeLayout(tree, null);
    expect(layout.nodes.size).toBe(3);
    expect(layout.edges.size).toBe(3);
  });

  describe('with canned engine output', () => {
    const tree = parseTree(`attacks:
- a: A
  from:
  - reality: 'tag'
- b: B
  from:
  - a
  - reality
`);

    it('defaults missing coordinates and sizes to zero and skips edges without a route', async () => {
      elk.override = (g) => ({
        id: 'root',
        children: g.children!.map((c) => ({ id: c.id })),
        edges: [
          // label without coordinates, no bend points
          { id: 'a:0', sources: ['reality'], targets: ['a'], labels: [{ id: 'a:0#label' }], sections: [{ id: 's', startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 100 } }] },
          { id: 'b:0', sources: ['a'], targets: ['b'] },
          { id: 'b:1', sources: ['reality'], targets: ['b'], sections: [] },
        ],
      });
      const layout = await computeLayout(tree, null);
      expect(layout.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
      for (const p of layout.nodes.values()) expect([p.x, p.y]).toEqual([0, 0]);
      expect([...layout.edges.keys()]).toEqual(['a:0']);
      const box = measureEdgeLabel('tag');
      // ELK put the label at its origin; it is pulled onto the route
      expect(layout.edges.get('a:0')).toEqual({
        id: 'a:0',
        path: 'M0,0 L0,100',
        label: { ...box, x: 0, y: box.height / 2 },
      });
    });

    it('drops the label when ELK returns none for a labelled edge', async () => {
      elk.override = (g) => ({
        id: 'root',
        width: 10,
        height: 20,
        children: g.children!.map((c) => ({ id: c.id, x: 1, y: 2 })),
        edges: [{ id: 'a:0', sources: ['reality'], targets: ['a'], sections: [{ id: 's', startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 50 } }] }],
      });
      const layout = await computeLayout(tree, null);
      expect(layout.edges.get('a:0')!.label).toBeUndefined();
      expect(layout.bounds).toEqual({ x: 0, y: 0, width: 10, height: 20 });
      expect(layout.nodes.get('a')).toMatchObject({ x: 1, y: 2 });
    });

    it('survives a result with no children and no edges', async () => {
      elk.override = () => ({ id: 'root' });
      const layout: Layout = await computeLayout(tree, null);
      expect(layout.nodes.size).toBe(0);
      expect(layout.edges.size).toBe(0);
    });

    it('rounds corners, but not where bends are too close together', async () => {
      elk.override = (g) => ({
        id: 'root',
        children: g.children!.map((c) => ({ id: c.id })),
        edges: [
          {
            id: 'b:0',
            sources: ['a'],
            targets: ['b'],
            sections: [{ id: 's', startPoint: { x: 0, y: 0 }, bendPoints: [{ x: 0, y: 100 }, { x: 100, y: 100 }], endPoint: { x: 100, y: 200 } }],
          },
          {
            id: 'b:1',
            sources: ['reality'],
            targets: ['b'],
            // a short jog: the radius shrinks to half the shortest leg
            sections: [{ id: 's', startPoint: { x: 0, y: 0 }, bendPoints: [{ x: 0, y: 50 }, { x: 6, y: 50 }], endPoint: { x: 6, y: 100 } }],
          },
          {
            id: 'a:0',
            sources: ['reality'],
            targets: ['a'],
            // a repeated bend point: no curve, and the label snaps past the zero-length segment
            labels: [{ id: 'a:0#label', x: 0, y: 0 }],
            sections: [{ id: 's', startPoint: { x: 0, y: 0 }, bendPoints: [{ x: 0, y: 0 }, { x: 0, y: 80 }], endPoint: { x: 40, y: 80 } }],
          },
        ],
      });
      const layout = await computeLayout(tree, null);
      expect(layout.edges.get('b:0')!.path).toBe('M0,0 L0,90 Q0,100 10,100 L90,100 Q100,100 100,110 L100,200');
      expect(layout.edges.get('b:1')!.path).toBe('M0,0 L0,47 Q0,50 3,50 L3,50 Q6,50 6,53 L6,100');
      expect(layout.edges.get('a:0')!.path).toBe('M0,0 L0,0 L0,70 Q0,80 10,80 L40,80');
      const box = measureEdgeLabel('tag');
      // label center (box.width/2, box.height/2) snaps to the vertical leg x = 0
      expect(layout.edges.get('a:0')!.label).toMatchObject({ x: 0, y: box.height / 2 });
    });

    it('treats a label right at the start of a zero-length route', async () => {
      elk.override = (g) => ({
        id: 'root',
        children: g.children!.map((c) => ({ id: c.id })),
        edges: [
          {
            id: 'a:0',
            sources: ['reality'],
            targets: ['a'],
            labels: [{ id: 'a:0#label', x: 100, y: 100 }],
            sections: [{ id: 's', startPoint: { x: 5, y: 5 }, endPoint: { x: 5, y: 5 } }],
          },
        ],
      });
      const layout = await computeLayout(tree, null);
      expect(layout.edges.get('a:0')!.label).toMatchObject({ x: 5, y: 5 });
      expect(layout.edges.get('a:0')!.path).toBe('M5,5 L5,5');
    });
  });
});
