import { describe, expect, it } from 'vitest';
import { defaultLabel, parseTree } from './parse';
import { isGhost, type Tree } from './types';

/** diagnostics with the text they point at, which is easier to read than offsets */
function diags(text: string) {
  return parseTree(text).diagnostics.map((d) => ({ severity: d.severity, message: d.message, at: text.slice(d.from, d.to) }));
}

const node = (tree: Tree, id: string) => tree.nodes.find((n) => n.id === id);

describe('defaultLabel', () => {
  it.each([
    ['phish_admin', 'Phish admin'],
    ['a_b_c', 'A b c'],
    ['Already', 'Already'],
    ['x-y', 'X-y'],
    ['9lives', '9lives'],
    ['_lead', ' lead'],
    ['', ''],
  ])('%j -> %j', (id, label) => {
    expect(defaultLabel(id)).toBe(label);
  });
});

describe('parseTree: document shape', () => {
  it('an empty document is an empty tree without diagnostics', () => {
    expect(parseTree('')).toEqual({
      title: '',
      theme: undefined,
      nodes: [],
      edges: [],
      filter: [],
      filterRefs: [],
      positions: {},
      diagnostics: [],
      syntaxError: false,
    });
  });

  it('a document with only comments is an empty tree', () => {
    const tree = parseTree('# nothing here yet\n\n# still nothing\n');
    expect(tree.nodes).toEqual([]);
    expect(tree.diagnostics).toEqual([]);
  });

  it.each([
    ['42\n', '42'],
    ['- a\n- b\n', '- a\n- b\n'],
    ['just text\n', 'just text'],
  ])('rejects a non-mapping document %j', (text, at) => {
    expect(diags(text)).toEqual([
      { severity: 'error', message: 'The document must be a mapping (title, facts, attacks, mitigations, goals)', at },
    ]);
    expect(parseTree(text).nodes).toEqual([]);
  });

  it('reads title and theme, and accepts legend and dark silently', () => {
    const tree = parseTree('title: My tree\ntheme: dark\nlegend: true\ndark: false\n');
    expect(tree.title).toBe('My tree');
    expect(tree.theme).toBe('dark');
    expect(tree.diagnostics).toEqual([]);
  });

  it('turns scalar titles into text and leaves an empty title empty', () => {
    expect(parseTree('title: 2024\n').title).toBe('2024');
    expect(parseTree('title: true\n').title).toBe('true');
    expect(parseTree('title:\n')).toMatchObject({ title: '', diagnostics: [] });
  });

  it('rejects a title that is not text', () => {
    expect(diags('title: [a]\n')).toEqual([{ severity: 'error', message: 'The title must be text', at: '[a]' }]);
    expect(parseTree('title: [a]\n').title).toBe('');
  });

  it('ignores a theme that is not text', () => {
    expect(parseTree('theme: [x]\n')).toMatchObject({ theme: undefined, diagnostics: [] });
  });

  it('warns about unknown top-level keys and skips keys that are not text', () => {
    expect(diags('title: T\nbogus: 1\nfilter2: [a]\n~: x\n')).toEqual([
      { severity: 'warning', message: 'Unknown section "bogus"', at: 'bogus' },
      { severity: 'warning', message: 'Unknown section "filter2"', at: 'filter2' },
    ]);
  });

  it.each(['facts', 'attacks', 'mitigations', 'goals'])('"%s" must be a list', (key) => {
    expect(diags(`${key}: x\n`)).toEqual([{ severity: 'error', message: `"${key}" must be a list`, at: 'x' }]);
    expect(diags(`${key}: {}\n`)).toEqual([{ severity: 'error', message: `"${key}" must be a list`, at: '{}' }]);
  });

  // The JSON schema allows null sections and the parser means to skip them ("if (value == null) break").
  it.each(['facts:\n', 'attacks:\n', 'mitigations:\n', 'goals:\n', 'facts: ~\n', 'facts: null\n', 'facts: []\n'])(
    'accepts an empty section %j',
    (text) => {
      expect(parseTree(text)).toMatchObject({ nodes: [], diagnostics: [] });
    },
  );

  it('accepts empty sections around real ones', () => {
    const tree = parseTree('title: T\nfacts:\nattacks:\n- a: A\nmitigations:\ngoals:\nfilter:\npositions:\n');
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes.map((n) => n.id)).toEqual(['a']);
  });
});

