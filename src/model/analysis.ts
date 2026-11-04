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
