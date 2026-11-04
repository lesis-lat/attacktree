export type NodeKind = 'reality' | 'fact' | 'attack' | 'mitigation' | 'goal';
export type DeclaredKind = Exclude<NodeKind, 'reality'>;

export const SECTIONS = ['facts', 'attacks', 'mitigations', 'goals'] as const;
export type SectionKey = (typeof SECTIONS)[number];

export const SECTION_KIND: Record<SectionKey, DeclaredKind> = {
  facts: 'fact',
  attacks: 'attack',
  mitigations: 'mitigation',
  goals: 'goal',
};

export const KIND_SECTION: Record<DeclaredKind, SectionKey> = {
  fact: 'facts',
  attack: 'attacks',
  mitigation: 'mitigations',
  goal: 'goals',
};

export const KIND_LABEL: Record<NodeKind, string> = {
  reality: 'Reality',
  fact: 'Fact',
  attack: 'Attack',
  mitigation: 'Mitigation',
  goal: 'Goal',
};

export interface Point {
  x: number;
  y: number;
}

export interface Range {
  from: number;
  to: number;
}

export interface TreeNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** false for the implicit `reality` root and for ids referenced but never declared */
  declared: boolean;
  /** the whole `- id: label` item */
  range?: Range;
  /** just the id key */
  keyRange?: Range;
}

export interface TreeEdge {
  /** stable while editing other parts of the document: `target:index` */
  id: string;
  source: string;
  target: string;
  label?: string;
  backwards: boolean;
  implemented: boolean;
  ungrouped: boolean;
  /** position inside the target's `from:` list */
  fromIndex: number;
  range?: Range;
  sourceRange?: Range;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic extends Range {
  severity: Severity;
  message: string;
}

export interface Tree {
  title: string;
  theme?: string;
  nodes: TreeNode[];
  edges: TreeEdge[];
  filter: string[];
  /** where the user dragged nodes on the canvas; everything else is laid out automatically */
  positions: Record<string, Point>;
  diagnostics: Diagnostic[];
  /** the YAML itself failed to parse; the graph may be partial */
  syntaxError: boolean;
}

export function isGhost(node: TreeNode): boolean {
  return !node.declared && node.kind !== 'reality';
}
