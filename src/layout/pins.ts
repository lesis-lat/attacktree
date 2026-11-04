import { getSmoothStepPath, Position } from '@xyflow/react';
import type { Point, Tree } from '../model/types';
import type { Bounds, Layout, PlacedEdge, PlacedNode } from './layout';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PADDING = 48;

/**
 * A node-to-node connector in the same visual language as the ELK routes
 * (orthogonal, rounded). Used for edges whose ends were placed by hand.
 */
export function connector(s: Rect, t: Rect, backwards: boolean): { path: string; label: Point } {
  const [path, x, y] = backwards
    ? getSmoothStepPath({
        sourceX: s.x + s.width / 2,
        sourceY: s.y,
        sourcePosition: Position.Top,
        targetX: t.x + t.width / 2,
        targetY: t.y + t.height,
        targetPosition: Position.Bottom,
        borderRadius: 10,
        offset: 18,
      })
    : getSmoothStepPath({
        sourceX: s.x + s.width / 2,
        sourceY: s.y + s.height,
        sourcePosition: Position.Bottom,
        targetX: t.x + t.width / 2,
        targetY: t.y,
        targetPosition: Position.Top,
        borderRadius: 10,
        offset: 18,
      });
  return { path, label: { x, y } };
}

/** only called with at least one pinned node, so the box is never empty */
function boundsOf(nodes: Iterable<PlacedNode>, edges: Iterable<PlacedEdge>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const n of nodes) grow(n.x, n.y, n.width, n.height);
  for (const e of edges) if (e.label) grow(e.label.x - e.label.width / 2, e.label.y - e.label.height / 2, e.label.width, e.label.height);
  return { x: minX - PADDING, y: minY - PADDING, width: maxX - minX + PADDING * 2, height: maxY - minY + PADDING * 2 };
}

/** The automatic layout with the user's dragged positions applied on top. */
export function withPins(base: Layout, tree: Tree, pins: Record<string, Point>): Layout {
  // own keys only: `in` would also match "constructor", "toString"... which are valid node ids
  const pinned = new Set(Object.keys(pins).filter((id) => base.nodes.has(id)));
  if (pinned.size === 0) return base;

  const nodes = new Map(base.nodes);
  for (const id of pinned) nodes.set(id, { ...base.nodes.get(id)!, x: pins[id].x, y: pins[id].y });

  const edges = new Map(base.edges);
  for (const e of tree.edges) {
    const old = edges.get(e.id);
    if (!old || !(pinned.has(e.source) || pinned.has(e.target))) continue;
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (!s || !t) continue;
    const { path, label } = connector(s, t, e.backwards);
    edges.set(e.id, { id: e.id, path, free: true, label: old.label ? { ...old.label, ...label } : undefined });
  }

  return { ...base, nodes, edges, bounds: boundsOf(nodes.values(), edges.values()) };
}

/** Where a drawn path starts and ends: the source and target ends of an arrow. */
export function pathEnds(d: string): { start: Point; end: Point } | null {
  const n = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
  if (!n || n.length < 4) return null;
  return { start: { x: n[0], y: n[1] }, end: { x: n[n.length - 2], y: n[n.length - 1] } };
}
