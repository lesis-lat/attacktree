import { ReactFlowProvider } from '@xyflow/react';
import {
  BookOpen,
  Bot,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  FilePlus2,
  FileText,
  Image,
  Link2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isMap, isScalar, parseDocument, stringify } from 'yaml';
import { aiPrompt } from './ai/prompt';
import { Inspector, type InspectorActions } from './canvas/Inspector';
import { type Selection, TreeCanvas } from './canvas/TreeCanvas';
import { type EditorApi, type Reveal, YamlEditor } from './editor/YamlEditor';
import { copyText, download, fileBase, pngWithSource, renderPng, renderSvg } from './export/exporters';
import { computeLayout, type Layout, layoutKey } from './layout/layout';
import { fontsReady } from './layout/measure';
import { withPins } from './layout/pins';
import { pointsBackwards, visibleIds } from './model/analysis';
import { readTreeFile } from './model/embed';
import { BLANK_TREE, EXAMPLE_CICD } from './model/examples';
import * as edit from './model/mutate';
import { parseTree } from './model/parse';
import { decodeShare, encodeShare } from './model/share';
import { type DeclaredKind, isGhost, type Tree } from './model/types';
import {
  createDoc,
  deleteDoc,
  lastOpen,
  listDocs,
  rememberLastOpen,
  saveDoc,
  type TreeDoc,
} from './store/docs';
import { cx } from './ui/cx';
import { ByLesis } from './ui/Lesis';
import { Logo } from './ui/Logo';
import { ConfirmItem, Menu, MenuItem, MenuLabel, MenuSeparator } from './ui/Menu';
import { useTheme } from './ui/theme';
import { Toasts, useToasts } from './ui/Toasts';

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function ago(time: number): string {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(time).toLocaleDateString();
}

function nextKindAfter(kind: string): DeclaredKind {
  return kind === 'attack' ? 'mitigation' : 'attack';
}

/** The same source with " (copy)" after its title, still valid YAML whatever quoting or comment the title has. */
function withCopyTitle(text: string): string {
  const doc = parseDocument(text);
  const node = isMap(doc.contents) ? doc.contents.get('title', true) : undefined;
  if (!isScalar(node) || node.value == null || String(node.value).trim() === '' || !node.range) return text;
  const title = `${String(node.value)} (copy)`;
  const [from, to] = node.range;
  const trailing = text.slice(from, to).match(/\s*$/)![0];
  // plain when YAML allows it, else double-quoted (a JSON string is valid YAML)
  for (const scalar of [stringify(title, { lineWidth: 0 }).trimEnd(), JSON.stringify(title)]) {
    const next = text.slice(0, from) + scalar + trailing + text.slice(to);
    if (parseTree(next).title === title) return next;
  }
  return text;
}

