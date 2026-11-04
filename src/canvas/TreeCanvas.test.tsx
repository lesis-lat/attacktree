import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { type ReactFlowProps, ReactFlowProvider, type FinalConnectionState } from '@xyflow/react';
import { createElement } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { computeLayout, type Layout } from '../layout/layout';
import { withPins } from '../layout/pins';
import { parseTree } from '../model/parse';
import type { Tree } from '../model/types';
import { TreeCanvas, type Selection } from './TreeCanvas';

// The real ELK, in-process.
vi.mock('elkjs/lib/elk-worker.min.js?url', () => ({ default: '/elk-worker.min.js' }));
vi.mock('elkjs/lib/elk-api.js', async () => {
  const { default: Real } = await import('elkjs/lib/elk.bundled.js');
  return {
    default: class {
      real = new Real();
      layout(graph: ElkNode) {
        return this.real.layout(graph);
      }
    },
  };
});

// The real React Flow, with its props and viewport calls observable.
const rf = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  viewport: { x: 0, y: 0, zoom: 1 },
  flow: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@xyflow/react')>();
  const wrapped = new WeakMap<object, Record<string, unknown>>();
  return {
    ...mod,
    ReactFlow: (props: ReactFlowProps) => {
      rf.props = props as Record<string, unknown>;
      return createElement(mod.ReactFlow, props);
    },
    useReactFlow: () => {
      const real = mod.useReactFlow();
      if (!wrapped.has(real)) {
        wrapped.set(real, {
          ...real,
          fitView: vi.fn(async () => true),
          setCenter: vi.fn(async () => true),
          zoomIn: vi.fn(async () => true),
          zoomOut: vi.fn(async () => true),
          getViewport: vi.fn(() => rf.viewport),
        });
      }
      const flow = wrapped.get(real)!;
      rf.flow = flow as Record<string, ReturnType<typeof vi.fn>>;
      return flow;
    },
  };
});

// React Flow measures nodes and handles before it draws edges; jsdom has no layout.
// This is the setup the React Flow docs recommend for testing.
const saved: { ro?: typeof ResizeObserver; ow?: PropertyDescriptor; oh?: PropertyDescriptor; cw?: PropertyDescriptor; ch?: PropertyDescriptor } = {};
const HOST = { width: 1000, height: 800 };
beforeAll(() => {
  saved.ro = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  saved.ow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  saved.oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  saved.cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  saved.ch = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: function (this: HTMLElement) { return parseFloat(this.style.width) || 1; } },
    offsetHeight: { configurable: true, get: function (this: HTMLElement) { return parseFloat(this.style.height) || 1; } },
  });
  Object.defineProperties(Element.prototype, {
    clientWidth: { configurable: true, get: function (this: Element) { return this.classList.contains('canvas') ? HOST.width : 0; } },
    clientHeight: { configurable: true, get: function (this: Element) { return this.classList.contains('canvas') ? HOST.height : 0; } },
  });
});
afterAll(() => {
  globalThis.ResizeObserver = saved.ro!;
  for (const [proto, key, d] of [
    [HTMLElement.prototype, 'offsetWidth', saved.ow],
    [HTMLElement.prototype, 'offsetHeight', saved.oh],
    [Element.prototype, 'clientWidth', saved.cw],
    [Element.prototype, 'clientHeight', saved.ch],
  ] as const) {
    if (d) Object.defineProperty(proto, key, d);
    else delete (proto as unknown as Record<string, unknown>)[key];
  }
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  rf.viewport = { x: 0, y: 0, zoom: 1 };
  rf.props = null;
});

const TEXT = `attacks:
- phish: Phish an engineer
  from:
  - reality
  - review:
    backwards: true
- push: Push a backdoor
  from:
  - phish: '#yolosec'
mitigations:
- review: Code review
  from:
  - push:
    implemented: false
goals:
- shipped: Backdoor ships
  from:
  - push: via CI
  - ghost
- other: Another goal
  from:
  - reality
`;

type Handlers = {
  onSelect: ReturnType<typeof vi.fn>;
  onConnect: ReturnType<typeof vi.fn>;
  onCreateFrom: ReturnType<typeof vi.fn>;
  onAdd: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
  onEditLabel: ReturnType<typeof vi.fn>;
  onMove: ReturnType<typeof vi.fn>;
  onResetLayout: ReturnType<typeof vi.fn>;
};

