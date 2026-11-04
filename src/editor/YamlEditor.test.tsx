import { currentCompletions, completionStatus, startCompletion } from '@codemirror/autocomplete';
import { undoDepth } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { diagnosticCount, forEachDiagnostic } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { act, createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef, StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTree } from '../model/parse';
import type { Diagnostic, Tree } from '../model/types';
import { type EditorApi, type Reveal, YamlEditor } from './YamlEditor';

const SRC = `title: Demo
# a comment
facts:
- leak: Leaked creds
  from:
  - reality: '#yolosec'
attacks:
- login: Log in with them
  from:
  - leak
  - ghost
mitigations:
- mfa: Require MFA
  from:
  - login
goals:
- win: Attacker wins
  from:
  - login
filter:
- win
`;

interface Opts {
  docId?: string;
  value?: string;
  tree?: Tree;
  reveal?: Reveal | null;
  onChange?: (t: string) => void;
  onCursor?: (p: number) => void;
}

function setup(opts: Opts = {}) {
  const onChange = vi.fn(opts.onChange);
  const onCursor = vi.fn(opts.onCursor);
  const apiRef = createRef<EditorApi | null>() as React.RefObject<EditorApi | null>;
  const props = {
    docId: opts.docId ?? 'doc1',
    value: opts.value ?? SRC,
    tree: opts.tree ?? parseTree(opts.value ?? SRC),
    reveal: opts.reveal ?? null,
    onChange,
    onCursor,
    apiRef,
  };
  const utils = render(<YamlEditor {...props} />);
  const view = () => EditorView.findFromDOM(utils.container.querySelector('.cm-editor') as HTMLElement)!;
  const update = (next: Partial<typeof props>) => {
    Object.assign(props, next);
    utils.rerender(<YamlEditor {...props} />);
  };
  return { ...utils, view, onChange, onCursor, apiRef, update, props };
}

/** Like the app: the editor's text is state, and the tree is parsed from it. */
function Controlled({ initial, apiRef, onCursor }: { initial: string; apiRef: React.RefObject<EditorApi | null>; onCursor?: (p: number) => void }) {
  const [text, setText] = useState(initial);
  return (
    <>
      <YamlEditor docId="d" value={text} tree={parseTree(text)} onChange={setText} onCursor={onCursor ?? (() => {})} reveal={null} apiRef={apiRef} />
      <output data-testid="text">{text}</output>
      <button type="button" onClick={() => setText(text.replace('Log in with them', 'Log in remotely'))}>
        canvas-rename
      </button>
    </>
  );
}

function diagnostics(view: EditorView) {
  const out: Array<{ from: number; to: number; severity: string; message: string }> = [];
  forEachDiagnostic(view.state, (d, from, to) => out.push({ from, to, severity: d.severity, message: d.message }));
  return out;
}

/** The id marks the editor draws: [class, text]. */
function marks(view: EditorView): Array<[string, string]> {
  return [...view.contentDOM.querySelectorAll('.cm-node-id, .cm-node-ref')].map((el) => [el.className, el.textContent!]);
}

/** Type like a user: insert at the cursor as an input event. */
function type(view: EditorView, text: string, at = view.state.selection.main.head) {
  act(() => {
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: 'input.type',
      scrollIntoView: true,
    });
  });
}

function placeCursor(view: EditorView, pos: number) {
  act(() => view.dispatch({ selection: { anchor: pos }, userEvent: 'select' }));
}

async function completionsAt(view: EditorView, pos: number) {
  placeCursor(view, pos);
  act(() => {
    startCompletion(view);
  });
  await waitFor(() => expect(completionStatus(view.state)).not.toBe('pending'));
  return completionStatus(view.state) === 'active' ? currentCompletions(view.state) : [];
}

function key(view: EditorView, init: KeyboardEventInit) {
  act(() => {
    fireEvent.keyDown(view.contentDOM, init);
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as unknown as { __editor?: unknown }).__editor;
});

