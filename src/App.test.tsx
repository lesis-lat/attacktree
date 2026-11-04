/**
 * End-to-end tests for the editor shell: real YAML editor, real canvas, real
 * layout engine (in-process), real IndexedDB (fake-indexeddb). Only browser
 * boundaries are replaced: clipboard, downloads, PNG rasterising, window.open,
 * canvas text measuring, and the Blob streaming methods jsdom lacks.
 */
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clear, createStore, get, set, values } from 'idb-keyval';
import { type ComponentProps, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeCanvas as RealTreeCanvas } from './canvas/TreeCanvas';
import type { TreeDoc } from './store/docs';

type CanvasProps = ComponentProps<typeof RealTreeCanvas>;

const ctl = vi.hoisted(() => ({
  elkFail: false,
  elkGate: null as Promise<unknown> | null,
  listFail: false,
  listGate: null as Promise<unknown> | null,
  saveFail: false,
  saveGate: null as Promise<unknown> | null,
  deleteGate: null as Promise<unknown> | null,
  canvas: null as unknown,
}));

// The layout engine runs in-process instead of in a worker.
vi.mock('elkjs/lib/elk-api.js', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const engine = new ELK();
  return {
    default: class {
      layout(graph: Parameters<typeof engine.layout>[0]) {
        if (ctl.elkFail) return Promise.reject(new Error('layout engine down'));
        const run = () => engine.layout(graph);
        return ctl.elkGate ? ctl.elkGate.then(run) : run();
      }
    },
  };
});
vi.mock('elkjs/lib/elk-worker.min.js?url', () => ({ default: 'elk-worker.js' }));

// Real storage, with switches to simulate a browser that refuses or is slow.
vi.mock('./store/docs', async (importOriginal) => {
  const real = await importOriginal<typeof import('./store/docs')>();
  return {
    ...real,
    listDocs: async () => {
      if (ctl.listGate) await ctl.listGate;
      if (ctl.listFail) throw new Error('blocked');
      return real.listDocs();
    },
    saveDoc: async (doc: TreeDoc) => {
      if (ctl.saveGate) await ctl.saveGate;
      if (ctl.saveFail) throw new Error('quota');
      return real.saveDoc(doc);
    },
    // the delete is issued at once (like IndexedDB), but completes late
    deleteDoc: (id: string) => {
      const done = real.deleteDoc(id);
      return ctl.deleteGate ? done.then(() => ctl.deleteGate) : done;
    },
  };
});

// Downloads and PNG rasterising are browser boundaries; SVG rendering stays real.
vi.mock('./export/exporters', async (importOriginal) => {
  const real = await importOriginal<typeof import('./export/exporters')>();
  return {
    ...real,
    download: vi.fn(),
    renderPng: vi.fn(async () => new Blob(['PNGDATA'], { type: 'image/png' })),
  };
});

// The real canvas, with its callbacks reachable for gestures jsdom cannot perform
// (dragging a connection between handles needs real geometry).
vi.mock('./canvas/TreeCanvas', async (importOriginal) => {
  const real = await importOriginal<typeof import('./canvas/TreeCanvas')>();
  return {
    ...real,
    TreeCanvas: (props: CanvasProps) => {
      ctl.canvas = props;
      return createElement(real.TreeCanvas, props);
    },
  };
});

import { App } from './App';
import { aiPrompt } from './ai/prompt';
import * as exporters from './export/exporters';
import { extractEmbedded } from './model/embed';
import { BLANK_TREE, EXAMPLE_CICD } from './model/examples';
import { parseTree } from './model/parse';
import { decodeShare, encodeShare } from './model/share';

const download = vi.mocked(exporters.download);
const renderPng = vi.mocked(exporters.renderPng);
const canvas = () => ctl.canvas as CanvasProps;

// --- browser gaps in jsdom -------------------------------------------------------

HTMLCanvasElement.prototype.getContext = function () {
  return { font: '', measureText: (t: string) => ({ width: t.length * 7 }) };
} as never;
HTMLElement.prototype.setPointerCapture ??= function () {};

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}
Blob.prototype.arrayBuffer ??= function (this: Blob) {
  return readBlob(this);
};
Blob.prototype.text ??= async function (this: Blob) {
  return new TextDecoder().decode(await readBlob(this));
};
Blob.prototype.stream ??= function (this: Blob) {
  const blob = this;
  return new ReadableStream({
    async start(c) {
      c.enqueue(new Uint8Array(await readBlob(blob)));
      c.close();
    },
  });
} as never;

// --- fixtures --------------------------------------------------------------------

const SMALL = `title: Small tree

facts:
- public_repo: Source is public
  from:
  - reality

attacks:
- phish: Phish a maintainer
  from:
  - public_repo
- push: Push to main
  from:
  - phish

mitigations:
- mfa: Hardware keys
  from:
  - phish

goals:
- win: Malicious release
  from:
  - push
`;

const OTHER = `title: Other tree

attacks:
- guess: Guess the password
  from:
  - reality
`;

const idb = createStore('attacktree', 'docs');
const allDocs = async () => (await values<TreeDoc>(idb)).sort((a, b) => b.updatedAt - a.updatedAt);
const storedDoc = (id: string) => get<TreeDoc>(id, idb);

let seq = 0;
async function seed(text: string, init: Partial<TreeDoc> = {}): Promise<TreeDoc> {
  const now = Date.now();
  const doc: TreeDoc = { id: `seed${++seq}`, title: text.match(/^title: (.*)$/m)?.[1] ?? 'Untitled tree', text, createdAt: now, updatedAt: now, ...init };
  await set(doc.id, doc, idb);
  return doc;
}

// --- helpers ---------------------------------------------------------------------

const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const yaml = () => view().state.doc.toString();
const flowNode = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
const flowIds = () => [...document.querySelectorAll('.react-flow__node')].map((n) => n.getAttribute('data-id'));
const inspector = () => document.querySelector<HTMLElement>('.inspector');
const saveDot = () => document.querySelector('.save-dot')!;
const counts = () => document.querySelector('.status-counts')!.textContent;
const docTitle = () => document.querySelector('.doc-title')!.textContent;
const app = () => document.querySelector<HTMLElement>('.app')!;
const workspace = () => document.querySelector('main.workspace')!;
const toastTexts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);
const lastOpenId = () => localStorage.getItem('attacktree:last-open');

/** a user edit in the YAML editor: replaces the whole document */
function typeYaml(text: string) {
  act(() => {
    const v = view();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, annotations: isolateHistory.of('full') });
  });
}

function setCursor(pos: number) {
  act(() => view().dispatch({ selection: { anchor: pos } }));
}

async function mount() {
  const result = render(<App />);
  await waitFor(() => expect(document.querySelector('.cm-editor')).toBeTruthy());
  return result;
}

/** mount and wait until the canvas shows the opened tree */
async function mountReady(firstNode = 'reality') {
  const result = await mount();
  await waitFor(() => expect(flowNode(firstNode)).toBeTruthy(), { timeout: 4000 });
  return result;
}

function openDocMenu() {
  fireEvent.click(document.querySelector('button.doc-switcher')!);
  return screen.getByRole('menu');
}

function menuItem(name: RegExp | string) {
  return screen.getByRole('menuitem', { name });
}

function key(target: Element | Document, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function pointer(target: Element, type: string, clientX: number) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
  });
}

function mouse(target: Element | Document, type: string, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'view', { value: window }); // d3-drag reads event.view
  act(() => {
    target.dispatchEvent(e);
  });
}

async function dragNode(id: string, dx: number, dy: number) {
  const el = flowNode(id)!;
  mouse(el, 'mousedown', 10, 10);
  mouse(document, 'mousemove', 10 + dx / 2, 10 + dy / 2);
  mouse(document, 'mousemove', 10 + dx, 10 + dy);
  mouse(document, 'mouseup', 10 + dx, 10 + dy);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>() };

