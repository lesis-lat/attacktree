import type { Tree, TreeEdge } from './types';

type Adjacency = Map<string, string[]>;

function adjacency(edges: TreeEdge[], direction: 'out' | 'in', includeBackwards: boolean): Adjacency {
  const adj: Adjacency = new Map();
  for (const e of edges) {
    if (e.backwards && !includeBackwards) continue;
    const [from, to] = direction === 'out' ? [e.source, e.target] : [e.target, e.source];
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  }
  return adj;
}

/** every node reachable from `start` (inclusive) */
export function reach(start: Iterable<string>, adj: Adjacency): Set<string> {
  const seen = new Set<string>(start);
  const queue = [...seen];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * The `filter` section keeps only the nodes on a path through the listed ones:
 * the listed nodes, everything that leads to them and everything they lead to.
 * Returns null when there is no filter.
 */
export function visibleIds(tree: Tree): Set<string> | null {
  const filter = tree.filter.filter((id) => tree.nodes.some((n) => n.id === id));
  if (filter.length === 0) return null;
  const down = reach(filter, adjacency(tree.edges, 'out', true));
  const up = reach(filter, adjacency(tree.edges, 'in', true));
  return new Set([...down, ...up]);
}

export interface Lineage {
  nodes: Set<string>;
  edges: Set<string>;
}

/** Everything on a path through `id`: what leads to it and what it leads to. */
export function lineage(tree: Tree, id: string): Lineage {
  const up = reach([id], adjacency(tree.edges, 'in', false));
  const down = reach([id], adjacency(tree.edges, 'out', false));
  const edges = new Set<string>();
  for (const e of tree.edges) {
    if (e.backwards) {
      if (e.source === id || e.target === id) edges.add(e.id);
    } else if ((up.has(e.source) && up.has(e.target)) || (down.has(e.source) && down.has(e.target))) {
      edges.add(e.id);
    }
  }
  const nodes = new Set([...up, ...down]);
  for (const e of tree.edges) {
    if (edges.has(e.id)) {
      nodes.add(e.source);
      nodes.add(e.target);
    }
  }
  return { nodes, edges };
}

/** Would an edge source -> target point back up the tree (i.e. close a cycle)? */
export function pointsBackwards(tree: Tree, source: string, target: string): boolean {
  return reach([target], adjacency(tree.edges, 'out', false)).has(source);
}

export interface DefenseGaps {
  /** attacks that nothing counters: no mitigation that is in place comes from them */
  undefended: Set<string>;
  /** goals the attacker can reach from a starting point without beating any defense */
  openGoals: Set<string>;
  /** the connections on those open paths */
  openEdges: Set<string>;
}

/**
 * Where the tree has no defense, worked out from its structure alone.
 *
 * An attack is defended when a mitigation that is in place comes from it. A path is open
 * when the attacker never has to beat a defense on the way: it may go through a defended
 * attack only by way of its mitigation (the attacker hit the defense and tried something
 * else), never straight on. Connections that are not implemented, and backwards ones,
 * are not real steps. Computed on the whole tree, so a `filter` never hides a defense.
 */
export function defenseGaps(tree: Tree): DefenseGaps {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const real = tree.edges.filter((e) => !e.backwards && e.implemented);

  const defended = new Set<string>();
  for (const e of real) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (s?.kind === 'attack' && s.declared && t?.kind === 'mitigation' && t.declared) defended.add(s.id);
  }
  const undefended = new Set(tree.nodes.filter((n) => n.kind === 'attack' && n.declared && !defended.has(n.id)).map((n) => n.id));

  // straight on past a defended attack is blocked; around it, through its mitigation, is fine
  const passable = real.filter((e) => !(defended.has(e.source) && byId.get(e.target)?.kind !== 'mitigation'));
  const hasParent = new Set(tree.edges.filter((e) => !e.backwards).map((e) => e.target));
  const starts = tree.nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);

  const forward = reach(starts, adjacency(passable, 'out', false));
  const openGoals = new Set(tree.nodes.filter((n) => n.kind === 'goal' && n.declared && forward.has(n.id)).map((n) => n.id));
  const backward = reach(openGoals, adjacency(passable, 'in', false));
  const openEdges = new Set(passable.filter((e) => forward.has(e.source) && backward.has(e.target)).map((e) => e.id));

  return { undefended, openGoals, openEdges };
}

/** What the canvas and exports write on a node's tag row, next to its kind. */
export interface Badge {
  label: string;
  /** one sentence for tooltips and the inspector */
  hint: string;
}

export const BADGES = {
  undefended: { label: 'No defense', hint: 'Nothing counters this attack yet: no mitigation in place comes from it.' },
  openGoal: { label: 'Open path', hint: 'The attacker can reach this goal without beating any defense. The red arrows show how.' },
} as const satisfies Record<string, Badge>;

export function badgeOf(id: string, gaps: DefenseGaps): Badge | null {
  if (gaps.undefended.has(id)) return BADGES.undefended;
  if (gaps.openGoals.has(id)) return BADGES.openGoal;
  return null;
}