describe('parseTree: nodes', () => {
  const text = 'facts:\n- f: F\nattacks:\n- a: A\nmitigations:\n- m: M\ngoals:\n- g: G\n';

  it('gives each section its kind and keeps declaration order', () => {
    const tree = parseTree(text);
    expect(tree.nodes.map((n) => [n.id, n.kind, n.label, n.declared])).toEqual([
      ['f', 'fact', 'F', true],
      ['a', 'attack', 'A', true],
      ['m', 'mitigation', 'M', true],
      ['g', 'goal', 'G', true],
    ]);
    expect(tree.diagnostics).toEqual([]);
  });

  it('tags each node with the range of its item and of its id', () => {
    const src = 'attacks:\n- phish: Phish\n  from:\n  - reality\n- b: B\n';
    const tree = parseTree(src);
    const phish = node(tree, 'phish')!;
    expect(src.slice(phish.keyRange!.from, phish.keyRange!.to)).toBe('phish');
    expect(src.slice(phish.range!.from, phish.range!.to)).toBe('phish: Phish\n  from:\n  - reality\n');
    const b = node(tree, 'b')!;
    expect(src.slice(b.range!.from, b.range!.to)).toBe('b: B\n');
  });

  it('puts reality first, whether implicit or declared', () => {
    expect(parseTree('attacks:\n- a: A\n  from:\n  - reality\n').nodes.map((n) => n.id)).toEqual(['reality', 'a']);
    const declared = parseTree('attacks:\n- a: A\nfacts:\n- reality: The world\n');
    expect(declared.nodes.map((n) => [n.id, n.kind, n.label, n.declared])).toEqual([
      ['reality', 'reality', 'The world', true],
      ['a', 'attack', 'A', true],
    ]);
  });

  it('a declared reality without a label is called Reality', () => {
    expect(node(parseTree('facts:\n- reality:\n'), 'reality')!.label).toBe('Reality');
  });

  it('derives empty and blank labels from the id', () => {
    const tree = parseTree("attacks:\n- phish_admin:\n- b_c: ''\n- d_e: '   '\n- f: ~\n");
    expect(tree.nodes.map((n) => n.label)).toEqual(['Phish admin', 'B c', 'D e', 'F']);
    expect(tree.diagnostics).toEqual([]);
  });

  it('keeps labels exactly, including numbers, unicode and line breaks', () => {
    const tree = parseTree(
      "attacks:\n- a: 42\n- b: true\n- c: Ataque à cadeia ✓ 🔥\n- d: |\n    line one\n    line two\n- e: '  padded  '\n- f: \"#yolosec\"\n",
    );
    expect(tree.nodes.map((n) => n.label)).toEqual([
      '42',
      'true',
      'Ataque à cadeia ✓ 🔥',
      'line one\nline two\n',
      '  padded  ',
      '#yolosec',
    ]);
  });

  it('accepts ids with dashes, digits and unicode', () => {
    const tree = parseTree('attacks:\n- my-node_2: X\n- 42: Y\n- ação: Z\ngoals:\n- g: G\n  from:\n  - my-node_2\n  - 42\n  - ação\n');
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges.map((e) => e.source)).toEqual(['my-node_2', '42', 'ação']);
  });

  it('warns about labels that are not plain text and derives them from the id', () => {
    const src = 'attacks:\n- big_one: [x]\n';
    expect(diags(src)).toEqual([{ severity: 'warning', message: 'Node labels should be plain text', at: '[x]' }]);
    expect(node(parseTree(src), 'big_one')!.label).toBe('Big one');
  });

  it.each([
    ['attacks:\n- {}\n', '{}'],
    ['attacks:\n- plain\n', 'plain'],
    ['attacks:\n- [x]\n', '[x]'],
    ['attacks:\n-\n', '\n'],
  ])('items that are not "- id: label" maps are errors: %j', (src, at) => {
    expect(diags(src)).toEqual([{ severity: 'error', message: 'Each node is written as "- id: label"', at }]);
  });

  it('an item without an id is an error', () => {
    expect(diags('attacks:\n- : x\n')).toEqual([{ severity: 'error', message: 'Missing node id', at: ':' }]);
    expect(diags("attacks:\n- '': x\n")).toEqual([{ severity: 'error', message: 'Missing node id', at: "''" }]);
    expect(diags('attacks:\n- [a]: x\n')).toEqual([{ severity: 'error', message: 'Missing node id', at: '[a]' }]);
  });

  it('a node whose first key is "from" is an error', () => {
    expect(diags('attacks:\n- from: A\n')).toEqual([
      { severity: 'error', message: 'The first key of a node is its id; "from" goes after it', at: 'from' },
    ]);
    expect(parseTree('attacks:\n- from: A\n').nodes).toEqual([]);
  });

  it.each([
    ['facts', 'a fact'],
    ['attacks', 'an attack'],
    ['mitigations', 'a mitigation'],
    ['goals', 'a goal'],
  ])('a node declared twice is an error, even across sections (%s)', (section, article) => {
    const other = section === 'goals' ? 'facts' : 'goals';
    const src = `${section}:\n- x: first\n${other}:\n- x: second\n  from:\n  - reality\n`;
    expect(diags(src)).toEqual([{ severity: 'error', message: `"x" is already declared as ${article}`, at: 'x' }]);
    const tree = parseTree(src);
    // the first declaration wins, and the duplicate's connections are ignored
    expect(tree.nodes.filter((n) => n.id === 'x')).toHaveLength(1);
    expect(node(tree, 'x')!.label).toBe('first');
    expect(tree.edges).toEqual([]);
  });

  it('a duplicate of a declared reality says "a reality"', () => {
    expect(diags('facts:\n- reality: R\n- reality: R2\n')).toEqual([
      { severity: 'error', message: '"reality" is already declared as a reality', at: 'reality' },
    ]);
  });

  it('warns about unknown node properties', () => {
    expect(diags('attacks:\n- a: A\n  color: red\n  form:\n  - reality\n')).toEqual([
      { severity: 'warning', message: 'Unknown node property "color"', at: 'color' },
      { severity: 'warning', message: 'Unknown node property "form"', at: 'form' },
    ]);
  });

  it('reads flow-style sections and nodes', () => {
    const tree = parseTree("attacks: [{a: A, from: [reality, {b: '#yolosec'}]}, {b: B}]\n");
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes.map((n) => n.id)).toEqual(['reality', 'a', 'b']);
    expect(tree.edges.map((e) => [e.source, e.target, e.label])).toEqual([
      ['reality', 'a', undefined],
      ['b', 'a', '#yolosec'],
    ]);
  });
});

