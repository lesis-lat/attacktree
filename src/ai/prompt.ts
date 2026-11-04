/** Everything an assistant needs to edit a tree correctly, followed by the tree itself. */
export function aiPrompt(yaml: string): string {
  const fence = '```';
  return `You are helping me edit an attack tree written in the attacktree / Deciduous YAML format.

FORMAT
- One YAML document with the keys: title, facts, attacks, mitigations, goals, filter, positions.
- facts, attacks, mitigations and goals are lists of nodes. A node is "- id: Label", optionally followed by a "from:" list.
- The first key of a node is its id: letters, digits, "_" or "-", starting with a letter, unique across the whole tree. Its value is the label people read.
- "from" lists the ids this node comes from. Arrows point from them to the node. "reality" is the implicit root, so use it for starting points.
- A from entry is an id, or a map whose first key is the id. Flags go on the next lines, aligned with the id:
    - leaked_keys: '#yolosec'      # label on the arrow; quote it, because # starts a YAML comment
    - code_review:
      backwards: true              # a mitigation sends the attacker back to this earlier step
    - dns_block:
      implemented: false           # planned, not in place yet
- Every id used in "from" must be declared in one of the four sections.
- Leave "positions" as it is, except for removing entries of nodes you delete.

CONVENTIONS
- Facts are true statements about the system. Attacks are attacker actions. Mitigations are defenses that counter an attack. Goals are what the attacker ultimately wants.
- Model in a rhythm: an attack, the mitigation that counters it, then the attack the adversary tries next because of that mitigation.
- Label a connection '#yolosec' when nothing stops that step.
- Keep labels short (under 60 characters), concrete, and specific to this system.

REPLY
Return the complete updated tree as one ${fence}yaml code block and nothing after it. Keep existing ids and comments unless I ask otherwise.

CURRENT TREE
${fence}yaml
${yaml.trimEnd()}
${fence}

MY REQUEST
`;
}

const FENCED = /```[^\n]*\n([\s\S]*?)```/g;

/** Assistants wrap YAML in Markdown fences, often with prose around them. Keep the YAML. */
export function stripFences(text: string): string {
  if (!text.includes('```')) return text;
  const blocks = [...text.matchAll(FENCED)].map((m) => m[1]);
  if (blocks.length === 0) return text.replace(/^```[^\n]*\n?|```\s*$/g, '');
  return blocks.sort((a, b) => b.length - a.length)[0];
}