export function App() {
  const theme = useTheme();
  const { toasts, push: toast } = useToasts();

  const [docs, setDocs] = useState<TreeDoc[]>([]);
  const [doc, setDoc] = useState<TreeDoc | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [revealNonce, setRevealNonce] = useState(0);
  const [fitNonce, setFitNonce] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [fonts, setFonts] = useState(false);
  const [pane, setPane] = useState<'text' | 'canvas'>('canvas');
  const [editorHidden, setEditorHidden] = useState(() => {
    try {
      return localStorage.getItem('attacktree:editor-hidden') === '1';
    } catch {
      return false;
    }
  });
  const [editorWidth, setEditorWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('attacktree:editor-width'));
      if (saved > 0) return saved;
    } catch {
      /* private mode */
    }
    return Math.round(Math.min(480, Math.max(340, window.innerWidth * 0.34)));
  });

  const editorApi = useRef<EditorApi | null>(null);
  const labelRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // --- parsing ---------------------------------------------------------------

  const parsed = useMemo(() => parseTree(text), [text]);
  // While the YAML is broken mid-edit, the canvas keeps showing the last good version.
  const lastGood = useRef<{ docId: string | undefined; tree: Tree; text: string }>({ docId: undefined, tree: parsed, text });
  if (!parsed.syntaxError || lastGood.current.docId !== doc?.id) lastGood.current = { docId: doc?.id, tree: parsed, text };
  const tree = parsed.syntaxError ? lastGood.current.tree : parsed;
  const readOnly = parsed.syntaxError;

  const visible = useMemo(() => visibleIds(tree), [tree]);
  // ELK lays everything out; positions dragged by hand are applied on top.
  const shownLayout = useMemo(() => (layout ? withPins(layout, tree, tree.positions) : null), [layout, tree]);
  const geometryKey = useMemo(() => layoutKey(tree, visible), [tree, visible]);

  const refs = useRef({ text, parsed, tree, doc });
  refs.current = { text, parsed, tree, doc };

  useEffect(() => {
    if (!fonts || !doc) return;
    let cancelled = false;
    computeLayout(refs.current.tree, visible)
      .then((l) => !cancelled && setLayout(l))
      .catch((err) => {
        console.error(err);
        if (!cancelled) toast('Could not lay out this tree', 'error');
      });
    return () => {
      cancelled = true;
    };
    // the key captures everything that changes geometry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometryKey, fonts, doc?.id]);

  // --- documents ---------------------------------------------------------------

  // Trees being deleted must not be written back by a late autosave.
  const deleted = useRef(new Set<string>());
  // The last save of the open tree failed: its text is not on disk even though `doc` holds it.
  const unsaved = useRef(false);

  /** Saves the open tree; false when the browser refused. */
  const persist = useCallback(async (): Promise<boolean> => {
    const { doc: current, text: body, parsed: p } = refs.current;
    if (!current || (body === current.text && !unsaved.current) || deleted.current.has(current.id)) return true;
    const updated: TreeDoc = { ...current, text: body, title: p.title || 'Untitled tree', updatedAt: Date.now() };
    refs.current.doc = updated;
    setDoc(updated);
    setDocs((all) => [updated, ...all.filter((d) => d.id !== updated.id)]);
    try {
      await saveDoc(updated);
      unsaved.current = false;
      // more typing may have arrived while the disk was busy
      setSaved(refs.current.text === body);
      return true;
    } catch {
      unsaved.current = true;
      toast('Could not save in this browser', 'error');
      return false;
    }
  }, [toast]);

  useEffect(() => {
    if (!doc || text === doc.text) return;
    setSaved(false);
    const handle = setTimeout(persist, 450);
    return () => clearTimeout(handle);
  }, [text, doc, persist]);

  useEffect(() => {
    const flush = () => void persist();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [persist]);

  const open = useCallback(
    async (next: TreeDoc) => {
      await persist();
      unsaved.current = false;
      refs.current.doc = next;
      setDoc(next);
      setText(next.text);
      setSaved(true);
      setSelection(null);
      setLayout(null);
      setFitNonce((n) => n + 1);
      rememberLastOpen(next.id);
    },
    [persist],
  );

  const createAndOpen = useCallback(
    async (body: string, fallbackTitle: string) => {
      const d = createDoc(body, parseTree(body).title || fallbackTitle);
      let stored = true;
      try {
        await saveDoc(d);
      } catch {
        stored = false;
        toast('This browser is not keeping data; changes will be lost on reload', 'error');
      }
      setDocs((all) => [d, ...all]);
      await open(d);
      if (!stored) {
        // not on disk yet: the dot says so, and the next save writes it
        unsaved.current = true;
        setSaved(false);
      }
      return d;
    },
    [open, toast],
  );

  const importShared = useCallback(async () => {
    let shared: string | null = null;
    try {
      shared = await decodeShare(window.location.hash);
    } catch {
      toast('This share link is damaged', 'error');
    }
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    if (shared === null) return false;
    await createAndOpen(shared, 'Shared tree');
    toast('Opened the shared tree. It is now saved in this browser.');
    return true;
  }, [createAndOpen, toast]);

  const started = useRef(false);
  useEffect(() => {
    fontsReady().then(() => setFonts(true));
    const onHash = () => void importShared();
    window.addEventListener('hashchange', onHash);
    const stop = () => window.removeEventListener('hashchange', onHash);
    if (started.current) return stop;
    started.current = true;
    (async () => {
      let all: TreeDoc[] = [];
      try {
        all = await listDocs();
      } catch {
        toast('This browser is not keeping data; changes will be lost on reload', 'error');
      }
      setDocs(all);
      if (await importShared()) return;
      const remembered = lastOpen();
      const first = all.find((d) => d.id === remembered) ?? all[0];
      if (first) await open(first);
      else await createAndOpen(EXAMPLE_CICD, 'Example');
    })();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeCurrent = async () => {
    if (!doc) return;
    deleted.current.add(doc.id);
    await deleteDoc(doc.id).catch(() => undefined);
    const rest = docs.filter((d) => d.id !== doc.id);
    setDocs(rest);
    refs.current.doc = null;
    if (rest[0]) await open(rest[0]);
    else await createAndOpen(BLANK_TREE, 'Untitled tree');
    toast('Tree deleted');
  };

  // --- editing -------------------------------------------------------------------

  const apply = useCallback(
    (change: (text: string) => string) => {
      try {
        const next = change(refs.current.text);
        if (next !== refs.current.text) {
          refs.current.text = next;
          setText(next);
        }
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        return false;
      }
    },
    [toast],
  );

  const focusLabel = () =>
    setTimeout(() => {
      labelRef.current?.focus();
      labelRef.current?.select();
    }, 60);

  const addNode = useCallback(
    (kind: DeclaredKind, from: string[]) => {
      let id = '';
      const ok = apply((t) => {
        const r = edit.addNode(t, { kind, label: `New ${kind}`, from });
        id = r.id;
        return r.text;
      });
      if (!ok) return;
      setSelection({ type: 'node', id });
      setRevealNonce((n) => n + 1);
      focusLabel();
    },
    [apply],
  );

  const selectFromEditor = useCallback((pos: number) => {
    const t = refs.current.parsed;
    const edge = t.edges.find((e) => e.range && pos >= e.range.from && pos <= e.range.to);
    if (edge) {
      setSelection({ type: 'edge', id: edge.id });
      return;
    }
    const node = t.nodes.find((n) => n.range && pos >= n.range.from && pos <= n.range.to);
    setSelection(node ? { type: 'node', id: node.id } : null);
    if (node) setRevealNonce((n) => n + 1);
  }, []);

  const selectFromCanvas = useCallback((s: Selection) => {
    setSelection(s);
    if (!s) return;
    const t = refs.current.parsed;
    const range =
      s.type === 'node' ? t.nodes.find((n) => n.id === s.id)?.keyRange : t.edges.find((e) => e.id === s.id)?.sourceRange;
    if (range) setReveal({ ...range, nonce: Date.now() });
  }, []);

  const onConnect = useCallback(
    (source: string, target: string) => {
      const backwards = pointsBackwards(refs.current.tree, source, target);
      if (apply((t) => edit.connect(t, source, target, backwards)) && backwards) {
        toast('Added as a backwards edge: it points back up the tree');
      }
    },
    [apply, toast],
  );

  const reconnect = useCallback(
    (edgeId: string, to: { source: string; target: string }) => {
      const t = refs.current.tree;
      const edge = t.edges.find((e) => e.id === edgeId);
      if (!edge) return;
      // pointing back at an ancestor makes it a backwards edge, as when connecting
      const backwards = pointsBackwards({ ...t, edges: t.edges.filter((e) => e.id !== edgeId) }, to.source, to.target);
      let next = '';
      if (!apply((text) => (next = edit.reconnectEdge(text, edge.target, edge.fromIndex, { ...to, backwards })))) return;
      const moved = parseTree(next).edges.find((e) => e.source === to.source && e.target === to.target && e.backwards === backwards);
      if (moved) setSelection({ type: 'edge', id: moved.id });
      if (backwards && !edge.backwards) toast('Now a backwards edge: it points back up the tree');
    },
    [apply, toast],
  );

  const onCreateFrom = useCallback(
    (source: string) => {
      const node = refs.current.tree.nodes.find((n) => n.id === source);
      addNode(nextKindAfter(node?.kind ?? 'reality'), [source]);
    },
    [addNode],
  );

  const onAdd = useCallback(
    (kind: DeclaredKind) => {
      const t = refs.current.tree;
      const selected = selection?.type === 'node' ? t.nodes.find((n) => n.id === selection.id) : undefined;
      const from = selected && !isGhost(selected) ? [selected.id] : kind === 'attack' || kind === 'fact' ? ['reality'] : [];
      addNode(kind, from);
    },
    [addNode, selection],
  );

  const onDelete = useCallback(
    (nodeIds: string[], edgeIds: string[]) => {
      const t = refs.current.tree;
      const doomed = new Set(nodeIds);
      const edges = t.edges
        .filter((e) => edgeIds.includes(e.id) && !doomed.has(e.source) && !doomed.has(e.target))
        .sort((a, b) => b.fromIndex - a.fromIndex);
      const ok = apply((text) => {
        let next = text;
        for (const e of edges) next = edit.removeEdge(next, e.target, e.fromIndex);
        return edit.removeNodes(next, nodeIds);
      });
      if (ok) setSelection(null);
    },
    [apply],
  );

  const onMove = useCallback(
    (moved: Record<string, { x: number; y: number }>) => apply((t) => edit.setPositions(t, moved)),
    [apply],
  );

  const onResetLayout = useCallback((ids: string[]) => {
    if (apply((t) => edit.clearPositions(t, ids))) toast('Back to the automatic layout');
  }, [apply, toast]);

  const inspector: InspectorActions = {
    unpin: (id) => apply((t) => edit.clearPositions(t, [id])),
    setLabel: (id, label) => apply((t) => edit.setLabel(t, id, label)),
    setKind: (id, kind) => apply((t) => edit.setKind(t, id, kind)),
    validateId: (id, next) => edit.validateId(refs.current.text, id, next),
    renameId: (id, next) => {
      const problem = edit.validateId(refs.current.text, id, next);
      if (problem) return problem;
      if (apply((t) => edit.renameId(t, id, next))) setSelection({ type: 'node', id: next });
      return null;
    },
    addChild: (id, kind) => addNode(kind, [id]),
    deleteNode: (id) => onDelete([id], []),
    updateEdge: (e, patch) => apply((t) => edit.updateEdge(t, e.target, e.fromIndex, patch)),
    reconnect: (e, to) => reconnect(e.id, to),
    deleteEdge: (e) => {
      if (apply((t) => edit.removeEdge(t, e.target, e.fromIndex))) setSelection(null);
    },
    close: () => setSelection(null),
  };

  // --- import / export / share -------------------------------------------------

  const onImport = async (file: File) => {
    try {
      const body = await readTreeFile(file);
      await createAndOpen(body, file.name.replace(/\.[^.]+$/, ''));
      toast(`Imported ${file.name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not read that file', 'error');
    }
  };

  const exportAs = async (format: 'yaml' | 'svg' | 'png') => {
    const base = fileBase(tree.title);
    if (format === 'yaml') return download(`${base}.yaml`, text, 'text/yaml');
    if (!shownLayout) return toast('The tree is still being laid out', 'error');
    try {
      // an image carries the source of the tree it shows (the last valid one while the YAML is broken)
      const source = lastGood.current.text;
      const { svg, width, height } = await renderSvg(tree, shownLayout, source);
      if (format === 'svg') return download(`${base}.svg`, svg, 'image/svg+xml');
      const png = await renderPng(svg, width, height, 2);
      download(`${base}.png`, pngWithSource(png, source));
    } catch (err) {
      console.error(err);
      toast('Export failed', 'error');
    }
  };

  const copyForAi = async () => {
    const prompt = aiPrompt(text);
    if (await copyText(prompt)) toast('Prompt copied. Paste it into your AI assistant and add your request.');
    else window.prompt('Copy this prompt', prompt);
  };

  const share = async () => {
    let hash: string;
    try {
      hash = await encodeShare(text);
    } catch {
      return toast('Could not create a share link in this browser', 'error');
    }
    const url = `${window.location.origin}${window.location.pathname}${hash}`;
    if (await copyText(url)) toast('Share link copied. The whole tree travels inside the link.');
    else window.prompt('Copy this link', url);
  };

  // --- keyboard + layout chrome --------------------------------------------------

  const showEditor = useCallback((show: boolean) => {
    setEditorHidden(!show);
    writePref('attacktree:editor-hidden', show ? '0' : '1');
    // the canvas changes width; refit once React Flow has measured it
    requestAnimationFrame(() => setFitNonce((n) => n + 1));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const inField = !!el?.closest('input, textarea, select, [contenteditable="true"], .cm-editor');
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void persist().then((ok) => ok && toast('Saved in this browser'));
      } else if (mod && e.key.toLowerCase() === 'z' && !inField) {
        e.preventDefault();
        if (e.shiftKey) editorApi.current?.redo();
        else editorApi.current?.undo();
      } else if (mod && e.key.toLowerCase() === 'y' && !inField) {
        e.preventDefault();
        editorApi.current?.redo();
      } else if (mod && !e.altKey && e.key === '\\') {
        // Ctrl+Alt is AltGr on Windows, which is how many layouts type a backslash
        e.preventDefault();
        showEditor(editorHidden);
      } else if (e.key === 'Escape' && !inField) {
        setSelection(null);
      }
    };
    // capture: panels such as the inspector stop key events from bubbling
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [persist, toast, showEditor, editorHidden]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let width = editorWidth;
    const move = (ev: PointerEvent) => {
      width = Math.round(Math.max(300, Math.min(window.innerWidth - 380, ev.clientX)));
      setEditorWidth(width);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      writePref('attacktree:editor-width', String(width));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    // a cancelled pointer never sends pointerup; without this, plain hovering would keep resizing
    el.addEventListener('pointercancel', up);
  };

  const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
  const warnings = parsed.diagnostics.filter((d) => d.severity === 'warning');
  const firstProblem = errors[0] ?? warnings[0];
  const lineOf = (pos: number) => text.slice(0, pos).split('\n').length;
  const jumpTo = (from: number, to: number) => {
    setPane('text');
    if (editorHidden) showEditor(true);
    setReveal({ from, to, nonce: Date.now() });
    editorApi.current?.focus();
  };

  const title = tree.title || 'Untitled tree';
  const ThemeIcon = theme.resolved === 'dark' ? Sun : Moon;
  const themeLabel = theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <div className="app" style={{ '--editor-width': `${editorWidth}px` } as React.CSSProperties}>
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span className="brand-name">attacktree</span>
          <ByLesis medium="app" />
        </div>

        <Menu
          className="doc-switcher"
          label={
            <>
              <span className="doc-title">{title}</span>
              <span className={cx('save-dot', !saved && 'is-dirty')} title={saved ? 'Saved in this browser' : 'Saving…'} />
              <ChevronDown size={14} />
            </>
          }
        >
          <MenuLabel>Your trees · stored in this browser</MenuLabel>
          <div className="menu-scroll">
            {docs.map((d) => (
              <MenuItem
                key={d.id}
                icon={<FileText size={14} />}
                active={d.id === doc?.id}
                hint={ago(d.updatedAt)}
                onSelect={() => d.id !== doc?.id && void open(d)}
              >
                {d.title}
              </MenuItem>
            ))}
          </div>
          <MenuSeparator />
          <MenuItem icon={<FilePlus2 size={14} />} onSelect={() => void createAndOpen(BLANK_TREE, 'Untitled tree')}>
            New tree
          </MenuItem>
          <MenuItem icon={<Sparkles size={14} />} onSelect={() => void createAndOpen(EXAMPLE_CICD, 'Example')}>
            New from example
          </MenuItem>
          <MenuItem icon={<Upload size={14} />} hint=".yaml .svg .png" onSelect={() => fileInput.current?.click()}>
            Import file…
          </MenuItem>
          <MenuItem
            icon={<Copy size={14} />}
            onSelect={() => void createAndOpen(withCopyTitle(text), `${title} (copy)`)}
          >
            Duplicate
          </MenuItem>
          <ConfirmItem icon={<Trash2 size={14} />} confirmText="Click again to delete" onConfirm={() => void removeCurrent()}>
            Delete this tree
          </ConfirmItem>
          <MenuSeparator />
          <MenuItem icon={<Bot size={14} />} onSelect={() => void copyForAi()}>
            Copy prompt for AI
          </MenuItem>
          <MenuItem icon={<BookOpen size={14} />} onSelect={() => window.open(`${import.meta.env.BASE_URL}docs/`, '_blank', 'noopener')}>
            Documentation
          </MenuItem>
        </Menu>

        <button
          type="button"
          className="icon-button hide-sm"
          onClick={() => showEditor(editorHidden)}
          title={`${editorHidden ? 'Show' : 'Hide'} the YAML editor (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+\\)`}
          aria-label={editorHidden ? 'Show the YAML editor' : 'Hide the YAML editor'}
          aria-pressed={!editorHidden}
        >
          {editorHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>

        <div className="pane-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={pane === 'text'} onClick={() => setPane('text')}>
            YAML
          </button>
          <button type="button" role="tab" aria-selected={pane === 'canvas'} onClick={() => setPane('canvas')}>
            Canvas
          </button>
        </div>

        <div className="topbar-actions">
          <button type="button" className="button ghost hide-sm" onClick={() => fileInput.current?.click()} title="Open a .yaml file, or an SVG/PNG exported with the source inside">
            <Upload size={15} />
            <span className="hide-md">Import</span>
          </button>
          <Menu
            align="right"
            className="ghost"
            label={
              <>
                <Download size={15} />
                <span className="hide-md">Export</span>
              </>
            }
          >
            <MenuLabel>Images keep the YAML inside, so they can be imported again</MenuLabel>
            <MenuItem icon={<Image size={14} />} hint=".svg" onSelect={() => void exportAs('svg')}>
              Vector image
            </MenuItem>
            <MenuItem icon={<Image size={14} />} hint=".png" onSelect={() => void exportAs('png')}>
              PNG image
            </MenuItem>
            <MenuItem icon={<FileText size={14} />} hint=".yaml" onSelect={() => void exportAs('yaml')}>
              YAML source
            </MenuItem>
          </Menu>
          <button
            type="button"
            className="button ghost hide-sm"
            onClick={() => void copyForAi()}
            title="Copy a prompt with the format rules and this tree, for ChatGPT, Claude and other assistants"
          >
            <Bot size={15} />
            <span className="hide-md">Copy for AI</span>
          </button>
          <a className="button ghost hide-sm" href={`${import.meta.env.BASE_URL}docs/`} target="_blank" rel="noopener" title="Documentation">
            <BookOpen size={15} />
            <span className="hide-md">Docs</span>
          </a>
          <button type="button" className="button primary" onClick={() => void share()}>
            <Link2 size={15} />
            <span className="hide-sm">Share</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={theme.toggle}
            title={themeLabel}
            aria-label={themeLabel}
          >
            <ThemeIcon size={16} />
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".yaml,.yml,.svg,.png,.dot,text/yaml,image/svg+xml,image/png"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void onImport(file);
          }}
        />
      </header>

      <main className={cx('workspace', `show-${pane}`, editorHidden && 'editor-hidden')}>
        <section className="pane editor-pane" aria-label="YAML source">
          {doc && (
            <YamlEditor
              docId={doc.id}
              value={text}
              tree={parsed}
              onChange={setText}
              onCursor={selectFromEditor}
              reveal={reveal}
              apiRef={editorApi}
            />
          )}
          <footer className="statusbar">
            {firstProblem ? (
              <button type="button" className={cx('status-problems', errors.length > 0 && 'has-errors')} onClick={() => jumpTo(firstProblem.from, firstProblem.to)}>
                {errors.length > 0 ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}
                {errors.length > 0 && `${errors.length} error${errors.length > 1 ? 's' : ''}`}
                {errors.length > 0 && warnings.length > 0 && ' · '}
                {warnings.length > 0 && `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}
              </button>
            ) : (
              <span className="status-ok">No problems</span>
            )}
            <span className="status-counts">
              {tree.nodes.length} nodes · {tree.edges.length} edges
              {visible && ` · filtered to ${visible.size}`}
            </span>
          </footer>
        </section>

        <div className="divider" onPointerDown={startResize} role="separator" aria-orientation="vertical" />

        <section className="pane canvas-pane" aria-label="Tree">
          <ReactFlowProvider>
            <TreeCanvas
              tree={tree}
              layout={shownLayout}
              selection={selection}
              revealNonce={revealNonce}
              fitNonce={fitNonce}
              readOnly={readOnly}
              onSelect={selectFromCanvas}
              onConnect={onConnect}
              onCreateFrom={onCreateFrom}
              onAdd={onAdd}
              onDelete={onDelete}
              onEditLabel={focusLabel}
              onMove={onMove}
              onResetLayout={onResetLayout}
              onReconnect={reconnect}
            />
          </ReactFlowProvider>
          {readOnly && errors[0] && (
            <button type="button" className="syntax-banner" onClick={() => jumpTo(errors[0].from, errors[0].to)}>
              <CircleAlert size={14} />
              <span>
                YAML error on line {lineOf(errors[0].from)}: {errors[0].message}
                <small>Showing the last valid version until it is fixed.</small>
              </span>
            </button>
          )}
          <Inspector tree={tree} selection={selection} actions={inspector} labelRef={labelRef} readOnly={readOnly} />
        </section>
      </main>

      <Toasts toasts={toasts} />
    </div>
  );
}
