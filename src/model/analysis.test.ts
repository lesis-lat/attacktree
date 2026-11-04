import { describe, expect, it } from 'vitest';
import { lineage, pointsBackwards, reach, visibleIds } from './analysis';
import { EXAMPLE_CICD } from './examples';
import { parseTree } from './parse';
import type { Tree, TreeEdge } from './types';

/**
 *   reality -> a -> b -> goal
 *                \-> c -> goal
 *   m (mitigation) <- b, and m sends the attacker back to a (backwards)
 *   x -> y is a separate island
 */
const TEXT = `attacks:
- a: A
  from:
  - reality
  - m:
    backwards: true
- b: B
  from:
  - a
- c: C
  from:
  - a
- x: X
- y: Y
  from:
  - x
mitigations:
- m: M
  from:
  - b
goals:
- goal: G
  from:
  - b
  - c
`;

const tree = parseTree(TEXT);
const sorted = (s: Iterable<string>) => [...s].sort();
const edgeId = (t: Tree, source: string, target: string) => t.edges.find((e) => e.source === source && e.target === target)!.id;

describe('reach', () => {
  const adj = new Map([
    ['a', ['b', 'c']],
    ['b', ['d']],
    ['c', ['d', 'a']],
  ]);

  it('includes the start and everything reachable, once, following cycles safely', () => {
    expect(sorted(reach(['a'], adj))).toEqual(['a', 'b', 'c', 'd']);
    expect(sorted(reach(['d'], adj))).toEqual(['d']);
  });

  it('accepts several starts and unknown ids', () => {
    expect(sorted(reach(['b', 'zzz'], adj))).toEqual(['b', 'd', 'zzz']);
    expect(sorted(reach([], adj))).toEqual([]);
  });
});

describe('visibleIds', () => {
  it('is null without a filter', () => {
    expect(tree.filter).toEqual([]);
    expect(visibleIds(tree)).toBeNull();
  });

  it('is null when no filtered id is a node', () => {
    expect(visibleIds({ ...tree, filter: ['nope'] })).toBeNull();
  });

  it('keeps the filtered node, what leads to it and what it leads to', () => {
    expect(sorted(visibleIds({ ...tree, filter: ['y'] })!)).toEqual(['x', 'y']);
    expect(sorted(visibleIds({ ...tree, filter: ['goal'] })!)).toEqual(['a', 'b', 'c', 'goal', 'm', 'reality']);
  });

  it('counts paths through backwards edges as leading to the node', () => {
    // b -> m -> (backwards) a -> c
    expect(sorted(visibleIds({ ...tree, filter: ['c'] })!)).toEqual(['a', 'b', 'c', 'goal', 'm', 'reality']);
    const forwardOnly = { ...tree, edges: tree.edges.filter((e) => !e.backwards), filter: ['c'] };
    expect(sorted(visibleIds(forwardOnly)!)).toEqual(['a', 'c', 'goal', 'reality']);
  });

  it('follows backwards edges both ways', () => {
    // m leads (backwards) to a, so a and everything after it is on a path through m
    expect(sorted(visibleIds({ ...tree, filter: ['m'] })!)).toEqual(['a', 'b', 'c', 'goal', 'm', 'reality']);
  });

  it('unions several filtered nodes and ignores unknown ones', () => {
    expect(sorted(visibleIds({ ...tree, filter: ['y', 'nope', 'c'] })!)).toEqual(['a', 'b', 'c', 'goal', 'm', 'reality', 'x', 'y']);
  });

  it('reads the filter from the YAML', () => {
    const filtered = parseTree(`${TEXT}filter:\n- x\n`);
    expect(sorted(visibleIds(filtered)!)).toEqual(['x', 'y']);
  });
});

