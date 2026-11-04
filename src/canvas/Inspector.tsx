import { ArrowRight, CornerLeftUp, Hash, Pin, Trash2, X } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';
import { type DeclaredKind, isGhost, KIND_LABEL, type Tree, type TreeEdge, type TreeNode } from '../model/types';
import { cx } from '../ui/cx';
import type { Selection } from './TreeCanvas';

const KINDS: DeclaredKind[] = ['fact', 'attack', 'mitigation', 'goal'];

export interface InspectorActions {
  unpin(id: string): void;
  setLabel(id: string, label: string): void;
  setKind(id: string, kind: DeclaredKind): void;
  renameId(id: string, next: string): string | null;
  validateId(id: string, next: string): string | null;
  addChild(id: string, kind: DeclaredKind): void;
  deleteNode(id: string): void;
  updateEdge(edge: TreeEdge, patch: { label?: string; backwards?: boolean; implemented?: boolean }): void;
  deleteEdge(edge: TreeEdge): void;
  close(): void;
}

interface Props {
  tree: Tree;
  selection: Selection;
  readOnly: boolean;
  actions: InspectorActions;
  labelRef: RefObject<HTMLTextAreaElement | null>;
}

function NodePanel({ node, tree, actions, labelRef, readOnly }: { node: TreeNode; tree: Tree; actions: InspectorActions; labelRef: Props['labelRef']; readOnly: boolean }) {
  const [label, setLabel] = useState(node.label);
  const [id, setId] = useState(node.id);
  const [idError, setIdError] = useState<string | null>(null);
  useEffect(() => setLabel(node.label), [node.id, node.label]);
  useEffect(() => {
    setId(node.id);
    setIdError(null);
  }, [node.id]);

  const incoming = tree.edges.filter((e) => e.target === node.id).length;
  const outgoing = tree.edges.filter((e) => e.source === node.id).length;
  const editable = node.declared && node.kind !== 'reality' && !readOnly;
  const nextKind: DeclaredKind = node.kind === 'attack' ? 'mitigation' : 'attack';

  const commitId = () => {
    const next = id.trim();
    if (next === node.id) return setIdError(null);
    const problem = actions.renameId(node.id, next);
    setIdError(problem);
  };

  return (
    <>
      <div className={cx('inspector-head', `kind-${node.kind}`)}>
        <span className="kind-dot" />
        <span className="inspector-kind">{isGhost(node) ? 'Undeclared node' : KIND_LABEL[node.kind]}</span>
        <button type="button" className="icon-button" title="Close" onClick={actions.close}>
          <X size={15} />
        </button>
      </div>

      {editable && (
        <div className="segmented" role="radiogroup" aria-label="Kind">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={node.kind === k}
              className={cx(`kind-${k}`, node.kind === k && 'is-active')}
              onClick={() => actions.setKind(node.id, k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      <label className="field">
        <span className="field-label">Label</span>
        <textarea
          ref={labelRef}
          rows={2}
          value={label}
          disabled={!editable}
          onChange={(e) => {
            setLabel(e.target.value);
            if (e.target.value.trim()) actions.setLabel(node.id, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
      </label>

      <label className="field">
        <span className="field-label">Id</span>
        <input
          className={cx('mono', idError && 'has-error')}
          value={id}
          disabled={!editable}
          spellCheck={false}
          onChange={(e) => {
            setId(e.target.value);
            setIdError(actions.validateId(node.id, e.target.value.trim()));
          }}
          onBlur={commitId}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setId(node.id);
              setIdError(null);
            }
          }}
        />
        {idError ? (
          <span className="field-error">{idError}</span>
        ) : (
          <span className="field-hint">Renaming updates every reference.</span>
        )}
      </label>

      <div className="inspector-stats">
        <span>
          <strong>{incoming}</strong> in
        </span>
        <span>
          <strong>{outgoing}</strong> out
        </span>
        {node.id in tree.positions && (
          <span className="pinned">
            <Pin size={12} /> Placed by hand
            {!readOnly && (
              <button type="button" className="link-button" onClick={() => actions.unpin(node.id)}>
                Auto
              </button>
            )}
          </span>
        )}
      </div>

      {!readOnly && (
        <div className="inspector-actions">
          {node.kind !== 'goal' && (
            <button type="button" className="button" onClick={() => actions.addChild(node.id, nextKind)}>
              <ArrowRight size={14} /> Add {KIND_LABEL[nextKind].toLowerCase()} after
            </button>
          )}
          {editable && (
            <button type="button" className="button danger" onClick={() => actions.deleteNode(node.id)}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      )}
    </>
  );
}

function EdgePanel({ edge, tree, actions, readOnly }: { edge: TreeEdge; tree: Tree; actions: InspectorActions; readOnly: boolean }) {
  const [label, setLabel] = useState(edge.label ?? '');
  useEffect(() => setLabel(edge.label ?? ''), [edge.id, edge.label]);
  const name = (id: string) => tree.nodes.find((n) => n.id === id)?.label ?? id;
  const yolo = edge.label === '#yolosec';

  return (
    <>
      <div className="inspector-head">
        <span className="inspector-kind">Connection</span>
        <button type="button" className="icon-button" title="Close" onClick={actions.close}>
          <X size={15} />
        </button>
      </div>
      <div className="edge-route">
        <span>{name(edge.source)}</span>
        <ArrowRight size={13} />
        <span>{name(edge.target)}</span>
      </div>

      <label className="field">
        <span className="field-label">Label</span>
        <input
          value={label}
          placeholder="e.g. #yolosec"
          disabled={readOnly}
          onChange={(e) => {
            setLabel(e.target.value);
            actions.updateEdge(edge, { label: e.target.value });
          }}
        />
      </label>

      {!readOnly && (
        <div className="toggles">
          <button
            type="button"
            className={cx('toggle', yolo && 'is-on')}
            onClick={() => actions.updateEdge(edge, { label: yolo ? '' : '#yolosec' })}
          >
            <Hash size={14} />
            <span>
              <strong>#yolosec</strong>
              <small>No mitigation, or a bad practice</small>
            </span>
          </button>
          <button
            type="button"
            className={cx('toggle', edge.backwards && 'is-on')}
            onClick={() => actions.updateEdge(edge, { backwards: !edge.backwards })}
          >
            <CornerLeftUp size={14} />
            <span>
              <strong>Backwards</strong>
              <small>Forces the attacker back up the tree</small>
            </span>
          </button>
          <button
            type="button"
            className={cx('toggle', !edge.implemented && 'is-on')}
            onClick={() => actions.updateEdge(edge, { implemented: !edge.implemented })}
          >
            <span className="toggle-dash" />
            <span>
              <strong>Not implemented</strong>
              <small>Planned, not in place yet</small>
            </span>
          </button>
        </div>
      )}

      {!readOnly && (
        <div className="inspector-actions">
          <button type="button" className="button danger" onClick={() => actions.deleteEdge(edge)}>
            <Trash2 size={14} /> Delete connection
          </button>
        </div>
      )}
    </>
  );
}

export function Inspector({ tree, selection, actions, labelRef, readOnly }: Props) {
  if (!selection) return null;
  if (selection.type === 'node') {
    const node = tree.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    return (
      <aside className="inspector" onKeyDown={(e) => e.stopPropagation()}>
        <NodePanel node={node} tree={tree} actions={actions} labelRef={labelRef} readOnly={readOnly} />
      </aside>
    );
  }
  const edge = tree.edges.find((e) => e.id === selection.id);
  if (!edge) return null;
  return (
    <aside className="inspector" onKeyDown={(e) => e.stopPropagation()}>
      <EdgePanel edge={edge} tree={tree} actions={actions} readOnly={readOnly} />
    </aside>
  );
}