beforeEach(async () => {
  await clear(idb);
  Object.assign(ctl, { elkFail: false, elkGate: null, listFail: false, listGate: null, saveFail: false, saveGate: null, deleteGate: null, canvas: null });
  history.replaceState(null, '', '/');
  document.documentElement.removeAttribute('data-theme');
  download.mockClear();
  renderPng.mockClear();
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

// =================================================================================

describe('opening trees', () => {
  it('opens the example on the first visit and saves it in the browser', async () => {
    await mountReady('malicious_release');
    expect(docTitle()).toBe('Ship a malicious release through CI/CD');
    expect(yaml()).toBe(EXAMPLE_CICD);
    expect(counts()).toBe('23 nodes · 29 edges');
    expect(screen.getByText('No problems')).toBeInTheDocument();
    expect(saveDot()).not.toHaveClass('is-dirty');
    expect(saveDot()).toHaveAttribute('title', 'Saved in this browser');
    const docs = await allDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ title: 'Ship a malicious release through CI/CD', text: EXAMPLE_CICD });
    expect(lastOpenId()).toBe(docs[0].id);
  });

  it('reopens the tree that was open last, and lists every tree with its age', async () => {
    const now = Date.now();
    const old = await seed(OTHER, { updatedAt: new Date(2020, 0, 2).getTime() });
    await seed(SMALL, { title: 'Minutes', updatedAt: now - 5 * 60_000 });
    await seed(SMALL, { title: 'Hours', updatedAt: now - 3 * 3600_000 });
    await seed(SMALL, { title: 'Recent', updatedAt: now - 10_000 });
    localStorage.setItem('attacktree:last-open', old.id);
    await mountReady('guess');
    expect(docTitle()).toBe('Other tree');
    expect(yaml()).toBe(OTHER);

    const menu = openDocMenu();
    const items = within(menu).getAllByRole('menuitem').slice(0, 4);
    expect(items.map((i) => i.querySelector('.menu-text')!.textContent)).toEqual(['Recent', 'Minutes', 'Hours', 'Other tree']);
    expect(items.map((i) => i.querySelector('.menu-hint')!.textContent)).toEqual([
      'just now',
      '5 min ago',
      '3 h ago',
      new Date(2020, 0, 2).toLocaleDateString(),
    ]);
    expect(items[3]).toHaveClass('is-active');
    expect((await allDocs()).length).toBe(4);
  });

  it('opens the most recent tree when the remembered one is gone', async () => {
    await seed(OTHER, { updatedAt: Date.now() - 1000 });
    const recent = await seed(SMALL);
    localStorage.setItem('attacktree:last-open', 'deleted-long-ago');
    await mountReady('win');
    expect(docTitle()).toBe('Small tree');
    expect(lastOpenId()).toBe(recent.id);
  });

  it('imports a share link as a new tree and clears the hash', async () => {
    const existing = await seed(OTHER);
    localStorage.setItem('attacktree:last-open', existing.id);
    history.replaceState(null, '', `/app/?lang=en${await encodeShare(SMALL)}`);
    await mountReady('win');
    expect(docTitle()).toBe('Small tree');
    expect(yaml()).toBe(SMALL);
    expect(await screen.findByText('Opened the shared tree. It is now saved in this browser.')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/app/?lang=en');
    const docs = await allDocs();
    expect(docs).toHaveLength(2);
    const imported = docs.find((d) => d.id !== existing.id)!;
    expect(imported).toMatchObject({ title: 'Small tree', text: SMALL });
    expect(lastOpenId()).toBe(imported.id);
    expect(await storedDoc(existing.id)).toMatchObject({ text: OTHER });
  });

  it('names an untitled shared tree "Shared tree"', async () => {
    history.replaceState(null, '', `/${await encodeShare(OTHER.replace('title: Other tree\n', ''))}`);
    await mountReady('guess');
    expect(docTitle()).toBe('Untitled tree');
    expect((await allDocs())[0].title).toBe('Shared tree');
  });

  it('reports a damaged share link and falls back to the usual tree', async () => {
    history.replaceState(null, '', '/#tree=AAAAAAAA');
    await mountReady('malicious_release');
    expect(await screen.findByText('This share link is damaged')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(docTitle()).toBe('Ship a malicious release through CI/CD');
    expect(await allDocs()).toHaveLength(1);
  });

  it('ignores a hash that is not a share link', async () => {
    history.replaceState(null, '', '/#tree=not valid!');
    await seed(SMALL);
    await mountReady('win');
    expect(window.location.hash).toBe('');
    expect(toastTexts()).toEqual([]);
    expect(await allDocs()).toHaveLength(1);
  });

  it('imports a share link pasted while the app is open, saving pending edits first', async () => {
    const doc = await seed(OTHER);
    await mountReady('guess');
    typeYaml(OTHER.replace('Guess the password', 'Guess harder'));
    const hash = await encodeShare(SMALL);
    act(() => {
      window.location.hash = hash;
    });
    await waitFor(() => expect(docTitle()).toBe('Small tree'));
    expect(window.location.hash).toBe('');
    expect((await storedDoc(doc.id))!.text).toContain('Guess harder');
    expect(await allDocs()).toHaveLength(2);
  });

  it('warns when the browser keeps no data, and still opens the example', async () => {
    ctl.listFail = true;
    ctl.saveFail = true;
    await mountReady('malicious_release');
    await waitFor(() =>
      expect(toastTexts()).toEqual([
        'This browser is not keeping data; changes will be lost on reload',
        'This browser is not keeping data; changes will be lost on reload',
      ]),
    );
    expect(docTitle()).toBe('Ship a malicious release through CI/CD');
  });

  it('reports a layout failure', async () => {
    ctl.elkFail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seed(SMALL);
    await mount();
    expect(await screen.findByText('Could not lay out this tree')).toBeInTheDocument();
    expect(err).toHaveBeenCalled();
    expect(flowIds()).toEqual([]);
  });
});

// =================================================================================

describe('editing and saving', () => {
  it('updates the canvas, the save dot and the stored tree while typing', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    expect(counts()).toBe('6 nodes · 5 edges');

    typeYaml(`${SMALL}- extra: Extra goal\n  from:\n  - mfa\n`);
    expect(saveDot()).toHaveClass('is-dirty');
    expect(saveDot()).toHaveAttribute('title', 'Saving…');
    expect(counts()).toBe('7 nodes · 6 edges');
    await waitFor(() => expect(flowNode('extra')).toBeTruthy());
    expect(flowNode('extra')).toHaveTextContent('Extra goal');

    await waitFor(() => expect(saveDot()).not.toHaveClass('is-dirty'));
    expect((await storedDoc(doc.id))!.text).toContain('- extra: Extra goal');
  });

  it('renames the tree from its title line', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    typeYaml(SMALL.replace('title: Small tree', 'title: Renamed tree'));
    expect(docTitle()).toBe('Renamed tree');
    await waitFor(async () => expect((await storedDoc(doc.id))!.title).toBe('Renamed tree'));
    openDocMenu();
    expect(menuItem(/Renamed tree/)).toHaveClass('is-active');

    typeYaml(SMALL.replace('title: Small tree\n', ''));
    expect(docTitle()).toBe('Untitled tree');
    await waitFor(async () => expect((await storedDoc(doc.id))!.title).toBe('Untitled tree'));
  });

  it('saves at once with Ctrl+S', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    typeYaml(SMALL.replace('Hardware keys', 'FIDO2 keys'));
    const e = key(document.body, { key: 's', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    // the toast comes once the save landed, well before the autosave delay
    expect(await screen.findByText('Saved in this browser', {}, { timeout: 300 })).toBeInTheDocument();
    expect((await storedDoc(doc.id))!.text).toContain('FIDO2 keys');
    expect(saveDot()).not.toHaveClass('is-dirty');
  });

  it('saves with ⌘S too, even with nothing to save', async () => {
    await seed(SMALL);
    await mountReady('win');
    key(document.body, { key: 'S', metaKey: true });
    expect(await screen.findByText('Saved in this browser')).toBeInTheDocument();
  });

  it('flushes pending edits when the page is hidden', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    typeYaml(SMALL.replace('Hardware keys', 'Passkeys'));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(async () => expect((await storedDoc(doc.id))!.text).toContain('Passkeys'), { timeout: 400 });
    typeYaml(SMALL.replace('Hardware keys', 'Tokens'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(async () => expect((await storedDoc(doc.id))!.text).toContain('Tokens'), { timeout: 400 });
  });

  it('says so when saving fails, and keeps the dot dirty', async () => {
    await seed(SMALL);
    await mountReady('win');
    ctl.saveFail = true;
    typeYaml(SMALL.replace('Hardware keys', 'Passkeys'));
    expect(await screen.findByText('Could not save in this browser', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(saveDot()).toHaveClass('is-dirty');
  });

  it('retries a failed save on Ctrl+S instead of claiming it is saved', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    ctl.saveFail = true;
    typeYaml(SMALL.replace('Hardware keys', 'Passkeys'));
    expect(await screen.findByText('Could not save in this browser', {}, { timeout: 2000 })).toBeInTheDocument();
    ctl.saveFail = false;
    key(document.body, { key: 's', ctrlKey: true });
    await waitFor(async () => expect((await storedDoc(doc.id))!.text).toContain('Passkeys'));
    expect(await screen.findByText('Saved in this browser')).toBeInTheDocument();
    expect(saveDot()).not.toHaveClass('is-dirty');
  });

  it('retries a failed save before switching trees', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    ctl.saveFail = true;
    typeYaml(SMALL.replace('Hardware keys', 'Passkeys'));
    expect(await screen.findByText('Could not save in this browser', {}, { timeout: 2000 })).toBeInTheDocument();
    ctl.saveFail = false;
    openDocMenu();
    fireEvent.click(menuItem('New tree'));
    await waitFor(() => expect(yaml()).toBe(BLANK_TREE));
    expect((await storedDoc(doc.id))!.text).toContain('Passkeys');
  });

  it('marks a new tree that could not be stored as unsaved, and stores it on Ctrl+S', async () => {
    await seed(SMALL);
    await mountReady('win');
    ctl.saveFail = true;
    openDocMenu();
    fireEvent.click(menuItem('New tree'));
    expect(await screen.findByText('This browser is not keeping data; changes will be lost on reload')).toBeInTheDocument();
    await waitFor(() => expect(yaml()).toBe(BLANK_TREE));
    expect(saveDot()).toHaveClass('is-dirty');
    expect(await allDocs()).toHaveLength(1);
    ctl.saveFail = false;
    key(document.body, { key: 's', ctrlKey: true });
    await waitFor(async () => expect(await allDocs()).toHaveLength(2));
    expect((await allDocs()).some((d) => d.text === BLANK_TREE)).toBe(true);
    expect(saveDot()).not.toHaveClass('is-dirty');
  });

  it('does not claim "Saved" on Ctrl+S when saving fails', async () => {
    await seed(SMALL);
    await mountReady('win');
    ctl.saveFail = true;
    typeYaml(SMALL.replace('Hardware keys', 'Passkeys'));
    key(document.body, { key: 's', ctrlKey: true });
    expect(await screen.findByText('Could not save in this browser')).toBeInTheDocument();
    expect(toastTexts()).not.toContain('Saved in this browser');
  });

  it('keeps the dot dirty when more edits arrive while a save is in flight', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    const gate = deferred();
    ctl.saveGate = gate.promise;
    typeYaml(SMALL.replace('Hardware keys', 'First edit'));
    key(document.body, { key: 's', ctrlKey: true }); // save starts, and waits on the disk
    typeYaml(SMALL.replace('Hardware keys', 'Second edit'));
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    ctl.saveGate = null;
    // the first save landed, the second edit is not saved yet
    await waitFor(async () => expect((await storedDoc(doc.id))!.text).toContain('First edit'));
    expect(saveDot()).toHaveClass('is-dirty');
    await waitFor(async () => expect((await storedDoc(doc.id))!.text).toContain('Second edit'));
    await waitFor(() => expect(saveDot()).not.toHaveClass('is-dirty'));
  });
});

// =================================================================================

describe('the tree menu', () => {
  it('creates a new tree, saving the current one first', async () => {
    const first = await seed(SMALL);
    await mountReady('win');
    typeYaml(SMALL.replace('Hardware keys', 'Unsaved edit'));
    openDocMenu();
    fireEvent.click(menuItem('New tree'));
    await waitFor(() => expect(flowNode('attacker_wins')).toBeTruthy());
    expect(yaml()).toBe(BLANK_TREE);
    expect(docTitle()).toBe('Untitled tree');
    expect(screen.queryByRole('menu')).toBeNull();
    const docs = await allDocs();
    expect(docs).toHaveLength(2);
    expect((await storedDoc(first.id))!.text).toContain('Unsaved edit');
    const created = docs.find((d) => d.id !== first.id)!;
    expect(created).toMatchObject({ title: 'Untitled tree', text: BLANK_TREE });
    expect(lastOpenId()).toBe(created.id);
    expect(saveDot()).not.toHaveClass('is-dirty');
  });

  it('creates a tree from the example', async () => {
    await seed(SMALL);
    await mountReady('win');
    openDocMenu();
    fireEvent.click(menuItem('New from example'));
    await waitFor(() => expect(yaml()).toBe(EXAMPLE_CICD));
    expect(await allDocs()).toHaveLength(2);
  });

  it('switches between trees, with a fresh undo history', async () => {
    const small = await seed(SMALL, { updatedAt: Date.now() - 1000 });
    const other = await seed(OTHER);
    localStorage.setItem('attacktree:last-open', small.id);
    await mountReady('win');
    expect(docTitle()).toBe('Small tree');

    openDocMenu();
    fireEvent.click(menuItem(/Other tree/));
    await waitFor(() => expect(flowNode('guess')).toBeTruthy());
    expect(yaml()).toBe(OTHER);
    expect(flowNode('win')).toBeNull();
    expect(lastOpenId()).toBe(other.id);

    key(document.body, { key: 'z', ctrlKey: true });
    expect(yaml()).toBe(OTHER);

    // picking the open tree again does nothing
    openDocMenu();
    fireEvent.click(menuItem(/Other tree/));
    expect(yaml()).toBe(OTHER);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('duplicates the tree', async () => {
    const original = await seed(SMALL);
    await mountReady('win');
    openDocMenu();
    fireEvent.click(menuItem('Duplicate'));
    await waitFor(() => expect(docTitle()).toBe('Small tree (copy)'));
    expect(yaml()).toBe(SMALL.replace('title: Small tree', 'title: Small tree (copy)'));
    const docs = await allDocs();
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.id !== original.id)!.title).toBe('Small tree (copy)');
  });

  it('duplicates a tree whose title is quoted without breaking the YAML', async () => {
    const text = SMALL.replace('title: Small tree', "title: 'Bob''s tree: v2'");
    await seed(text);
    await mountReady('win');
    expect(docTitle()).toBe("Bob's tree: v2");
    openDocMenu();
    fireEvent.click(menuItem('Duplicate'));
    await waitFor(() => expect(docTitle()).toBe("Bob's tree: v2 (copy)"));
    expect(document.querySelector('.syntax-banner')).toBeNull();
    expect(screen.getByText('No problems')).toBeInTheDocument();
  });

  it('duplicates a tree whose title line has a comment', async () => {
    await seed(SMALL.replace('title: Small tree', 'title: Small tree # draft'));
    await mountReady('win');
    openDocMenu();
    fireEvent.click(menuItem('Duplicate'));
    await waitFor(() => expect(docTitle()).toBe('Small tree (copy)'));
    expect(yaml()).toContain('# draft');
  });

  it.each([
    ['a multi-line title', 'title: "Line one\\nline two"\n\nattacks:\n- a: A\n', 'Line one\nline two (copy)'],
    ['a title inside a flow mapping', "{title: 'a, b', attacks: [{a: A, from: [reality]}]}\n", 'a, b (copy)'],
    ['a numeric title', 'title: 2024\n\nattacks:\n- a: A\n', '2024 (copy)'],
  ])('duplicates a tree with %s', async (_, text, expected) => {
    await seed(text);
    await mountReady('a');
    openDocMenu();
    fireEvent.click(menuItem('Duplicate'));
    await waitFor(async () => expect(await allDocs()).toHaveLength(2));
    await waitFor(() => expect(parseTree(yaml()).title).toBe(expected));
    expect(parseTree(yaml()).syntaxError).toBe(false);
  });

  it.each([
    ['an empty title', 'title:\n\nattacks:\n- a: A\n'],
    ['a document that is not a mapping', '- a\n- b\n'],
    ['a title written twice', 'title: One\ntitle: Two\n'],
  ])('duplicates %s unchanged', async (_, text) => {
    const original = await seed(text);
    await mount();
    await waitFor(() => expect(yaml()).toBe(text));
    openDocMenu();
    fireEvent.click(menuItem('Duplicate'));
    await waitFor(async () => expect(await allDocs()).toHaveLength(2));
    await waitFor(() => expect(lastOpenId()).not.toBe(original.id));
    expect(yaml()).toBe(text);
  });

  it('ignores Delete before any tree is open', async () => {
    const gate = deferred();
    ctl.listGate = gate.promise;
    await seed(SMALL);
    render(<App />);
    expect(document.querySelector('.cm-editor')).toBeNull();
    openDocMenu();
    fireEvent.click(menuItem('Delete this tree'));
    fireEvent.click(menuItem('Click again to delete'));
    gate.resolve();
    await waitFor(() => expect(flowNode('win')).toBeTruthy());
    expect(toastTexts()).toEqual([]);
    expect(await allDocs()).toHaveLength(1);
  });

  it('duplicates an untitled tree', async () => {
    await seed(OTHER.replace('title: Other tree\n', ''));
    await mountReady('guess');
    openDocMenu();
    fireEvent.click(menuItem('Duplicate'));
    await waitFor(async () => expect(await allDocs()).toHaveLength(2));
    expect((await allDocs()).map((d) => d.title).sort()).toEqual(['Untitled tree', 'Untitled tree (copy)']);
  });

  it('deletes the tree only on the second click', async () => {
    const keep = await seed(OTHER, { updatedAt: Date.now() - 1000 });
    const doomed = await seed(SMALL);
    await mountReady('win');
    openDocMenu();
    const del = menuItem('Delete this tree');
    fireEvent.click(del);
    expect(del).toHaveTextContent('Click again to delete');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(await allDocs()).toHaveLength(2);
    fireEvent.mouseLeave(del);
    expect(del).toHaveTextContent('Delete this tree');
    fireEvent.click(del);
    fireEvent.click(del);
    expect(await screen.findByText('Tree deleted')).toBeInTheDocument();
    await waitFor(() => expect(docTitle()).toBe('Other tree'));
    expect(await storedDoc(doomed.id)).toBeUndefined();
    expect((await allDocs()).map((d) => d.id)).toEqual([keep.id]);
    openDocMenu();
    expect(screen.queryByRole('menuitem', { name: /Small tree/ })).toBeNull();
  });

  it('starts a blank tree after deleting the last one', async () => {
    const only = await seed(SMALL);
    await mountReady('win');
    openDocMenu();
    fireEvent.click(menuItem('Delete this tree'));
    fireEvent.click(menuItem('Click again to delete'));
    await waitFor(() => expect(yaml()).toBe(BLANK_TREE));
    const docs = await allDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].id).not.toBe(only.id);
    expect(docs[0].title).toBe('Untitled tree');
  });

  it('does not bring a deleted tree back when an autosave races the delete', async () => {
    await seed(OTHER, { updatedAt: Date.now() - 1000 });
    const doomed = await seed(SMALL);
    await mountReady('win');
    typeYaml(SMALL.replace('Hardware keys', 'Unsaved edit'));
    const gate = deferred();
    ctl.deleteGate = gate.promise;
    openDocMenu();
    fireEvent.click(menuItem('Delete this tree'));
    fireEvent.click(menuItem('Click again to delete'));
    // the autosave timer fires while the delete is still completing
    await new Promise((r) => setTimeout(r, 600));
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(docTitle()).toBe('Other tree'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await storedDoc(doomed.id)).toBeUndefined();
  });

  it('opens the documentation in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await seed(SMALL);
    await mountReady('win');
    openDocMenu();
    fireEvent.click(menuItem('Documentation'));
    expect(open).toHaveBeenCalledWith('/docs/', '_blank', 'noopener');
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs/');
  });
});

