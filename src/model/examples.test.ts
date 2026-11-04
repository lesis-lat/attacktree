import { describe, expect, it } from 'vitest';
import { BLANK_TREE, EXAMPLE_CICD } from './examples';
import { parseTree } from './parse';
import { isGhost, KIND_LABEL, KIND_SECTION, SECTION_KIND, SECTIONS, type TreeNode } from './types';

describe('bundled trees', () => {
  it('the CI/CD example uses every kind and edge form, without diagnostics', () => {
    const tree = parseTree(EXAMPLE_CICD);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.title).toBe('Ship a malicious release through CI/CD');
    expect(new Set(tree.nodes.map((n) => n.kind))).toEqual(new Set(['reality', 'fact', 'attack', 'mitigation', 'goal']));
    expect(tree.nodes.every((n) => !isGhost(n))).toBe(true);
    expect(tree.edges.some((e) => e.label === '#yolosec')).toBe(true);
    expect(tree.edges.some((e) => e.backwards)).toBe(true);
    expect(tree.edges.some((e) => !e.implemented)).toBe(true);
    expect(tree.positions).toEqual({});
  });

  it('the blank tree is a minimal valid start', () => {
    const tree = parseTree(BLANK_TREE);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.title).toBe('Untitled tree');
    expect(tree.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['reality', 'reality'],
      ['first_attack', 'attack'],
      ['attacker_wins', 'goal'],
    ]);
    expect(tree.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['reality->first_attack', 'first_attack->attacker_wins']);
  });
});

describe('kinds and sections', () => {
  it('map each section to its kind and back', () => {
    expect(SECTIONS).toEqual(['facts', 'attacks', 'mitigations', 'goals']);
    for (const section of SECTIONS) expect(KIND_SECTION[SECTION_KIND[section]]).toBe(section);
    expect(Object.keys(KIND_SECTION).sort()).toEqual(['attack', 'fact', 'goal', 'mitigation']);
  });

  it('have human labels', () => {
    expect(KIND_LABEL).toEqual({ reality: 'Reality', fact: 'Fact', attack: 'Attack', mitigation: 'Mitigation', goal: 'Goal' });
  });

  it('a ghost is an undeclared node other than reality', () => {
    const n = (kind: TreeNode['kind'], declared: boolean): TreeNode => ({ id: 'x', kind, label: 'X', declared });
    expect(isGhost(n('fact', false))).toBe(true);
    expect(isGhost(n('fact', true))).toBe(false);
    expect(isGhost(n('reality', false))).toBe(false);
    expect(isGhost(n('reality', true))).toBe(false);
  });
});
