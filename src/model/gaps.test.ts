import { describe, expect, it } from 'vitest';
import { defenseGaps } from './analysis';
import { EXAMPLE_CICD } from './examples';
import { parseTree } from './parse';

const gaps = (yaml: string) => {
  const g = defenseGaps(parseTree(yaml));
  return { undefended: [...g.undefended].sort(), openGoals: [...g.openGoals].sort(), openEdges: [...g.openEdges].sort() };
};

describe('defenseGaps: which attacks have no defense', () => {
  it('an attack with no mitigation is undefended; one with a mitigation in place is not', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - reality
- b: B
  from:
  - reality
mitigations:
- m: M
  from:
  - a
`);
    expect(g.undefended).toEqual(['b']);
  });

  it('a planned mitigation (implemented: false) does not defend yet', () => {
    expect(gaps(`attacks:
- a: A
  from:
  - reality
mitigations:
- m: M
  from:
  - a:
    implemented: false
`).undefended).toEqual(['a']);
  });

  it('a backwards connection from the attack to a mitigation is not a defense of it', () => {
    expect(gaps(`attacks:
- a: A
  from:
  - reality
mitigations:
- m: M
  from:
  - a:
    backwards: true
`).undefended).toEqual(['a']);
  });

  it('only declared attacks count, and an undeclared "mitigation" defends nothing', () => {
    // "ghost" is used but never declared: it is drawn as an undeclared node, not an attack
    const g = gaps(`attacks:
- a: A
  from:
  - reality
  - ghost
facts:
- f: F
  from:
  - a
`);
    expect(g.undefended).toEqual(['a']);
  });

  it('facts, mitigations and goals are never "undefended"', () => {
    expect(gaps(`facts:
- f: F
  from:
  - reality
goals:
- g: G
  from:
  - f
`).undefended).toEqual([]);
  });
});

describe('defenseGaps: open paths to goals', () => {
  it('a goal behind an undefended attack is open, and every step of the way is marked', () => {
    const g = gaps(`facts:
- f: F
  from:
  - reality
attacks:
- a: A
  from:
  - f
goals:
- g: G
  from:
  - a
`);
    expect(g.openGoals).toEqual(['g']);
    expect(g.openEdges).toEqual(['a:0', 'f:0', 'g:0']);
  });

  it('a defended attack blocks the way straight on', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - reality
mitigations:
- m: M
  from:
  - a
goals:
- g: G
  from:
  - a
`);
    expect(g.openGoals).toEqual([]);
    expect(g.openEdges).toEqual([]);
  });

  it('the way around a defense, through its mitigation, stays open when the next attack is undefended', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - reality
- next: Try something else
  from:
  - m
mitigations:
- m: M
  from:
  - a
goals:
- g: G
  from:
  - a
  - next
`);
    expect(g.undefended).toEqual(['next']);
    expect(g.openGoals).toEqual(['g']);
    // a -> g is blocked by m; reality -> a -> m -> next -> g is the open path
    expect(g.openEdges).toEqual(['a:0', 'g:1', 'm:0', 'next:0']);
  });

  it('connections that are not implemented, or backwards, are not steps', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - reality
- b: B
  from:
  - reality
goals:
- g: G
  from:
  - a:
    implemented: false
  - b:
    backwards: true
`);
    expect(g.undefended).toEqual(['a', 'b']);
    expect(g.openGoals).toEqual([]);
  });

  it('nodes with no "from" are starting points too, even without reality', () => {
    const g = gaps(`attacks:
- a: A
goals:
- g: G
  from:
  - a
`);
    expect(g.openGoals).toEqual(['g']);
    expect(g.openEdges).toEqual(['g:0']);
  });

  it('a node that only has a backwards parent is a starting point', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - m:
    backwards: true
- b: B
  from:
  - a
mitigations:
- m: M
  from:
  - b
goals:
- g: G
  from:
  - a
`);
    expect(g.openGoals).toEqual(['g']);
  });

  it('marks only the edges that lead to an open goal, not every reachable one', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - reality
- dead_end: Goes nowhere
  from:
  - reality
goals:
- g: G
  from:
  - a
`);
    expect(g.openEdges).toEqual(['a:0', 'g:0']);
  });

  it('an undeclared goal reference is not an open goal', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - reality
`);
    expect(g.openGoals).toEqual([]);
  });

  it('survives cycles', () => {
    const g = gaps(`attacks:
- a: A
  from:
  - reality
  - b
- b: B
  from:
  - a
goals:
- g: G
  from:
  - b
`);
    expect(g.openGoals).toEqual(['g']);
  });

  it('a filter does not change the answer: gaps are about the whole tree', () => {
    const src = `attacks:
- a: A
  from:
  - reality
mitigations:
- m: M
  from:
  - a
goals:
- g: G
  from:
  - a
`;
    expect(gaps(`${src}filter:\n- g\n`)).toEqual(gaps(src));
  });

  it('the bundled example shows a planned defense leaving the cloud account open', () => {
    const g = gaps(EXAMPLE_CICD);
    expect(g.undefended).toEqual(['dump_runner_creds', 'malicious_pr', 'pwn_request', 'steal_session']);
    expect(g.openGoals).toEqual(['cloud_takeover']);
  });
});
