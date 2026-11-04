# attacktree documentation

attacktree is a free, browser-based editor for **attack trees and decision trees**. You describe a scenario in a small YAML format (or draw it on a canvas) and attacktree lays it out as a diagram: what an attacker can do, what you have in place to stop them, and where those defenses run out.

Everything runs in your browser. Trees are saved locally, and share links carry the whole tree inside the URL. Nothing is uploaded.

attacktree is built and maintained by [LESIS](https://lesis.lat/?utm_source=attacktree&utm_medium=docs), a security engineering team that does security assessments, security consultancy, due diligence and custom tools.

## Introduction

A decision tree documents **what you believe will happen** when someone, or something, tries to break your system. Every branch is an assumption:

- "the attacker will try to phish a maintainer first"
- "MFA stops that, so they will go after session cookies instead"
- "nothing stops a typosquatted dependency today"

Writing those beliefs down has three effects:

1. **It makes gaps visible.** A branch that reaches the attacker's goal with no mitigation on the way is a priority, and it is hard to miss once it is drawn.
2. **It turns security work into a conversation.** Engineers, product people and leadership can all read a tree. Disagreements about it ("would they really go that way?") are where the useful discussions happen.
3. **It gives you hypotheses to test.** Each mitigation is a claim ("this stops that"). You can verify those claims with tests, exercises and security chaos experiments, and update the tree with what you learn.

The approach applies to reliability failures too: missing logs, a failed dependency, a bad deploy. The format doesn't care whether the adversary is a person or entropy.

### Where the idea comes from

attacktree is an independent, modern take on [Deciduous](https://www.deciduous.app/) by Ryan Petrich and Kelly Shortridge ([source code](https://github.com/rpetrich/deciduous), [launch post](https://kellyshortridge.com/blog/posts/deciduous-attack-tree-app/)). Deciduous introduced the YAML format used here, and attacktree reads Deciduous files as they are. For the methodology in depth, Kelly Shortridge's book [*Security Chaos Engineering*](https://www.securitychaoseng.com/) is the reference.

## Quick start

1. **Open the editor.** The first visit opens an example tree about shipping a malicious release through CI/CD. Pick **New tree** in the menu next to the title to start from scratch.
2. **Read it top to bottom.** *Reality* sits at the top and the attacker's goals sit at the bottom. Every path between them is a way the attacker might get there.
3. **Click a node.** Everything on a path through that node lights up, the rest fades, and the YAML on the left jumps to its declaration.
4. **Add something.** Use **Add → Attack** in the canvas toolbar, or drag from the small handle under a node and drop it on empty space. Type the label straight away.
5. **Connect things.** Drag from a node's bottom handle onto another node.
6. **Rearrange.** Drag nodes to where you want them. **Auto-arrange** puts everything back.
7. **Share it.** **Share** copies a link that contains the whole tree. **Export** produces an SVG or PNG that can be imported again later.

The YAML and the canvas are always in sync, so you can work in either one. Edits on the canvas rewrite the YAML and keep your comments.

## Concepts

A tree has five kinds of node. Each kind has a section in the YAML, except Reality, which is always there.

| Kind | YAML section | What it represents |
|---|---|---|
| **Reality** | *(implicit)* | The starting point: the world as it is. Use the id `reality` to point at it. |
| **Fact** | `facts` | Something true about the system that is neither an attack nor a defense. Example: "the repository is public". |
| **Attack** | `attacks` | An action the attacker takes. |
| **Mitigation** | `mitigations` | Something the defender has, or plans, that counters an attack. |
| **Goal** | `goals` | What the attacker ultimately wants. Goals are drawn at the bottom. |

Every node lists the nodes it comes **from**. Arrows go from those nodes to it. That's the whole model:

```yaml example
title: Reading a tree
facts:
- public_api: The login API is on the internet
  from:
  - reality
attacks:
- stuffing: Credential stuffing on /login
  from:
  - public_api
- buy_session: Buy a stolen session token
  from:
  - rate_limit
mitigations:
- rate_limit: Rate limiting and breached-password checks
  from:
  - stuffing
goals:
- takeover: Take over a customer account
  from:
  - stuffing
  - buy_session
```

Read it as a story: the API is public, so an attacker tries credential stuffing. Rate limiting makes that hard, so the attacker buys a session token instead. Both paths lead to account takeover. The tree is a record of the attacker's **decisions** given your defenses, which is why these are called decision trees.

## The YAML format

A tree is one YAML document. Its keys, in the usual order:

| Key | Type | Meaning |
|---|---|---|
| `title` | text | Shown in the editor and on exports. |
| `facts`, `attacks`, `mitigations`, `goals` | list of nodes | The nodes, one section per kind. All sections are optional. |
| `filter` | list of ids | Show only the paths that go through these nodes. |
| `positions` | map of id → `[x, y]` | Where nodes were dragged on the canvas. Written for you. |
| `theme`, `legend`, `dark` | — | Accepted for Deciduous compatibility, and ignored. |

### Nodes

Each node is a list item whose **first key is its id** and whose value is its **label**:

```yaml
attacks:
- phish_admin: Phish an administrator
  from:
  - reality
```

- **Ids** are short and unique across the whole tree: letters, digits, `_` and `-`, starting with a letter or `_`. They are used in `from` lists and never shown on the diagram.
- **Labels** are free text. If the label is empty (`- phish_admin:`), it is derived from the id ("Phish admin").
- `from` lists where the node comes from. Leave it out for a node with no parents.
- A node declared twice is an error, even in different sections.

### Connections

A `from` entry is usually just an id. To add a label or a flag, write it as a small map whose first key is the id:

```yaml
from:
- reality                    # plain connection
- leaked_keys: '#yolosec'    # connection with a label
- code_review:              # a map: the id first, flags as siblings
  backwards: true            # see "Backwards edges"
- dns_filtering:
  implemented: false         # a mitigation that is planned, not in place
```

| Flag | Default | Meaning |
|---|---|---|
| *(label)* | none | Text drawn on the arrow. `'#yolosec'` is the usual one. Quote anything that starts with `#`, or YAML reads it as a comment. |
| `backwards` | `false` | The arrow points back up the tree: a mitigation sends the attacker back to an earlier step. Drawn dotted and blue. |
| `implemented` | `true` | `false` means the connection isn't real yet, usually a planned mitigation. Drawn dashed. |
| `ungrouped` | `false` | Accepted for Deciduous compatibility. It has no visual effect in attacktree. |

Flags are siblings of the id in the same map, as Deciduous writes them. attacktree also accepts them nested one level deeper (`- code_review: {backwards: true}`), which is what language models often produce.

### Filter

`filter` narrows the diagram to the paths through the listed nodes: the nodes themselves, everything leading to them and everything they lead to. The YAML keeps the full tree. Use it to present one goal or one mitigation to an audience.

```yaml example
title: Only what goes through rate limiting
facts:
- public_api: The login API is on the internet
  from:
  - reality
attacks:
- stuffing: Credential stuffing on /login
  from:
  - public_api
- buy_session: Buy a stolen session token
  from:
  - rate_limit
- sqli: SQL injection in search
  from:
  - public_api
mitigations:
- rate_limit: Rate limiting and breached-password checks
  from:
  - stuffing
goals:
- takeover: Take over a customer account
  from:
  - stuffing
  - buy_session
- dump_db: Dump the customer database
  from:
  - sqli
filter:
- rate_limit
```

### Positions

When you drag a node on the canvas, its position is saved at the end of the YAML:

```yaml
# Where nodes were dragged on the canvas. Remove a line to lay that node out automatically again.
positions:
  phish_admin: [ 420, 180 ]
```

Positions travel with the tree in files, share links and exports. Deciduous ignores them. Delete a line, or use **Auto-arrange**, to go back to the automatic layout.

### Schema

A JSON Schema for the format is published at [`/attacktree.schema.json`](/attacktree.schema.json). Editors that use the YAML language server (VS Code, Neovim, JetBrains) can validate and autocomplete tree files when you add this line at the top:

```yaml
# yaml-language-server: $schema=https://<this-site>/attacktree.schema.json
```

## Modeling patterns

### The decision rhythm: attack, mitigation, next attack

The core pattern alternates. An attack, the mitigation that counters it, then the attack the adversary tries **because** of that mitigation. Ask "and then what?" after every mitigation. A branch ends when you can't think of a next move, or when it reaches a goal.

### #yolosec: nothing in the way

Label a connection `'#yolosec'` when nothing stops that step: no mitigation, or a "worst practice" in place. These are usually the first things to fix, and the label makes them easy to find when you review the tree.

```yaml example
title: The cheapest path
facts:
- public_backups: Backup bucket is world-readable
  from:
  - reality: '#yolosec'
attacks:
- list_bucket: List and download the backups
  from:
  - public_backups: '#yolosec'
goals:
- data_leak: Customer data leaks
  from:
  - list_bucket
```

### Backwards edges: back to the drawing board

Sometimes a mitigation doesn't end the attack. It sends the attacker back to an earlier step to try another way. Draw that with `backwards: true` on the earlier node's `from` entry:

```yaml example
title: Review sends the attacker back
attacks:
- phish: Phish an engineer's password
  from:
  - reality
  - code_review:
    backwards: true
- push_backdoor: Push a backdoor to main
  from:
  - phish
mitigations:
- code_review: Required code review on main
  from:
  - push_backdoor
goals:
- shipped: Backdoor ships to production
  from:
  - push_backdoor
```

Here, required review forces the attacker back to phishing. This time they need a second account to approve their own change.

On the canvas, connecting a node to one of its own ancestors creates a backwards edge automatically.

### Planned mitigations

Mark a mitigation that you intend to have, but don't have yet, with `implemented: false` on the connection that leads to it. It is drawn dashed, so the tree shows the present and the plan at once.

```yaml example
title: Today and tomorrow
attacks:
- exfil_dns: Exfiltrate data over DNS
  from:
  - reality
mitigations:
- egress_dns: Block DNS except internal resolvers
  from:
  - exfil_dns:
    implemented: false
goals:
- exfiltrated: Data leaves the network
  from:
  - exfil_dns
```

### Several goals in one tree

A tree can have more than one goal. Shared early steps (recon, initial access) usually feed several outcomes, and seeing them together shows which early mitigations pay off the most. Use `filter` to present one goal at a time.

## Building a tree: a method

1. **Name the asset and the goal.** What would hurt? "Customer recordings leak", "a malicious release reaches users". Put it under `goals`.
2. **Start from reality, with the cheapest path.** What would a low-effort attacker try first? Public buckets, default credentials and leaked keys come before zero-days. Mark undefended steps `#yolosec`.
3. **Add what you have.** For each attack, add the mitigations that exist today. Add the ones you only plan with `implemented: false`.
4. **Ask "and then what?"** For every mitigation, add the attacker's next move. Use `backwards` when a mitigation pushes them back up the tree.
5. **Look for open paths.** Click each goal. Everything lit up is a way to get there. Paths with no mitigation, and `#yolosec` labels, are your priorities.
6. **Find leverage.** Click a mitigation to see how many paths go through it. A mitigation early in the tree that many paths cross is worth more than one at the edge.
7. **Test your assumptions.** Each mitigation is a hypothesis. Verify the important ones with tests, red-team exercises or security chaos experiments, and update the tree with the results.
8. **Keep it alive.** Revisit the tree after incidents, architecture changes and new findings. An old tree describes a system that no longer exists.

Trees work best when they are built together. A 45-minute session with the people who build and run the system usually finds more than a week of solo work.

## The canvas

| Action | How |
|---|---|
| Select a node | Click it. Its paths light up, the YAML jumps to it, and the inspector opens on the right. |
| Edit a label | Double-click the node, or use the inspector. Enter confirms, Shift+Enter adds a line. |
| Change kind | Use the Fact / Attack / Mitigation / Goal switch in the inspector. |
| Rename an id | Edit **Id** in the inspector. Every reference is updated. |
| Add a node | **Add** in the toolbar. If a node is selected, the new node comes from it. Otherwise a fact or an attack comes from Reality, and a mitigation or a goal starts unconnected. |
| Add the next step | Drag from the handle under a node and drop on empty space. After an attack comes a mitigation, and after anything else comes an attack. |
| Connect two nodes | Drag from the handle under a node and drop it anywhere on the other node. |
| Edit a connection | Click the arrow or its label. The inspector toggles `#yolosec`, backwards and not implemented. |
| Move a node | Drag it. The position is saved in the YAML, and its arrows follow it. |
| Back to automatic layout | **Auto-arrange** in the bottom-right corner, or **Auto** next to "Placed by hand" in the inspector. |
| Delete | Select, then press Delete or Backspace, or use the inspector button. Deleting a node removes every reference to it. |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z (⌘ on macOS). This works on the canvas too, because canvas edits are edits to the YAML. |
| Pan and zoom | Drag the empty canvas to pan. Scroll or pinch to zoom. The bottom-right buttons zoom and fit. |
| Only the diagram | The panel button next to the title hides the YAML editor, and Ctrl/⌘ + \\ toggles it. The choice is remembered. On phones, use the YAML / Canvas tabs. |

While the YAML has a syntax error, the canvas keeps showing the last valid version and becomes read-only until the error is fixed. A banner says where the error is.

## The editor

The editor on the left is the source of truth.

- **Autocomplete:** typing a list item under `from:` or `filter:` suggests node ids, with labels and kinds. Ctrl+Space opens the list.
- **Colors by kind:** ids are colored by kind (attacks pink, mitigations blue, and so on), both where they are declared and where they are referenced.
- **Two-way selection:** moving the cursor into a node or a connection selects it on the canvas.
- **Search:** Ctrl+F (⌘F).

### Diagnostics

Problems are underlined in the editor and counted in the status bar. Click the count to jump to the first one.

| Message | What to do |
|---|---|
| `"x" is not declared in facts, attacks, mitigations or goals` | A `from` or `filter` entry names an id that doesn't exist. It is drawn as a dashed *Undeclared* node. Declare it, or fix the typo. |
| `"x" is already declared as …` | Ids are unique across the whole tree. Rename one. |
| `Each node is written as "- id: label"` | A list item in a section isn't a mapping. |
| `"from" must be a list of node ids` | Write `from:` followed by `- id` lines. |
| `"backwards" must be true or false` | Flags only accept `true` or `false`. |
| `"y" already comes from "x"` | The same connection is listed twice. The duplicate is ignored. |
| `"x" cannot come from itself` | Remove the self-reference. |
| `Unknown section / node property / edge property` | Probably a typo. Unknown keys are ignored. |
| `"x" has a position but is not a node` | A leftover line in `positions`. Delete it. |

## Saving, sharing and exporting

- **Local-first:** trees are saved automatically in this browser (IndexedDB). The dot next to the title turns green when everything is saved. Different browsers, devices and addresses (`localhost` versus a LAN IP, for example) keep separate collections.
- **Share links:** **Share** copies a link with the whole tree compressed into the part of the URL after `#`. Browsers never send that part to the server. Whoever opens the link gets their own copy, saved in their browser. Treat a link like the document itself: anyone who has it can read the tree.
- **Export:** SVG and PNG images include the YAML source inside the file, so **Import** can turn an exported image back into an editable tree. **YAML source** downloads the text.
- **Import:** accepts `.yaml` and `.yml` files, images exported by attacktree, and SVG, PNG and DOT files exported by Deciduous.
- **Backups:** clearing site data erases local trees. Export the YAML of trees you care about, or keep them in a repository.

## Using attacktree with AI

The format is small and regular, which makes it a good fit for language models.

- **Copy for AI** (in the top bar, and **Copy prompt for AI** in the menu next to the title) copies a ready-made prompt: the format rules, the conventions above and the current tree. Paste it into your assistant, then say what you want: "add the insider threat branch", "suggest mitigations for every #yolosec edge", "translate the labels into Portuguese".
- **Pasting answers back:** paste the model's answer straight into the editor. Markdown code fences (```` ```yaml ````) are removed for you. **Import** removes them from files too.
- **Machine-readable docs:** [`/llms.txt`](/llms.txt) and [`/llms-full.txt`](/llms-full.txt) describe the tool and the format in plain text, following the llms.txt convention, and [`/attacktree.schema.json`](/attacktree.schema.json) is the JSON Schema.

Language models are good at proposing branches you hadn't considered and bad at knowing your system. Use them to widen the brainstorm, then keep only what is true for you.

## Coming from Deciduous

attacktree reads Deciduous YAML unchanged, and its own files stay readable by Deciduous.

- **Same format:** `facts`, `attacks`, `mitigations`, `goals`, `from`, edge labels, `backwards`, `implemented`, `filter`, and the implicit `reality` node.
- **Ignored on purpose:** `theme`, `legend` and `dark`. attacktree has its own light and dark themes, plus a legend on the canvas.
- **Extension:** `positions`, for nodes placed by hand. Deciduous ignores it.
- **Images:** SVG, PNG and DOT files exported by Deciduous can be imported, because they carry their source too.
- **Not included:** Graphviz DOT export and Gist import. A share link replaces the Gist workflow.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/⌘ + S | Save now (saving is automatic anyway) |
| Ctrl/⌘ + Z | Undo, in the editor and on the canvas |
| Ctrl/⌘ + Shift + Z, Ctrl + Y | Redo |
| Delete, Backspace | Delete the selected node or connection (canvas) |
| Ctrl/⌘ + \\ | Hide or show the YAML editor |
| Esc | Clear the selection |
| Ctrl + Space | Open autocomplete (editor) |
| Ctrl/⌘ + F | Search (editor) |
| Tab / Shift + Tab | Indent / outdent (editor) |

## FAQ

**Where are my trees stored?**
In this browser's storage for this address. Nothing is sent to a server. Use Share or Export to move a tree elsewhere.

**Someone sent me a link. Did that change their tree?**
No. Opening a share link creates your own copy. Changes are not synchronized.

**The canvas stopped updating.**
The YAML probably has a syntax error. The banner at the top of the canvas and the status bar point to it. The canvas shows the last valid version meanwhile.

**Why are some nodes dashed and labeled "Undeclared"?**
They are referenced in a `from` list but never declared. Declare them in the right section, or fix the id.

**Can I use this for reliability, not security?**
Yes. Use attacks for failure events, mitigations for the controls that contain them (retries, alerts, fallbacks), and goals for the outcomes you want to avoid.

**Who makes attacktree?**
[LESIS](https://lesis.lat/?utm_source=attacktree&utm_medium=docs), a security engineering team: security assessments, security consultancy, due diligence and custom tools, delivered and tracked to closure. Write to them if you want help modeling your own systems.
