import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  type Connection,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  type FinalConnectionState,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnDelete,
  Panel,
  Position,
  ReactFlow,
  type InternalNode,
  useConnection,
  useInternalNode,
  useReactFlow,
} from '@xyflow/react';
import { Maximize, Minus, Plus, WandSparkles } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Layout, PlacedLabel } from '../layout/layout';
import { connector, pathEnds } from '../layout/pins';
import { type Badge, badgeOf, defenseGaps, lineage } from '../model/analysis';
import { type DeclaredKind, isGhost, KIND_LABEL, type Tree, type TreeEdge, type TreeNode } from '../model/types';
import { cx } from '../ui/cx';
import { Legend } from './Legend';

export type Selection = { type: 'node' | 'edge'; id: string } | null;

type TreeNodeData = { node: TreeNode; lines: string[]; badge: Badge | null };
type TreeFlowNode = Node<TreeNodeData, 'tree'>;
type RoutedEdgeData = {
  edge: TreeEdge;
  path: string;
  label?: PlacedLabel;
  onPath: boolean;
  /** on a path that reaches a goal without beating any defense */
  open: boolean;
  /** follow the nodes as they move instead of using the precomputed route */
  live: boolean;
  select(id: string): void;
  /** dragging an end onto another node moves the connection; null when read-only */
  reconnect: Reconnect | null;
};

type End = 'source' | 'target';
type Reconnect = {
  /** may this end of the connection move onto that node? */
  can(edge: TreeEdge, end: End, nodeId: string): boolean;
  move(edge: TreeEdge, end: End, nodeId: string): void;
};
type RoutedFlowEdge = Edge<RoutedEdgeData, 'routed'>;

const NodeCard = memo(function NodeCard({ id, data, selected }: NodeProps<TreeFlowNode>) {
  const { node, lines, badge } = data;
  const ghost = isGhost(node);
  // While dragging a connection, the whole card becomes a drop target.
  const dropTarget = useConnection((c) => c.inProgress && c.fromNode.id !== id && node.kind !== 'reality' && !ghost);
  return (
    <div className={cx('tree-node', `kind-${node.kind}`, ghost && 'is-ghost', selected && 'is-selected')}>
      <Handle type="target" position={Position.Top} className={cx('handle handle-in', dropTarget && 'is-cover')} isConnectableStart={false} />
      {node.kind !== 'reality' && (
        <div className="tree-node-tag">
          <span className="tree-node-dot" />
          {ghost ? 'Undeclared' : KIND_LABEL[node.kind]}
          {badge && (
            <span className="tree-node-badge" title={badge.hint}>
              {badge.label}
            </span>
          )}
        </div>
      )}
      <div className="tree-node-label">
        {lines.map((line, i) => (
          <span key={i}>{line}</span>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} className="handle handle-out" isConnectableEnd={false} />
    </div>
  );
});

function rectOf(n: InternalNode) {
  return {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    width: n.measured.width ?? n.width ?? 0,
    height: n.measured.height ?? n.height ?? 0,
  };
}

/**
 * The card under the pointer. Looks past the dot being dragged and its preview line, but
 * not past anything else: a card hidden under the inspector is not a drop target.
 */
function nodeUnder(x: number, y: number): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('.edge-end, .reconnect-preview')) continue;
    return el.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
  }
  return null;
}

/**
 * The two ends of the selected arrow, where it actually meets the cards (ELK routes don't
 * start at the handles). Drag one onto another card to move that end of the connection.
 */