interface Options {
  tree?: Tree;
  layout?: Layout | null;
  selection?: Selection;
  readOnly?: boolean;
  revealNonce?: number;
  fitNonce?: number;
}

async function layoutOf(tree: Tree) {
  return withPins(await computeLayout(tree, null), tree, tree.positions);
}

async function setup(options: Options = {}) {
  const tree = options.tree ?? parseTree(TEXT);
  const layout = options.layout === undefined ? await layoutOf(tree) : options.layout;
  const handlers: Handlers = {
    onSelect: vi.fn(),
    onConnect: vi.fn(),
    onCreateFrom: vi.fn(),
    onAdd: vi.fn(),
    onDelete: vi.fn(),
    onEditLabel: vi.fn(),
    onMove: vi.fn(),
    onResetLayout: vi.fn(),
  };
  let current: Required<Options> = {
    tree,
    layout,
    selection: options.selection ?? null,
    readOnly: options.readOnly ?? false,
    revealNonce: options.revealNonce ?? 0,
    fitNonce: options.fitNonce ?? 0,
  };
  const ui = () => (
    <ReactFlowProvider>
      <div style={{ width: 1000, height: 800 }}>
        <TreeCanvas {...current} {...handlers} />
      </div>
    </ReactFlowProvider>
  );
  const view = render(ui());
  await flush();
  const update = async (next: Partial<Options>) => {
    current = { ...current, ...next } as Required<Options>;
    view.rerender(ui());
    await flush();
  };
  return { ...view, tree, layout, handlers, update, user: userEvent.setup() };
}

/** let effects, measurements and animation frames settle */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** React Flow tracks held keys: press and release */
async function press(key: string) {
  fireEvent.keyDown(document.body, { key });
  fireEvent.keyUp(document.body, { key });
  await flush();
}

const nodeEl = (id: string) => screen.getByTestId(`rf__node-${id}`);
const edgeEl = (id: string) => document.querySelector(`[data-id="${id}"].react-flow__edge`) as SVGGElement | null;
const props = () => rf.props as Required<ReactFlowProps>;

