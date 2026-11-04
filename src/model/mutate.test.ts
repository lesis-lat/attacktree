import { describe, expect, it } from 'vitest';
import { parseDocument, visit } from 'yaml';
import { BLANK_TREE, EXAMPLE_CICD } from './examples';
import * as edit from './mutate';
import { MutationError } from './mutate';
import { defaultLabel, parseTree } from './parse';
import type { DeclaredKind, Tree } from './types';

const SMALL = `title: Small
# keep me
facts:
- leak: Credentials in a public gist # where it started
  from:
  - reality: '#yolosec'

attacks:
- login: Log in with leaked creds
  from:
  - leak
- brute:
  from:
  - reality

mitigations:
- mfa: MFA
  from:
  - login

goals:
- win: Attacker wins
  from:
  - login
  - brute
`;

const INDENTED = `title: Indented
facts:
  - leak: Credentials in a public gist
    from:
      - reality
attacks:
  - login: Log in
    from:
      - leak
`;

const KINDS: DeclaredKind[] = ['fact', 'attack', 'mitigation', 'goal'];

/** what the tree means, without ranges or edge ids */
function meaning(tree: Tree) {
  return {
    title: tree.title,
    nodes: tree.nodes.map(({ id, kind, label, declared }) => ({ id, kind, label, declared })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: tree.edges
      .map(({ source, target, label, backwards, implemented, ungrouped }) => ({ source, target, label, backwards, implemented, ungrouped }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    filter: tree.filter,
    positions: tree.positions,
  };
}

const messages = (text: string) => parseTree(text).diagnostics.map((d) => d.message);

/** every comment line in a YAML text, as the yaml library sees them */
function comments(text: string): string[] {
  const doc = parseDocument(text);
  const out: string[] = [];
  const add = (c: string | null | undefined) => c && out.push(...c.split('\n').map((l) => l.trim()).filter(Boolean));
  add(doc.commentBefore);
  add(doc.comment);
  visit(doc, {
    Node(_, n) {
      add(n.commentBefore);
      add(n.comment);
    },
  });
  return out;
}

function expectSameComments(before: string, after: string) {
  expect(comments(after).sort()).toEqual(comments(before).sort());
}

describe('slugify', () => {
  it.each([
    ['Rotate leaked keys', 'rotate_leaked_keys'],
    ['Ação rápida', 'acao_rapida'],
    ['Ünïcödé façade', 'unicode_facade'],
    ['  --Phish!!  the admin--  ', 'phish_the_admin'],
    ['', 'node'],
    ['   ', 'node'],
    ['🔥🔥', 'node'],
    ['___', 'node'],
    ['123 go', 'node_123_go'],
    ['42', 'node_42'],
    ['x'.repeat(40), 'x'.repeat(32)],
    [`${'a'.repeat(31)} b`, 'a'.repeat(31)],
    ['CamelCase', 'camelcase'],
    ['Reality', 'reality'],
  ])('%j -> %j', (label, slug) => {
    expect(edit.slugify(label)).toBe(slug);
  });

  it('always yields an id that validateId accepts', () => {
    for (const label of ['', '9', 'é', '—', 'a b', '_', 'İstanbul', 'ﬁle', '１２３', 'Ⅻ', '\u0000x']) {
      const id = edit.slugify(label);
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(id.length).toBeLessThanOrEqual(32);
      expect(edit.validateId('', 'old', id)).toBeNull();
    }
  });
});

describe('refusals', () => {
  it.each<[string, (t: string) => unknown]>([
    ['addNode', (t) => edit.addNode(t, { kind: 'attack', label: 'x' })],
    ['connect', (t) => edit.connect(t, 'a', 'b')],
    ['removeEdge', (t) => edit.removeEdge(t, 'a', 0)],
    ['updateEdge', (t) => edit.updateEdge(t, 'a', 0, {})],
    ['removeNodes', (t) => edit.removeNodes(t, ['a'])],
    ['setLabel', (t) => edit.setLabel(t, 'a', 'x')],
    ['setKind', (t) => edit.setKind(t, 'a', 'goal')],
    ['renameId', (t) => edit.renameId(t, 'a', 'b2')],
    ['setPositions', (t) => edit.setPositions(t, { a: { x: 1, y: 1 } })],
    ['clearPositions', (t) => edit.clearPositions(t)],
  ])('%s refuses broken YAML and non-mapping documents', (_, run) => {
    expect(() => run('attacks:\n- a: [x\n')).toThrow(new MutationError('Fix the YAML errors before editing on the canvas'));
    expect(() => run('- a\n- b\n')).toThrow(new MutationError('The document must be a mapping'));
  });

  it('MutationError is an Error', () => {
    expect(new MutationError('x')).toBeInstanceOf(Error);
  });

  it.each<[string, (t: string) => unknown]>([
    ['connect', (t) => edit.connect(t, 'login', 'nope')],
    ['removeEdge', (t) => edit.removeEdge(t, 'nope', 0)],
    ['updateEdge', (t) => edit.updateEdge(t, 'nope', 0, {})],
    ['setLabel', (t) => edit.setLabel(t, 'nope', 'x')],
    ['setKind', (t) => edit.setKind(t, 'nope', 'goal')],
    ['renameId', (t) => edit.renameId(t, 'nope', 'fresh')],
  ])('%s refuses ids that are not declared', (_, run) => {
    expect(() => run(SMALL)).toThrow(new MutationError('"nope" is not declared'));
  });

  it('ghosts and implicit reality are not declared, so they cannot be edited', () => {
    const text = 'attacks:\n- a: A\n  from:\n  - reality\n  - ghost\n';
    expect(() => edit.setLabel(text, 'ghost', 'x')).toThrow('"ghost" is not declared');
    expect(() => edit.setKind(text, 'reality', 'goal')).toThrow('"reality" is not declared');
  });
});

describe('addNode', () => {
  it('appends to an existing section, keeping flush lists and comments', () => {
    const { text, id } = edit.addNode(SMALL, { kind: 'attack', label: 'Phish the admin', from: ['leak', 'reality'] });
    expect(id).toBe('phish_the_admin');
    expect(text).toContain('- brute:\n  from:\n  - reality\n- phish_the_admin: Phish the admin\n  from:\n  - leak\n  - reality\n\nmitigations:');
    expectSameComments(SMALL, text);
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes.find((n) => n.id === id)).toMatchObject({ kind: 'attack', label: 'Phish the admin' });
    expect(tree.edges.filter((e) => e.target === id).map((e) => e.source)).toEqual(['leak', 'reality']);
  });

  it('leaves everything else byte for byte', () => {
    const { text } = edit.addNode(SMALL, { kind: 'goal', label: 'Another' });
    expect(text).toBe(`${SMALL}- another: Another\n`);
  });

  it('omits "from" when there are no parents', () => {
    expect(edit.addNode(SMALL, { kind: 'goal', label: 'X', from: [] }).text).toBe(`${SMALL}- x: X\n`);
  });

  it('keeps indented lists indented', () => {
    const { text } = edit.addNode(INDENTED, { kind: 'attack', label: 'B', from: ['login'] });
    expect(text).toBe(`${INDENTED}  - b: B\n    from:\n      - login\n`);
  });

  it('picks a fresh id when the slug is taken, by a node, reality or "from"', () => {
    const text = 'attacks:\n- a: A\n- a_2: A2\n';
    expect(edit.addNode(text, { kind: 'attack', label: 'A' }).id).toBe('a_3');
    expect(edit.addNode(text, { kind: 'attack', label: 'A 2' }).id).toBe('a_2_2');
    expect(edit.addNode(text, { kind: 'attack', label: 'Reality' }).id).toBe('reality_2');
    expect(edit.addNode(text, { kind: 'attack', label: 'From' }).id).toBe('from_2');
    // ids taken in any section count
    expect(edit.addNode('goals:\n- x: X\n', { kind: 'fact', label: 'x' }).id).toBe('x_2');
  });

  it('gives labels without letters a generic id', () => {
    const first = edit.addNode('attacks:\n- a: A\n', { kind: 'attack', label: '???' });
    expect(first.id).toBe('node');
    const second = edit.addNode(first.text, { kind: 'attack', label: '!!!' });
    expect(second.id).toBe('node_2');
    expect(parseTree(second.text).nodes.map((n) => n.label)).toEqual(['A', '???', '!!!']);
  });

  it('starts an empty document', () => {
    const { text, id } = edit.addNode('', { kind: 'attack', label: 'First' });
    expect(id).toBe('first');
    expect(parseTree(text).nodes.map((n) => [n.id, n.kind])).toEqual([['first', 'attack']]);
    expect(text).toBe('attacks:\n  - first: First\n');
  });

  it('keeps a document that only has comments', () => {
    const { text } = edit.addNode('# just a comment\n', { kind: 'fact', label: 'F' });
    expect(text).toContain('# just a comment');
    expect(parseTree(text).nodes.map((n) => n.id)).toEqual(['f']);
  });

  it('fills an empty or broken-shaped section in place', () => {
    for (const section of ['facts:\n', 'facts: ~\n', 'facts: []\n', 'facts: oops\n']) {
      const { text } = edit.addNode(`title: T\n${section}goals:\n- g: G\n`, { kind: 'fact', label: 'F' });
      expect(text).toBe('title: T\nfacts:\n- f: F\ngoals:\n- g: G\n');
    }
  });

  it('turns a flow section into a block list, keeping flow items as they are', () => {
    const { text } = edit.addNode('attacks: [{a: A}]\n', { kind: 'attack', label: 'B' });
    expect(text).toBe('attacks:\n  - { a: A }\n  - b: B\n');
    expect(parseTree(text).nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  describe('creates missing sections in canonical order, one blank line apart', () => {
    it('between existing sections', () => {
      const { text } = edit.addNode('title: T\n\nfacts:\n- f: F\n\ngoals:\n- g: G\n', { kind: 'mitigation', label: 'M' });
      expect(text).toBe('title: T\n\nfacts:\n- f: F\n\nmitigations:\n- m: M\n\ngoals:\n- g: G\n');
    });

    it('at the end', () => {
      const { text } = edit.addNode('title: T\n\nfacts:\n- f: F\n', { kind: 'goal', label: 'G' });
      expect(text).toBe('title: T\n\nfacts:\n- f: F\n\ngoals:\n- g: G\n');
    });

    it('before filter and positions', () => {
      const { text } = edit.addNode('title: T\nfilter:\n- f\npositions:\n  f: [ 1, 2 ]\n', { kind: 'fact', label: 'F' });
      expect(text).toBe('title: T\n\nfacts:\n- f: F\nfilter:\n- f\npositions:\n  f: [ 1, 2 ]\n');
    });

    it('past keys that are not text', () => {
      const { text } = edit.addNode('? [odd]\n: x\ngoals:\n- g: G\n', { kind: 'fact', label: 'F' });
      expect(text).toBe('? [ odd ]\n: x\n\nfacts:\n- f: F\ngoals:\n- g: G\n');
    });

    it('after unknown keys that come first', () => {
      const { text } = edit.addNode('custom: 1\n', { kind: 'goal', label: 'G' });
      expect(text.indexOf('custom')).toBeLessThan(text.indexOf('goals'));
    });

    it('at the very top, without a leading blank line', () => {
      const { text } = edit.addNode('goals:\n- g: G\n', { kind: 'fact', label: 'F' });
      expect(text).toBe('facts:\n- f: F\n\ngoals:\n- g: G\n');
    });

    it('at the very top, keeping the comment on the section below', () => {
      const { text } = edit.addNode('# about goals\ngoals:\n- g: G\n', { kind: 'fact', label: 'F' });
      expect(text).toBe('facts:\n- f: F\n\n# about goals\ngoals:\n- g: G\n');
    });

    it('at the very top, below the comment that heads the document', () => {
      const { text } = edit.addNode('# header\n\ngoals:\n- g: G\n', { kind: 'fact', label: 'F' });
      expect(text).toBe('# header\n\nfacts:\n- f: F\n\ngoals:\n- g: G\n');
    });

    it.each(KINDS)('for every kind (%s)', (kind) => {
      const { text } = edit.addNode('title: T\n', { kind, label: 'N' });
      const tree = parseTree(text);
      expect(tree.diagnostics).toEqual([]);
      expect(tree.nodes).toMatchObject([{ id: 'n', kind }]);
    });
  });

  it.each([
    '#yolosec',
    'a: b',
    '- dash',
    '[x]',
    '{x}',
    '*star',
    '&amp',
    '!bang',
    '%pct',
    '@at',
    '`tick',
    "it's",
    '"quoted"',
    'x #y',
    'null',
    'true',
    '~',
    '123',
    '1e3',
    '0x1F',
    '---',
    '...',
    'Ataque à cadeia ✓ 🔥',
    'tab\there',
    'back\\slash',
    'line1\nline2',
    'trailing\n',
    ' padded ',
    '? q',
    ': colon',
    'a'.repeat(300),
  ])('round-trips the label %j', (label) => {
    const { text, id } = edit.addNode(SMALL, { kind: 'attack', label });
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes.find((n) => n.id === id)!.label).toBe(label);
  });
});

describe('connect', () => {
  it('adds the source to the target\'s "from" list', () => {
    const text = edit.connect(SMALL, 'mfa', 'brute');
    expect(text).toBe(SMALL.replace('- brute:\n  from:\n  - reality\n', '- brute:\n  from:\n  - reality\n  - mfa\n'));
  });

  it('creates "from" when the node has none, or when it is empty', () => {
    expect(edit.connect('attacks:\n- a: A\n- b: B\n', 'b', 'a')).toBe('attacks:\n- a: A\n  from:\n  - b\n- b: B\n');
    expect(edit.connect('attacks:\n- a: A\n  from:\n- b: B\n', 'b', 'a')).toBe('attacks:\n- a: A\n  from:\n  - b\n- b: B\n');
    expect(edit.connect('attacks:\n- a: A\n  from: oops\n- b: B\n', 'b', 'a')).toBe('attacks:\n- a: A\n  from:\n  - b\n- b: B\n');
  });

  it('writes backwards edges with their flag', () => {
    const text = edit.connect(SMALL, 'mfa', 'leak', true);
    expect(text).toContain("  - reality: '#yolosec'\n  - mfa:\n    backwards: true\n");
    expect(parseTree(text).edges.find((e) => e.source === 'mfa' && e.target === 'leak')).toMatchObject({ backwards: true, implemented: true });
  });

  it('is idempotent: an existing connection returns the text untouched', () => {
    const odd = 'attacks:\n- a:   A\n  from: [ b,  reality ]\n- b: B\n';
    expect(edit.connect(odd, 'b', 'a')).toBe(odd);
    expect(edit.connect(SMALL, 'reality', 'leak')).toBe(SMALL);
    const once = edit.connect(SMALL, 'mfa', 'leak', true);
    expect(edit.connect(once, 'mfa', 'leak', true)).toBe(once);
  });

  it('recognizes existing connections in every entry form', () => {
    const text = "attacks:\n- a: A\n  from:\n  - b: '#yolosec'\n  - c: {backwards: true}\n  - d:\n    backwards: true\n- b: B\n- c: C\n- d: D\n";
    expect(edit.connect(text, 'b', 'a')).toBe(text);
    expect(edit.connect(text, 'c', 'a', true)).toBe(text);
    expect(edit.connect(text, 'd', 'a', true)).toBe(text);
  });

  it('nests the flag under an id that has the same name, instead of writing a duplicate key', () => {
    const src = 'attacks:\n- a: A\n- backwards: B\n- implemented: I\n';
    let text = edit.connect(src, 'backwards', 'a', true);
    expect(text).toBe('attacks:\n- a: A\n  from:\n  - backwards:\n      backwards: true\n- backwards: B\n- implemented: I\n');
    text = edit.connect(text, 'implemented', 'a');
    text = edit.updateEdge(text, 'a', 1, { implemented: false, label: '#yolosec' });
    const tree = parseTree(text);
    expect(tree).toMatchObject({ syntaxError: false, diagnostics: [] });
    expect(tree.edges.map((e) => [e.source, e.backwards, e.implemented, e.label])).toEqual([
      ['backwards', true, true, undefined],
      ['implemented', false, false, '#yolosec'],
    ]);
  });

  it('a forward and a backwards connection between the same nodes are distinct', () => {
    const text = edit.connect(edit.connect('attacks:\n- a: A\n- b: B\n', 'b', 'a'), 'b', 'a', true);
    expect(parseTree(text).edges.map((e) => [e.source, e.backwards])).toEqual([
      ['b', false],
      ['b', true],
    ]);
    expect(parseTree(text).diagnostics).toEqual([]);
  });

  it('turns a flow "from" into a block list', () => {
    expect(edit.connect('attacks:\n- a: A\n  from: [reality]\n- b: B\n', 'b', 'a')).toBe(
      'attacks:\n- a: A\n  from:\n  - reality\n  - b\n- b: B\n',
    );
  });

  it('may connect from an undeclared id, which then shows as a ghost', () => {
    const text = edit.connect('attacks:\n- a: A\n', 'ghost', 'a');
    expect(messages(text)).toEqual(['"ghost" is not declared in facts, attacks, mitigations or goals']);
  });

  it('refuses self-loops and edges into reality', () => {
    expect(() => edit.connect(SMALL, 'login', 'login')).toThrow(new MutationError('A node cannot come from itself'));
    expect(() => edit.connect(SMALL, 'login', 'reality')).toThrow(new MutationError('Nothing can lead into Reality'));
  });

  it('connect then removeEdge gives back the original text', () => {
    for (const source of [SMALL, EXAMPLE_CICD, BLANK_TREE, INDENTED]) {
      const tree = parseTree(source);
      const target = tree.nodes.find((n) => n.declared && n.kind !== 'reality')!;
      const index = tree.edges.filter((e) => e.target === target.id).length;
      const connected = edit.connect(source, 'brand_new', target.id);
      expect(edit.removeEdge(connected, target.id, index)).toBe(source);
    }
  });
});

describe('removeEdge', () => {
  it('removes the entry at that position', () => {
    const text = edit.removeEdge(SMALL, 'win', 0);
    expect(text).toBe(SMALL.replace('  - login\n  - brute\n', '  - brute\n'));
  });

  it('drops a "from" list that became empty', () => {
    const text = edit.removeEdge(SMALL, 'login', 0);
    expect(text).toBe(SMALL.replace('- login: Log in with leaked creds\n  from:\n  - leak\n', '- login: Log in with leaked creds\n'));
    expect(parseTree(text).diagnostics).toEqual([]);
  });

  it('removes invalid entries too, by position', () => {
    const text = 'attacks:\n- a: A\n  from:\n  - [bad]\n  - reality\n';
    expect(edit.removeEdge(text, 'a', 0)).toBe('attacks:\n- a: A\n  from:\n  - reality\n');
  });

  it('leaves the text alone when there is nothing at that position', () => {
    expect(edit.removeEdge(SMALL, 'win', 2)).toBe(SMALL);
    expect(edit.removeEdge(SMALL, 'win', 99)).toBe(SMALL);
    expect(edit.removeEdge('attacks:\n- a: A\n', 'a', 0)).toBe('attacks:\n- a: A\n');
    expect(edit.removeEdge('attacks:\n- a: A\n  from:\n', 'a', 0)).toBe('attacks:\n- a: A\n  from:\n');
  });

  it('never removes a different entry for a position that does not exist', () => {
    expect(edit.removeEdge(SMALL, 'win', -1)).toBe(SMALL);
    expect(edit.removeEdge(SMALL, 'win', 0.5)).toBe(SMALL);
    expect(edit.removeEdge(SMALL, 'win', Number.NaN)).toBe(SMALL);
  });

  it('works with the edge ids the parser gives, removing from the highest index down', () => {
    const tree = parseTree(SMALL);
    let text = SMALL;
    for (const e of tree.edges.filter((x) => x.target === 'win').sort((a, b) => b.fromIndex - a.fromIndex)) {
      text = edit.removeEdge(text, e.target, e.fromIndex);
    }
    expect(text).toContain('- win: Attacker wins\n');
    expect(parseTree(text).edges.filter((e) => e.target === 'win')).toEqual([]);
  });
});

describe('updateEdge', () => {
  const one = (entry: string) => `attacks:\n- a: A\n  from:\n${entry}- b: B\n`;
  const edgeOf = (text: string) => parseTree(text).edges.find((e) => e.target === 'a')!;

  it('sets and clears a label', () => {
    const labelled = edit.updateEdge(one('  - b\n'), 'a', 0, { label: '#yolosec' });
    expect(labelled).toBe(one("  - b: '#yolosec'\n"));
    expect(edit.updateEdge(labelled, 'a', 0, { label: '' })).toBe(one('  - b\n'));
    expect(edit.updateEdge(labelled, 'a', 0, { label: '   ' })).toBe(one('  - b\n'));
    expect(edit.updateEdge(labelled, 'a', 0, { label: undefined })).toBe(one('  - b\n'));
  });

  it('sets each flag and goes back to the short form when all are default', () => {
    let text = one('  - b\n');
    text = edit.updateEdge(text, 'a', 0, { backwards: true });
    expect(text).toBe(one('  - b:\n    backwards: true\n'));
    text = edit.updateEdge(text, 'a', 0, { implemented: false, ungrouped: true });
    expect(text).toBe(one('  - b:\n    backwards: true\n    implemented: false\n    ungrouped: true\n'));
    expect(edgeOf(text)).toMatchObject({ backwards: true, implemented: false, ungrouped: true });
    text = edit.updateEdge(text, 'a', 0, { backwards: false, implemented: true, ungrouped: false });
    expect(text).toBe(one('  - b\n'));
  });

  it('keeps what is not patched', () => {
    const text = edit.updateEdge(one("  - b: '#yolosec'\n    backwards: true\n"), 'a', 0, { implemented: false });
    expect(edgeOf(text)).toMatchObject({ label: '#yolosec', backwards: true, implemented: false, ungrouped: false });
  });

  it('keeps labels that YAML reads as numbers or booleans', () => {
    for (const label of ['2024', 'true', '3.5']) {
      const text = edit.updateEdge(one(`  - b: ${label}\n`), 'a', 0, { implemented: false });
      expect(edgeOf(text)).toMatchObject({ label, implemented: false });
    }
  });

  it('keeps a nested label, and normalizes nested flags to the Deciduous layout', () => {
    const text = edit.updateEdge(one("  - b:\n      label: '#yolosec'\n      backwards: true\n"), 'a', 0, { ungrouped: true });
    expect(text).toBe(one("  - b: '#yolosec'\n    backwards: true\n    ungrouped: true\n"));
    expect(edit.updateEdge(one('  - b: {label: 7}\n'), 'a', 0, { implemented: false })).toBe(one("  - b: '7'\n    implemented: false\n"));
  });

  it('does not turn a property the parser ignores into a label', () => {
    const src = one('  - b:\n    label: x\n');
    expect(edgeOf(src).label).toBeUndefined();
    const text = edit.updateEdge(src, 'a', 0, { implemented: false });
    expect(edgeOf(text)).toMatchObject({ label: undefined, implemented: false });
  });

  it('changes only the connection it was asked to', () => {
    const src = one("  - reality\n  - b: '#yolosec'\n  - c:\n    backwards: true\n").replace('- b: B\n', '- b: B\n- c: C\n');
    const before = meaning(parseTree(src));
    const text = edit.updateEdge(src, 'a', 1, { implemented: false });
    const after = meaning(parseTree(text));
    expect(after.edges.filter((e) => e.source !== 'b')).toEqual(before.edges.filter((e) => e.source !== 'b'));
    expect(after.edges.find((e) => e.source === 'b')).toEqual({ ...before.edges.find((e) => e.source === 'b'), implemented: false });
  });

  it('keeps a comment on a plain entry', () => {
    const text = edit.updateEdge(one('  - b # why\n'), 'a', 0, { implemented: false });
    expect(text).toBe(one('  - b: # why\n    implemented: false\n'));
  });

  it('keeps a comment after a label', () => {
    const text = edit.updateEdge(one("  - b: '#yolosec' # nothing stops this\n"), 'a', 0, { implemented: false });
    expect(text).toBe(one("  - b: '#yolosec' # nothing stops this\n    implemented: false\n"));
  });

  it('keeps comments when going back to the short form', () => {
    const text = edit.updateEdge(one('  - b: # planned\n    implemented: false\n'), 'a', 0, { implemented: true });
    expect(text).toBe(one('  - b # planned\n'));
  });

  it('keeps comments on flags and before the entry', () => {
    const src = one('  - reality\n  # about b\n  - b:\n    backwards: true # sent back\n');
    const text = edit.updateEdge(src, 'a', 1, { implemented: false });
    expectSameComments(src, text);
    expect(text).toContain('  # about b\n  - b:');
    expect(parseTree(text).edges[1]).toMatchObject({ source: 'b', backwards: true, implemented: false });
  });

  it('keeps a comment line between the id and its flags', () => {
    const src = one('  - b:\n    # sent back by review\n    backwards: true\n');
    const text = edit.updateEdge(src, 'a', 0, { implemented: false });
    expectSameComments(src, text);
    expect(edgeOf(text)).toMatchObject({ backwards: true, implemented: false });
  });

  it('ignores flags that are not booleans and empty nested labels, like the parser', () => {
    const src = one("  - b: {label: '', backwards: [x]}\n");
    const text = edit.updateEdge(src, 'a', 0, { ungrouped: true });
    expect(text).toBe(one('  - b:\n    ungrouped: true\n'));
  });

  it('updates an entry inside a flow list', () => {
    const text = edit.updateEdge('attacks:\n- a: A\n  from: [reality, b]\n- b: B\n', 'a', 1, { implemented: false });
    expect(parseTree(text).diagnostics).toEqual([]);
    expect(parseTree(text).edges[1]).toMatchObject({ source: 'b', implemented: false });
  });

  it('refuses a connection that no longer exists', () => {
    const err = new MutationError('That connection no longer exists');
    expect(() => edit.updateEdge(one('  - b\n'), 'a', 1, { implemented: false })).toThrow(err);
    expect(() => edit.updateEdge(one('  - b\n'), 'a', -1, { implemented: false })).toThrow(err);
    expect(() => edit.updateEdge(one('  - ~\n'), 'a', 0, { implemented: false })).toThrow(err);
    expect(() => edit.updateEdge(one('  - {}\n'), 'a', 0, { implemented: false })).toThrow(err);
    expect(() => edit.updateEdge(one('  - [b]\n'), 'a', 0, { implemented: false })).toThrow(err);
    expect(() => edit.updateEdge('attacks:\n- a: A\n', 'a', 0, { implemented: false })).toThrow(err);
  });
});

describe('removeNodes', () => {
  it('removes the declaration and every reference: from lists, filter and positions', () => {
    const src = `${SMALL}filter:\n- login\n- mfa\npositions:\n  login: [ 1, 2 ]\n  win: [ 3, 4 ]\n`;
    const text = edit.removeNodes(src, ['login']);
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes.map((n) => n.id)).not.toContain('login');
    expect(tree.edges.some((e) => e.source === 'login' || e.target === 'login')).toBe(false);
    expect(tree.filter).toEqual(['mfa']);
    expect(tree.positions).toEqual({ win: { x: 3, y: 4 } });
    // mfa only came from login: its "from" is gone, not left empty
    expect(text).toContain('- mfa: MFA\n\ngoals:');
    expectSameComments(src, text);
  });

  it('removes several nodes at once, in any section', () => {
    const text = edit.removeNodes(SMALL, ['leak', 'win', 'mfa']);
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes.map((n) => n.id).sort()).toEqual(['brute', 'login', 'reality']);
  });

  it('removing the last node of a section leaves a valid empty section', () => {
    const text = edit.removeNodes(SMALL, ['mfa']);
    expect(text).toContain('mitigations: []');
    expect(parseTree(text).diagnostics).toEqual([]);
  });

  it('emptying a list that has comments keeps valid YAML and the comments in place', () => {
    const src = 'attacks:\n# phase 1\n- a: A\n\ngoals:\n- g: G\n  from:\n  - a\nfilter:\n# shown\n- a\n';
    const text = edit.removeNodes(src, ['a']);
    expect(text).toBe('attacks:\n  # phase 1\n  []\n\ngoals:\n- g: G\nfilter:\n  # shown\n  []\n');
    expect(parseTree(text)).toMatchObject({ syntaxError: false, diagnostics: [] });
    expect(edit.removeNodes('# top\nfacts:\n# c\n- f: F\n', ['f'])).toBe('# top\nfacts:\n  # c\n  []\n');
    expect(edit.removeNodes('facts:\n  # c\n  - f: F\n', ['f'])).toBe('facts:\n  # c\n  []\n');
  });

  it('leaves empty lists the user wrote alone', () => {
    const src = 'facts: [] # nothing yet\nattacks:\n- a: A\n';
    expect(edit.setLabel(src, 'a', 'B')).toBe('facts: [] # nothing yet\nattacks:\n- a: B\n');
  });

  it('drops positions when the last one goes', () => {
    const text = edit.removeNodes(edit.setPositions(SMALL, { mfa: { x: 1, y: 1 } }), ['mfa']);
    expect(text).not.toContain('positions');
    expect(text).not.toContain('Where nodes were dragged');
  });

  it('removes references to ghosts, which makes the ghost disappear', () => {
    const src = 'attacks:\n- a: A\n  from:\n  - reality\n  - ghost\nfilter: [ghost]\n';
    const text = edit.removeNodes(src, ['ghost']);
    expect(text).toBe('attacks:\n- a: A\n  from:\n  - reality\nfilter: []\n');
    expect(parseTree(text).nodes.map((n) => n.id)).toEqual(['reality', 'a']);
  });

  it('never removes reality, and does nothing for an empty list', () => {
    expect(edit.removeNodes(SMALL, ['reality'])).toBe(SMALL);
    expect(edit.removeNodes(SMALL, [])).toBe(SMALL);
    expect(edit.removeNodes('not: [valid', [])).toBe('not: [valid');
  });

  it('ignores ids that are nowhere in the tree', () => {
    expect(meaning(parseTree(edit.removeNodes(SMALL, ['nope'])))).toEqual(meaning(parseTree(SMALL)));
  });

  it('keeps entries without an id while removing others', () => {
    const src = 'attacks:\n- a: A\n  from:\n  - ~\n  - {}\n  - b\n- b: B\nfilter:\n- ~\n- b\npositions:\n  : [1, 2]\n  b: [3, 4]\n';
    const text = edit.removeNodes(src, ['b']);
    expect(text).toBe('attacks:\n- a: A\n  from:\n  - ~\n  - {}\nfilter:\n- ~\npositions:\n  : [ 1, 2 ]\n');
    expect(edit.clearPositions(src, ['b'])).toBe(src.replace('  : [1, 2]\n  b: [3, 4]\n', '  : [ 1, 2 ]\n'));
  });

  it('removes a node from a flow list and filter', () => {
    const text = edit.removeNodes('attacks: [{a: A}, {b: B, from: [a, reality]}]\nfilter: [a, b]\n', ['a']);
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes.map((n) => n.id)).toEqual(['reality', 'b']);
    expect(tree.filter).toEqual(['b']);
  });

  it('is idempotent', () => {
    const once = edit.removeNodes(SMALL, ['login']);
    expect(edit.removeNodes(once, ['login'])).toBe(once);
  });
});

describe('setLabel', () => {
  it('replaces the label and nothing else', () => {
    const text = edit.setLabel(SMALL, 'login', 'Credential stuffing');
    expect(text).toBe(SMALL.replace('- login: Log in with leaked creds', '- login: Credential stuffing'));
  });

  it('labels a node that had no label', () => {
    expect(edit.setLabel(SMALL, 'brute', 'Brute force')).toBe(SMALL.replace('- brute:\n', '- brute: Brute force\n'));
  });

  it('keeps the comment after the label', () => {
    expect(edit.setLabel('attacks:\n- a: A # note\n', 'a', 'B')).toBe('attacks:\n- a: B # note\n');
    expect(edit.setLabel(SMALL, 'leak', 'Keys in a gist')).toContain('- leak: Keys in a gist # where it started\n');
  });

  it('writes multi-line labels as a block and reads them back', () => {
    const text = edit.setLabel('attacks:\n- a: A\n', 'a', 'line1\nline2');
    expect(text).toBe('attacks:\n- a: |-\n    line1\n    line2\n');
    expect(parseTree(text).nodes[0].label).toBe('line1\nline2');
  });

  it('an empty label falls back to the one derived from the id', () => {
    const text = edit.setLabel('attacks:\n- phish_admin: A\n', 'phish_admin', '');
    expect(parseTree(text).nodes[0].label).toBe('Phish admin');
    expect(parseTree(text).diagnostics).toEqual([]);
  });

  it.each(['#yolosec', 'a: b', '- x', 'null', '123', "it's", '"q"', 'x # y', 'Ação ✓', ' lead', 'tab\t', '&a', '*a'])(
    'round-trips %j',
    (label) => {
      const text = edit.setLabel(SMALL, 'login', label);
      expect(parseTree(text).nodes.find((n) => n.id === 'login')!.label).toBe(label);
      expect(parseTree(text).diagnostics).toEqual([]);
      expectSameComments(SMALL, text);
    },
  );
});

describe('setKind', () => {
  it('moves the node, with its connections, to the end of the other section', () => {
    const text = edit.setKind(SMALL, 'login', 'goal');
    expect(text).toContain('- win: Attacker wins\n  from:\n  - login\n  - brute\n- login: Log in with leaked creds\n  from:\n  - leak\n');
    const before = meaning(parseTree(SMALL));
    const after = meaning(parseTree(text));
    expect(after.edges).toEqual(before.edges);
    expect(after.nodes).toEqual(before.nodes.map((n) => (n.id === 'login' ? { ...n, kind: 'goal' } : n)));
  });

  it('does nothing when the kind is the same', () => {
    expect(edit.setKind(SMALL, 'login', 'attack')).toBe(SMALL);
  });

  it('creates the section when it does not exist yet', () => {
    const text = edit.setKind('title: T\n\nattacks:\n- a: A\n- b: B\n\ngoals:\n- g: G\n', 'a', 'mitigation');
    expect(text).toBe('title: T\n\nattacks:\n- b: B\n\nmitigations:\n- a: A\n\ngoals:\n- g: G\n');
  });

  it('moving the last node out leaves a valid empty section', () => {
    const text = edit.setKind(SMALL, 'mfa', 'fact');
    expect(text).toContain('mitigations: []');
    expect(parseTree(text).diagnostics).toEqual([]);
    expect(parseTree(text).nodes.find((n) => n.id === 'mfa')!.kind).toBe('fact');
  });

  it('moving the last node out of a commented section keeps valid YAML', () => {
    const text = edit.setKind('facts: # facts\n- f: F\n', 'f', 'goal');
    expect(text).toBe('facts:\n  # facts\n  []\n\ngoals:\n- f: F\n');
    expect(parseTree(text)).toMatchObject({ syntaxError: false, diagnostics: [] });
  });

  it('keeps the comment of the node it moves', () => {
    const text = edit.setKind(SMALL, 'leak', 'attack');
    expectSameComments(SMALL, text);
    expect(text).toContain('- leak: Credentials in a public gist # where it started\n');
  });

  it.each(KINDS)('works for every kind (%s)', (kind) => {
    const text = edit.setKind(SMALL, 'brute', kind);
    expect(parseTree(text).nodes.find((n) => n.id === 'brute')!.kind).toBe(kind);
    expect(parseTree(text).diagnostics).toEqual([]);
  });
});

describe('validateId', () => {
  it('accepts the same id, and fresh ids made of letters, digits, "_" and "-"', () => {
    expect(edit.validateId(SMALL, 'login', 'login')).toBeNull();
    for (const id of ['stuffing', 'a', 'A1', 'x-y', 'x_y', 'phish-2fa_v2']) expect(edit.validateId(SMALL, 'login', id)).toBeNull();
  });

  it.each(['', ' a', 'a b', '1a', '-a', 'a.b', 'ação', 'a:b', 'a#', '#a', 'a\n'])('rejects %j', (id) => {
    expect(edit.validateId(SMALL, 'login', id)).toBe('Use letters, digits, "_" or "-", starting with a letter or "_"');
  });

  it.each(['leak', 'mfa', 'reality', 'from', 'backwards', 'implemented', 'ungrouped'])('rejects %j because it is taken', (id) => {
    expect(edit.validateId(SMALL, 'login', id)).toBe(`"${id}" is already taken`);
  });

  it('works on documents with YAML errors without throwing', () => {
    expect(edit.validateId('attacks:\n- a: A\n- b: [x\n', 'a', 'a2')).toBeNull();
  });

  it('works on empty and non-mapping documents without throwing', () => {
    for (const text of ['', '- a\n', '42\n', '- [\n']) {
      expect(edit.validateId(text, 'a', 'b')).toBeNull();
      expect(edit.validateId(text, 'a', 'reality')).toBe('"reality" is already taken');
      expect(edit.validateId(text, 'a', 'from')).toBe('"from" is already taken');
    }
  });
});

describe('renameId', () => {
  it('renames the declaration and every reference, keeping comments', () => {
    const src = `${SMALL}filter:\n- login\npositions:\n  login: [ 1, 2 ]\n`;
    const text = edit.renameId(src, 'login', 'stuffing');
    expect(text).toBe(src.replace(/\blogin\b/g, 'stuffing'));
    expectSameComments(src, text);
  });

  it('renames sources written as maps, flat or nested', () => {
    const src = "attacks:\n- a: A\n  from:\n  - b: '#yolosec'\n  - c: x\n- d: D\n  from:\n  - b:\n      backwards: true\n- b: B\n- c: C\n";
    const text = edit.renameId(src, 'b', 'bee');
    expect(text).toBe(src.replace(/\bb\b/g, 'bee'));
    expect(parseTree(text).diagnostics).toEqual([]);
  });

  it('renames in flow lists', () => {
    const src = 'attacks:\n- a: A\n  from: [b, reality]\n- b: B\nfilter: [b]\npositions: {b: [1, 2]}\n';
    const text = edit.renameId(src, 'b', 'bee');
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges.map((e) => e.source)).toEqual(['bee', 'reality']);
    expect(tree.filter).toEqual(['bee']);
    expect(tree.positions).toEqual({ bee: { x: 1, y: 2 } });
  });

  it('keeps the meaning of the tree, with the id substituted', () => {
    for (const src of [SMALL, EXAMPLE_CICD]) {
      const tree = parseTree(src);
      for (const n of tree.nodes.filter((x) => x.declared && x.kind !== 'reality')) {
        const next = `${n.id}-renamed`;
        const text = edit.renameId(src, n.id, next);
        const swap = (id: string) => (id === n.id ? next : id);
        const expected = meaning(tree);
        // a label derived from the id follows the id
        const derived = (x: { id: string; label: string }) => x.id === n.id && x.label === defaultLabel(n.id);
        expected.nodes = expected.nodes
          .map((x) => ({ ...x, id: swap(x.id), label: derived(x) ? defaultLabel(next) : x.label }))
          .sort((a, b) => a.id.localeCompare(b.id));
        expected.edges = expected.edges
          .map((e) => ({ ...e, source: swap(e.source), target: swap(e.target) }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        expect(meaning(parseTree(text))).toEqual(expected);
        expect(parseTree(text).diagnostics).toEqual([]);
      }
    }
  });

  it('a node without a label keeps the derived label of its old id', () => {
    const text = edit.renameId(SMALL, 'brute', 'guess');
    // the label is derived from the id, so it follows the rename
    expect(parseTree(text).nodes.find((n) => n.id === 'guess')!.label).toBe('Guess');
  });

  it('quotes ids that YAML would read as something else', () => {
    for (const id of ['null', 'true', 'False', 'NaN', 'inf']) {
      const text = edit.renameId('attacks:\n- a: A\ngoals:\n- g: G\n  from:\n  - a\n', 'a', id);
      const tree = parseTree(text);
      expect(tree.diagnostics).toEqual([]);
      expect(tree.edges.map((e) => e.source)).toEqual([id]);
    }
  });

  it('does nothing when the id is the same', () => {
    expect(edit.renameId(SMALL, 'login', 'login')).toBe(SMALL);
  });

  it('refuses invalid and taken ids', () => {
    expect(() => edit.renameId(SMALL, 'login', '1x')).toThrow(new MutationError('Use letters, digits, "_" or "-", starting with a letter or "_"'));
    expect(() => edit.renameId(SMALL, 'login', 'mfa')).toThrow(new MutationError('"mfa" is already taken'));
  });

  it('taking the id of a ghost that has a position keeps the node\'s own position, without a duplicate key', () => {
    const src = 'attacks:\n- a: A\n- x: X\n  from:\n  - a\n  - b\npositions:\n  a: [ 1, 2 ]\n  b: [ 3, 4 ]\n';
    const text = edit.renameId(src, 'a', 'b');
    const tree = parseTree(text);
    expect(tree.syntaxError).toBe(false);
    expect(tree.positions).toEqual({ b: { x: 1, y: 2 } });
    // without a position of its own, the node takes the one that was there
    const inherited = parseTree(edit.renameId(src.replace('  a: [ 1, 2 ]\n', ''), 'a', 'b'));
    expect(inherited.positions).toEqual({ b: { x: 3, y: 4 } });
  });

  it('can take the id of a ghost, which then becomes declared', () => {
    const text = edit.renameId('attacks:\n- a: A\n  from:\n  - ghost\n- b: B\n', 'b', 'ghost');
    expect(parseTree(text).diagnostics).toEqual([]);
  });
});

describe('setPositions', () => {
  it('creates the positions section at the end, with its note, rounding to whole pixels', () => {
    const text = edit.setPositions(SMALL, { login: { x: 120.4, y: 80.6 } });
    expect(text).toBe(
      `${SMALL}\n# Where nodes were dragged on the canvas. Remove a line to lay that node out automatically again.\npositions:\n  login: [ 120, 81 ]\n`,
    );
    expect(parseTree(text).positions).toEqual({ login: { x: 120, y: 81 } });
  });

  it('updates existing entries in place and appends new ones', () => {
    let text = edit.setPositions(SMALL, { login: { x: 1, y: 2 }, mfa: { x: 3, y: 4 } });
    text = edit.setPositions(text, { mfa: { x: 30, y: 40 }, win: { x: 5, y: 6 } });
    expect(text.endsWith('positions:\n  login: [ 1, 2 ]\n  mfa: [ 30, 40 ]\n  win: [ 5, 6 ]\n')).toBe(true);
    expect(text.match(/Where nodes were dragged/g)).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = edit.setPositions(SMALL, { login: { x: 1, y: 2 } });
    expect(edit.setPositions(once, { login: { x: 1, y: 2 } })).toBe(once);
  });

  it('does nothing when nothing moved', () => {
    expect(edit.setPositions(SMALL, {})).toBe(SMALL);
  });

  it('keeps a comment on a position line', () => {
    const src = 'attacks:\n- a: A\npositions:\n  a: [ 1, 2 ] # for the demo\n';
    expect(edit.setPositions(src, { a: { x: 5, y: 6 } })).toBe('attacks:\n- a: A\npositions:\n  a: [ 5, 6 ] # for the demo\n');
  });

  it('writes negative positions and never "-0"', () => {
    const text = edit.setPositions('attacks:\n- a: A\n', { a: { x: -0.2, y: -10.6 } });
    expect(text).toContain('a: [ 0, -11 ]');
    expect(parseTree(text).positions.a).toEqual({ x: 0, y: -11 });
  });

  it('skips coordinates that are not finite numbers instead of writing an invalid position', () => {
    const src = 'attacks:\n- a: A\n- b: B\n';
    expect(edit.setPositions(src, { a: { x: Number.NaN, y: 1 }, b: { x: 1, y: Number.POSITIVE_INFINITY } })).toBe(src);
    const text = edit.setPositions(src, { a: { x: Number.NaN, y: 1 }, b: { x: 1, y: 2 } });
    expect(parseTree(text)).toMatchObject({ positions: { b: { x: 1, y: 2 } }, diagnostics: [] });
  });

  it('turns a flow map into a block map', () => {
    const text = edit.setPositions('attacks:\n- a: A\npositions: {a: [0, 0]}\n', { a: { x: 1, y: 2 } });
    expect(text).toBe('attacks:\n- a: A\npositions:\n  a: [ 1, 2 ]\n');
  });

  it('replaces an empty or malformed positions section', () => {
    for (const bad of ['positions:\n', 'positions: [1]\n', 'positions: x\n']) {
      const text = edit.setPositions(`attacks:\n- a: A\n${bad}`, { a: { x: 1, y: 2 } });
      expect(parseTree(text)).toMatchObject({ positions: { a: { x: 1, y: 2 } }, diagnostics: [] });
      expect(text.match(/positions/g)).toHaveLength(1);
    }
  });

  it('starts an empty document without a leading blank line', () => {
    const text = edit.setPositions('', { a: { x: 1, y: 2 } });
    expect(text).toBe('# Where nodes were dragged on the canvas. Remove a line to lay that node out automatically again.\npositions:\n  a: [ 1, 2 ]\n');
  });
});

describe('clearPositions', () => {
  const placed = edit.setPositions(SMALL, { login: { x: 1, y: 2 }, mfa: { x: 3, y: 4 } });

  it('forgets all positions, with the note', () => {
    expect(edit.clearPositions(placed)).toBe(SMALL);
  });

  it('forgets the given ids only', () => {
    const text = edit.clearPositions(placed, ['mfa']);
    expect(parseTree(text).positions).toEqual({ login: { x: 1, y: 2 } });
    expect(edit.clearPositions(text, ['login'])).toBe(SMALL);
  });

  it('does nothing without positions', () => {
    expect(edit.clearPositions(SMALL)).toBe(SMALL);
    expect(edit.clearPositions(SMALL, ['login'])).toBe(SMALL);
  });

  it('keeps everything for ids that have no position', () => {
    expect(edit.clearPositions(placed, ['win'])).toBe(placed);
    expect(edit.clearPositions(placed, [])).toBe(placed);
  });
});

describe('style detection', () => {
  it('keeps flush lists when the first section key has a comment', () => {
    const src = 'facts: # true things\n- a: A\n  from:\n  - reality\n';
    const { text } = edit.addNode(src, { kind: 'fact', label: 'B', from: ['a'] });
    expect(text).toContain('- a: A\n  from:\n  - reality\n- b: B\n  from:\n  - a\n');
    expectSameComments(src, text);
  });

  it('keeps flush lists when comments or blank lines come before the first item', () => {
    const src = 'facts:\n\n# the facts\n- a: A\n  from:\n  - reality\n';
    const { text } = edit.addNode(src, { kind: 'fact', label: 'B' });
    expect(text).toBe(`${src}- b: B\n`);
  });

  it('keeps indented lists when comments come before the first item', () => {
    const src = 'facts:\n  # the facts\n  - a: A\n    from:\n      - reality\n';
    const { text } = edit.addNode(src, { kind: 'fact', label: 'B' });
    expect(text).toBe(`${src}  - b: B\n`);
  });

  it('reads CRLF documents and keeps their list style', () => {
    const src = SMALL.replace(/\n/g, '\r\n');
    const { text } = edit.addNode(src, { kind: 'goal', label: 'Another' });
    expect(text).toBe(`${SMALL}- another: Another\n`);
  });

  it('defaults to indented lists when nothing shows a style', () => {
    expect(edit.addNode('title: T\n', { kind: 'goal', label: 'G', from: ['reality'] }).text).toBe(
      'title: T\n\ngoals:\n  - g: G\n    from:\n      - reality\n',
    );
  });

  it('keeps other formatting: quotes, flow lists, long lines', () => {
    const long = 'x'.repeat(200);
    const src = `title: "Double quoted"\nattacks:\n- a: ${long}\n  from: [ reality ]\n- b: 'single'\n`;
    const text = edit.setLabel(src, 'b', 'other');
    expect(text).toBe(src.replace("'single'", 'other'));
  });
});

// ---------------------------------------------------------------------------------
// Properties over a corpus: every edit re-parses, adds no diagnostics, keeps comments
// and changes only what it was asked to.

describe('every edit keeps the document valid and its comments', async () => {
  const { default: guide } = await import('../docs/guide.md?raw');
  const examples = [...guide.matchAll(/```yaml example\n([\s\S]*?)```/g)].map((m) => m[1]);
  const corpus: Array<[string, string]> = [
    ['SMALL', SMALL],
    ['INDENTED', INDENTED],
    ['EXAMPLE_CICD', EXAMPLE_CICD],
    ['BLANK_TREE', BLANK_TREE],
    ['CRLF', SMALL.replace(/\n/g, '\r\n')],
    ['commented', `# header\n\ntitle: T # the title\n\nfacts: # facts\n# first\n- f: F # f\n  from: # parents\n  - reality # root\n\n# about attacks\nattacks:\n- a: A\n  from:\n  - f: '#yolosec' # open\n  - m:\n    backwards: true # back\n\nmitigations:\n- m: M\n  from:\n  - a\n# trailing\n`],
    ...examples.map((e, i): [string, string] => [`guide example ${i + 1}`, e]),
  ];

  const check = (before: string, after: string, keepComments = true) => {
    const tree = parseTree(after);
    expect(tree.syntaxError).toBe(false);
    // no diagnostic that was not there before
    const old = messages(before);
    for (const m of messages(after)) expect(old).toContain(m);
    if (keepComments) for (const c of comments(before)) expect(comments(after)).toContain(c);
    return tree;
  };

  describe.each(corpus)('%s', (_, src) => {
    const tree = parseTree(src);
    const declared = tree.nodes.filter((n) => n.declared && n.kind !== 'reality');
    const before = meaning(tree);

    it('parses cleanly to begin with', () => {
      expect(tree.diagnostics).toEqual([]);
    });

    it('addNode', () => {
      for (const kind of KINDS) {
        const { text, id } = edit.addNode(src, { kind, label: 'Brand new step', from: [declared[0].id] });
        const after = meaning(check(src, text));
        expect(after.nodes).toContainEqual({ id, kind, label: 'Brand new step', declared: true });
        expect(after.nodes.filter((n) => n.id !== id)).toEqual(before.nodes);
        expect(after.edges.filter((e) => e.target !== id)).toEqual(before.edges);
      }
    });

    it('connect', () => {
      const some = declared.slice(0, 6);
      for (const s of some) {
        for (const t of some) {
          if (s === t) continue;
          for (const backwards of [false, true]) {
            const text = edit.connect(src, s.id, t.id, backwards);
            const after = meaning(check(src, text));
            const edge = { source: s.id, target: t.id, label: undefined, backwards, implemented: true, ungrouped: false };
            const existed = tree.edges.some((e) => e.source === s.id && e.target === t.id && e.backwards === backwards);
            if (existed) expect(text).toBe(src);
            else expect(after.edges).toEqual([...before.edges, edge].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
          }
        }
      }
    });

    it('removeEdge', () => {
      for (const e of tree.edges) {
        const text = edit.removeEdge(src, e.target, e.fromIndex);
        const after = meaning(check(src, text, false));
        const gone = before.edges.findIndex((x) => x.source === e.source && x.target === e.target && x.backwards === e.backwards);
        expect(after.edges).toEqual(before.edges.filter((_x, i) => i !== gone));
      }
    });

    it('updateEdge', () => {
      for (const e of tree.edges) {
        const patches = [{ implemented: !e.implemented }, { backwards: !e.backwards }, { label: e.label ? '' : '#yolosec' }, { ungrouped: true }];
        for (const patch of patches) {
          const text = edit.updateEdge(src, e.target, e.fromIndex, patch);
          const t = check(src, text);
          const updated = t.edges.find((x) => x.id === e.id);
          if (patch.backwards !== undefined && tree.edges.some((x) => x !== e && x.source === e.source && x.target === e.target && x.backwards === patch.backwards)) {
            continue; // flipping into an existing connection makes it a duplicate
          }
          const expected = { ...e, ...patch, label: patch.label === '' ? undefined : (patch.label ?? e.label) };
          expect(updated).toMatchObject({ source: e.source, target: e.target, label: expected.label, backwards: expected.backwards, implemented: expected.implemented, ungrouped: expected.ungrouped });
          const others = (x: Tree) => x.edges.filter((y) => y.id !== e.id).map(({ range: _r, sourceRange: _s, ...rest }) => rest);
          expect(others(t)).toEqual(others(tree));
        }
      }
    });

    it('removeNodes', () => {
      for (const n of declared) {
        const text = edit.removeNodes(src, [n.id]);
        const t = check(src, text, false);
        expect(t.nodes.some((x) => x.id === n.id)).toBe(false);
        expect(t.filter).not.toContain(n.id);
        expect(t.positions).not.toHaveProperty(n.id);
        const kept = before.edges.filter((e) => e.source !== n.id && e.target !== n.id);
        expect(meaning(t).edges).toEqual(kept);
        expect(meaning(t).nodes.filter((x) => x.declared)).toEqual(before.nodes.filter((x) => x.declared && x.id !== n.id));
      }
    });

    it('setLabel', () => {
      for (const n of declared) {
        const text = edit.setLabel(src, n.id, `${n.label} (edited) #1: ok`);
        const after = meaning(check(src, text));
        expect(after.nodes).toEqual(before.nodes.map((x) => (x.id === n.id ? { ...x, label: `${n.label} (edited) #1: ok` } : x)));
        expect(after.edges).toEqual(before.edges);
      }
    });

    it('setKind', () => {
      for (const n of declared) {
        for (const kind of KINDS) {
          const text = edit.setKind(src, n.id, kind);
          const after = meaning(check(src, text));
          expect(after.nodes).toEqual(before.nodes.map((x) => (x.id === n.id ? { ...x, kind } : x)));
          expect(after.edges).toEqual(before.edges);
        }
      }
    });

    it('renameId', () => {
      for (const n of declared) {
        const text = edit.renameId(src, n.id, `${n.id}_v2`);
        const after = meaning(check(src, text));
        expect(after.nodes.map((x) => x.id)).toContain(`${n.id}_v2`);
        expect(after.edges).toHaveLength(before.edges.length);
      }
    });

    it('setPositions and clearPositions', () => {
      const moved = Object.fromEntries(declared.map((n, i) => [n.id, { x: i * 10.4, y: -i * 3.6 }]));
      const text = edit.setPositions(src, moved);
      const t = check(src, text);
      expect(Object.keys(t.positions)).toEqual(declared.map((n) => n.id));
      expect({ ...meaning(t), positions: {} }).toEqual(before);
      const cleared = edit.clearPositions(text);
      expect(meaning(check(src, cleared))).toEqual(before);
    });
  });
});