function EndHandles({ edge, path, reconnect }: { edge: TreeEdge; path: string; reconnect: Reconnect }) {
  const flow = useReactFlow();
  const [drag, setDrag] = useState<{ end: End; x: number; y: number } | null>(null);
  const stop = useRef<(() => void) | null>(null);
  // an arrow that goes away mid-drag (undo, the YAML changed) must not leave listeners behind
  useEffect(() => () => stop.current?.(), []);
  const ends = pathEnds(path);
  if (!ends) return null;
  const at = (end: End) => (end === 'source' ? ends.start : ends.end);

  const begin = (end: End) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    let hovered: Element | null = null;
    const mark = (id: string | null) => {
      hovered?.classList.remove('is-reconnect-target');
      hovered = id && reconnect.can(edge, end, id) ? document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) : null;
      hovered?.classList.add('is-reconnect-target');
    };
    const move = (ev: PointerEvent) => {
      setDrag({ end, ...flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }) });
      mark(nodeUnder(ev.clientX, ev.clientY));
    };
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      stop.current = null;
      mark(null);
      setDrag(null);
      const id = ev && nodeUnder(ev.clientX, ev.clientY);
      if (!id || !reconnect.can(edge, end, id)) return;
      // the click that ends the drag must not land on the pane and clear the selection
      const swallow = (c: Event) => c.stopPropagation();
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      reconnect.move(edge, end, id);
    };
    const up = (ev: PointerEvent) => finish(ev);
    const cancel = () => finish(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    stop.current = cancel;
    setDrag({ end, ...at(end) });
  };

  const fixed = drag && at(drag.end === 'source' ? 'target' : 'source');
  return (
    <g className="edge-ends">
      {drag && fixed && <path className="reconnect-preview" d={`M${fixed.x},${fixed.y} L${drag.x},${drag.y}`} />}
      {(['source', 'target'] as const).map((end) => {
        const p = drag?.end === end ? drag : at(end);
        return (
          <g
            key={end}
            className={cx('edge-end nodrag nopan', drag?.end === end && 'is-dragging')}
            data-end={end}
            onPointerDown={begin(end)}
          >
            <title>{end === 'source' ? 'Drag to change where this comes from' : 'Drag to change where this leads'}</title>
            <circle className="edge-end-hit" cx={p.x} cy={p.y} r={12} />
            <circle className="edge-end-dot" cx={p.x} cy={p.y} r={4.5} />
          </g>
        );
      })}
    </g>
  );
}