describe('rendering', () => {
  it('draws every placed node as a card at its layout position', async () => {
    const { tree, layout } = await setup();
    for (const n of tree.nodes) {
      const el = nodeEl(n.id);
      const p = layout!.nodes.get(n.id)!;
      expect(el.style.transform).toBe(`translate(${p.x}px,${p.y}px)`);
      expect(el.style.width).toBe(`${p.width}px`);
      expect(el.style.height).toBe(`${p.height}px`);
      expect(el.querySelector('.tree-node')).toHaveClass(`kind-${n.kind}`);
    }
    expect(nodeEl('phish')).toHaveTextContent('AttackPhish an engineer');
    expect(nodeEl('review')).toHaveTextContent('Mitigation');
    // reality has no tag
    expect(nodeEl('reality').querySelector('.tree-node-tag')).toBeNull();
    expect(nodeEl('reality')).toHaveTextContent('Reality');
    // undeclared nodes are drawn as ghosts
    expect(nodeEl('ghost').querySelector('.tree-node')).toHaveClass('is-ghost');
    expect(nodeEl('ghost')).toHaveTextContent('Undeclared');
  });

  it('draws one span per laid-out line', async () => {
    const tree = parseTree(`attacks:\n- long: ${'word '.repeat(12).trim()}\n  from:\n  - reality\n`);
    const { layout } = await setup({ tree });
    const spans = [...nodeEl('long').querySelectorAll('.tree-node-label span')].map((s) => s.textContent);
    expect(spans).toEqual(layout!.nodes.get('long')!.lines);
    expect(spans.length).toBeGreaterThan(1);
  });

  it('draws every edge along its route, styled by kind', async () => {
    const { tree, layout } = await setup();
    for (const e of tree.edges) {
      const g = edgeEl(e.id)!;
      expect(g).not.toBeNull();
      const path = g.querySelector('path.tree-edge')!;
      expect(path.getAttribute('d')).toBe(layout!.edges.get(e.id)!.path);
    }
    const back = edgeEl('phish:1')!.querySelector('path.tree-edge')!;
    expect(back).toHaveClass('is-backwards');
    expect(back.getAttribute('marker-end')).toBe('url(#at-arrow-backwards)');
    const planned = edgeEl('review:0')!.querySelector('path.tree-edge')!;
    expect(planned).toHaveClass('is-unimplemented');
    expect(planned.getAttribute('marker-end')).toBe('url(#at-arrow-default)');
    expect(edgeEl('push:0')!.querySelector('path.tree-edge')).not.toHaveClass('is-backwards');
    // the four arrowheads are defined once
    expect([...document.querySelectorAll('.arrow-defs marker')].map((m) => m.id)).toEqual([
      'at-arrow-default',
      'at-arrow-path',
      'at-arrow-selected',
      'at-arrow-backwards',
    ]);
  });

  it('draws edge labels at their spot; #tags as tags', async () => {
    const { layout } = await setup();
    const tag = screen.getByRole('button', { name: '#yolosec' });
    expect(tag).toHaveClass('edge-label', 'is-tag');
    const l = layout!.edges.get('push:0')!.label!;
    expect(tag.style.transform).toBe(`translate(-50%, -50%) translate(${l.x}px, ${l.y}px)`);
    expect(tag.style.width).toBe(`${l.width}px`);
    const plain = screen.getByRole('button', { name: 'via CI' });
    expect(plain).not.toHaveClass('is-tag');
  });

  it('renders nothing but the chrome without a layout', async () => {
    await setup({ layout: null });
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(0);
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Fact' })).toBeInTheDocument();
    expect(screen.queryByText('An empty tree')).toBeNull();
  });

  it('skips nodes and edges the layout does not have (filtered out)', async () => {
    const tree = parseTree(TEXT);
    const layout = await computeLayout(tree, new Set(['reality', 'phish', 'push', 'review']));
    await setup({ tree, layout });
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(4);
    expect(screen.queryByTestId('rf__node-shipped')).toBeNull();
    expect(edgeEl('shipped:0')).toBeNull();
    expect(edgeEl('push:0')).not.toBeNull();
  });

  it('says so when the tree is empty', async () => {
    await setup({ tree: parseTree('title: Nothing yet\n') });
    expect(screen.getByText('An empty tree')).toBeInTheDocument();
  });

  it('has a legend', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: /Legend/ }));
    expect(screen.getByText('Forces the attacker back up')).toBeInTheDocument();
  });
});

describe('selection', () => {
  it('reports clicks on nodes, edges, labels and the empty canvas', async () => {
    const { handlers } = await setup();
    fireEvent.click(nodeEl('push'));
    expect(handlers.onSelect).toHaveBeenLastCalledWith({ type: 'node', id: 'push' });
    fireEvent.click(edgeEl('review:0')!);
    expect(handlers.onSelect).toHaveBeenLastCalledWith({ type: 'edge', id: 'review:0' });
    fireEvent.click(screen.getByRole('button', { name: '#yolosec' }));
    expect(handlers.onSelect).toHaveBeenLastCalledWith({ type: 'edge', id: 'push:0' });
    fireEvent.click(document.querySelector('.react-flow__pane')!);
    expect(handlers.onSelect).toHaveBeenLastCalledWith(null);
    expect(handlers.onEditLabel).not.toHaveBeenCalled();
  });

  it('opens the label editor on double-click', async () => {
    const { handlers } = await setup();
    fireEvent.doubleClick(nodeEl('phish'));
    expect(handlers.onSelect).toHaveBeenLastCalledWith({ type: 'node', id: 'phish' });
    expect(handlers.onEditLabel).toHaveBeenCalledOnce();
  });

  it('lights up the paths through the selected node and dims the rest', async () => {
    await setup({ selection: { type: 'node', id: 'push' } });
    expect(nodeEl('push').querySelector('.tree-node')).toHaveClass('is-selected');
    expect(nodeEl('push')).toHaveClass('is-path');
    for (const id of ['reality', 'phish', 'review', 'shipped']) expect(nodeEl(id)).toHaveClass('is-path');
    expect(nodeEl('other')).toHaveClass('is-dim');
    expect(nodeEl('ghost')).toHaveClass('is-dim');
    expect(edgeEl('push:0')).toHaveClass('is-path');
    expect(edgeEl('push:0')!.querySelector('path.tree-edge')!.getAttribute('marker-end')).toBe('url(#at-arrow-path)');
    expect(edgeEl('other:0')).toHaveClass('is-dim');
    expect(edgeEl('other:0')!.querySelector('path.tree-edge')!.getAttribute('marker-end')).toBe('url(#at-arrow-default)');
  });

  it('highlights a selected edge and its two ends', async () => {
    await setup({ selection: { type: 'edge', id: 'push:0' } });
    expect(edgeEl('push:0')).toHaveClass('is-path', 'selected');
    expect(edgeEl('push:0')!.querySelector('path.tree-edge')!.getAttribute('marker-end')).toBe('url(#at-arrow-selected)');
    expect(screen.getByRole('button', { name: '#yolosec' })).toHaveClass('is-selected');
    expect(nodeEl('phish')).toHaveClass('is-path');
    expect(nodeEl('push')).toHaveClass('is-path');
    expect(nodeEl('reality')).toHaveClass('is-dim');
    expect(edgeEl('phish:0')).toHaveClass('is-dim');
  });

  it('does not dim anything without a selection, or for a selection that is gone', async () => {
    const { update } = await setup();
    expect(document.querySelectorAll('.is-dim, .is-path')).toHaveLength(0);
    await update({ selection: { type: 'edge', id: 'gone:3' } });
    expect(document.querySelectorAll('.is-dim, .is-path')).toHaveLength(0);
    // e.g. a node that was just added, then undone
    await update({ selection: { type: 'node', id: 'new_attack' } });
    expect(document.querySelectorAll('.is-dim, .is-path')).toHaveLength(0);
  });
});

