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
import { connector } from '../layout/pins';
import { lineage } from '../model/analysis';
import { type DeclaredKind, isGhost, KIND_LABEL, type Tree, type TreeEdge, type TreeNode } from '../model/types';
import { cx } from '../ui/cx';
import { Legend } from './Legend';

export type Selection = { type: 'node' | 'edge'; id: string } | null;

type TreeNodeData = { node: TreeNode; lines: string[] };
type TreeFlowNode = Node<TreeNodeData, 'tree'>;
type RoutedEdgeData = {
  edge: TreeEdge;
  path: string;
  label?: PlacedLabel;
  onPath: boolean;
  /** follow the nodes as they move instead of using the precomputed route */
  live: boolean;
  select(id: string): void;
};
type RoutedFlowEdge = Edge<RoutedEdgeData, 'routed'>;

const NodeCard = memo(function NodeCard({ id, data, selected }: NodeProps<TreeFlowNode>) {
  const { node, lines } = data;
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

const RoutedEdge = memo(function RoutedEdge({ id, source, target, data, selected }: EdgeProps<RoutedFlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!data) return null;
  const { edge } = data;
  const live = data.live && s && t ? connector(rectOf(s), rectOf(t), edge.backwards) : null;
  const path = live?.path ?? data.path;
  const label = data.label && live ? { ...data.label, ...live.label } : data.label;
  const marker = selected ? 'selected' : edge.backwards ? 'backwards' : data.onPath ? 'path' : 'default';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#at-arrow-${marker})`}
        interactionWidth={18}
        className={cx('tree-edge', edge.backwards && 'is-backwards', !edge.implemented && 'is-unimplemented')}
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
  onResetLayout(): void;
}

export function TreeCanvas(props: Props) {
  const { tree, layout, selection, readOnly } = props;
  const flow = useReactFlow<TreeFlowNode, RoutedFlowEdge>();
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  const focus = useMemo(() => {
    if (!selection) return null;
    if (selection.type === 'node') return lineage(tree, selection.id);
    const edge = tree.edges.find((e) => e.id === selection.id);
    return edge ? { nodes: new Set([edge.source, edge.target]), edges: new Set([edge.id]) } : null;
  }, [tree, selection]);

  const select = useCallback((id: string) => callbacks.current.onSelect({ type: 'edge', id }), []);

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
          data: { node, lines: p.lines },
          selected: selection?.type === 'node' && selection.id === node.id,
          className: cx(focus && (focus.nodes.has(node.id) ? 'is-path' : 'is-dim')),
          deletable: node.declared && node.kind !== 'reality' && !readOnly,
          connectable: !readOnly,
          draggable: !readOnly,
        },
      ];
    });
  }, [tree, layout, selection, focus, readOnly]);

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
          data: { edge, path: placed.path, label: placed.label, onPath: !!onPath, live, select },
          selected: selection?.type === 'edge' && selection.id === edge.id,
          className: cx(focus && (onPath ? 'is-path' : 'is-dim')),
          deletable: !readOnly,
        },
      ];
    });
  }, [tree, layout, selection, focus, select, readOnly, moving]);

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

  const onConnectEnd = useCallback((_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || state.toNode) return;
    callbacks.current.onCreateFrom(state.fromNode.id);
  }, []);

  const onDelete = useCallback<OnDelete<TreeFlowNode, RoutedFlowEdge>>(({ nodes, edges }) => {
    callbacks.current.onDelete(
      nodes.map((n) => n.id),
      edges.map((e) => e.id),
    );
  }, []);

  const empty = tree.nodes.length === 0;
  const pinnedCount = Object.keys(tree.positions).filter((id) => layout?.nodes.has(id)).length;

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
              onClick={props.onResetLayout}
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
