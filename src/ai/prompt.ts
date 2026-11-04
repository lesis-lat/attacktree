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

/** A Markdown fence line: three or more backticks at the start of a line (up to 3 spaces of indent). */
const FENCE = /^ {0,3}`{3,}/;

/**
 * Assistants wrap YAML in Markdown fences, often with prose around them. Keep the YAML:
 * the longest fenced block, or what follows an opening fence when the reply was cut short.
 * Backticks inside a line ("use ``` for code") are not fences.
 */
export function stripFences(text: string): string {
  if (!text.includes('```')) return text;
  const lines = text.match(/[^\n]*(?:\n|$)/g)!.slice(0, -1);
  const fences = lines.flatMap((line, i) => (FENCE.test(line) ? [i] : []));
  if (fences.length === 0) return text;
  const between = (from: number, to: number) => lines.slice(from, to).join('');
  const blocks: string[] = [];
  for (let k = 0; k + 1 < fences.length; k += 2) blocks.push(between(fences[k] + 1, fences[k + 1]));
  if (fences.length % 2 === 1) {
    const last = fences[fences.length - 1];
    const after = between(last + 1, lines.length);
    // a lone fence with only blank text after it closes a block that was pasted without its start
    blocks.push(fences.length === 1 && after.trim() === '' ? between(0, last) : after);
  }
  return blocks.reduce((a, b) => (b.length > a.length ? b : a));
}
