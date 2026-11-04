import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { type RefObject, useEffect, useRef } from 'react';
import { stripFences } from '../ai/prompt';
import { KIND_LABEL, type Tree, isGhost } from '../model/types';

export interface EditorApi {
  undo(): void;
  redo(): void;
  focus(): void;
}

export interface Reveal {
  from: number;
  to: number;
  nonce: number;
}

interface Props {
  docId: string;
  value: string;
  tree: Tree;
  onChange(text: string): void;
  onCursor(pos: number): void;
  reveal: Reveal | null;
  apiRef: RefObject<EditorApi | null>;
}

/** Changes that came from outside (canvas edits); they must not echo back through onChange. */
const external = Annotation.define<boolean>();
/** Selections we set ourselves; they must not re-select on the canvas. */
const programmatic = Annotation.define<boolean>();

const setMarks = StateEffect.define<DecorationSet>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--syn-atom)' },
  { tag: t.number, color: 'var(--syn-atom)' },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.brace], color: 'var(--syn-punct)' },
  { tag: [t.keyword, t.meta, t.typeName, t.labelName], color: 'var(--syn-meta)' },
  { tag: t.content, color: 'var(--text)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '1.65' },
  '.cm-content': { padding: '14px 0 40vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--text-4)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '34px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--editor-selection) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-match)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-4)', padding: '0 4px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-ui)', fontSize: '12.5px', maxHeight: '260px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '5px 10px !important', display: 'flex', alignItems: 'center', gap: '8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionLabel': { fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-completionDetail': { marginLeft: 'auto', paddingLeft: '16px', color: 'var(--text-3)', fontStyle: 'normal' },
  '.cm-diagnostic': { padding: '6px 10px', fontFamily: 'var(--font-ui)', fontSize: '12.5px', borderLeftWidth: '3px' },
  '.cm-lint-marker': { width: '0.8em', height: '0.8em' },
  '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)', borderColor: 'var(--border)' },
});

function isUserTx(tr: Transaction) {
  return !tr.annotation(external) && !tr.annotation(programmatic);
}

/** Suggest node ids while typing a list item under `from:` or `filter:`. */
function idCompletions(treeRef: RefObject<Tree>) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const item = before.match(/^(\s*)-\s+([\w-]*)$/);
    if (!item) return null;
    if (!ctx.explicit && item[2] === '' && !ctx.matchBefore(/-\s+$/)) return null;
    const indent = item[1].length;
    let parent: string | null = null;
    for (let n = line.number - 1; n >= 1; n--) {
      const text = ctx.state.doc.line(n).text;
      const trimmed = text.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const ind = text.length - text.trimStart().length;
      if (ind > indent || (ind === indent && trimmed.startsWith('-'))) continue;
      parent = trimmed;
      break;
    }
    if (!parent || !/^(from|filter):\s*(#.*)?$/.test(parent)) return null;
    const options: Completion[] = treeRef.current.nodes
      .filter((n) => !isGhost(n))
      .map((n) => ({
        label: n.id,
        detail: n.kind === 'reality' ? 'Reality' : n.label,
        type: n.kind,
        boost: n.kind === 'reality' ? -1 : 0,
        info: KIND_LABEL[n.kind],
      }));
    return { from: ctx.pos - item[2].length, options, validFor: /^[\w-]*$/ };
  };
}

function marksFor(tree: Tree, length: number): DecorationSet {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const ranges = [];
  const ok = (r: { from: number; to: number }) => r.from >= 0 && r.to <= length && r.from < r.to;
  for (const n of tree.nodes) {
    if (n.declared && n.keyRange && ok(n.keyRange)) {
      ranges.push(Decoration.mark({ class: `cm-node-id cm-kind-${n.kind}` }).range(n.keyRange.from, n.keyRange.to));
    }
  }
  for (const e of tree.edges) {
    if (!e.sourceRange || !ok(e.sourceRange)) continue;
    const src = byId.get(e.source);
    const kind = !src || isGhost(src) ? 'ghost' : src.kind;
    ranges.push(Decoration.mark({ class: `cm-node-ref cm-kind-${kind}` }).range(e.sourceRange.from, e.sourceRange.to));
  }
  return Decoration.set(ranges, true);
}

export function YamlEditor({ docId, value, tree, onChange, onCursor, reveal, apiRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const treeRef = useRef(tree);
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursor);
  treeRef.current = tree;
  onChangeRef.current = onChange;
  onCursorRef.current = onCursor;

  const makeState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter({ openText: '▾', closedText: '▸' }),
        lintGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorState.tabSize.of(2),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        EditorView.clipboardInputFilter.of((text) => stripFences(text)),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        yaml(),
        syntaxHighlighting(highlight),
        autocompletion({ override: [idCompletions(treeRef)], icons: true }),
        marksField,
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && u.transactions.some((tr) => !tr.annotation(external))) {
            onChangeRef.current(u.state.doc.toString());
          }
          if (u.selectionSet && u.transactions.some(isUserTx)) {
            onCursorRef.current(u.state.selection.main.head);
          }
        }),
      ],
    });

  useEffect(() => {
    const v = new EditorView({ state: makeState(value), parent: host.current! });
    view.current = v;
    // handle for end-to-end checks during development
    if (import.meta.env.DEV) (window as unknown as { __editor?: EditorView }).__editor = v;
    apiRef.current = {
      undo: () => undo(v),
      redo: () => redo(v),
      focus: () => v.focus(),
    };
    return () => {
      v.destroy();
      view.current = null;
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching documents starts a fresh history; undo must never cross documents.
  const lastDoc = useRef(docId);
  useEffect(() => {
    const v = view.current;
    if (!v || lastDoc.current === docId) return;
    lastDoc.current = docId;
    v.setState(makeState(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Canvas edits arrive as a new value: apply the smallest change so the cursor stays put.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      let start = 0;
      while (start < current.length && start < value.length && current[start] === value[start]) start++;
      let endA = current.length;
      let endB = value.length;
      while (endA > start && endB > start && current[endA - 1] === value[endB - 1]) {
        endA--;
        endB--;
      }
      v.dispatch({
        changes: { from: start, to: endA, insert: value.slice(start, endB) },
        annotations: [external.of(true), Transaction.addToHistory.of(true)],
      });
    }
    const length = v.state.doc.length;
    const clamp = (n: number) => Math.max(0, Math.min(length, n));
    const diagnostics: CmDiagnostic[] = tree.diagnostics.map((d) => {
      const from = clamp(d.from);
      return { from, to: Math.max(from, clamp(d.to)), severity: d.severity, message: d.message };
    });
    v.dispatch(setDiagnostics(v.state, diagnostics));
    v.dispatch({ effects: setMarks.of(marksFor(tree, length)) });
  }, [value, tree, docId]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const length = v.state.doc.length;
    const from = Math.min(reveal.from, length);
    const to = Math.min(reveal.to, length);
    v.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
      annotations: programmatic.of(true),
    });
  }, [reveal]);

  return <div className="yaml-editor" ref={host} />;
}