describe('parseTree: connections', () => {
  const wrap = (entries: string) => `attacks:\n- a: A\n  from:\n${entries}- b: B\n- c: C\n`;

  it('reads every documented entry form', () => {
    const tree = parseTree(
      wrap(
        "  - reality\n  - b: '#yolosec'\n  - c:\n    backwards: true\n  - d:\n    implemented: false\n  - e:\n    ungrouped: true\n",
      ).replace('- c: C\n', '- c: C\n- d: D\n- e: E\n'),
    );
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges.map(({ id, source, target, label, backwards, implemented, ungrouped, fromIndex }) => ({
      id,
      source,
      target,
      label,
      backwards,
      implemented,
      ungrouped,
      fromIndex,
    }))).toEqual([
      { id: 'a:0', source: 'reality', target: 'a', label: undefined, backwards: false, implemented: true, ungrouped: false, fromIndex: 0 },
      { id: 'a:1', source: 'b', target: 'a', label: '#yolosec', backwards: false, implemented: true, ungrouped: false, fromIndex: 1 },
      { id: 'a:2', source: 'c', target: 'a', label: undefined, backwards: true, implemented: true, ungrouped: false, fromIndex: 2 },
      { id: 'a:3', source: 'd', target: 'a', label: undefined, backwards: false, implemented: false, ungrouped: false, fromIndex: 3 },
      { id: 'a:4', source: 'e', target: 'a', label: undefined, backwards: false, implemented: true, ungrouped: true, fromIndex: 4 },
    ]);
  });

  it('tags edges with the range of the entry and of the source id', () => {
    const src = wrap("  - b: '#yolosec'\n");
    const [edge] = parseTree(src).edges;
    expect(src.slice(edge.range!.from, edge.range!.to)).toBe("b: '#yolosec'\n");
    expect(src.slice(edge.sourceRange!.from, edge.sourceRange!.to)).toBe('b');
  });

  it('accepts flags nested under the id, with a label among them', () => {
    const tree = parseTree(wrap('  - b: {backwards: true, implemented: false, ungrouped: true, label: 7}\n'));
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges[0]).toMatchObject({ source: 'b', label: '7', backwards: true, implemented: false, ungrouped: true });
  });

  it('combines nested flags with sibling flags; the sibling comes last and wins', () => {
    const tree = parseTree(wrap('  - b:\n      backwards: true\n    backwards: false\n    implemented: false\n'));
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges[0]).toMatchObject({ backwards: false, implemented: false });
  });

  it('ignores empty labels, nested or not', () => {
    const tree = parseTree(wrap("  - b: ''\n  - c: {label: '', backwards: true}\n"));
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges.map((e) => e.label)).toEqual([undefined, undefined]);
  });

  it('reads scalar labels as text', () => {
    expect(parseTree(wrap('  - b: 2024\n  - c: true\n')).edges.map((e) => e.label)).toEqual(['2024', 'true']);
  });

  it('only accepts "label" nested under the id; beside it, it is unknown', () => {
    const src = wrap('  - b:\n    label: x\n');
    expect(diags(src)).toEqual([{ severity: 'warning', message: 'Unknown edge property "label"', at: 'label' }]);
    expect(parseTree(src).edges[0].label).toBeUndefined();
  });

  it('warns about labels that are not plain text', () => {
    expect(diags(wrap('  - b: [x]\n  - c: {}\n'))).toEqual([
      { severity: 'warning', message: 'Edge labels should be plain text', at: '[x]' },
      { severity: 'warning', message: 'Edge labels should be plain text', at: '{}' },
    ]);
    // the edge is still there
    expect(parseTree(wrap('  - b: [x]\n')).edges).toHaveLength(1);
  });

  it.each(['backwards', 'implemented', 'ungrouped'])('"%s" must be true or false', (flag) => {
    const src = wrap(`  - b:\n    ${flag}: yes\n  - c: {${flag}: 1}\n`);
    expect(diags(src)).toEqual([
      { severity: 'error', message: `"${flag}" must be true or false`, at: 'yes' },
      { severity: 'error', message: `"${flag}" must be true or false`, at: '1' },
    ]);
    // invalid flags keep their defaults
    expect(parseTree(src).edges.map((e) => [e.backwards, e.implemented, e.ungrouped])).toEqual([
      [false, true, false],
      [false, true, false],
    ]);
  });

  it('points at the flag when it has no value at all', () => {
    expect(diags(wrap('  - b:\n    ? backwards\n'))).toEqual([
      { severity: 'error', message: '"backwards" must be true or false', at: 'backwards' },
    ]);
    // an empty value has no text of its own; underlining the line break would be invisible
    expect(diags(wrap('  - b:\n    implemented:\n  - c: {ungrouped: }\n'))).toEqual([
      { severity: 'error', message: '"implemented" must be true or false', at: 'implemented' },
      { severity: 'error', message: '"ungrouped" must be true or false', at: 'ungrouped' },
    ]);
  });

  it('warns about unknown edge properties, nested or not', () => {
    expect(diags(wrap('  - b:\n    color: red\n  - c: {weight: 3}\n'))).toEqual([
      { severity: 'warning', message: 'Unknown edge property "color"', at: 'color' },
      { severity: 'warning', message: 'Unknown edge property "weight"', at: 'weight' },
    ]);
  });

  it('"from" must be a list', () => {
    expect(diags('attacks:\n- a: A\n  from: reality\n')).toEqual([
      { severity: 'error', message: '"from" must be a list of node ids', at: 'reality' },
    ]);
    expect(diags('attacks:\n- a: A\n  from: {reality: x}\n')).toEqual([
      { severity: 'error', message: '"from" must be a list of node ids', at: '{reality: x}' },
    ]);
  });

  // The schema allows "from: null", and the parser means to skip it ("if (value == null) return").
  it.each(['attacks:\n- a: A\n  from:\n', 'attacks:\n- a: A\n  from: ~\n', 'attacks:\n- a: A\n  from: []\n'])(
    'accepts an empty "from" %j',
    (src) => {
      expect(parseTree(src)).toMatchObject({ edges: [], diagnostics: [] });
    },
  );

  it('reports entries without an id', () => {
    expect(diags(wrap('  - ~\n  - ""\n  -\n  - ? [x]\n'))).toEqual([
      { severity: 'error', message: 'Missing node id', at: '~' },
      { severity: 'error', message: 'Missing node id', at: '""' },
      { severity: 'error', message: 'Missing node id', at: '\n' },
      { severity: 'error', message: 'Missing node id', at: '? [x]\n' },
    ]);
  });

  it('reports entries that are neither an id nor a map', () => {
    expect(diags(wrap('  - [b]\n  - {}\n'))).toEqual([
      { severity: 'error', message: 'Each "from" entry must be a node id', at: '[b]' },
      { severity: 'error', message: 'Each "from" entry must be a node id', at: '{}' },
    ]);
  });

  it('a node cannot come from itself', () => {
    const src = wrap('  - a\n  - a: label\n');
    expect(diags(src)).toEqual([
      { severity: 'warning', message: '"a" cannot come from itself', at: 'a' },
      { severity: 'warning', message: '"a" cannot come from itself', at: 'a' },
    ]);
    expect(parseTree(src).edges).toEqual([]);
  });

  it('drops exact duplicates and says so, but keeps the first', () => {
    const src = wrap("  - b: first\n  - b: '#yolosec'\n  - b\n");
    expect(diags(src)).toEqual([
      { severity: 'warning', message: '"a" already comes from "b"', at: 'b' },
      { severity: 'warning', message: '"a" already comes from "b"', at: 'b' },
    ]);
    const tree = parseTree(src);
    expect(tree.edges.map((e) => [e.id, e.label])).toEqual([['a:0', 'first']]);
    // the warnings point at the duplicates, not the original
    expect(tree.diagnostics.map((d) => d.from)).toEqual([src.indexOf("b: '#"), src.lastIndexOf('- b\n') + 2]);
  });

  it('a backwards edge and a forward edge between the same nodes are different connections', () => {
    const tree = parseTree(wrap('  - b\n  - b:\n    backwards: true\n'));
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges.map((e) => [e.id, e.backwards])).toEqual([
      ['a:0', false],
      ['a:1', true],
    ]);
  });

  it('keeps edge ids tied to the position in "from", even after invalid entries', () => {
    const tree = parseTree(wrap('  - [bad]\n  - a\n  - b\n'));
    expect(tree.edges.map((e) => [e.id, e.fromIndex])).toEqual([['a:2', 2]]);
  });

  it('only reads "from" of the first declaration of a duplicated id', () => {
    const tree = parseTree('attacks:\n- a: A\n  from:\n  - reality\n- a: again\n  from:\n  - b\n- b: B\n');
    expect(tree.edges.map((e) => e.source)).toEqual(['reality']);
  });
});

