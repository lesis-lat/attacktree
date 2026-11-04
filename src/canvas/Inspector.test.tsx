import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { parseTree } from '../model/parse';
import type { Tree } from '../model/types';
import { Inspector, type InspectorActions } from './Inspector';
import type { Selection } from './TreeCanvas';

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
  - push: 'via CI'
  - ghost
positions:
  push: [10, 20]
`;

function actions(overrides: Partial<InspectorActions> = {}): InspectorActions {
  return {
    unpin: vi.fn(),
    setLabel: vi.fn(),
    setKind: vi.fn(),
    renameId: vi.fn(() => null),
    validateId: vi.fn(() => null),
    addChild: vi.fn(),
    deleteNode: vi.fn(),
    updateEdge: vi.fn(),
    deleteEdge: vi.fn(),
    reconnect: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function setup(selection: Selection, { readOnly = false, tree = parseTree(TEXT), acts = actions() } = {}) {
  const labelRef = createRef<HTMLTextAreaElement>();
  const user = userEvent.setup();
  const view = render(<Inspector tree={tree} selection={selection} actions={acts} labelRef={labelRef} readOnly={readOnly} />);
  const rerender = (s: Selection, t: Tree = tree, ro = readOnly) =>
    view.rerender(<Inspector tree={t} selection={s} actions={acts} labelRef={labelRef} readOnly={ro} />);
  return { ...view, user, acts, labelRef, tree, rerender };
}

const labelBox = () => screen.getByRole('textbox', { name: 'Label' });
// the hint or error inside the <label> is part of the name
const idBox = () => screen.getByRole('textbox', { name: /^Id\b/ });

describe('Inspector', () => {
  it('renders nothing without a selection, or for a selection that no longer exists', () => {
    expect(setup(null).container).toBeEmptyDOMElement();
    expect(setup({ type: 'node', id: 'gone' }).container).toBeEmptyDOMElement();
    expect(setup({ type: 'edge', id: 'gone:0' }).container).toBeEmptyDOMElement();
  });

  it('keeps key presses from reaching the canvas shortcuts', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    setup({ type: 'node', id: 'phish' });
    fireEvent.keyDown(labelBox(), { key: 'Delete' });
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
  });
});

describe('node panel', () => {
  it('shows the node', () => {
    const { labelRef } = setup({ type: 'node', id: 'push' });
    expect(screen.getByText('Attack', { selector: '.inspector-kind' })).toBeInTheDocument();
    expect(labelBox()).toHaveValue('Push a backdoor');
    expect(labelRef.current).toBe(labelBox());
    expect(idBox()).toHaveValue('push');
    expect(screen.getByText('Renaming updates every reference.')).toBeInTheDocument();
    const stats = screen.getByText('in').closest('.inspector-stats')!;
    // phish -> push in; push -> review, push -> shipped out
    expect(stats).toHaveTextContent('1 in');
    expect(stats).toHaveTextContent('2 out');
    expect(screen.getByRole('radio', { name: 'Attack' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Attack' })).toHaveClass('is-active');
    expect(screen.getByRole('radio', { name: 'Goal' })).toHaveAttribute('aria-checked', 'false');
  });

  it('closes', async () => {
    const { user, acts } = setup({ type: 'node', id: 'push' });
    await user.click(screen.getByTitle('Close'));
    expect(acts.close).toHaveBeenCalledOnce();
  });

  it('changes the kind', async () => {
    const { user, acts } = setup({ type: 'node', id: 'push' });
    await user.click(screen.getByRole('radio', { name: 'Mitigation' }));
    expect(acts.setKind).toHaveBeenCalledWith('push', 'mitigation');
    await user.click(screen.getByRole('radio', { name: 'Fact' }));
    expect(acts.setKind).toHaveBeenLastCalledWith('push', 'fact');
  });

  it('edits the label as you type, but never to nothing', async () => {
    const { user, acts } = setup({ type: 'node', id: 'push' });
    await user.clear(labelBox());
    expect(labelBox()).toHaveValue('');
    expect(acts.setLabel).not.toHaveBeenCalledWith('push', '');
    await user.type(labelBox(), 'Go');
    expect(acts.setLabel).toHaveBeenLastCalledWith('push', 'Go');
    await user.type(labelBox(), ' ');
    expect(acts.setLabel).toHaveBeenLastCalledWith('push', 'Go ');
    vi.mocked(acts.setLabel).mockClear();
    await user.clear(labelBox());
    await user.type(labelBox(), '   ');
    expect(acts.setLabel).not.toHaveBeenCalled();
  });

  it('shows the saved label again when the field is left empty', async () => {
    const { user, acts } = setup({ type: 'node', id: 'push' });
    await user.clear(labelBox());
    await user.type(labelBox(), '  ');
    await user.tab();
    // the node keeps its label, so the field must not pretend otherwise
    expect(acts.setLabel).not.toHaveBeenCalled();
    expect(labelBox()).toHaveValue('Push a backdoor');
  });

  it('confirms the label with Enter, adds a line with Shift+Enter', async () => {
    const { user, acts } = setup({ type: 'node', id: 'push' });
    await user.click(labelBox());
    await user.keyboard('{Shift>}{Enter}{/Shift}x');
    expect(acts.setLabel).toHaveBeenLastCalledWith('push', 'Push a backdoor\nx');
    expect(labelBox()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(labelBox()).not.toHaveFocus();
    expect(labelBox()).toHaveValue('Push a backdoor\nx');
  });

  it('follows the label when the YAML changes it', () => {
    const { rerender, tree } = setup({ type: 'node', id: 'push' });
    const next = { ...tree, nodes: tree.nodes.map((n) => (n.id === 'push' ? { ...n, label: 'Edited in YAML' } : n)) };
    rerender({ type: 'node', id: 'push' }, next);
    expect(labelBox()).toHaveValue('Edited in YAML');
  });

  it('validates the id as you type and renames on blur', async () => {
    const validateId = vi.fn((_: string, next: string) => (next === 'phish' ? '"phish" is already taken' : null));
    const { user, acts } = setup({ type: 'node', id: 'push' }, { acts: actions({ validateId }) });
    await user.clear(idBox());
    await user.type(idBox(), 'phish');
    expect(validateId).toHaveBeenLastCalledWith('push', 'phish');
    expect(screen.getByText('"phish" is already taken')).toHaveClass('field-error');
    expect(idBox()).toHaveClass('has-error');
    expect(screen.queryByText('Renaming updates every reference.')).toBeNull();
    await user.type(idBox(), '2');
    expect(screen.queryByText('"phish" is already taken')).toBeNull();
    expect(idBox()).not.toHaveClass('has-error');
    // trims what it validates and renames
    await user.type(idBox(), '  ');
    expect(validateId).toHaveBeenLastCalledWith('push', 'phish2');
    await user.tab();
    expect(acts.renameId).toHaveBeenCalledWith('push', 'phish2');
  });

  it('shows the error when the rename is refused', async () => {
    const renameId = vi.fn(() => 'Use letters, digits, "_" or "-", starting with a letter or "_"');
    const { user } = setup({ type: 'node', id: 'push' }, { acts: actions({ renameId }) });
    await user.clear(idBox());
    await user.type(idBox(), '9lives{Enter}');
    expect(renameId).toHaveBeenCalledWith('push', '9lives');
    expect(screen.getByText('Use letters, digits, "_" or "-", starting with a letter or "_"')).toBeInTheDocument();
    expect(idBox()).not.toHaveFocus();
  });

  it('does not rename to the same id', async () => {
    const validateId = vi.fn(() => 'some error');
    const { user, acts } = setup({ type: 'node', id: 'push' }, { acts: actions({ validateId }) });
    await user.type(idBox(), 'x');
    expect(screen.getByText('some error')).toBeInTheDocument();
    await user.keyboard('{Backspace}');
    await user.tab();
    expect(acts.renameId).not.toHaveBeenCalled();
    expect(screen.queryByText('some error')).toBeNull();
  });

  it('cancels an id edit with Escape', async () => {
    const validateId = vi.fn(() => 'bad');
    const { user, acts } = setup({ type: 'node', id: 'push' }, { acts: actions({ validateId }) });
    await user.type(idBox(), '!!');
    expect(screen.getByText('bad')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(idBox()).toHaveValue('push');
    expect(screen.queryByText('bad')).toBeNull();
    await user.tab();
    expect(acts.renameId).not.toHaveBeenCalled();
  });

  it('starts over when another node is selected', async () => {
    const validateId = vi.fn(() => 'bad');
    const { user, rerender } = setup({ type: 'node', id: 'push' }, { acts: actions({ validateId }) });
    await user.type(idBox(), '!');
    await user.type(labelBox(), ' more');
    rerender({ type: 'node', id: 'phish' });
    expect(idBox()).toHaveValue('phish');
    expect(labelBox()).toHaveValue('Phish an engineer');
    expect(screen.queryByText('bad')).toBeNull();
  });

  it('adds the next step: a mitigation after an attack, an attack after anything else', async () => {
    const { user, acts, rerender } = setup({ type: 'node', id: 'push' });
    await user.click(screen.getByRole('button', { name: 'Add mitigation after' }));
    expect(acts.addChild).toHaveBeenCalledWith('push', 'mitigation');
    rerender({ type: 'node', id: 'review' });
    await user.click(screen.getByRole('button', { name: 'Add attack after' }));
    expect(acts.addChild).toHaveBeenLastCalledWith('review', 'attack');
    rerender({ type: 'node', id: 'reality' });
    await user.click(screen.getByRole('button', { name: 'Add attack after' }));
    expect(acts.addChild).toHaveBeenLastCalledWith('reality', 'attack');
    // nothing comes after a goal
    rerender({ type: 'node', id: 'shipped' });
    expect(screen.queryByRole('button', { name: /after/ })).toBeNull();
  });

  it('deletes the node', async () => {
    const { user, acts } = setup({ type: 'node', id: 'review' });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(acts.deleteNode).toHaveBeenCalledWith('review');
  });

  it('shows a hand-placed node and puts it back on the automatic layout', async () => {
    const { user, acts, rerender } = setup({ type: 'node', id: 'push' });
    expect(screen.getByText('Placed by hand')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    expect(acts.unpin).toHaveBeenCalledWith('push');
    rerender({ type: 'node', id: 'phish' });
    expect(screen.queryByText('Placed by hand')).toBeNull();
  });

  it('does not mistake built-in object names for positions', () => {
    const tree = parseTree(`attacks:
