import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { Tree } from '../model/types';
import { type Box, measureEdgeLabel, measureNode } from './measure';

// ELK runs in its own worker so big trees never block typing.
const elk = new ELK({ workerUrl });

export interface PlacedNode extends Box {
  id: string;
  x: number;
  y: number;
}

export interface PlacedLabel extends Box {
  /** center */
  x: number;
  y: number;
}

export interface PlacedEdge {
  id: string;
  path: string;
  label?: PlacedLabel;
  /** drawn node-to-node because an end was moved by hand (not routed by ELK) */
  free?: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  key: string;
  nodes: Map<string, PlacedNode>;
  edges: Map<string, PlacedEdge>;
  bounds: Bounds;
}

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=48,left=48,bottom=48,right=48]',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '54',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.edgeLabel': '4',
  'elk.edgeLabels.placement': 'CENTER',
  'elk.edgeLabels.inline': 'true',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.thoroughness': '14',
};

/** Only what changes geometry; typing in a comment must not trigger a new layout. */
export function layoutKey(tree: Tree, visible: Set<string> | null): string {
  const nodes = tree.nodes.filter((n) => !visible || visible.has(n.id)).map((n) => [n.id, n.kind, n.label]);
  const edges = tree.edges.map((e) => [e.id, e.source, e.target, e.label ?? '', e.backwards]);
  return JSON.stringify([nodes, edges]);
}

function roundedPath(points: ElkPoint[], radius = 10): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const d1 = Math.hypot(b.x - a.x, b.y - a.y);
    const d2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) {
      d += ` L${b.x},${b.y}`;
      continue;
    }
    const p = { x: b.x + ((a.x - b.x) * r) / d1, y: b.y + ((a.y - b.y) * r) / d1 };
    const q = { x: b.x + ((c.x - b.x) * r) / d2, y: b.y + ((c.y - b.y) * r) / d2 };
    d += ` L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

function snapToPath(points: ElkPoint[], p: ElkPoint): ElkPoint {
  let best = points[0];
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = q;
    }
  }
  return best;
}

export async function computeLayout(tree: Tree, visible: Set<string> | null): Promise<Layout> {
  const key = layoutKey(tree, visible);
  const shown = tree.nodes.filter((n) => !visible || visible.has(n.id));
  const ids = new Set(shown.map((n) => n.id));
  const edges = tree.edges.filter((e) => ids.has(e.source) && ids.has(e.target));

  // A backwards edge points up the tree. ELK lays it out pointing down (target -> source),
  // which routes it cleanly around nodes; it is flipped back when drawn.
  const routed = edges.map((e) => (e.backwards ? { e, from: e.target, to: e.source } : { e, from: e.source, to: e.target }));
  const hasOut = new Set(routed.map((r) => r.from));
  const hasIn = new Set(routed.map((r) => r.to));

  const boxes = new Map(shown.map((n) => [n.id, measureNode(n)]));
  const labels = new Map(edges.filter((e) => e.label).map((e) => [e.id, measureEdgeLabel(e.label!)]));

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: shown.map((n) => {
      const box = boxes.get(n.id)!;
      const layoutOptions: Record<string, string> = {};
      if (n.kind === 'reality' && !hasIn.has(n.id)) layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
      if (n.kind === 'goal' && !hasOut.has(n.id)) layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST';
      return { id: n.id, width: box.width, height: box.height, layoutOptions };
    }),
    edges: routed.map(({ e, from, to }): ElkExtendedEdge => {
      const label = labels.get(e.id);
      return {
        id: e.id,
        sources: [from],
        targets: [to],
        labels: label ? [{ id: `${e.id}#label`, text: e.label, width: label.width, height: label.height }] : [],
      };
    }),
  };

  const result = await elk.layout(graph);

  const nodes = new Map<string, PlacedNode>();
  for (const child of result.children ?? []) {
    const box = boxes.get(child.id)!;
    nodes.set(child.id, { id: child.id, x: child.x ?? 0, y: child.y ?? 0, ...box });
  }

  const backwards = new Set(edges.filter((e) => e.backwards).map((e) => e.id));
  const placed = new Map<string, PlacedEdge>();
  for (const e of (result.edges ?? []) as ElkExtendedEdge[]) {
    const section = e.sections?.[0];
    if (!section) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    if (backwards.has(e.id)) points.reverse();
    const box = labels.get(e.id);
    const l = e.labels?.[0];
    // ELK reserves room for the label beside the edge; sit it on the line itself, at that spot.
    const center = box && l ? snapToPath(points, { x: (l.x ?? 0) + box.width / 2, y: (l.y ?? 0) + box.height / 2 }) : null;
    placed.set(e.id, {
      id: e.id,
      path: roundedPath(points),
      label: box && center ? { ...box, ...center } : undefined,
    });
  }

  return { key, nodes, edges: placed, bounds: { x: 0, y: 0, width: result.width ?? 0, height: result.height ?? 0 } };
}