describe('parseTree: references', () => {
  it('undeclared ids become ghost facts, with a warning at each use', () => {
    const src = 'attacks:\n- a: A\n  from:\n  - leaked_keys\ngoals:\n- g: G\n  from:\n  - leaked_keys\n';
    const tree = parseTree(src);
    const ghost = node(tree, 'leaked_keys')!;
    expect(ghost).toEqual({ id: 'leaked_keys', kind: 'fact', label: 'Leaked keys', declared: false });
    expect(isGhost(ghost)).toBe(true);
    expect(diags(src)).toEqual([
      { severity: 'warning', message: '"leaked_keys" is not declared in facts, attacks, mitigations or goals', at: 'leaked_keys' },
      { severity: 'warning', message: '"leaked_keys" is not declared in facts, attacks, mitigations or goals', at: 'leaked_keys' },
    ]);
  });

  it('reality is implicit: referencing it is fine and it is not a ghost', () => {
    const tree = parseTree('attacks:\n- a: A\n  from:\n  - reality\n');
    expect(tree.diagnostics).toEqual([]);
    const reality = node(tree, 'reality')!;
    expect(reality).toEqual({ id: 'reality', kind: 'reality', label: 'Reality', declared: false });
    expect(isGhost(reality)).toBe(false);
    expect(isGhost(node(tree, 'a')!)).toBe(false);
  });

  it('reality only appears when something uses it', () => {
    expect(parseTree('attacks:\n- a: A\n').nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('"from" can be used as a source id, and is then undeclared', () => {
    expect(diags('attacks:\n- a: A\n  from:\n  - from\n')).toEqual([
      { severity: 'warning', message: '"from" is not declared in facts, attacks, mitigations or goals', at: 'from' },
    ]);
  });

  it('a reference may come before the declaration', () => {
    const tree = parseTree('goals:\n- g: G\n  from:\n  - a\nattacks:\n- a: A\n');
    expect(tree.diagnostics).toEqual([]);
    expect(node(tree, 'a')).toMatchObject({ kind: 'attack', declared: true });
  });
});

describe('parseTree: filter', () => {
  it('reads the listed ids, in order', () => {
    const tree = parseTree('attacks:\n- a: A\n- b: B\nfilter:\n- b\n- a\n');
    expect(tree.filter).toEqual(['b', 'a']);
    expect(tree.diagnostics).toEqual([]);
  });

  it('filter entries count as references', () => {
    const tree = parseTree('filter: [nope, reality]\n');
    expect(diags('filter: [nope, reality]\n')).toEqual([
      { severity: 'warning', message: '"nope" is not declared in facts, attacks, mitigations or goals', at: 'nope' },
    ]);
    expect(tree.nodes.map((n) => n.id)).toEqual(['reality', 'nope']);
  });

  it('rejects entries that are not ids', () => {
    expect(diags('attacks:\n- a: A\nfilter:\n- ~\n- [a]\n- ""\n- a\n')).toEqual([
      { severity: 'error', message: 'Each filter entry must be a node id', at: '~' },
      { severity: 'error', message: 'Each filter entry must be a node id', at: '[a]' },
      { severity: 'error', message: 'Each filter entry must be a node id', at: '""' },
    ]);
    expect(parseTree('attacks:\n- a: A\nfilter:\n- ~\n- a\n').filter).toEqual(['a']);
  });

  it('must be a list', () => {
    expect(diags('filter: a\n')).toEqual([{ severity: 'error', message: '"filter" must be a list of node ids', at: 'a' }]);
  });

  it.each(['filter:\n', 'filter: ~\n', 'filter: []\n'])('an empty filter is no filter: %j', (src) => {
    expect(parseTree(src)).toMatchObject({ filter: [], diagnostics: [] });
  });
});

describe('parseTree: positions', () => {
  it('reads positions of declared nodes, ghosts and reality', () => {
    const tree = parseTree(
      'attacks:\n- a: A\n  from:\n  - reality\n  - ghost\npositions:\n  a: [1, 2]\n  reality: [-3.5, 0]\n  ghost: [ 10, 20 ]\n',
    );
    expect(tree.positions).toEqual({ a: { x: 1, y: 2 }, reality: { x: -3.5, y: 0 }, ghost: { x: 10, y: 20 } });
    expect(tree.diagnostics.map((d) => d.message)).toEqual(['"ghost" is not declared in facts, attacks, mitigations or goals']);
  });

  it('rejects anything that is not [x, y] with finite numbers', () => {
    const src = 'attacks:\n- a: A\npositions:\n  a: [1, x]\n  b: 3\n  c: [1, 2, 3]\n  d: [.inf, 1]\n  e: [.nan, 1]\n  f: [[1], 2]\n  g: ["1", "2"]\n  h:\n  [k]: [1, 2]\n';
    expect(diags(src)).toEqual(
      ['[1, x]', '3', '[1, 2, 3]', '[.inf, 1]', '[.nan, 1]', '[[1], 2]', '["1", "2"]', 'h', '[1, 2]'].map((at) => ({
        severity: 'error',
        message: 'Write a position as "id: [x, y]"',
        at,
      })),
    );
    expect(parseTree(src).positions).toEqual({});
  });

  it('warns about positions of ids that are not nodes', () => {
    expect(diags('attacks:\n- a: A\npositions:\n  a: [0, 0]\n  nope: [1, 2]\n')).toEqual([
      { severity: 'warning', message: '"nope" has a position but is not a node', at: 'nope' },
    ]);
    // implicit reality is only a node when something uses it
    expect(diags('positions:\n  reality: [0, 0]\n')).toEqual([
      { severity: 'warning', message: '"reality" has a position but is not a node', at: 'reality' },
    ]);
  });

  it('must be a map', () => {
    expect(diags('positions: [1, 2]\n')).toEqual([
      { severity: 'error', message: '"positions" maps node ids to [x, y]', at: '[1, 2]' },
    ]);
  });

  it.each(['positions:\n', 'positions: ~\n', 'positions: {}\n'])('accepts empty positions %j', (src) => {
    expect(parseTree(src)).toMatchObject({ positions: {}, diagnostics: [] });
  });
});

describe('parseTree: YAML errors', () => {
  it('reports only the syntax errors while the YAML is broken', () => {
    const src = 'bogus: 1\nattacks:\n- a: [unclosed\n  from:\n  - ghost\n';
    const tree = parseTree(src);
    expect(tree.syntaxError).toBe(true);
    expect(tree.diagnostics.length).toBeGreaterThan(0);
    expect(tree.diagnostics.every((d) => d.severity === 'error')).toBe(true);
    expect(tree.diagnostics.map((d) => d.message).join('\n')).not.toMatch(/Unknown section|not declared/);
  });

  it('reports duplicate keys as syntax errors, on one line and without position suffixes', () => {
    const tree = parseTree('title: a\ntitle: b\n');
    expect(tree.syntaxError).toBe(true);
    expect(tree.diagnostics).toEqual([{ from: 9, to: 10, severity: 'error', message: 'Map keys must be unique' }]);
  });

  it('every syntax error has a non-empty range inside the text', () => {
    for (const src of ['a: [', '- a\nb: c\n', 'a: "x\n', 'attacks:\n  - a: A\n - b: B\n', '\t- x\n', 'a: b: c\n']) {
      const tree = parseTree(src);
      expect(tree.syntaxError).toBe(true);
      for (const d of tree.diagnostics) {
        expect(d.to).toBeGreaterThan(d.from);
        expect(d.from).toBeGreaterThanOrEqual(0);
        expect(d.message).not.toContain('\n');
        expect(d.message).not.toMatch(/at line \d+/);
      }
    }
  });

  it('YAML warnings are shown but do not make it a syntax error', () => {
    const tree = parseTree('title: !foo x\n');
    expect(tree.syntaxError).toBe(false);
    expect(diags('title: !foo x\n')).toEqual([{ severity: 'warning', message: 'Unresolved tag: !foo', at: '!foo' }]);
  });

  it('sorts diagnostics by position', () => {
    const src = 'zzz: 1\nattacks:\n- a: A\n  from:\n  - ghost\n  color: red\nyyy: 2\n';
    const tree = parseTree(src);
    expect(tree.diagnostics.map((d) => d.from)).toEqual([...tree.diagnostics.map((d) => d.from)].sort((a, b) => a - b));
    expect(tree.diagnostics.map((d) => d.message)).toEqual([
      'Unknown section "zzz"',
      '"ghost" is not declared in facts, attacks, mitigations or goals',
      'Unknown node property "color"',
      'Unknown section "yyy"',
    ]);
  });
});

describe('parseTree: line endings and robustness', () => {
  const LF = "title: T\n# c\nattacks:\n- a: A\n  from:\n  - reality: '#yolosec'\n  - ghost\n";

  it('reads CRLF documents the same way, with ranges into the CRLF text', () => {
    const crlf = LF.replace(/\n/g, '\r\n');
    const a = parseTree(LF);
    const b = parseTree(crlf);
    expect(b.title).toBe('T');
    expect(b.nodes.map(({ id, kind, label }) => ({ id, kind, label }))).toEqual(a.nodes.map(({ id, kind, label }) => ({ id, kind, label })));
    expect(b.edges.map((e) => [e.source, e.label])).toEqual(a.edges.map((e) => [e.source, e.label]));
    expect(b.diagnostics.map((d) => [d.message, crlf.slice(d.from, d.to)])).toEqual([
      ['"ghost" is not declared in facts, attacks, mitigations or goals', 'ghost'],
    ]);
    const key = b.nodes.find((n) => n.id === 'a')!.keyRange!;
    expect(crlf.slice(key.from, key.to)).toBe('a');
  });

  it('never throws, whatever the input', () => {
    const inputs = ['', '\n', ':', '- -', '{', '[', '&a *a', '*nope', '? ? ?', 'a: *x', '!!binary x', '%YAML 1.2\n---\n', '---\n---\n', '\u0000', 'facts: !!set {a}', 'facts:\n- &x a: A\n- *x\n'];
    for (const src of inputs) expect(() => parseTree(src)).not.toThrow();
  });

  it('does not resolve aliases: one used where a list is expected is reported', () => {
    // a known limitation: "*x" is an Alias node, not the list it points to
    expect(diags('a: &x [1, 2]\npositions:\n  z: *x\nfilter: *x\n').map((d) => d.message)).toEqual([
      'Unknown section "a"',
      'Write a position as "id: [x, y]"',
      '"filter" must be a list of node ids',
    ]);
  });
});

describe('the Diagnostics table in the guide', async () => {
  const { default: guide } = await import('../docs/guide.md?raw');
  const section = guide.slice(guide.indexOf('### Diagnostics'), guide.indexOf('## Saving'));
  const documented = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);

  // one document that triggers every problem the parser knows about
  const BAD = `bogus: 1
facts:
- plain
- a: A
  color: red
  from:
  - a
  - ghost
  - b
  - b
  - c:
    backwards: maybe
    weight: 1
- b: B
  from: b_only
attacks:
- a: again
positions:
  nope: [1, 2]
`;
  const produced = parseTree(BAD).diagnostics.map((d) => d.message);

  it('lists the messages', () => {
    expect(documented.length).toBeGreaterThanOrEqual(9);
  });

  it('every documented message is one the parser actually produces', () => {
    for (const doc of documented) {
      const variants = doc.startsWith('Unknown ') ? doc.replace(/^Unknown /, '').split(' / ').map((w) => `Unknown ${w}`) : [doc];
      for (const v of variants) {
        const pattern = new RegExp(
          `^${v
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/"[xy]"/g, '"[^"]+"')
            .replace(/…/g, '.+')}`,
        );
        expect(produced.some((m) => pattern.test(m)), `${v} in ${JSON.stringify(produced)}`).toBe(true);
      }
    }
  });
});

describe('ids that look like Object internals', () => {
  it('keeps the position of a node called __proto__ or constructor', () => {
    const t = parseTree(
      "facts:\n- __proto__: Weird id\n  from:\n  - reality\n- constructor: Another\npositions:\n  __proto__: [10, 20]\n  constructor: [30, 40]\n",
    );
    expect(t.diagnostics).toEqual([]);
    expect(Object.keys(t.positions).sort()).toEqual(['__proto__', 'constructor']);
    expect(t.positions['__proto__']).toEqual({ x: 10, y: 20 });
    expect(t.positions['constructor']).toEqual({ x: 30, y: 40 });
  });

  it('records where each filter entry is, for the editor', () => {
    const src = 'attacks:\n- a: A\n  from:\n  - reality\nfilter:\n- a\n- ghost\n';
    const t = parseTree(src);
    expect(t.filterRefs?.map((f) => [f.id, src.slice(f.range.from, f.range.to)])).toEqual([
      ['a', 'a'],
      ['ghost', 'ghost'],
    ]);
  });
});