describe('lineage', () => {
  it('lights up ancestors, descendants and the edges between them, but not siblings', () => {
    const l = lineage(tree, 'b');
    expect(sorted(l.nodes)).toEqual(['a', 'b', 'goal', 'm', 'reality']);
    expect(sorted(l.edges)).toEqual(sorted([edgeId(tree, 'reality', 'a'), edgeId(tree, 'a', 'b'), edgeId(tree, 'b', 'goal'), edgeId(tree, 'b', 'm')]));
    expect(l.nodes.has('c')).toBe(false);
  });

  it('includes a backwards edge that touches the node, with both its ends', () => {
    const l = lineage(tree, 'm');
    expect(l.edges.has(edgeId(tree, 'm', 'a'))).toBe(true);
    expect(sorted(l.nodes)).toEqual(['a', 'b', 'm', 'reality']);

    const fromA = lineage(tree, 'a');
    expect(fromA.edges.has(edgeId(tree, 'm', 'a'))).toBe(true);
  });

  it('does not follow backwards edges further', () => {
    // c is below a, but its lineage must not run through m back up and down again
    const l = lineage(tree, 'c');
    expect(l.edges.has(edgeId(tree, 'm', 'a'))).toBe(false);
    expect(sorted(l.nodes)).toEqual(['a', 'c', 'goal', 'reality']);
  });

  it('a goal lights up every path to it', () => {
    const l = lineage(tree, 'goal');
    expect(sorted(l.nodes)).toEqual(['a', 'b', 'c', 'goal', 'reality']);
    expect(l.edges.size).toBe(5);
  });

  it('an isolated or unknown node is only itself', () => {
    expect(lineage(tree, 'nope')).toEqual({ nodes: new Set(['nope']), edges: new Set() });
    const lone = parseTree('attacks:\n- lone: L\n');
    expect(lineage(lone, 'lone')).toEqual({ nodes: new Set(['lone']), edges: new Set() });
  });

  it('works on the bundled example', () => {
    const t = parseTree(EXAMPLE_CICD);
    const l = lineage(t, 'malicious_release');
    expect(l.nodes.has('reality')).toBe(true);
    expect(l.nodes.has('cloud_takeover')).toBe(false);
    for (const id of l.edges) {
      const e = t.edges.find((x) => x.id === id)!;
      expect(l.nodes.has(e.source) && l.nodes.has(e.target)).toBe(true);
    }
  });
});

describe('pointsBackwards', () => {
  it('is true when the target already leads to the source', () => {
    expect(pointsBackwards(tree, 'goal', 'a')).toBe(true);
    expect(pointsBackwards(tree, 'b', 'reality')).toBe(true);
    expect(pointsBackwards(tree, 'c', 'a')).toBe(true);
  });

  it('is false for a forward or unrelated connection', () => {
    expect(pointsBackwards(tree, 'a', 'goal')).toBe(false);
    expect(pointsBackwards(tree, 'c', 'b')).toBe(false);
    expect(pointsBackwards(tree, 'x', 'a')).toBe(false);
    expect(pointsBackwards(tree, 'nope', 'a')).toBe(false);
  });

  it('ignores existing backwards edges', () => {
    // a -> m only exists through the backwards m -> a edge being reversed; it is not a cycle
    expect(pointsBackwards(tree, 'a', 'm')).toBe(false);
    // m -> b would close b -> m
    expect(pointsBackwards(tree, 'm', 'b')).toBe(true);
  });

  it('a self-loop counts as pointing back', () => {
    expect(pointsBackwards(tree, 'a', 'a')).toBe(true);
  });

  it('handles edges built by hand', () => {
    const edges: TreeEdge[] = [
      { id: 'q:0', source: 'p', target: 'q', backwards: false, implemented: true, ungrouped: false, fromIndex: 0 },
      { id: 'q:1', source: 'o', target: 'q', backwards: false, implemented: true, ungrouped: false, fromIndex: 1 },
    ];
    const t: Tree = { title: '', nodes: [], edges, filter: [], positions: {}, diagnostics: [], syntaxError: false };
    expect(pointsBackwards(t, 'q', 'p')).toBe(true);
    expect(pointsBackwards(t, 'o', 'p')).toBe(false);
  });
});