// =================================================================================

describe('canvas editing', () => {
  it('selects a node: the inspector opens, its paths light up and the YAML jumps to it', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(flowNode('phish')!);
    expect(inspector()).toHaveTextContent('Attack');
    expect(within(inspector()!).getByDisplayValue('Phish a maintainer')).toBeInTheDocument();
    const { from, to } = view().state.selection.main;
    expect(yaml().slice(from, to)).toBe('phish');
    expect(flowNode('push')).toHaveClass('is-path');
    expect(flowNode('mfa')).toHaveClass('is-path');
    await waitFor(() => expect(flowNode('reality')).toHaveClass('is-path'));

    fireEvent.click(within(inspector()!).getByTitle('Close'));
    expect(inspector()).toBeNull();
  });

  it('selects an undeclared node without moving the cursor', async () => {
    await seed(`${OTHER}- second: Second\n  from:\n  - ghost\n`);
    await mountReady('ghost');
    setCursor(0);
    act(() => canvas().onSelect({ type: 'node', id: 'ghost' }));
    expect(inspector()).toHaveTextContent('Undeclared node');
    expect(view().state.selection.main.head).toBe(0);
    act(() => canvas().onSelect(null));
    expect(inspector()).toBeNull();
  });

  it('selects a connection and jumps to it in the YAML', async () => {
    await seed(SMALL);
    await mountReady('win');
    act(() => canvas().onSelect({ type: 'edge', id: 'push:0' }));
    expect(inspector()).toHaveTextContent('Connection');
    expect(inspector()).toHaveTextContent('Phish a maintainerPush to main');
    const { from, to } = view().state.selection.main;
    expect(yaml().slice(from, to)).toBe('phish');
    expect(yaml().lastIndexOf('- phish', from)).toBeGreaterThan(yaml().indexOf('- push: Push to main'));
  });

  it('selects from the editor cursor: node, connection, or nothing', async () => {
    await seed(SMALL);
    await mountReady('win');
    setCursor(yaml().indexOf('mfa: Hardware'));
    expect(inspector()).toHaveTextContent('Mitigation');
    setCursor(yaml().indexOf('  - push') + 4);
    expect(inspector()).toHaveTextContent('Connection');
    expect(inspector()).toHaveTextContent('Push to mainMalicious release');
    setCursor(0);
    expect(inspector()).toBeNull();
  });

  it('adds a node from Reality when nothing is selected, and focuses its label', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(document.querySelector('.add-node.kind-attack')!);
    expect(yaml()).toContain('- new_attack: New attack\n  from:\n  - reality\n');
    expect(inspector()).toHaveTextContent('Attack');
    const label = within(inspector()!).getByDisplayValue('New attack') as HTMLTextAreaElement;
    await waitFor(() => expect(label).toHaveFocus());
    expect([label.selectionStart, label.selectionEnd]).toEqual([0, 'New attack'.length]);
    await waitFor(() => expect(flowNode('new_attack')).toBeTruthy());

    fireEvent.click(document.querySelector('.add-node.kind-fact')!);
    expect(yaml()).toMatch(/- new_fact: New fact\n {2}from:\n {2}- new_attack\n/);
  });

  it('adds mitigations and goals unconnected when nothing is selected', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(document.querySelector('.add-node.kind-mitigation')!);
    expect(yaml()).toMatch(/- new_mitigation: New mitigation\n/);
    expect(yaml()).not.toMatch(/- new_mitigation: New mitigation\n {2}from/);
    act(() => canvas().onSelect(null));
    fireEvent.click(document.querySelector('.add-node.kind-goal')!);
    expect(yaml()).toMatch(/- new_goal: New goal\n(?! {2}from)/);
  });

  it('adds from the selected node, but not from an undeclared one or a connection', async () => {
    await seed(`${SMALL}- other: Other goal\n  from:\n  - ghost\n`);
    await mountReady('ghost');
    act(() => canvas().onSelect({ type: 'node', id: 'mfa' }));
    fireEvent.click(document.querySelector('.add-node.kind-attack')!);
    expect(yaml()).toContain('- new_attack: New attack\n  from:\n  - mfa\n');

    act(() => canvas().onSelect({ type: 'node', id: 'ghost' }));
    fireEvent.click(document.querySelector('.add-node.kind-attack')!);
    expect(yaml()).toContain('- new_attack_2: New attack\n  from:\n  - reality\n');
    act(() => canvas().onSelect({ type: 'node', id: 'ghost' }));
    fireEvent.click(document.querySelector('.add-node.kind-goal')!);
    expect(yaml()).toMatch(/- new_goal: New goal\n(?! {2}from)/);

    act(() => canvas().onSelect({ type: 'edge', id: 'push:0' }));
    fireEvent.click(document.querySelector('.add-node.kind-fact')!);
    expect(yaml()).toContain('- new_fact: New fact\n  from:\n  - reality\n');
  });

  it('connects two nodes', async () => {
    await seed(SMALL);
    await mountReady('win');
    act(() => canvas().onConnect('public_repo', 'push'));
    expect(yaml()).toContain('- push: Push to main\n  from:\n  - phish\n  - public_repo\n');
    expect(toastTexts()).toEqual([]);
    expect(counts()).toBe('6 nodes · 6 edges');
  });

  it('marks a connection back up the tree as backwards, and says so', async () => {
    await seed(SMALL);
    await mountReady('win');
    act(() => canvas().onConnect('mfa', 'public_repo'));
    expect(yaml()).toContain('- public_repo: Source is public\n  from:\n  - reality\n  - mfa:\n    backwards: true\n');
    expect(await screen.findByText('Added as a backwards edge: it points back up the tree')).toBeInTheDocument();
  });

  it('shows a refused canvas edit as an error toast and leaves the YAML alone', async () => {
    await seed(SMALL);
    await mountReady('win');
    act(() => canvas().onConnect('phish', 'reality'));
    expect(yaml()).toBe(SMALL);
    const toast = await screen.findByText('Nothing can lead into Reality');
    expect(toast).toHaveClass('is-error');
  });

  it('reports a canvas edit on a document that is not a mapping', async () => {
    await seed('- just\n- a list\n');
    await mount();
    await waitFor(() => expect(document.querySelector('.add-node')).not.toBeNull());
    fireEvent.click(document.querySelector('.add-node.kind-attack')!);
    expect(await screen.findByText('The document must be a mapping')).toHaveClass('is-error');
    expect(yaml()).toBe('- just\n- a list\n');
    expect(inspector()).toBeNull();
  });

  it('creates the next step when a connection is dropped on empty space', async () => {
    await seed(SMALL);
    await mountReady('win');
    act(() => canvas().onCreateFrom('phish'));
    expect(yaml()).toContain('- new_mitigation: New mitigation\n  from:\n  - phish\n');
    act(() => canvas().onCreateFrom('mfa'));
    expect(yaml()).toContain('- new_attack: New attack\n  from:\n  - mfa\n');
    act(() => canvas().onCreateFrom('reality'));
    expect(yaml()).toContain('- new_attack_2: New attack\n  from:\n  - reality\n');
    act(() => canvas().onCreateFrom('vanished'));
    expect(yaml()).toContain('- new_attack_3: New attack\n  from:\n  - vanished\n');
  });

  it('deletes the selected node with Backspace, and every reference to it', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(flowNode('phish')!);
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    await waitFor(() => expect(yaml()).not.toContain('phish'));
    expect(yaml()).toContain('- push: Push to main\n');
    expect(inspector()).toBeNull();
    await waitFor(() => expect(flowNode('phish')).toBeNull());
  });

  it('deletes connections, skipping those of deleted nodes', async () => {
    await seed(`${SMALL}- both: Both\n  from:\n  - push\n  - mfa\n  - public_repo\n`);
    await mountReady('both');
    act(() => canvas().onDelete([], ['both:0', 'both:2']));
    expect(yaml()).toContain('- both: Both\n  from:\n  - mfa\n');
    act(() => canvas().onDelete(['mfa'], ['both:0', 'win:0']));
    expect(yaml()).not.toContain('mfa');
    expect(yaml()).toContain('- win: Malicious release\n');
    expect(yaml()).not.toContain('- win: Malicious release\n  from');
  });

  it('moves a dragged node and writes its position to the YAML; Auto-arrange forgets it', async () => {
    await seed(SMALL);
    await mountReady('win');
    expect(screen.queryByRole('button', { name: 'Auto-arrange' })).toBeNull();
    await dragNode('push', 200, 120);
    await waitFor(() => expect(yaml()).toMatch(/\npositions:\n {2}push: \[ -?\d+, -?\d+ \]\n$/));
    const arrange = await screen.findByRole('button', { name: 'Auto-arrange' });
    fireEvent.click(arrange);
    expect(yaml()).not.toContain('positions');
    expect(await screen.findByText('Back to the automatic layout')).toBeInTheDocument();
  });

  it('Auto-arrange under a filter keeps the positions of the nodes it hides', async () => {
    await seed(`${SMALL}filter:\n- mfa\npositions:\n  mfa: [ 10, 20 ]\n  win: [ 30, 40 ]\n`);
    await mountReady('mfa');
    expect(flowNode('win')).toBeNull(); // hidden by the filter
    const arrange = await screen.findByRole('button', { name: 'Auto-arrange' });
    expect(arrange).toHaveAttribute('title', 'Auto-arrange: forget the 1 position set by hand');
    fireEvent.click(arrange);
    expect(yaml()).toContain('positions:\n  win: [ 30, 40 ]\n');
    expect(yaml()).not.toContain('mfa: [');
  });

  it('writes moves reported by the canvas', async () => {
    await seed(SMALL);
    await mountReady('win');
    act(() => canvas().onMove({ win: { x: 10.4, y: 20.6 }, mfa: { x: -5, y: 3 } }));
    expect(yaml()).toContain('positions:\n  win: [ 10, 21 ]\n  mfa: [ -5, 3 ]\n');
    fireEvent.click(flowNode('win')!);
    expect(inspector()).toHaveTextContent('Placed by hand');
    fireEvent.click(within(inspector()!).getByRole('button', { name: 'Auto' }));
    expect(yaml()).toContain('positions:\n  mfa: [ -5, 3 ]\n');
    expect(inspector()).not.toHaveTextContent('Placed by hand');
  });

  it('double-clicking a node opens its label for editing', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.doubleClick(flowNode('mfa')!);
    const label = within(inspector()!).getByDisplayValue('Hardware keys');
    await waitFor(() => expect(label).toHaveFocus());
  });

  it('edits a node through the inspector', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(flowNode('phish')!);
    const panel = inspector()!;

    fireEvent.change(within(panel).getByDisplayValue('Phish a maintainer'), { target: { value: 'Phish the lead' } });
    expect(yaml()).toContain('- phish: Phish the lead\n');

    const id = panel.querySelector('input.mono') as HTMLInputElement;
    fireEvent.change(id, { target: { value: 'push' } });
    expect(panel).toHaveTextContent('"push" is already taken');
    fireEvent.blur(id);
    expect(yaml()).toContain('- phish: Phish the lead\n');
    fireEvent.change(id, { target: { value: 'phishing' } });
    fireEvent.blur(id);
    expect(yaml()).toContain('- phishing: Phish the lead\n');
    expect(yaml()).toContain('- push: Push to main\n  from:\n  - phishing\n');
    expect(inspector()!.querySelector('input.mono')).toHaveValue('phishing');

    fireEvent.click(within(inspector()!).getByRole('radio', { name: 'Fact' }));
    expect(yaml()).toMatch(/facts:\n- public_repo: Source is public\n {2}from:\n {2}- reality\n- phishing: Phish the lead/);
    expect(inspector()).toHaveTextContent('Fact');

    fireEvent.click(within(inspector()!).getByRole('button', { name: /Add attack after/ }));
    expect(yaml()).toContain('- new_attack: New attack\n  from:\n  - phishing\n');
    expect(inspector()!.querySelector('input.mono')).toHaveValue('new_attack');

    fireEvent.click(within(inspector()!).getByRole('button', { name: 'Delete' }));
    expect(yaml()).not.toContain('new_attack');
    expect(inspector()).toBeNull();
  });

  it('edits a connection through the inspector', async () => {
    await seed(SMALL);
    await mountReady('win');
    act(() => canvas().onSelect({ type: 'edge', id: 'push:0' }));
    fireEvent.click(within(inspector()!).getByRole('button', { name: /#yolosec/ }));
    expect(yaml()).toContain("- push: Push to main\n  from:\n  - phish: '#yolosec'\n");
    fireEvent.click(within(inspector()!).getByRole('button', { name: /Not implemented/ }));
    expect(yaml()).toContain("  - phish: '#yolosec'\n    implemented: false\n");
    fireEvent.change(within(inspector()!).getByPlaceholderText('e.g. #yolosec'), { target: { value: 'via SSO' } });
    expect(yaml()).toContain('  - phish: via SSO\n');
    fireEvent.click(within(inspector()!).getByRole('button', { name: /Delete connection/ }));
    expect(yaml()).toContain('- push: Push to main\n\n');
    expect(inspector()).toBeNull();
  });

  it('clears the selection with Escape, but not while typing in the editor', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(flowNode('phish')!);
    key(view().contentDOM, { key: 'Escape' });
    expect(inspector()).not.toBeNull();
    key(document.body, { key: 'Escape' });
    expect(inspector()).toBeNull();
  });
});