- constructor: Build the payload
  from:
  - reality
`);
    setup({ type: 'node', id: 'constructor' }, { tree });
    expect(screen.queryByText('Placed by hand')).toBeNull();
  });

  it('cannot edit reality or undeclared nodes, but can continue from them', () => {
    const { rerender } = setup({ type: 'node', id: 'reality' });
    expect(screen.getByText('Reality', { selector: '.inspector-kind' })).toBeInTheDocument();
    expect(labelBox()).toBeDisabled();
    expect(idBox()).toBeDisabled();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add attack after' })).toBeInTheDocument();

    rerender({ type: 'node', id: 'ghost' });
    expect(screen.getByText('Undeclared node')).toBeInTheDocument();
    expect(labelBox()).toBeDisabled();
    expect(idBox()).toBeDisabled();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add attack after' })).toBeInTheDocument();
  });

  it('is read-only while the YAML is broken', async () => {
    const { user, acts } = setup({ type: 'node', id: 'push' }, { readOnly: true });
    expect(labelBox()).toBeDisabled();
    expect(idBox()).toBeDisabled();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: /after/ })).toBeNull();
    expect(screen.getByText('Placed by hand')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
    await user.type(labelBox(), 'x');
    expect(acts.setLabel).not.toHaveBeenCalled();
    // closing still works
    await user.click(screen.getByTitle('Close'));
    expect(acts.close).toHaveBeenCalled();
  });
});

describe('edge panel', () => {
  it('shows where the connection goes, as From and To choices', () => {
    setup({ type: 'edge', id: 'shipped:0' });
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('push');
    expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('shipped');
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('via CI');
  });

  it('offers every node as the start, and declared nodes other than reality as the end', () => {
    setup({ type: 'edge', id: 'shipped:0' });
    const options = (name: string) => [...screen.getByRole('combobox', { name }).querySelectorAll('option')].map((o) => [o.value, o.textContent]);
    // not the end itself; an undeclared id is named as such
    expect(options('From')).toEqual([
      ['reality', 'Reality'],
      ['phish', 'Phish an engineer'],
      ['push', 'Push a backdoor'],
      ['review', 'Code review'],
      ['ghost', 'Undeclared: ghost'],
    ]);
    // not reality, not undeclared ids, not the start itself
    expect(options('To')).toEqual([
      ['phish', 'Phish an engineer'],
      ['review', 'Code review'],
      ['shipped', 'Backdoor ships'],
    ]);
  });

  it('names two nodes with the same label by their ids too', () => {
    const tree = parseTree(TEXT.replace('- review: Code review', '- review: Phish an engineer'));
    setup({ type: 'edge', id: 'shipped:0' }, { tree });
    const texts = [...screen.getByRole('combobox', { name: 'From' }).querySelectorAll('option')].map((o) => o.textContent);
    expect(texts).toContain('Phish an engineer (phish)');
    expect(texts).toContain('Phish an engineer (review)');
  });

  it('moves either end of the connection', () => {
    const { acts, tree } = setup({ type: 'edge', id: 'shipped:0' });
    const edge = tree.edges.find((e) => e.id === 'shipped:0')!;
    fireEvent.change(screen.getByRole('combobox', { name: 'From' }), { target: { value: 'phish' } });
    expect(acts.reconnect).toHaveBeenLastCalledWith(edge, { source: 'phish', target: 'shipped' });
    fireEvent.change(screen.getByRole('combobox', { name: 'To' }), { target: { value: 'review' } });
    expect(acts.reconnect).toHaveBeenLastCalledWith(edge, { source: 'push', target: 'review' });
  });

  it('read-only: shows the route as text', () => {
    setup({ type: 'edge', id: 'shipped:0' }, { readOnly: true });
    expect(screen.queryByRole('combobox')).toBeNull();
    const route = document.querySelector('.edge-route')!;
    expect(route).toHaveTextContent('Push a backdoor');
    expect(route).toHaveTextContent('Backdoor ships');
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('via CI');
  });

  it('falls back to the id for an end it cannot find', () => {
    const tree = parseTree(TEXT);
    tree.nodes = tree.nodes.filter((n) => n.id !== 'push');
    setup({ type: 'edge', id: 'shipped:0' }, { tree, readOnly: true });
    expect(document.querySelector('.edge-route')).toHaveTextContent('push');
  });

  it('edits the label as you type, empty included', async () => {
    const { user, acts, tree } = setup({ type: 'edge', id: 'shipped:0' });
    const edge = tree.edges.find((e) => e.id === 'shipped:0')!;
    const box = screen.getByRole('textbox', { name: 'Label' });
    await user.type(box, '!');
    expect(acts.updateEdge).toHaveBeenLastCalledWith(edge, { label: 'via CI!' });
    await user.clear(box);
    expect(acts.updateEdge).toHaveBeenLastCalledWith(edge, { label: '' });
    expect(box).toHaveAttribute('placeholder', 'e.g. via a phishing kit');
  });

  it('follows the label when the edge changes', () => {
    const { rerender, tree } = setup({ type: 'edge', id: 'shipped:0' });
    rerender({ type: 'edge', id: 'review:0' });
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('');
    rerender({ type: 'edge', id: 'push:0' }, tree);
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('#yolosec');
  });

  it('has no #yolosec switch: the app finds undefended steps by itself', () => {
    setup({ type: 'edge', id: 'push:0' });
    expect(screen.queryByRole('button', { name: /#yolosec/ })).toBeNull();
    // a '#yolosec' label from a Deciduous file is still an ordinary, editable label
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('#yolosec');
  });

  it('says when a connection is on an open path', () => {
    const { rerender } = setup({ type: 'edge', id: 'shipped:0' });
    expect(screen.getByRole('note')).toHaveTextContent('Open path. This step is on a way to a goal that meets no defense.');
    // backwards connections are never steps of a path
    rerender({ type: 'edge', id: 'phish:1' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('toggles backwards', async () => {
    const { user, acts, tree, rerender } = setup({ type: 'edge', id: 'phish:1' });
    const toggle = () => screen.getByRole('button', { name: /Backwards/ });
    expect(toggle()).toHaveClass('is-on');
    await user.click(toggle());
    expect(acts.updateEdge).toHaveBeenLastCalledWith(tree.edges.find((e) => e.id === 'phish:1'), { backwards: false });
    rerender({ type: 'edge', id: 'phish:0' });
    expect(toggle()).not.toHaveClass('is-on');
    await user.click(toggle());
    expect(acts.updateEdge).toHaveBeenLastCalledWith(tree.edges.find((e) => e.id === 'phish:0'), { backwards: true });
  });

  it('toggles not implemented', async () => {
    const { user, acts, tree, rerender } = setup({ type: 'edge', id: 'review:0' });
    const toggle = () => screen.getByRole('button', { name: /Not implemented/ });
    expect(toggle()).toHaveClass('is-on');
    await user.click(toggle());
    expect(acts.updateEdge).toHaveBeenLastCalledWith(tree.edges.find((e) => e.id === 'review:0'), { implemented: true });
    rerender({ type: 'edge', id: 'phish:0' });
    expect(toggle()).not.toHaveClass('is-on');
    await user.click(toggle());
    expect(acts.updateEdge).toHaveBeenLastCalledWith(tree.edges.find((e) => e.id === 'phish:0'), { implemented: false });
  });

  it('deletes the connection and closes', async () => {
    const { user, acts, tree } = setup({ type: 'edge', id: 'review:0' });
    await user.click(screen.getByRole('button', { name: 'Delete connection' }));
    expect(acts.deleteEdge).toHaveBeenCalledWith(tree.edges.find((e) => e.id === 'review:0'));
    await user.click(screen.getByTitle('Close'));
    expect(acts.close).toHaveBeenCalledOnce();
  });

  it('is read-only while the YAML is broken', async () => {
    const { user, acts } = setup({ type: 'edge', id: 'push:0' }, { readOnly: true });
    expect(screen.getByRole('textbox', { name: 'Label' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /#yolosec|Backwards|Not implemented|Delete/ })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'x');
    expect(acts.updateEdge).not.toHaveBeenCalled();
  });
});

describe('defense gaps in the node panel', () => {
  it('explains an attack with no defense, and how to fix it', () => {
    setup({ type: 'node', id: 'phish' });
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('No defense. Nothing counters this attack yet: no mitigation in place comes from it.');
    expect(note).toHaveTextContent('Add a mitigation after it, or connect one that exists.');
  });

  it('a planned mitigation is not a defense yet', () => {
    // "review" counters "push" but is not implemented
    setup({ type: 'node', id: 'push' });
    expect(screen.getByRole('note')).toHaveTextContent('No defense.');
  });

  it('read-only: explains, without suggesting an edit', () => {
    setup({ type: 'node', id: 'phish' }, { readOnly: true });
    expect(screen.getByRole('note')).toHaveTextContent('No defense.');
    expect(screen.getByRole('note')).not.toHaveTextContent('Add a mitigation');
  });

  it('explains a goal the attacker can reach without beating any defense', () => {
    setup({ type: 'node', id: 'shipped' });
    expect(screen.getByRole('note')).toHaveTextContent('Open path. The attacker can reach this goal without beating any defense. The red arrows show how.');
  });

  it('says nothing for a defended attack, a mitigation or reality', () => {
    const tree = parseTree(TEXT.replace('  - push:\n    implemented: false\n', '  - push\n'));
    const { rerender } = setup({ type: 'node', id: 'push' }, { tree });
    expect(screen.queryByRole('note')).toBeNull();
    rerender({ type: 'node', id: 'review' });
    expect(screen.queryByRole('note')).toBeNull();
    rerender({ type: 'node', id: 'reality' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('follows the tree as it changes', () => {
    const { rerender } = setup({ type: 'node', id: 'push' });
    expect(screen.getByRole('note')).toBeInTheDocument();
    rerender({ type: 'node', id: 'push' }, parseTree(TEXT.replace('  - push:\n    implemented: false\n', '  - push\n')));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
