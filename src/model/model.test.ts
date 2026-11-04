import { describe, expect, it } from 'vitest';
import { lineage, pointsBackwards, visibleIds } from './analysis';
import { extractEmbedded, svgSourceComment } from './embed';
import { EXAMPLE_CICD } from './examples';
import * as edit from './mutate';
import { parseTree } from './parse';

const SMALL = `title: Small
# keep me
facts:
- leak: Credentials in a public gist
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

describe('parseTree', () => {
  it('reads the bundled example without problems', () => {
    const tree = parseTree(EXAMPLE_CICD);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.nodes[0].id).toBe('reality');
    expect(tree.nodes.filter((n) => n.kind === 'goal')).toHaveLength(2);
  });

  it('understands the deciduous edge forms', () => {
    const tree = parseTree(SMALL);
    expect(tree.diagnostics).toEqual([]);
    const yolo = tree.edges.find((e) => e.target === 'leak')!;
    expect(yolo).toMatchObject({ source: 'reality', label: '#yolosec', backwards: false, implemented: true });
    expect(tree.nodes.find((n) => n.id === 'brute')!.label).toBe('Brute');
  });

  it('accepts edge flags nested under the id (common in LLM output)', () => {
    const tree = parseTree(`attacks:\n- a: A\n  from:\n  - reality:\n      backwards: true\n      label: '#yolosec'\n`);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges[0]).toMatchObject({ source: 'reality', backwards: true, label: '#yolosec' });
    // editing it normalizes to the Deciduous layout
    const text = edit.updateEdge(`attacks:\n- a: A\n  from:\n  - reality:\n      backwards: true\n`, 'a', 0, { implemented: false });
    expect(text).toContain('  - reality:\n    backwards: true\n    implemented: false');
  });

  it('flags undeclared references and duplicates', () => {
    const tree = parseTree(`attacks:\n- a: A\n  from:\n  - ghost\n- a: again\n`);
    const messages = tree.diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes('"ghost" is not declared'))).toBe(true);
    expect(messages.some((m) => m.includes('already declared'))).toBe(true);
    expect(tree.nodes.find((n) => n.id === 'ghost')!.declared).toBe(false);
  });

  it('marks YAML syntax errors', () => {
    expect(parseTree('attacks:\n- a: [unclosed\n').syntaxError).toBe(true);
  });
});

describe('analysis', () => {
  it('filters to paths through the listed nodes', () => {
    const tree = parseTree(SMALL + 'filter:\n- mfa\n');
    expect([...visibleIds(tree)!].sort()).toEqual(['leak', 'login', 'mfa', 'reality']);
  });

  it('finds the lineage of a node', () => {
    const l = lineage(parseTree(SMALL), 'login');
    expect([...l.nodes].sort()).toEqual(['leak', 'login', 'mfa', 'reality', 'win']);
  });

  it('detects edges that point back up', () => {
    const tree = parseTree(SMALL);
    expect(pointsBackwards(tree, 'mfa', 'leak')).toBe(true);
    expect(pointsBackwards(tree, 'mfa', 'brute')).toBe(false);
  });
});

describe('mutations keep the document tidy', () => {
  it('adds a node in the right section and keeps comments and flush lists', () => {
    const { text, id } = edit.addNode(SMALL, { kind: 'mitigation', label: 'Rotate leaked keys', from: ['leak'] });
    expect(id).toBe('rotate_leaked_keys');
    expect(text).toContain('# keep me');
    expect(text).toContain('- rotate_leaked_keys: Rotate leaked keys\n  from:\n  - leak');
    expect(parseTree(text).diagnostics).toEqual([]);
  });

  it('creates missing sections in canonical order', () => {
    const text = edit.addNode('title: T\n\ngoals:\n- g: G\n', { kind: 'attack', label: 'First' }).text;
    expect(text.indexOf('attacks:')).toBeLessThan(text.indexOf('goals:'));
  });

  it('connects, labels and removes edges', () => {
    let text = edit.connect(SMALL, 'mfa', 'brute');
    let tree = parseTree(text);
    const edge = tree.edges.find((e) => e.source === 'mfa' && e.target === 'brute')!;
    text = edit.updateEdge(text, edge.target, edge.fromIndex, { label: '#yolosec', implemented: false });
    expect(text).toContain("- mfa: '#yolosec'\n    implemented: false");
    tree = parseTree(text);
    expect(tree.edges.find((e) => e.id === edge.id)).toMatchObject({ label: '#yolosec', implemented: false });
    text = edit.updateEdge(text, edge.target, edge.fromIndex, { label: '', implemented: true });
    expect(text).toContain('  - reality\n  - mfa\n');
    text = edit.removeEdge(text, edge.target, edge.fromIndex);
    expect(parseTree(text).edges.some((e) => e.source === 'mfa' && e.target === 'brute')).toBe(false);
  });

  it('deletes nodes together with every reference to them', () => {
    const text = edit.removeNodes(SMALL, ['login']);
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges.some((e) => e.source === 'login' || e.target === 'login')).toBe(false);
    // mfa only came from login, so its now-empty "from:" is dropped
    expect(text).not.toMatch(/from:[ \t]*\n(?![ \t]*-)/);
  });

  it('renames ids everywhere', () => {
    const text = edit.renameId(SMALL, 'login', 'credential_stuffing');
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.edges.filter((e) => e.source === 'credential_stuffing' || e.target === 'credential_stuffing')).toHaveLength(3);
    expect(edit.validateId(text, 'mfa', 'leak')).toMatch(/taken/);
  });

  it('moves a node to another kind', () => {
    const text = edit.setKind(SMALL, 'mfa', 'fact');
    expect(parseTree(text).nodes.find((n) => n.id === 'mfa')!.kind).toBe('fact');
  });

  it('refuses to edit broken YAML', () => {
    expect(() => edit.setLabel('attacks:\n- a: [x\n', 'a', 'b')).toThrow(edit.MutationError);
  });
});

describe('manual positions', () => {
  it('writes dragged positions to a positions section and reads them back', () => {
    let text = edit.setPositions(SMALL, { login: { x: 120.4, y: 80.6 } });
    expect(text).toMatch(/\n\n# Where nodes were dragged[^\n]*\npositions:\n  login: \[ 120, 81 \]\n$/);
    text = edit.setPositions(text, { login: { x: 10, y: 20 }, mfa: { x: 300, y: 400 } });
    const tree = parseTree(text);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.positions).toEqual({ login: { x: 10, y: 20 }, mfa: { x: 300, y: 400 } });
  });

  it('follows renames and deletions, and can be cleared', () => {
    let text = edit.setPositions(SMALL, { login: { x: 1, y: 2 }, mfa: { x: 3, y: 4 } });
    text = edit.renameId(text, 'login', 'stuffing');
    expect(parseTree(text).positions).toHaveProperty('stuffing');
    text = edit.removeNodes(text, ['mfa']);
    expect(Object.keys(parseTree(text).positions)).toEqual(['stuffing']);
    text = edit.clearPositions(text, ['stuffing']);
    expect(text).not.toContain('positions');
    expect(parseTree(text).diagnostics).toEqual([]);
  });

  it('warns about positions for nodes that do not exist', () => {
    const tree = parseTree(SMALL + 'positions:\n  nope: [1, 2]\n');
    expect(tree.diagnostics.map((d) => d.message)).toContain('"nope" has a position but is not a node');
  });
});

describe('embedded source', () => {
  it('round-trips through an SVG comment, including non-latin text', () => {
    const source = 'title: Ataque à cadeia de suprimentos ✓\n';
    expect(extractEmbedded(`<svg></svg>\n${svgSourceComment(source)}`)).toBe(source);
  });

  it('reads the deciduous marker', () => {
    const b64 = btoa('title: legacy\n');
    expect(extractEmbedded(`digraph {}\n// deciduous:${b64}`)).toBe('title: legacy\n');
  });
});