const RoutedEdge = memo(function RoutedEdge({ id, source, target, data, selected }: EdgeProps<RoutedFlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!data) return null;
  const { edge } = data;
  const live = data.live && s && t ? connector(rectOf(s), rectOf(t), edge.backwards) : null;
  const path = live?.path ?? data.path;
  const label = data.label && live ? { ...data.label, ...live.label } : data.label;
  const marker = selected ? 'selected' : edge.backwards ? 'backwards' : data.open ? 'open' : data.onPath ? 'path' : 'default';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#at-arrow-${marker})`}
        interactionWidth={18}
        className={cx('tree-edge', edge.backwards && 'is-backwards', !edge.implemented && 'is-unimplemented', data.open && 'is-open')}
      />
      {label && edge.label && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={cx('edge-label nodrag nopan', edge.label.startsWith('#') && 'is-tag', selected && 'is-selected')}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`, width: label.width }}
            onClick={() => data.select(id)}
          >
            {label.lines.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </button>
        </EdgeLabelRenderer>
      )}
      {selected && data.reconnect && <EndHandles edge={edge} path={path} reconnect={data.reconnect} />}
    </>
  );
});

const FIT_PADDING = { top: '76px', bottom: '64px', left: '40px', right: '40px' } as const;

const nodeTypes = { tree: NodeCard };
const edgeTypes = { routed: RoutedEdge };

function ArrowDefs() {
  const arrow = (name: string, color: string) => (
    <marker
      id={`at-arrow-${name}`}
      viewBox="0 0 10 10"
      refX="9.5"
      refY="5"
      markerWidth="9"
      markerHeight="9"
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      <path d="M0.5,1 L9.5,5 L0.5,9 Q2.5,5 0.5,1 z" style={{ fill: color }} />
    </marker>
  );
  return (
    <svg className="arrow-defs" aria-hidden>
      <defs>
        {arrow('default', 'var(--edge)')}
        {arrow('path', 'var(--edge-strong)')}
        {arrow('selected', 'var(--accent)')}
        {arrow('backwards', 'var(--edge-backwards)')}
        {arrow('open', 'var(--danger)')}
      </defs>
    </svg>
  );
}

interface Props {
  tree: Tree;
  layout: Layout | null;
  selection: Selection;
  /** bumps when the canvas should bring the selection into view */
  revealNonce: number;
  /** bumps when the canvas should fit the whole tree (document switch, first load) */
  fitNonce: number;
  readOnly: boolean;
  onSelect(selection: Selection): void;
  onConnect(source: string, target: string): void;
  onCreateFrom(source: string): void;
  onAdd(kind: DeclaredKind): void;
  onDelete(nodeIds: string[], edgeIds: string[]): void;
  onEditLabel(): void;
  onMove(moved: Record<string, { x: number; y: number }>): void;
  /** forget the hand-placed positions of these nodes (the ones on screen) */
  onResetLayout(ids: string[]): void;
  /** move an end of a connection to another node */
  onReconnect(edgeId: string, to: { source: string; target: string }): void;
}

export function TreeCanvas(props: Props) {
  const { tree, layout, selection, readOnly } = props;
  const flow = useReactFlow<TreeFlowNode, RoutedFlowEdge>();
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  const focus = useMemo(() => {
    if (!selection) return null;
    // a stale selection (the node was just undone or deleted in the YAML) must not dim the whole tree
    if (selection.type === 'node') return tree.nodes.some((n) => n.id === selection.id) ? lineage(tree, selection.id) : null;
    const edge = tree.edges.find((e) => e.id === selection.id);
    return edge ? { nodes: new Set([edge.source, edge.target]), edges: new Set([edge.id]) } : null;
  }, [tree, selection]);

  const select = useCallback((id: string) => callbacks.current.onSelect({ type: 'edge', id }), []);
  const gaps = useMemo(() => defenseGaps(tree), [tree]);
  const reconnect = useMemo<Reconnect | null>(() => {
    if (readOnly) return null;
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    const ends = (edge: TreeEdge, end: End, nodeId: string) =>
      end === 'source' ? { source: nodeId, target: edge.target } : { source: edge.source, target: nodeId };
    return {
      can(edge, end, nodeId) {
        const to = ends(edge, end, nodeId);
        if (to.source === to.target || (to.source === edge.source && to.target === edge.target)) return false;
        const target = byId.get(to.target);
        return !!target && target.declared && target.kind !== 'reality' && byId.has(to.source);
      },
      move: (edge, end, nodeId) => callbacks.current.onReconnect(edge.id, ends(edge, end, nodeId)),
    };
  }, [tree, readOnly]);

  const built = useMemo<TreeFlowNode[]>(() => {
    if (!layout) return [];
    return tree.nodes.flatMap((node) => {
      const p = layout.nodes.get(node.id);
      if (!p) return [];
      return [
        {
          id: node.id,
          type: 'tree' as const,
          position: { x: p.x, y: p.y },
          width: p.width,
          height: p.height,
          data: { node, lines: p.lines, badge: badgeOf(node.id, gaps) },
          selected: selection?.type === 'node' && selection.id === node.id,
          className: cx(focus && (focus.nodes.has(node.id) ? 'is-path' : 'is-dim')),
          deletable: node.declared && node.kind !== 'reality' && !readOnly,
          connectable: !readOnly,
          draggable: !readOnly,
        },
      ];
    });
  }, [tree, layout, selection, focus, readOnly, gaps]);

  const [nodes, setNodes] = useState<TreeFlowNode[]>([]);
  useEffect(() => {
    setNodes((prev) => {
      const before = new Map(prev.map((n) => [n.id, n]));
      return built.map((n) => {
        const old = before.get(n.id);
        return old?.measured && old.width === n.width && old.height === n.height ? { ...n, measured: old.measured } : n;
      });
    });
  }, [built]);
  const onNodesChange = useCallback(
    (changes: NodeChange<TreeFlowNode>[]) =>
      setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type === 'dimensions' || c.type === 'position'), nds)),
    [],
  );

  // While a node is being dragged its edges follow it; on drop the position is written to the YAML.
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const onNodeDragStart = useCallback((_: unknown, node: TreeFlowNode) => setMoving(new Set([node.id])), []);
  const onNodeDragStop = useCallback(
    (_: unknown, node: TreeFlowNode) => {
      setMoving(new Set());
      const before = layout?.nodes.get(node.id);
      if (before && Math.hypot(before.x - node.position.x, before.y - node.position.y) >= 2) {
        callbacks.current.onMove({ [node.id]: node.position });
      } else {
        setNodes(built);
      }
    },
    [layout, built],
  );

  const edges = useMemo<RoutedFlowEdge[]>(() => {
    if (!layout) return [];
    return tree.edges.flatMap((edge) => {
      const placed = layout.edges.get(edge.id);
      if (!placed) return [];
      const onPath = focus?.edges.has(edge.id);
      const live = !!placed.free || moving.has(edge.source) || moving.has(edge.target);
      return [
        {
          id: edge.id,
          type: 'routed' as const,
          source: edge.source,
          target: edge.target,
          data: { edge, path: placed.path, label: placed.label, onPath: !!onPath, open: gaps.openEdges.has(edge.id), live, select, reconnect },
          selected: selection?.type === 'edge' && selection.id === edge.id,
          className: cx(focus && (onPath ? 'is-path' : 'is-dim')),
          deletable: !readOnly,
        },
      ];
    });
  }, [tree, layout, selection, focus, select, readOnly, moving, gaps, reconnect]);

  // Fit the whole tree when a document opens.
  const fitted = useRef(-1);
  useEffect(() => {
    if (!layout || nodes.length === 0 || fitted.current === props.fitNonce) return;
    fitted.current = props.fitNonce;
    requestAnimationFrame(() => flow.fitView({ padding: FIT_PADDING, maxZoom: 1.1, duration: 0 }));
  }, [layout, nodes.length, props.fitNonce, flow]);

  // Bring the selection into view when it was picked from the editor or just created.
  useEffect(() => {
    if (!props.revealNonce || !selection || selection.type !== 'node' || !layout || !host.current) return;
    const p = layout.nodes.get(selection.id);
    if (!p) return;
    const { x, y, zoom } = flow.getViewport();
    const { clientWidth: w, clientHeight: h } = host.current;
    const left = p.x * zoom + x;
    const top = p.y * zoom + y;
    const margin = 48;
    const inside =
      left > margin && top > margin && left + p.width * zoom < w - margin && top + p.height * zoom < h - margin;
    if (!inside) flow.setCenter(p.x + p.width / 2, p.y + p.height / 2, { zoom, duration: 320 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revealNonce, layout]);

  const isValidConnection = useCallback(
    (c: Connection | RoutedFlowEdge) => {
      if (c.source === c.target) return false;
      const target = tree.nodes.find((n) => n.id === c.target);
      if (!target || !target.declared || target.kind === 'reality') return false;
      return !tree.edges.some((e) => e.source === c.source && e.target === c.target);
    },
    [tree],
  );

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || state.toNode) return;
    // Only a drop on empty canvas adds the next step, not one on a node that cannot take the connection.
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!point || document.elementFromPoint(point.clientX, point.clientY)?.closest('.react-flow__node')) return;
    callbacks.current.onCreateFrom(state.fromNode.id);
  }, []);

  const onDelete = useCallback<OnDelete<TreeFlowNode, RoutedFlowEdge>>(({ nodes, edges }) => {
    callbacks.current.onDelete(
      nodes.map((n) => n.id),
      edges.map((e) => e.id),
    );
  }, []);

  const empty = tree.nodes.length === 0;
  // only what is on screen: nodes hidden by `filter` keep their positions
  const pinnedIds = Object.keys(tree.positions).filter((id) => layout?.nodes.has(id));
  const pinnedCount = pinnedIds.length;

  return (
    <div className="canvas" ref={host}>
      <ArrowDefs />
      <ReactFlow<TreeFlowNode, RoutedFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => props.onSelect({ type: 'node', id: n.id })}
        onNodeDoubleClick={(_, n) => {
          props.onSelect({ type: 'node', id: n.id });
          props.onEditLabel();
        }}
        onEdgeClick={(_, e) => props.onSelect({ type: 'edge', id: e.id })}
        onPaneClick={() => props.onSelect(null)}
        onConnect={(c) => c.source && c.target && props.onConnect(c.source, c.target)}
        onConnectEnd={onConnectEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        nodeDragThreshold={3}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        isValidConnection={isValidConnection}
        // the selected arrow is drawn above the cards, so both of its ends can be grabbed
        elevateEdgesOnSelect
        edgesReconnectable={false}
        onDelete={onDelete}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        selectNodesOnDrag={false}
        connectionRadius={28}
        minZoom={0.15}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'routed' }}
        connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 1.75, strokeDasharray: '5 4' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--canvas-dot)" />
        {!readOnly && (
          <Panel position="top-left" className="canvas-toolbar">
            <span className="canvas-toolbar-label">
              <Plus size={14} /> Add
            </span>
            {(['fact', 'attack', 'mitigation', 'goal'] as const).map((kind) => (
              <button key={kind} type="button" className={cx('add-node', `kind-${kind}`)} onClick={() => props.onAdd(kind)}>
                <span className="kind-dot" />
                {KIND_LABEL[kind]}
              </button>
            ))}
          </Panel>
        )}
        <Panel position="bottom-left" className="canvas-bottom-left">
          <Legend />
        </Panel>
        <Panel position="bottom-right" className="zoom-controls">
          {pinnedCount > 0 && !readOnly && (
            <button
              type="button"
              className="auto-arrange"
              title={`Auto-arrange: forget the ${pinnedCount} position${pinnedCount > 1 ? 's' : ''} set by hand`}
              onClick={() => props.onResetLayout(pinnedIds)}
            >
              <WandSparkles size={14} />
              <span>Auto-arrange</span>
            </button>
          )}
          <button type="button" title="Zoom out" onClick={() => flow.zoomOut({ duration: 160 })}>
            <Minus size={15} />
          </button>
          <button type="button" title="Fit tree" onClick={() => flow.fitView({ padding: FIT_PADDING, duration: 260 })}>
            <Maximize size={14} />
          </button>
          <button type="button" title="Zoom in" onClick={() => flow.zoomIn({ duration: 160 })}>
            <Plus size={15} />
          </button>
        </Panel>
      </ReactFlow>
      {empty && (
        <div className="canvas-empty">
          <p className="canvas-empty-title">An empty tree</p>
          <p>Describe it in YAML on the left, or add a first node with the buttons above.</p>
        </div>
      )}
    </div>
  );
}