describe('editing', () => {
  /** what is under the pointer, since jsdom has no hit testing */
  function hitTest(find: (x: number, y: number) => Element | null) {
    Object.defineProperty(document, 'elementFromPoint', { value: find, configurable: true });
    onTestFinished(() => {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    });
  }

  it('adds nodes from the toolbar', async () => {
    const { handlers, user } = await setup();
    for (const [name, kind] of [
      ['Fact', 'fact'],
      ['Attack', 'attack'],
      ['Mitigation', 'mitigation'],
      ['Goal', 'goal'],
    ]) {
      await user.click(screen.getByRole('button', { name }));
      expect(handlers.onAdd).toHaveBeenLastCalledWith(kind);
    }
  });

  it('deletes the selected node with Delete or Backspace', async () => {
    const { handlers, update } = await setup({ selection: { type: 'node', id: 'review' } });
    await press('Delete');
    expect(handlers.onDelete).toHaveBeenCalledOnce();
    const [nodes, edges] = handlers.onDelete.mock.calls[0];
    expect(nodes).toEqual(['review']);
    // React Flow also hands over the connected edges; the app drops the ones the node takes with it
    expect([...edges].sort()).toEqual(['phish:1', 'review:0']);

    handlers.onDelete.mockClear();
    await update({ selection: { type: 'edge', id: 'shipped:0' } });
    await press('Backspace');
    expect(handlers.onDelete).toHaveBeenCalledWith([], ['shipped:0']);
  });

  it('cannot delete reality or an undeclared node with the keyboard', async () => {
    const { handlers, update } = await setup({ selection: { type: 'node', id: 'reality' } });
    await press('Delete');
    await update({ selection: { type: 'node', id: 'ghost' } });
    await press('Delete');
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it('connects two nodes', async () => {
    const { handlers } = await setup();
    act(() => props().onConnect({ source: 'phish', target: 'shipped', sourceHandle: null, targetHandle: null }));
    expect(handlers.onConnect).toHaveBeenCalledWith('phish', 'shipped');
  });

  it('accepts only connections that make sense', async () => {
    await setup();
    const valid = (source: string, target: string) => props().isValidConnection({ source, target, sourceHandle: null, targetHandle: null });
    expect(valid('phish', 'shipped')).toBe(true);
    // a backwards edge is fine: the app marks it
    expect(valid('shipped', 'phish')).toBe(true);
    expect(valid('phish', 'phish')).toBe(false);
    expect(valid('phish', 'reality')).toBe(false);
    expect(valid('phish', 'ghost')).toBe(false);
    expect(valid('phish', 'nowhere')).toBe(false);
    // already connected
    expect(valid('phish', 'push')).toBe(false);
    expect(valid('push', 'phish')).toBe(true);
  });

  it('creates the next node when a connection is dropped on empty canvas', async () => {
    hitTest(() => null);
    const { handlers } = await setup();
    const end = (state: { isValid: boolean | null; fromNode: unknown; toNode: unknown }) =>
      act(() => props().onConnectEnd(new MouseEvent('mouseup'), state as unknown as FinalConnectionState));
    const fromNode = { id: 'push' } as FinalConnectionState['fromNode'];
    end({ isValid: false, fromNode, toNode: null });
    expect(handlers.onCreateFrom).toHaveBeenCalledWith('push');
    end({ isValid: null, fromNode, toNode: null });
    expect(handlers.onCreateFrom).toHaveBeenCalledTimes(2);
    // dropped on a node it cannot connect to: nothing happens
    end({ isValid: false, fromNode, toNode: { id: 'reality' } as FinalConnectionState['toNode'] });
    // connected: onConnect does the work
    end({ isValid: true, fromNode, toNode: { id: 'shipped' } as FinalConnectionState['toNode'] });
    end({ isValid: false, fromNode: null, toNode: null });
    expect(handlers.onCreateFrom).toHaveBeenCalledTimes(2);
  });

  it('drags a connection out of a handle and drops it on empty canvas', async () => {
    hitTest((x, y) => (x === 900 && y === 790 ? document.querySelector('.react-flow__pane') : null));
    const { handlers } = await setup();
    const handle = nodeEl('push').querySelector('.handle-out')!;
    fireEvent.mouseDown(handle, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(document, { clientX: 900, clientY: 790 });
    await flush();
    // while connecting, the other cards become drop targets
    expect(nodeEl('shipped').querySelector('.handle-in')).toHaveClass('is-cover');
    expect(nodeEl('push').querySelector('.handle-in')).not.toHaveClass('is-cover');
    expect(nodeEl('reality').querySelector('.handle-in')).not.toHaveClass('is-cover');
    expect(nodeEl('ghost').querySelector('.handle-in')).not.toHaveClass('is-cover');
    fireEvent.mouseUp(document, { clientX: 900, clientY: 790 });
    await flush();
    expect(handlers.onCreateFrom).toHaveBeenCalledWith('push');
    expect(handlers.onConnect).not.toHaveBeenCalled();
    expect(nodeEl('shipped').querySelector('.handle-in')).not.toHaveClass('is-cover');
  });

  it('connects by dragging from one handle onto another node', async () => {
    const { handlers, layout } = await setup();
    const target = layout!.nodes.get('shipped')!;
    // React Flow measures handles at the card's corner in jsdom; the viewport is not moved
    hitTest((x, y) => (x === target.x && y === target.y ? nodeEl('shipped').querySelector('.handle-in') : null));
    fireEvent.mouseDown(nodeEl('phish').querySelector('.handle-out')!, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(document, { clientX: target.x, clientY: target.y });
    fireEvent.mouseUp(document, { clientX: target.x, clientY: target.y });
    await flush();
    expect(handlers.onConnect).toHaveBeenCalledWith('phish', 'shipped');
    expect(handlers.onCreateFrom).not.toHaveBeenCalled();
  });

  it('does not create a node when a connection is dropped on a node that cannot take it', async () => {
    const { handlers, layout } = await setup();
    const reality = layout!.nodes.get('reality')!;
    const [cx, cy] = [reality.x + reality.width / 2, reality.y + reality.height / 2];
    hitTest((x, y) => (x === cx && y === cy ? nodeEl('reality').querySelector('.tree-node-label') : null));
    fireEvent.mouseDown(nodeEl('push').querySelector('.handle-out')!, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(document, { clientX: cx, clientY: cy });
    fireEvent.mouseUp(document, { clientX: cx, clientY: cy });
    await flush();
    expect(handlers.onConnect).not.toHaveBeenCalled();
    // "drop on empty space" adds the next step; this was not empty space
    expect(handlers.onCreateFrom).not.toHaveBeenCalled();
  });

  it('tells empty canvas from a node for touch drops too', async () => {
    const { handlers } = await setup();
    const fromNode = { id: 'push' } as FinalConnectionState['fromNode'];
    const touch = (clientX: number, clientY: number) => ({ changedTouches: [{ clientX, clientY }], touches: [] }) as unknown as TouchEvent;
    hitTest((x) => (x === 1 ? nodeEl('ghost') : x === 2 ? document.querySelector('.react-flow__pane') : null));
    act(() => props().onConnectEnd(touch(1, 1), { isValid: false, fromNode, toNode: null } as FinalConnectionState));
    expect(handlers.onCreateFrom).not.toHaveBeenCalled();
    act(() => props().onConnectEnd(touch(2, 2), { isValid: false, fromNode, toNode: null } as FinalConnectionState));
    expect(handlers.onCreateFrom).toHaveBeenCalledWith('push');
    // no lifted finger to locate: do nothing rather than guess
    act(() => props().onConnectEnd({ changedTouches: [] } as unknown as TouchEvent, { isValid: false, fromNode, toNode: null } as FinalConnectionState));
    expect(handlers.onCreateFrom).toHaveBeenCalledTimes(1);
  });

  it('reports where a node was dragged to', async () => {
    const { handlers, layout } = await setup();
    const p = layout!.nodes.get('review')!;
    act(() => props().onNodeDragStart(new MouseEvent('mousedown'), { id: 'review' } as never, []));
    act(() => props().onNodeDragStop(new MouseEvent('mouseup'), { id: 'review', position: { x: p.x + 40, y: p.y - 10 } } as never, []));
    expect(handlers.onMove).toHaveBeenCalledWith({ review: { x: p.x + 40, y: p.y - 10 } });
  });

  it('drags a node with the mouse', async () => {
    const { handlers, layout } = await setup();
    const p = layout!.nodes.get('review')!;
    const el = nodeEl('review');
    // d3-drag listens on the event's view, which has to be jsdom's own window object
    const view = (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window;
    const mouse = (target: EventTarget, type: string, clientX: number, clientY: number) =>
      act(() => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view, button: 0, clientX, clientY }));
      });
    mouse(el, 'mousedown', 10, 10);
    mouse(view, 'mousemove', 60, 30);
    mouse(view, 'mousemove', 110, 60);
    await flush();
    // its edges follow the node while it moves, instead of the precomputed route
    const routed = layout!.edges.get('review:0')!.path;
    expect(edgeEl('review:0')!.querySelector('path.tree-edge')!.getAttribute('d')).not.toBe(routed);
    expect(edgeEl('phish:0')!.querySelector('path.tree-edge')!.getAttribute('d')).toBe(layout!.edges.get('phish:0')!.path);
    // where React Flow draws the node at the moment it is dropped
    const [, x, y] = el.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)!.map(Number);
    expect(x).toBeGreaterThan(p.x + 50);
    expect(y).toBeGreaterThan(p.y + 30);
    expect(handlers.onMove).not.toHaveBeenCalled();
    mouse(view, 'mouseup', 110, 60);
    await flush();
    expect(handlers.onMove).toHaveBeenCalledOnce();
    expect(handlers.onMove).toHaveBeenCalledWith({ review: { x, y } });
    expect(edgeEl('review:0')!.querySelector('path.tree-edge')!.getAttribute('d')).toBe(routed);
  });

  it('snaps back after a tiny drag instead of saving it', async () => {
    const { handlers, layout } = await setup();
    const p = layout!.nodes.get('review')!;
    act(() => props().onNodesChange([{ type: 'position', id: 'review', position: { x: p.x + 1, y: p.y + 1 }, dragging: true }]));
    await flush();
    expect(nodeEl('review').style.transform).toBe(`translate(${p.x + 1}px,${p.y + 1}px)`);
    act(() => props().onNodeDragStop(new MouseEvent('mouseup'), { id: 'review', position: { x: p.x + 1, y: p.y + 1 } } as never, []));
    await flush();
    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(nodeEl('review').style.transform).toBe(`translate(${p.x}px,${p.y}px)`);
  });

  it('ignores a drag stop for a node the layout does not know', async () => {
    const { handlers } = await setup();
    act(() => props().onNodeDragStop(new MouseEvent('mouseup'), { id: 'nope', position: { x: 500, y: 500 } } as never, []));
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('keeps selection and removal under the app’s control', async () => {
    const { handlers } = await setup();
    act(() =>
      props().onNodesChange([
        { type: 'select', id: 'push', selected: true },
        { type: 'remove', id: 'push' },
      ]),
    );
    await flush();
    expect(nodeEl('push')).toBeInTheDocument();
    expect(nodeEl('push').querySelector('.tree-node')).not.toHaveClass('is-selected');
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it('draws hand-placed edges node to node, and offers auto-arrange', async () => {
    const tree = parseTree(`${TEXT}positions:\n  review: [600, 40]\n  nowhere: [1, 1]\n`);
    const { handlers, user, layout } = await setup({ tree });
    expect(layout!.edges.get('review:0')!.free).toBe(true);
    // free edges follow the measured nodes live
    expect(edgeEl('review:0')!.querySelector('path.tree-edge')!.getAttribute('d')).toMatch(/^M/);
    const button = screen.getByRole('button', { name: 'Auto-arrange' });
    expect(button).toHaveAttribute('title', 'Auto-arrange: forget the 1 position set by hand');
    await user.click(button);
    expect(handlers.onResetLayout).toHaveBeenCalledOnce();
    // only nodes on screen: "nowhere" is not in the layout
    expect(handlers.onResetLayout).toHaveBeenCalledWith(['review']);
  });

  it('counts the positions set by hand', async () => {
    const tree = parseTree(`${TEXT}positions:\n  review: [600, 40]\n  phish: [0, 0]\n`);
    await setup({ tree });
    expect(screen.getByRole('button', { name: 'Auto-arrange' })).toHaveAttribute(
      'title',
      'Auto-arrange: forget the 2 positions set by hand',
    );
  });

  it('offers no auto-arrange when nothing on screen was placed by hand', async () => {
    const tree = parseTree(`${TEXT}positions:\n  nowhere: [1, 1]\n`);
    await setup({ tree });
    expect(screen.queryByRole('button', { name: 'Auto-arrange' })).toBeNull();
  });
});

describe('read-only', () => {
  it('blocks every edit while the YAML is broken', async () => {
    const tree = parseTree(`${TEXT}positions:\n  review: [600, 40]\n`);
    const { handlers } = await setup({ tree, readOnly: true, selection: { type: 'node', id: 'review' } });
    expect(screen.queryByRole('button', { name: 'Fact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Auto-arrange' })).toBeNull();
    expect(props().deleteKeyCode).toBeNull();
    expect(props().nodesDraggable).toBe(false);
    expect(props().nodesConnectable).toBe(false);
    await press('Delete');
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(nodeEl('review')).not.toHaveClass('draggable');
    for (const n of props().nodes as Array<{ deletable: boolean; draggable: boolean; connectable: boolean }>) {
      expect(n).toMatchObject({ deletable: false, draggable: false, connectable: false });
    }
    for (const e of props().edges as Array<{ deletable: boolean }>) expect(e.deletable).toBe(false);
    // still possible to look around
    fireEvent.click(nodeEl('push'));
    expect(handlers.onSelect).toHaveBeenLastCalledWith({ type: 'node', id: 'push' });
    expect(screen.getByTitle('Zoom in')).toBeInTheDocument();
  });

  it('allows editing otherwise', async () => {
    await setup();
    expect(props().deleteKeyCode).toEqual(['Backspace', 'Delete']);
    const nodes = props().nodes as Array<{ id: string; deletable: boolean; draggable: boolean }>;
    expect(nodes.find((n) => n.id === 'push')).toMatchObject({ deletable: true, draggable: true });
    expect(nodes.find((n) => n.id === 'reality')).toMatchObject({ deletable: false, draggable: true });
    expect(nodes.find((n) => n.id === 'ghost')).toMatchObject({ deletable: false, draggable: true });
  });
});

describe('viewport', () => {
  it('zooms and fits from the buttons', async () => {
    const { user } = await setup();
    await user.click(screen.getByTitle('Zoom in'));
    expect(rf.flow!.zoomIn).toHaveBeenCalledWith({ duration: 160 });
    await user.click(screen.getByTitle('Zoom out'));
    expect(rf.flow!.zoomOut).toHaveBeenCalledWith({ duration: 160 });
    rf.flow!.fitView.mockClear();
    await user.click(screen.getByTitle('Fit tree'));
    expect(rf.flow!.fitView).toHaveBeenCalledWith({
      padding: { top: '76px', bottom: '64px', left: '40px', right: '40px' },
      duration: 260,
    });
  });

  it('fits the tree once per fit request', async () => {
    const { update } = await setup();
    const fit = rf.flow!.fitView;
    expect(fit).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledWith({ padding: { top: '76px', bottom: '64px', left: '40px', right: '40px' }, maxZoom: 1.1, duration: 0 });
    // a new layout of the same document keeps the view
    const tree = parseTree(TEXT.replace('Backdoor ships', 'Backdoor ships to prod'));
    await update({ tree, layout: await layoutOf(tree) });
    expect(fit).toHaveBeenCalledTimes(1);
    await update({ fitNonce: 1 });
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it('waits for a layout before fitting', async () => {
    const { update } = await setup({ layout: null, fitNonce: 3 });
    expect(rf.flow!.fitView).not.toHaveBeenCalled();
    const tree = parseTree(TEXT);
    await update({ layout: await layoutOf(tree) });
    expect(rf.flow!.fitView).toHaveBeenCalledTimes(1);
  });

  it('does not fit an empty tree', async () => {
    const tree = parseTree('title: Empty\n');
    await setup({ tree });
    expect(rf.flow!.fitView).not.toHaveBeenCalled();
  });

  it('brings a node picked elsewhere into view', async () => {
    const { update, layout } = await setup({ selection: { type: 'node', id: 'review' } });
    const p = layout!.nodes.get('review')!;
    expect(rf.flow!.setCenter).not.toHaveBeenCalled();
    rf.viewport = { x: -5000, y: 0, zoom: 0.8 };
    await update({ revealNonce: 1 });
    expect(rf.flow!.setCenter).toHaveBeenCalledWith(p.x + p.width / 2, p.y + p.height / 2, { zoom: 0.8, duration: 320 });
  });

  it('leaves the view alone when the node is already visible', async () => {
    const { update, layout } = await setup({ selection: { type: 'node', id: 'review' } });
    const p = layout!.nodes.get('review')!;
    rf.viewport = { x: HOST.width / 2 - (p.x + p.width / 2), y: HOST.height / 2 - (p.y + p.height / 2), zoom: 1 };
    await update({ revealNonce: 1 });
    expect(rf.flow!.setCenter).not.toHaveBeenCalled();
  });

  it('checks every side of the viewport', async () => {
    const { update, layout } = await setup({ selection: { type: 'node', id: 'review' } });
    const p = layout!.nodes.get('review')!;
    let nonce = 1;
    for (const viewport of [
      { x: 48 - p.x, y: 0, zoom: 1 }, // left edge on the margin
      { x: 0, y: 48 - p.y, zoom: 1 }, // top edge on the margin
      { x: HOST.width - 48 - p.width - p.x, y: 0, zoom: 1 }, // right edge on the margin
      { x: 0, y: HOST.height - 48 - p.height - p.y, zoom: 1 }, // bottom edge on the margin
    ]) {
      rf.flow!.setCenter.mockClear();
      rf.viewport = viewport;
      await update({ revealNonce: nonce++ });
      expect(rf.flow!.setCenter).toHaveBeenCalledOnce();
    }
    rf.flow!.setCenter.mockClear();
    rf.viewport = { x: 49 - p.x, y: 49 - p.y, zoom: 1 };
    await update({ revealNonce: nonce++ });
    expect(rf.flow!.setCenter).not.toHaveBeenCalled();
  });

  it('reveals only nodes it can find', async () => {
    rf.viewport = { x: -5000, y: -5000, zoom: 1 };
    const { update } = await setup({ selection: { type: 'edge', id: 'push:0' }, revealNonce: 1 });
    await update({ selection: null, revealNonce: 2 });
    await update({ selection: { type: 'node', id: 'nope' }, revealNonce: 3 });
    await update({ selection: { type: 'node', id: 'review' }, layout: null, revealNonce: 4 });
    expect(rf.flow!.setCenter).not.toHaveBeenCalled();
  });

  it('does not chase the selection on every click', async () => {
    rf.viewport = { x: -5000, y: -5000, zoom: 1 };
    const { update } = await setup({ selection: { type: 'node', id: 'review' } });
    await update({ selection: { type: 'node', id: 'push' } });
    expect(rf.flow!.setCenter).not.toHaveBeenCalled();
  });
});