describe('YamlEditor: mounting', () => {
  it('shows the value, with line numbers, fold and lint gutters', () => {
    const { view, container } = setup();
    expect(view().state.doc.toString()).toBe(SRC);
    expect(container.querySelector('.yaml-editor > .cm-editor')).not.toBeNull();
    expect(container.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(container.querySelector('.cm-foldGutter')).not.toBeNull();
    expect(container.querySelector('.cm-gutter-lint')).not.toBeNull();
  });

  it('uses two-space indentation and tabs of two', () => {
    const { view } = setup();
    expect(view().state.tabSize).toBe(2);
    expect(view().state.facet(indentUnit)).toBe('  ');
    expect(view().contentDOM).toHaveClass('cm-lineWrapping');
  });

  it('does not report a change or a cursor move just for mounting', () => {
    const { onChange, onCursor } = setup();
    expect(onChange).not.toHaveBeenCalled();
    expect(onCursor).not.toHaveBeenCalled();
  });

  it('exposes undo, redo and focus through apiRef, and clears it on unmount', () => {
    const { view, apiRef, unmount, onChange } = setup();
    const api = apiRef.current!;
    expect(api).not.toBeNull();
    type(view(), 'X', 0);
    expect(view().state.doc.toString()).toBe('X' + SRC);
    act(() => api.undo());
    expect(view().state.doc.toString()).toBe(SRC);
    expect(onChange).toHaveBeenLastCalledWith(SRC);
    act(() => api.redo());
    expect(view().state.doc.toString()).toBe('X' + SRC);
    expect(onChange).toHaveBeenLastCalledWith('X' + SRC);
    act(() => api.focus());
    expect(view().hasFocus).toBe(true);
    expect(document.activeElement).toBe(view().contentDOM);
    const v = view();
    unmount();
    expect(apiRef.current).toBeNull();
    expect(v.dom.isConnected).toBe(false);
  });

  it('mounts a single editor under StrictMode', () => {
    const apiRef = createRef<EditorApi | null>() as React.RefObject<EditorApi | null>;
    const { container } = render(
      <StrictMode>
        <YamlEditor docId="d" value={SRC} tree={parseTree(SRC)} onChange={() => {}} onCursor={() => {}} reveal={null} apiRef={apiRef} />
      </StrictMode>,
    );
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(1);
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    type(view, 'Z', 0);
    act(() => apiRef.current!.undo());
    expect(view.state.doc.toString()).toBe(SRC);
  });

  it('in development, exposes the view as window.__editor', () => {
    const { view } = setup();
    expect((window as unknown as { __editor?: EditorView }).__editor).toBe(view());
  });

  it('outside development, does not expose window.__editor', () => {
    vi.stubEnv('DEV', false);
    setup();
    expect((window as unknown as { __editor?: EditorView }).__editor).toBeUndefined();
  });
});

describe('YamlEditor: typing', () => {
  it('reports every user change with the full new text', () => {
    const { view, onChange } = setup();
    type(view(), 'ab', SRC.indexOf('Demo') + 4);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(SRC.replace('Demo', 'Demoab'));
  });

  it('calls the latest onChange and onCursor props', () => {
    const { view, update, onChange } = setup();
    const second = vi.fn();
    const secondCursor = vi.fn();
    update({ onChange: second, onCursor: secondCursor });
    type(view(), 'x', 0);
    expect(onChange).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('x' + SRC);
    expect(secondCursor).toHaveBeenCalledWith(1);
  });

  it('keyboard: Ctrl+Z undoes, Ctrl+Y redoes', () => {
    const { view } = setup();
    type(view(), 'Q', 0);
    key(view(), { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(view().state.doc.toString()).toBe(SRC);
    key(view(), { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(view().state.doc.toString()).toBe('Q' + SRC);
  });

  // jsdom reports no platform, like Windows: CodeMirror binds Ctrl-Shift-z to redo on Linux only
  it('keyboard: Ctrl+Shift+Z redoes, as the shortcuts table says, on every platform', () => {
    const { view } = setup();
    type(view(), 'Q', 0);
    key(view(), { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(view().state.doc.toString()).toBe(SRC);
    key(view(), { key: 'Z', code: 'KeyZ', keyCode: 90, ctrlKey: true, shiftKey: true });
    expect(view().state.doc.toString()).toBe('Q' + SRC);
  });

  it('keyboard: Tab indents and Shift+Tab outdents by two spaces', () => {
    const { view } = setup();
    const line = view().state.doc.line(3); // "facts:"
    placeCursor(view(), line.from);
    key(view(), { key: 'Tab', code: 'Tab' });
    expect(view().state.doc.line(3).text).toBe('  facts:');
    key(view(), { key: 'Tab', code: 'Tab', shiftKey: true });
    expect(view().state.doc.line(3).text).toBe('facts:');
  });

  it('keyboard: Ctrl+F opens search', () => {
    const { view, container } = setup();
    key(view(), { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(container.querySelector('.cm-search')).not.toBeNull();
  });
});

describe('YamlEditor: pasting', () => {
  function paste(view: EditorView, text: string) {
    const event = createEvent.paste(view.contentDOM, {
      clipboardData: { getData: (t: string) => (t === 'text/plain' ? text : '') },
    });
    act(() => {
      fireEvent(view.contentDOM, event);
    });
  }

  it('strips Markdown fences and prose from a pasted assistant answer', () => {
    const { view, onChange } = setup({ value: '' , tree: parseTree('') });
    paste(view(), 'Here you go:\n```yaml\ntitle: Pasted\n```\nEnjoy!');
    expect(view().state.doc.toString()).toBe('title: Pasted\n');
    expect(onChange).toHaveBeenLastCalledWith('title: Pasted\n');
  });

  it('pastes plain text unchanged', () => {
    const { view } = setup({ value: '', tree: parseTree('') });
    paste(view(), 'title: Plain');
    expect(view().state.doc.toString()).toBe('title: Plain');
  });
});

describe('YamlEditor: cursor', () => {
  it('reports where the user puts the cursor', () => {
    const { view, onCursor } = setup();
    const pos = SRC.indexOf('login:');
    placeCursor(view(), pos);
    expect(onCursor).toHaveBeenCalledTimes(1);
    expect(onCursor).toHaveBeenLastCalledWith(pos);
  });

  it('reports the head of a selection', () => {
    const { view, onCursor } = setup();
    act(() => view().dispatch({ selection: { anchor: 3, head: 9 }, userEvent: 'select' }));
    expect(onCursor).toHaveBeenLastCalledWith(9);
  });

  it('does not report the cursor for a change that leaves the selection alone', () => {
    const { view, onCursor, onChange } = setup();
    act(() => view().dispatch({ changes: { from: 0, insert: 'x' } }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCursor).not.toHaveBeenCalled();
  });
});

describe('YamlEditor: reveal', () => {
  it('selects the range and scrolls it to the middle, without echoing it as a cursor move', () => {
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    const { view, update, onCursor, onChange } = setup();
    const from = SRC.indexOf('login:');
    update({ reveal: { from, to: from + 5, nonce: 1 } });
    const sel = view().state.selection.main;
    expect([sel.from, sel.to]).toEqual([from, from + 5]);
    expect(scroll).toHaveBeenCalledWith(from, { y: 'center' });
    expect(onCursor).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reveals the same range again when only the nonce changes', () => {
    const { view, update } = setup();
    update({ reveal: { from: 0, to: 5, nonce: 1 } });
    placeCursor(view(), 20);
    update({ reveal: { from: 0, to: 5, nonce: 2 } });
    expect(view().state.selection.main.from).toBe(0);
    expect(view().state.selection.main.to).toBe(5);
  });

  it('clamps a range that runs past the end of the document', () => {
    const { view, update } = setup();
    update({ reveal: { from: SRC.length - 2, to: SRC.length + 50, nonce: 1 } });
    const sel = view().state.selection.main;
    expect([sel.from, sel.to]).toEqual([SRC.length - 2, SRC.length]);
    update({ reveal: { from: SRC.length + 10, to: SRC.length + 20, nonce: 2 } });
    expect(view().state.selection.main.from).toBe(SRC.length);
    expect(view().state.selection.main.empty).toBe(true);
  });

  it('applies a reveal given at mount', () => {
    const { view } = setup({ reveal: { from: 2, to: 4, nonce: 1 } });
    expect(view().state.selection.main.from).toBe(2);
    expect(view().state.selection.main.to).toBe(4);
  });

  it('does nothing with a null reveal', () => {
    const { view, update } = setup();
    placeCursor(view(), 7);
    update({ reveal: null });
    expect(view().state.selection.main.head).toBe(7);
  });
});

describe('YamlEditor: diagnostics', () => {
  it('turns parser diagnostics into lint markers with the same range and severity', () => {
    const { view, container } = setup();
    const ghost = SRC.indexOf('ghost');
    expect(diagnostics(view())).toEqual([
      { from: ghost, to: ghost + 5, severity: 'warning', message: '"ghost" is not declared in facts, attacks, mitigations or goals' },
    ]);
    expect(diagnosticCount(view().state)).toBe(1);
    const underline = container.querySelector('.cm-lintRange-warning');
    expect(underline).not.toBeNull();
    expect(underline!.textContent).toBe('ghost');
    expect(container.querySelector('.cm-gutter-lint .cm-lint-marker-warning')).not.toBeNull();
  });

  it('maps errors and infos too, and replaces them when the tree changes', () => {
    const tree = parseTree(SRC);
    const custom: Diagnostic[] = [
      { from: 0, to: 5, severity: 'error', message: 'bad title' },
      { from: 7, to: 11, severity: 'info', message: 'fyi' },
    ];
    const { view, update, container } = setup({ tree: { ...tree, diagnostics: custom } });
    expect(diagnostics(view())).toEqual([
      { from: 0, to: 5, severity: 'error', message: 'bad title' },
      { from: 7, to: 11, severity: 'info', message: 'fyi' },
    ]);
    expect(container.querySelector('.cm-lintRange-error')!.textContent).toBe('title');
    expect(container.querySelector('.cm-lintRange-info')!.textContent).toBe('Demo');
    update({ tree: { ...tree, diagnostics: [] } });
    expect(diagnostics(view())).toEqual([]);
    expect(container.querySelector('.cm-lintRange')).toBeNull();
  });

  it('clamps diagnostics that point past the end of the text (a stale tree)', () => {
    const tree = parseTree(SRC);
    const len = SRC.length;
    const { view } = setup({
      tree: {
        ...tree,
        diagnostics: [
          { from: len - 3, to: len + 100, severity: 'error', message: 'tail' },
          { from: -4, to: 2, severity: 'info', message: 'before' },
          { from: 10, to: 4, severity: 'info', message: 'inverted' },
        ],
      },
    });
    const got = diagnostics(view());
    expect(got).toContainEqual({ from: len - 3, to: len, severity: 'error', message: 'tail' });
    expect(got).toHaveLength(3);
    expect(got).toContainEqual({ from: 0, to: 2, severity: 'info', message: 'before' });
    expect(got).toContainEqual({ from: 10, to: 10, severity: 'info', message: 'inverted' });
  });

  it('a diagnostic entirely past the end becomes a point at the end', () => {
    const tree = parseTree(SRC);
    const len = SRC.length;
    const { view } = setup({ tree: { ...tree, diagnostics: [{ from: len + 5, to: len + 9, severity: 'warning', message: 'past' }] } });
    expect(diagnostics(view())).toEqual([{ from: len, to: len, severity: 'warning', message: 'past' }]);
  });

  it('follows the text as the user fixes a problem', () => {
    const apiRef = createRef<EditorApi | null>() as React.RefObject<EditorApi | null>;
    const { container } = render(<Controlled initial={SRC} apiRef={apiRef} />);
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    expect(diagnosticCount(view.state)).toBe(1);
    const at = SRC.indexOf('  - ghost');
    act(() => view.dispatch({ changes: { from: at, to: at + '  - ghost\n'.length }, userEvent: 'delete' }));
    expect(diagnosticCount(view.state)).toBe(0);
  });
});

describe('YamlEditor: ids colored by kind', () => {
  it('marks every declared id and every reference with its kind', () => {
    const { view } = setup();
    expect(marks(view())).toEqual([
      ['cm-node-id cm-kind-fact', 'leak'],
      ['cm-node-ref cm-kind-reality', 'reality'],
      ['cm-node-id cm-kind-attack', 'login'],
      ['cm-node-ref cm-kind-fact', 'leak'],
      ['cm-node-ref cm-kind-ghost', 'ghost'],
      ['cm-node-id cm-kind-mitigation', 'mfa'],
      ['cm-node-ref cm-kind-attack', 'login'],
      ['cm-node-id cm-kind-goal', 'win'],
      ['cm-node-ref cm-kind-attack', 'login'],
      ['cm-node-ref cm-kind-goal', 'win'],
    ]);
  });

  it('a filter entry that names no node is drawn as a ghost; bad ranges are skipped', () => {
    const tree = parseTree(SRC);
    const len = SRC.length;
    const at = SRC.indexOf('- win\n', SRC.indexOf('filter:')) + 2;
    const filterRefs = [
      { id: 'nowhere', range: { from: at, to: at + 3 } },
      { id: 'win', range: { from: len, to: len + 3 } },
    ];
    const { view } = setup({ tree: { ...tree, filterRefs } });
    const refs = [...view().contentDOM.querySelectorAll('.cm-node-ref')].filter((el) => view().posAtDOM(el) >= at);
    expect(refs.map((el) => [el.className, el.textContent])).toEqual([['cm-node-ref cm-kind-ghost', 'win']]);
  });

  it('a tree without filter ranges (built by hand) still renders', () => {
    const { filterRefs: _, ...tree } = parseTree(SRC);
    const { view } = setup({ tree });
    expect(marks(view())).toHaveLength(9);
  });

  it('colors ids referenced under filter: too', () => {
    const { view } = setup();
    const filterAt = SRC.indexOf('filter:');
    const refs = [...view().contentDOM.querySelectorAll('.cm-node-ref')].filter((el) => view().posAtDOM(el) > filterAt);
    expect(refs.map((el) => [el.className, el.textContent])).toEqual([['cm-node-ref cm-kind-goal', 'win']]);
  });

  it('a reference to a node that is not in the tree at all is drawn as a ghost', () => {
    const tree = parseTree(SRC);
    const edges = tree.edges.map((e) => (e.source === 'leak' ? { ...e, source: 'nowhere' } : e));
    const { view } = setup({ tree: { ...tree, edges } });
    expect(marks(view())).toContainEqual(['cm-node-ref cm-kind-ghost', 'leak']);
  });

  it('skips ranges that are missing, empty or outside the text', () => {
    const tree = parseTree(SRC);
    const len = SRC.length;
    const nodes = tree.nodes.map((n) =>
      n.id === 'leak' ? { ...n, keyRange: { from: len, to: len + 4 } } : n.id === 'login' ? { ...n, keyRange: { from: 5, to: 5 } } : n.id === 'mfa' ? { ...n, keyRange: undefined } : n,
    );
    const edges = tree.edges.map((e, i) => (i === 0 ? { ...e, sourceRange: { from: -1, to: 3 } } : i === 1 ? { ...e, sourceRange: undefined } : e));
    const { view } = setup({ tree: { ...tree, nodes, edges } });
    expect(marks(view())).toEqual([
      ['cm-node-ref cm-kind-ghost', 'ghost'],
      ['cm-node-ref cm-kind-attack', 'login'],
      ['cm-node-id cm-kind-goal', 'win'],
      ['cm-node-ref cm-kind-attack', 'login'],
      ['cm-node-ref cm-kind-goal', 'win'],
    ]);
  });

  it('does not mark undeclared nodes at their (missing) declaration', () => {
    const tree = parseTree(SRC);
    const nodes = tree.nodes.map((n) => (n.id === 'win' ? { ...n, declared: false } : n));
    const { view } = setup({ tree: { ...tree, nodes } });
    expect(marks(view()).filter(([, t]) => t === 'win')).toEqual([['cm-node-ref cm-kind-ghost', 'win']]);
  });

  it('keeps the marks on their ids while the user types before them', () => {
    const { view } = setup();
    type(view(), '# hi\n', 0);
    // the tree prop did not change: the old marks moved with the text
    expect(marks(view())[0]).toEqual(['cm-node-id cm-kind-fact', 'leak']);
    expect(marks(view())).toHaveLength(10);
  });
});

describe('YamlEditor: autocomplete', () => {
  it('Ctrl+Space under from: suggests every node id with label and kind', async () => {
    const { view } = setup();
    const at = SRC.indexOf('  - leak\n') + '  - '.length;
    const options = await completionsAt(view(), at + 4); // after "leak"
    expect(options.map((o) => o.label)).toEqual(['leak']);
    const pos = SRC.indexOf('  - login\ngoals') + 4;
    act(() => view().dispatch({ changes: { from: pos, to: pos + 5 } }));
    const all = await completionsAt(view(), pos);
    const byLabel = Object.fromEntries(all.map((o) => [o.label, o]));
    expect(Object.keys(byLabel).sort()).toEqual(['leak', 'login', 'mfa', 'reality', 'win']);
    expect(byLabel.login).toMatchObject({ label: 'login', detail: 'Log in with them', type: 'attack', info: 'Attack', boost: 0 });
    expect(byLabel.leak).toMatchObject({ detail: 'Leaked creds', type: 'fact', info: 'Fact' });
    expect(byLabel.mfa).toMatchObject({ detail: 'Require MFA', type: 'mitigation', info: 'Mitigation' });
    expect(byLabel.win).toMatchObject({ detail: 'Attacker wins', type: 'goal', info: 'Goal' });
    expect(byLabel.reality).toMatchObject({ detail: 'Reality', type: 'reality', info: 'Reality', boost: -1 });
    expect(all[all.length - 1].label).toBe('reality');
  });

  it('shows the list with a kind icon and the label next to each id', async () => {
    const { view, container } = setup();
    const pos = SRC.indexOf('  - login\ngoals') + 4;
    act(() => view().dispatch({ changes: { from: pos, to: pos + 5, insert: 'l' } }));
    await completionsAt(view(), pos + 1);
    await waitFor(() => expect(container.querySelector('.cm-tooltip-autocomplete')).not.toBeNull());
    const rows = [...container.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => [
      li.querySelector('.cm-completionIcon')!.className,
      li.querySelector('.cm-completionLabel')!.textContent,
      li.querySelector('.cm-completionDetail')!.textContent,
    ]);
    expect(rows).toEqual([
      ['cm-completionIcon cm-completionIcon-fact', 'leak', 'Leaked creds'],
      ['cm-completionIcon cm-completionIcon-attack', 'login', 'Log in with them'],
    ]);
  });

  it('never suggests undeclared (ghost) ids', async () => {
    const { view } = setup();
    const at = SRC.indexOf('  - ghost') + 4;
    const options = await completionsAt(view(), at + 2); // "gh"
    expect(options.map((o) => o.label)).not.toContain('ghost');
  });

  it('completes the id being typed and accepting replaces it', async () => {
    const { view, onChange } = setup();
    const at = SRC.indexOf('  - ghost') + 4;
    act(() => view().dispatch({ changes: { from: at, to: at + 5, insert: 'mf' } }));
    const options = await completionsAt(view(), at + 2);
    expect(options.map((o) => o.label)).toEqual(['mfa']);
    await new Promise((r) => setTimeout(r, 100)); // CodeMirror ignores Enter for 75ms after opening
    key(view(), { key: 'Enter', code: 'Enter' });
    expect(view().state.doc.toString()).toContain('  - leak\n  - mfa\nmitigations');
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('  - mfa\nmitigations'));
  });

  it('opens while typing a new item under from:', async () => {
    const { view } = setup();
    const at = SRC.indexOf('  - ghost\n') + '  - ghost\n'.length;
    type(view(), '  - l', at);
    await waitFor(() => expect(completionStatus(view().state)).toBe('active'));
    expect(currentCompletions(view().state).map((o) => o.label)).toEqual(['leak', 'login']);
  });

  it('suggests under filter:, at the top level', async () => {
    const { view } = setup();
    const at = SRC.indexOf('- win\n', SRC.indexOf('filter:')) + 2;
    const options = await completionsAt(view(), at + 1); // "w"
    expect(options.map((o) => o.label)).toEqual(['win']);
  });

  it('suggests with items indented deeper than from:, after map items and with a comment on from:', async () => {
    const doc = `attacks:
- a: Alpha
  from:   # where it starts
    - reality
    - b:
      backwards: true

    # spacer
    -\x20
- b: Beta
`;
    const { view } = setup({ value: doc, tree: parseTree(doc) });
    const at = doc.indexOf('    - \n') + 6;
    expect(at).toBeGreaterThan(6);
    const options = await completionsAt(view(), at);
    expect(options.map((o) => o.label).sort()).toEqual(['a', 'b', 'reality']);
  });

  it.each([
    ['a node item under a section', 'attacks:\n- a: A\n- |\n'],
    ['a section key', 'att|\n'],
    ['after an id and colon', 'attacks:\n- a: A\n  from:\n  - reality: |\n'],
    ['a list under another key', 'attacks:\n- a: A\n  tags:\n  - |\n'],
    ['the first line', '- |\n'],
    ['a list item after its parent node ended', 'attacks:\n- a: A\n  from:\n  - reality\n- b: B\n  - |\n'],
    ['a list under a key that only starts with from', 'fromage:\n- |\n'],
  ])('suggests nothing on %s', async (_name, marked) => {
    const doc = marked.replace(/\|/g, '');
    const { view } = setup({ value: doc, tree: parseTree(doc) });
    const options = await completionsAt(view(), marked.indexOf('|'));
    expect(options).toEqual([]);
    expect(completionStatus(view().state)).toBeNull();
  });

  it('always offers reality, even before anything refers to it', async () => {
    const doc = 'attacks:\n- a: First step\n  from:\n  - \n';
    const { view } = setup({ value: doc, tree: parseTree(doc) });
    expect(parseTree(doc).nodes.some((n) => n.id === 'reality')).toBe(false);
    const options = await completionsAt(view(), doc.indexOf('  - \n') + 4);
    expect(options.map((o) => [o.label, o.detail, o.type, o.info, o.boost])).toEqual([
      ['a', 'First step', 'attack', 'Attack', 0],
      ['reality', 'Reality', 'reality', 'Reality', -1],
    ]);
  });

  it('uses the latest tree', async () => {
    const { view, update } = setup();
    const next = SRC.replace('- win: Attacker wins', '- win: Attacker wins\n- exfil: Steal data');
    update({ value: next, tree: parseTree(next) });
    const at = next.indexOf('- win\n', next.indexOf('filter:')) + 2;
    act(() => view().dispatch({ changes: { from: at, to: at + 3, insert: 'ex' } }));
    const options = await completionsAt(view(), at + 2);
    expect(options.map((o) => [o.label, o.detail])).toEqual([['exfil', 'Steal data']]);
  });
});

describe('YamlEditor: value from outside (canvas edits)', () => {
  it('applies the new text without echoing it through onChange, and keeps the cursor', () => {
    const { view, update, onChange, onCursor } = setup();
    const cursor = SRC.indexOf('goals:');
    placeCursor(view(), cursor);
    onCursor.mockClear();
    const next = SRC.replace('Log in with them', 'Log in');
    update({ value: next, tree: parseTree(next) });
    expect(view().state.doc.toString()).toBe(next);
    expect(onChange).not.toHaveBeenCalled();
    expect(onCursor).not.toHaveBeenCalled();
    expect(view().state.selection.main.head).toBe(cursor - ' with them'.length);
  });

  it.each([
    ['insert at start', 'X' + SRC],
    ['append', SRC + 'more\n'],
    ['delete everything', ''],
    ['replace a middle part', SRC.replace('Leaked creds', 'Stolen keys')],
    ['repeated characters', SRC.replace('title: Demo', 'title: Demoooo')],
    ['shrink a repeat', 'aa'],
  ])('applies the smallest change correctly: %s', (_n, next) => {
    const { view, update } = setup();
    const spy = vi.spyOn(view(), 'dispatch');
    update({ value: next, tree: parseTree(next) });
    expect(view().state.doc.toString()).toBe(next);
    expect(spy).toHaveBeenCalled();
  });

  it('a canvas edit can be undone from the editor, and undo reports the restored text', () => {
    const { view, update, apiRef, onChange } = setup();
    const next = SRC.replace('Require MFA', 'Hardware keys');
    update({ value: next, tree: parseTree(next) });
    act(() => apiRef.current!.undo());
    expect(view().state.doc.toString()).toBe(SRC);
    expect(onChange).toHaveBeenLastCalledWith(SRC);
  });

  it('a canvas edit right after typing is a separate undo step', () => {
    const apiRef = createRef<EditorApi | null>() as React.RefObject<EditorApi | null>;
    const { container, getByTestId, getByText } = render(<Controlled initial={SRC} apiRef={apiRef} />);
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    const end = SRC.indexOf('Log in with them') + 'Log in with them'.length;
    type(view, '!', end);
    act(() => getByText('canvas-rename').click());
    expect(view.state.doc.toString()).toBe(SRC.replace('Log in with them', 'Log in remotely!'));
    act(() => apiRef.current!.undo());
    expect(view.state.doc.toString()).toBe(SRC.replace('Log in with them', 'Log in with them!'));
    expect(getByTestId('text').textContent).toBe(SRC.replace('Log in with them', 'Log in with them!'));
    act(() => apiRef.current!.undo());
    expect(view.state.doc.toString()).toBe(SRC);
  });

  it('typing right after a canvas edit is a separate undo step', () => {
    const apiRef = createRef<EditorApi | null>() as React.RefObject<EditorApi | null>;
    const { container, getByText } = render(<Controlled initial={SRC} apiRef={apiRef} />);
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    act(() => getByText('canvas-rename').click());
    const renamed = SRC.replace('Log in with them', 'Log in remotely');
    type(view, '?', renamed.indexOf('Log in remotely') + 'Log in remotely'.length);
    act(() => apiRef.current!.undo());
    expect(view.state.doc.toString()).toBe(renamed);
    act(() => apiRef.current!.undo());
    expect(view.state.doc.toString()).toBe(SRC);
  });

  it('typing round-trips through a controlled parent without double-applying', () => {
    const apiRef = createRef<EditorApi | null>() as React.RefObject<EditorApi | null>;
    const { container, getByTestId } = render(<Controlled initial={SRC} apiRef={apiRef} />);
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    type(view, 'A', 0);
    type(view, 'B');
    expect(view.state.doc.toString()).toBe('AB' + SRC);
    expect(getByTestId('text').textContent).toBe('AB' + SRC);
    act(() => apiRef.current!.undo());
    expect(view.state.doc.toString()).toBe(SRC);
    expect(getByTestId('text').textContent).toBe(SRC);
  });

  it('rerendering with the same value changes nothing', () => {
    const { view, update } = setup();
    const before = view().state;
    update({ tree: parseTree(SRC) });
    expect(view().state.doc).toBe(before.doc);
    expect(undoDepth(view().state)).toBe(0);
  });
});

describe('YamlEditor: switching documents', () => {
  const OTHER = 'title: Other\nattacks:\n- x: X\n  from:\n  - nope\n';

  it('loads the new document with a fresh history: undo never crosses documents', () => {
    const { view, update, apiRef, onChange } = setup();
    type(view(), 'edit', 0);
    expect(undoDepth(view().state)).toBe(1);
    onChange.mockClear();
    update({ docId: 'doc2', value: OTHER, tree: parseTree(OTHER) });
    expect(view().state.doc.toString()).toBe(OTHER);
    expect(undoDepth(view().state)).toBe(0);
    act(() => apiRef.current!.undo());
    expect(view().state.doc.toString()).toBe(OTHER);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the new document’s diagnostics and marks', () => {
    const { view, update } = setup();
    update({ docId: 'doc2', value: OTHER, tree: parseTree(OTHER) });
    const at = OTHER.indexOf('nope');
    expect(diagnostics(view())).toEqual([
      { from: at, to: at + 4, severity: 'warning', message: '"nope" is not declared in facts, attacks, mitigations or goals' },
    ]);
    expect(marks(view())).toEqual([
      ['cm-node-id cm-kind-attack', 'x'],
      ['cm-node-ref cm-kind-ghost', 'nope'],
    ]);
  });

  it('keeps working after the switch: typing, autocomplete and the api', async () => {
    const { view, update, onChange, apiRef } = setup();
    update({ docId: 'doc2', value: OTHER, tree: parseTree(OTHER) });
    expect(view()).toBe((window as unknown as { __editor?: EditorView }).__editor);
    type(view(), '#', 0);
    expect(onChange).toHaveBeenLastCalledWith('#' + OTHER);
    act(() => apiRef.current!.undo());
    expect(view().state.doc.toString()).toBe(OTHER);
    const at = OTHER.indexOf('nope');
    act(() => view().dispatch({ changes: { from: at, to: at + 4 } }));
    const options = await completionsAt(view(), at);
    expect(options.map((o) => o.label).sort()).toEqual(['reality', 'x']);
  });

  it('switching to a document with the same text still resets history', () => {
    const { view, update } = setup();
    type(view(), 'x', 0);
    update({ docId: 'doc2', value: 'x' + SRC, tree: parseTree('x' + SRC) });
    expect(undoDepth(view().state)).toBe(0);
  });
});