describe('documentation', () => {
  it('every live example in the guide is a valid tree', async () => {
    const { default: guide } = await import('../docs/guide.md?raw');
    const examples = [...guide.matchAll(/```yaml example\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThan(4);
    for (const source of examples) {
      const tree = parseTree(source);
      expect({ title: tree.title, diagnostics: tree.diagnostics }).toEqual({ title: tree.title, diagnostics: [] });
    }
  });
});

describe('AI helpers', async () => {
  const { aiPrompt, stripFences } = await import('../ai/prompt');
  it('pulls the YAML out of an assistant reply', () => {
    const reply = 'Sure! Here is the tree:\n\n```yaml\ntitle: T\nattacks:\n- a: A\n```\n\nLet me know.';
    expect(stripFences(reply)).toBe('title: T\nattacks:\n- a: A\n');
    expect(stripFences('title: plain\n')).toBe('title: plain\n');
  });
  it('the prompt carries the tree and its own example is valid YAML for the format', () => {
    const p = aiPrompt(EXAMPLE_CICD);
    expect(p).toContain(EXAMPLE_CICD.trimEnd());
    const snippet = `attacks:\n- x: X\n  from:\n${p.match(/    - leaked_keys[\s\S]*?implemented: false/)![0].replace(/\s{2,}#.*$/gm, '').replace(/^  /gm, '')}\n`;
    const tree = parseTree(snippet.replace('leaked_keys', 'reality').replace('code_review', 'reality2').replace('dns_block', 'reality3'));
    expect(tree.edges.map((e) => [e.backwards, e.implemented])).toEqual([[false, true], [true, true], [false, false]]);
  });
});