// =================================================================================

describe('undo and redo', () => {
  it('undoes and redoes canvas edits from outside the editor', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(document.querySelector('.add-node.kind-goal')!);
    const added = yaml();
    expect(added).toContain('new_goal');
    act(() => canvas().onSelect(null));

    const undo = key(document.body, { key: 'z', ctrlKey: true });
    expect(undo.defaultPrevented).toBe(true);
    expect(yaml()).toBe(SMALL);
    expect(counts()).toBe('6 nodes · 5 edges');

    key(document.body, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(yaml()).toBe(added);
    key(document.body, { key: 'z', metaKey: true });
    expect(yaml()).toBe(SMALL);
    const redo = key(document.body, { key: 'y', ctrlKey: true });
    expect(redo.defaultPrevented).toBe(true);
    expect(yaml()).toBe(added);
  });

  it('leaves Ctrl+Z inside the editor to the editor (one step, not two)', async () => {
    await seed(SMALL);
    await mountReady('win');
    const one = SMALL.replace('Hardware keys', 'One');
    typeYaml(one);
    typeYaml(one.replace('Push to main', 'Two'));
    key(view().contentDOM, { key: 'z', ctrlKey: true });
    expect(yaml()).toBe(one);
  });
});

// =================================================================================

describe('syntax errors', () => {
  const BROKEN = SMALL.replace('- mfa: Hardware keys', '- mfa: [Hardware keys');

  it('keeps the last valid tree on a read-only canvas and points at the error', async () => {
    await seed(SMALL);
    await mountReady('win');
    expect(document.querySelector('.add-node')).not.toBeNull();
    typeYaml(BROKEN);
    const banner = document.querySelector<HTMLElement>('.syntax-banner')!;
    expect(banner).toHaveTextContent(/^YAML error on line \d+: .+Showing the last valid version until it is fixed\.$/);
    const line = Number(banner.textContent!.match(/line (\d+)/)![1]);
    expect(document.querySelector('.add-node')).toBeNull();
    expect(flowIds()).toHaveLength(6);
    expect(counts()).toBe('6 nodes · 5 edges');
    expect(document.querySelector('.status-problems')).toHaveClass('has-errors');
    expect(document.querySelector('.status-problems')).toHaveTextContent(/^\d+ errors?$/);

    // read-only: Backspace on a selected node does nothing
    fireEvent.click(flowNode('phish')!);
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(yaml()).toBe(BROKEN);
    expect(within(inspector()!).getByDisplayValue('Phish a maintainer')).toBeDisabled();
    expect(within(inspector()!).queryByRole('button', { name: 'Delete' })).toBeNull();

    // the banner jumps to the error, and shows the editor if it was hidden
    fireEvent.click(screen.getByRole('button', { name: 'Hide the YAML editor' }));
    setCursor(0);
    fireEvent.click(banner);
    expect(workspace()).not.toHaveClass('editor-hidden');
    expect(workspace()).toHaveClass('show-text');
    expect(localStorage.getItem('attacktree:editor-hidden')).toBe('0');
    const head = view().state.selection.main.from;
    expect(view().state.doc.lineAt(head).number).toBe(line);
    expect(view().hasFocus || document.activeElement === view().contentDOM).toBe(true);

    // fixing it brings the canvas back
    typeYaml(SMALL);
    expect(document.querySelector('.syntax-banner')).toBeNull();
    expect(document.querySelector('.add-node')).not.toBeNull();
  });

  it('exports the picture it shows: images carry the last valid source while the YAML is broken', async () => {
    await seed(SMALL);
    await mountReady('win');
    typeYaml(BROKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(menuItem(/Vector image/));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const svg = download.mock.calls[0][1] as string;
    expect(svg).toContain('>Hardware keys</text>');
    expect(extractEmbedded(svg)).toBe(SMALL);
    // the YAML download is the text as typed
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(menuItem(/YAML source/));
    expect(download).toHaveBeenLastCalledWith('small-tree.yaml', BROKEN, 'text/yaml');
  });

  it('opens a tree that is already broken', async () => {
    await seed(OTHER.replace('- guess: Guess the password', '- guess: [Guess'));
    await mount();
    await waitFor(() => expect(document.querySelector('.syntax-banner')).not.toBeNull());
    expect(document.querySelector('.add-node')).toBeNull();
  });
});

// =================================================================================

describe('status bar', () => {
  it('counts warnings and jumps to the first problem', async () => {
    await seed(`${SMALL}- extra: Extra\n  from:\n  - nowhere\n`);
    await mountReady('nowhere');
    const problems = document.querySelector<HTMLElement>('.status-problems')!;
    expect(problems).toHaveTextContent(/^1 warning$/);
    expect(problems).not.toHaveClass('has-errors');
    setCursor(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Canvas' }));
    fireEvent.click(problems);
    const { from, to } = view().state.selection.main;
    expect(yaml().slice(from, to)).toBe('nowhere');
    expect(workspace()).toHaveClass('show-text');

    typeYaml(`${SMALL}- extra: Extra\n  from:\n  - nowhere\n  - elsewhere\n`);
    expect(document.querySelector('.status-problems')).toHaveTextContent(/^2 warnings$/);
  });

  it('counts errors and warnings together', async () => {
    await seed(`${SMALL}- extra: Extra\n  from:\n  - nowhere\n  - push:\n    backwards: maybe\n`);
    await mountReady('nowhere');
    expect(document.querySelector('.status-problems')).toHaveTextContent(/^1 error · 1 warning$/);
    expect(document.querySelector('.syntax-banner')).toBeNull();
    typeYaml(`${SMALL}- extra: Extra\n  from:\n  - push:\n    backwards: maybe\n  - mfa:\n    implemented: 2\n`);
    expect(document.querySelector('.status-problems')).toHaveTextContent(/^2 errors$/);
  });

  it('says when a filter hides part of the tree', async () => {
    await seed(`${SMALL}\nfilter:\n- mfa\n`);
    await mountReady('mfa');
    expect(counts()).toBe('6 nodes · 5 edges · filtered to 4');
    await waitFor(() => expect(flowIds().sort()).toEqual(['mfa', 'phish', 'public_repo', 'reality']));
  });
});

// =================================================================================

describe('import', () => {
  const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const choose = (file: unknown) => fireEvent.change(fileInput(), { target: { files: file ? [file] : [] } });

  it('opens the file picker from the toolbar and the menu', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(click).toHaveBeenCalledTimes(1);
    openDocMenu();
    fireEvent.click(menuItem(/Import file/));
    expect(click).toHaveBeenCalledTimes(2);
    expect(fileInput()).toHaveAttribute('accept', expect.stringContaining('.yaml'));
  });

  it('imports a YAML file as a new tree, without the Markdown fences', async () => {
    await seed(SMALL);
    await mountReady('win');
    choose(new File(['Here you go:\n```yaml\n' + OTHER + '```\n'], 'answer.yaml', { type: 'text/yaml' }));
    expect(await screen.findByText('Imported answer.yaml')).toBeInTheDocument();
    // the toast can land a frame before the editor's effect swaps the text in
    await waitFor(() => expect(yaml()).toBe(OTHER));
    expect(docTitle()).toBe('Other tree');
    expect(fileInput().value).toBe('');
    expect(await allDocs()).toHaveLength(2);
  });

  it('names an untitled import after the file', async () => {
    await seed(SMALL);
    await mountReady('win');
    choose(new File([OTHER.replace('title: Other tree\n', '')], 'my.tree.yml'));
    await screen.findByText('Imported my.tree.yml');
    expect((await allDocs()).find((d) => d.text !== SMALL)!.title).toBe('my.tree');
  });

  it('round-trips an exported SVG', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(menuItem(/Vector image/));
    await waitFor(() => expect(download).toHaveBeenCalled());
    const svg = download.mock.calls[0][1] as string;
    typeYaml(OTHER);
    choose(new File([svg], 'small-tree.svg', { type: 'image/svg+xml' }));
    expect(await screen.findByText('Imported small-tree.svg')).toBeInTheDocument();
    // the toast can land a frame before the editor's effect swaps the text in
    await waitFor(() => expect(yaml()).toBe(SMALL));
    expect(await allDocs()).toHaveLength(2);
  });

  it('reports a file without a tree', async () => {
    await seed(SMALL);
    await mountReady('win');
    choose(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' }));
    const toast = await screen.findByText('logo.svg does not contain an embedded tree');
    expect(toast).toHaveClass('is-error');
    expect(await allDocs()).toHaveLength(1);
  });

  it('reports an unreadable file', async () => {
    await seed(SMALL);
    await mountReady('win');
    choose({ name: 'broken.yaml', type: 'text/yaml', text: () => Promise.reject('disk gone') });
    expect(await screen.findByText('Could not read that file')).toBeInTheDocument();
  });

  it('does nothing when the picker is cancelled', async () => {
    await seed(SMALL);
    await mountReady('win');
    choose(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(toastTexts()).toEqual([]);
    expect(await allDocs()).toHaveLength(1);
  });
});

// =================================================================================

describe('export', () => {
  const exportAs = (item: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(menuItem(item));
  };

  it('downloads the YAML source', async () => {
    await seed(SMALL);
    await mountReady('win');
    exportAs(/YAML source/);
    expect(download).toHaveBeenCalledWith('small-tree.yaml', SMALL, 'text/yaml');
  });

  it('downloads an SVG that carries its source', async () => {
    await seed(SMALL);
    await mountReady('win');
    exportAs(/Vector image/);
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [name, svg, type] = download.mock.calls[0];
    expect(name).toBe('small-tree.svg');
    expect(type).toBe('image/svg+xml');
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('>Small tree</text>');
    expect(svg).toContain('>Phish a maintainer</text>');
    expect(extractEmbedded(svg as string)).toBe(SMALL);
  });

  it('downloads a PNG that carries its source', async () => {
    await seed(SMALL);
    await mountReady('win');
    exportAs(/PNG image/);
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [name, png] = download.mock.calls[0];
    expect(name).toBe('small-tree.png');
    expect(renderPng).toHaveBeenCalledWith(expect.stringMatching(/^<svg /), expect.any(Number), expect.any(Number), 2);
    const bytes = await (png as Blob).text();
    expect(bytes.startsWith('PNGDATA')).toBe(true);
    expect(extractEmbedded(bytes)).toBe(SMALL);
  });

  it('reports a failed export', async () => {
    await seed(SMALL);
    await mountReady('win');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPng.mockRejectedValueOnce(new Error('no canvas'));
    exportAs(/PNG image/);
    expect(await screen.findByText('Export failed')).toBeInTheDocument();
    expect(err).toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('waits for the layout before exporting images', async () => {
    const gate = deferred();
    ctl.elkGate = gate.promise;
    await seed(SMALL);
    await mount();
    exportAs(/Vector image/);
    expect(await screen.findByText('The tree is still being laid out')).toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
    exportAs(/YAML source/);
    expect(download).toHaveBeenCalledTimes(1);
    gate.resolve();
    await waitFor(() => expect(flowNode('win')).toBeTruthy());
  });

  it('names the file "attack-tree" when the title has no usable characters', async () => {
    await seed(OTHER.replace('Other tree', '!!!'));
    await mountReady('guess');
    exportAs(/YAML source/);
    expect(download.mock.calls[0][0]).toBe('attack-tree.yaml');
  });
});

// =================================================================================

describe('share and AI', () => {
  it('copies a share link that carries the whole tree', async () => {
    await seed(SMALL);
    await mountReady('win');
    history.replaceState(null, '', '/app/?x=1');
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Share link copied. The whole tree travels inside the link.')).toBeInTheDocument();
    const url = new URL(clipboard.writeText.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(`${window.location.origin}/app/`);
    expect(url.search).toBe('');
    expect(await decodeShare(url.hash)).toBe(SMALL);
  });

  it('shows the share link in a prompt when copying is not allowed', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    clipboard.writeText.mockRejectedValue(new Error('denied'));
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    const [message, link] = prompt.mock.calls[0];
    expect(message).toBe('Copy this link');
    expect(await decodeShare(new URL(link!).hash)).toBe(SMALL);
    expect(toastTexts()).toEqual([]);
  });

  it('reports a share link that cannot be built', async () => {
    await seed(SMALL);
    await mountReady('win');
    vi.spyOn(globalThis, 'CompressionStream').mockImplementation(() => {
      throw new TypeError('CompressionStream is not supported');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const toast = await screen.findByText('Could not create a share link in this browser');
    expect(toast).toHaveClass('is-error');
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('copies a prompt for AI assistants', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(screen.getByRole('button', { name: 'Copy for AI' }));
    expect(await screen.findByText('Prompt copied. Paste it into your AI assistant and add your request.')).toBeInTheDocument();
    expect(clipboard.writeText).toHaveBeenCalledWith(aiPrompt(SMALL));

    typeYaml(OTHER);
    openDocMenu();
    fireEvent.click(menuItem('Copy prompt for AI'));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(aiPrompt(OTHER)));
  });

  it('shows the AI prompt in a prompt when copying is not allowed', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(screen.getByRole('button', { name: 'Copy for AI' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('Copy this prompt', aiPrompt(SMALL)));
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});

// =================================================================================

describe('workspace chrome', () => {
  it('toggles the theme', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    const light = screen.getByRole('button', { name: 'Switch to light theme' });
    expect(light).toHaveAttribute('title', 'Switch to light theme');
    fireEvent.click(light);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });

  it('hides and shows the editor with the button and Ctrl+\\, and remembers it', async () => {
    await seed(SMALL);
    const { unmount } = await mountReady('win');
    const hide = screen.getByRole('button', { name: 'Hide the YAML editor' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    expect(hide).toHaveAttribute('title', 'Hide the YAML editor (Ctrl+\\)');
    fireEvent.click(hide);
    expect(workspace()).toHaveClass('editor-hidden');
    expect(hide).toHaveAttribute('aria-label', 'Show the YAML editor');
    expect(hide).toHaveAttribute('aria-pressed', 'false');
    expect(hide).toHaveAttribute('title', 'Show the YAML editor (Ctrl+\\)');
    expect(localStorage.getItem('attacktree:editor-hidden')).toBe('1');

    unmount();
    await mountReady('win');
    expect(workspace()).toHaveClass('editor-hidden');
    // the shortcut works from inside the editor too
    const e = key(view().contentDOM, { key: '\\', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(workspace()).not.toHaveClass('editor-hidden');
    expect(localStorage.getItem('attacktree:editor-hidden')).toBe('0');
    key(document.body, { key: '\\', metaKey: true });
    expect(workspace()).toHaveClass('editor-hidden');
  });

  it('names the shortcut with ⌘ on macOS', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await seed(SMALL);
    await mountReady('win');
    expect(screen.getByRole('button', { name: 'Hide the YAML editor' })).toHaveAttribute('title', 'Hide the YAML editor (⌘+\\)');
  });

  it('copes with storage that throws', async () => {
    await seed(SMALL);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    await mountReady('win');
    expect(getItem).toHaveBeenCalled();
    expect(workspace()).not.toHaveClass('editor-hidden');
    expect(app().style.getPropertyValue('--editor-width')).toBe('348px');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the YAML editor' }));
    expect(workspace()).toHaveClass('editor-hidden');
  });

  it('resizes the editor by dragging the divider, and remembers the width', async () => {
    await seed(SMALL);
    const { unmount } = await mountReady('win');
    expect(app().style.getPropertyValue('--editor-width')).toBe('348px'); // 34% of 1024
    const divider = document.querySelector('.divider')!;
    expect(divider).toHaveAttribute('role', 'separator');
    pointer(divider, 'pointerdown', 348);
    pointer(divider, 'pointermove', 420.6);
    expect(app().style.getPropertyValue('--editor-width')).toBe('421px');
    pointer(divider, 'pointermove', 10);
    expect(app().style.getPropertyValue('--editor-width')).toBe('300px');
    pointer(divider, 'pointermove', 2000);
    expect(app().style.getPropertyValue('--editor-width')).toBe(`${1024 - 380}px`);
    pointer(divider, 'pointermove', 500);
    pointer(divider, 'pointerup', 500);
    expect(localStorage.getItem('attacktree:editor-width')).toBe('500');
    // hovering after the drag does not resize
    pointer(divider, 'pointermove', 600);
    expect(app().style.getPropertyValue('--editor-width')).toBe('500px');

    unmount();
    await mountReady('win');
    expect(app().style.getPropertyValue('--editor-width')).toBe('500px');
  });

  it('stops resizing when the pointer is cancelled', async () => {
    await seed(SMALL);
    await mountReady('win');
    const divider = document.querySelector('.divider')!;
    pointer(divider, 'pointerdown', 348);
    pointer(divider, 'pointermove', 400);
    pointer(divider, 'pointercancel', 400);
    expect(localStorage.getItem('attacktree:editor-width')).toBe('400');
    pointer(divider, 'pointermove', 600);
    expect(app().style.getPropertyValue('--editor-width')).toBe('400px');
  });

  it('switches between the YAML and Canvas tabs on small screens', async () => {
    await seed(SMALL);
    await mountReady('win');
    const yamlTab = screen.getByRole('tab', { name: 'YAML' });
    const canvasTab = screen.getByRole('tab', { name: 'Canvas' });
    expect(workspace()).toHaveClass('show-canvas');
    expect(canvasTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(yamlTab);
    expect(workspace()).toHaveClass('show-text');
    expect(yamlTab).toHaveAttribute('aria-selected', 'true');
    expect(canvasTab).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(canvasTab);
    expect(workspace()).toHaveClass('show-canvas');
  });

  it('keeps the global shortcuts working from inside the inspector', async () => {
    const doc = await seed(SMALL);
    await mountReady('win');
    fireEvent.click(flowNode('phish')!);
    const label = within(inspector()!).getByDisplayValue('Phish a maintainer');
    fireEvent.change(label, { target: { value: 'Phish the lead' } });
    // Ctrl+S must not fall through to the browser's "Save page"
    expect(key(label, { key: 's', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(await screen.findByText('Saved in this browser', {}, { timeout: 300 })).toBeInTheDocument();
    expect((await storedDoc(doc.id))!.text).toContain('Phish the lead');
    expect(key(label, { key: '\\', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(workspace()).toHaveClass('editor-hidden');
    // but field keys stay with the field
    expect(key(label, { key: 'z', ctrlKey: true }).defaultPrevented).toBe(false);
    key(label, { key: 'Escape' });
    expect(inspector()).not.toBeNull();
    expect(yaml()).toContain('- phish: Phish the lead\n');
  });

  it('lets AltGr type a backslash instead of hiding the editor', async () => {
    await seed(SMALL);
    await mountReady('win');
    // on Windows, AltGr arrives as Ctrl+Alt (German, Nordic, French… layouts type "\\" this way)
    key(view().contentDOM, { key: '\\', ctrlKey: true, altKey: true });
    expect(workspace()).not.toHaveClass('editor-hidden');
    expect(key(document.body, { key: '\\', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(workspace()).not.toHaveClass('editor-hidden');
  });

  it('ignores other keys', async () => {
    await seed(SMALL);
    await mountReady('win');
    fireEvent.click(flowNode('phish')!);
    for (const init of [{ key: 'z' }, { key: 'y' }, { key: 's' }, { key: '\\' }, { key: 'a', ctrlKey: true }]) {
      expect(key(document.body, init).defaultPrevented).toBe(false);
    }
    expect(yaml()).toBe(SMALL);
    expect(inspector()).not.toBeNull();
    expect(workspace()).not.toHaveClass('editor-hidden');
    expect(toastTexts()).toEqual([]);
  });
});
