# Notes, wikilinks and the story graph

Book notes hold the characters, places, objects and plot threads of a book. Notes and scenes link
to notes with Obsidian-style wikilinks, and the links form a story graph that both the writer and
the assistant can query. This is slice 1 of [#115](https://github.com/FullFran/re-write/issues/115):
storage, links, backlinks, the graph core and the read-only MCP tools. Slice 2 adds the links in the
editor, the notes and their backlinks in the page, the graph as data and its list view
([design](design.md#notes-wikilinks-and-the-graph-list)). Slice 3 adds the graph drawing and its
operations ([below](#the-graph-drawing), [design](design.md#the-graph-drawing-and-análisis)).

## Notes

- **Storage.** One Markdown file per note in `notas/` of the book repository, next to `scenes/`.
  Notes are versioned in the same git history and covered by the same backups. Only regular files
  directly inside a real `notas/` directory count: a symlinked file or a symlinked `notas/` is never
  read, so a note cannot point outside the book.
- **Name.** A note's name is its file name without `.md`, and it is what a wikilink names. A name
  cannot be empty or padded with spaces, start or end with a dot, hold two dots in a row, hold
  control characters, invisible characters (zero-width, direction marks, soft hyphen, private-use
  and unassigned code points, and similar), whitespace other than a plain space, `/`, `\`, `:`, or
  the characters that end or split a wikilink (`[`, `]`, `|`, `#`, `^`), and the file name is at
  most 255 bytes. A new note is refused when its name differs from an existing note only by case
  or accents (`Elena` and `elena` would collide on case-insensitive file systems and in links).
- **Frontmatter.** An optional leading block between `---` lines. RE;write reads two keys with a
  small, strict reader (no YAML library):
  - `type`: one of `personaje`, `lugar`, `objeto`, `trama`, `otra`;
  - `aliases`: a flow list `[la capitana, "Elena, la de Sal"]` or lines starting with `- `.

  Every other key is ignored and never rewritten. A malformed supported key is reported in the
  note's `problems` and that key is left unset; the note is still usable. A block that never closes
  is reported and the whole file is read as body.

### Who writes notes

Notes change only in the two ways scenes do:

1. **A proposal a person accepts.** An assistant proposes a new note with `propose_note` (the whole
   text) or a change to an existing note with `propose_revision` on its `notas/<name>.md` file. The
   proposal shows in the review page like any other, as a diff (a new note diffs against an empty
   file). Accepting a new note writes the file and the proposal record in one commit, and only if no
   file with that name exists by then, no note differs from it only by case or accents, and the file has no uncommitted change
   (such as a committed note deleted in the working tree): it never overwrites. A note creation cannot be reverted or proposed again automatically yet; change it
   with a new proposal.
2. **A person's own edit**, through the review door, with the same rules as a scene edit: it applies
   only on top of the version the person opened (`blob`), refuses uncommitted local edits, and goes
   into one commit that touches only that note. In the page, **Notas** in Concentración or Ayuda
   opens a note in the scene editor, which saves it through the same code as a scene.

## Wikilinks

`[[Nota]]`, `[[Nota|texto]]`, `[[Nota#Sección]]` and `[[Nota#Sección|texto]]`, in notes (outside
the frontmatter) and in scene prose. Each link carries its 1-based line and column (in UTF-16 code
units, the editor's unit).

- Skipped: anything inside a code span or a fenced code block (```` ``` ```` or `~~~`; an unclosed
  fence hides the rest of the text, as a Markdown renderer does); embeds `![[...]]`; block
  references `[[Nota#^id]]`; empty targets; a link with a line break or a `[` or `]` inside. Text
  after a skipped link is still parsed. Indented code blocks are not treated as code, because
  fiction often indents paragraphs.
- **Resolution.** The target is compared with note names and aliases after folding: Unicode NFD,
  combining marks removed, lower case, whitespace runs collapsed to one space, trimmed (no
  transliteration: `ß` stays `ß`). A note name wins over another note's alias. When two notes match
  the same way the link is **ambiguous** and is reported with its candidates, never guessed. A link
  that matches nothing is **unresolved**; `list_notes` lists both kinds with how often they occur
  and where they first appear.

## Backlinks

For each note:

- **Linked mentions**: every resolved link to it, in notes (by name) and then scenes (in reading
  order), with the sentence around the link.
- **Unlinked mentions**: the note's name or an alias written as plain text, compared folded like
  names, as whole words (not inside a longer word), outside links and code, and not in the note
  itself. The longest match wins when two overlap.

The sentence runs from the previous sentence end (`.`, `!`, `?` or `…` before a space) or line
break to the next one. It is cut around the mention to at most 240 characters, with `…` where it
was cut. Abbreviations such as "Sr." end a sentence early; this only shortens the context.

## The story graph

A pure, dependency-free module (`src/domain/story-graph.ts`) builds the graph from the texts:

- **Nodes**: every note (`note:<name>`, with its `type`) and every scene (`scene:<path>`, with its
  1-based reading `order`).
- **Edges**: `mention` (scene to note, weight = links in that scene), `link` (note to note, weight =
  links; a note linking itself is left out) and `cooccurs` (two notes linked from the same scene,
  from the smaller id to the larger, weight = scenes they share).
- **`as_of_scene`**: keeps the scenes up to and including that scene in reading order, with the
  `mention` and `cooccurs` edges they bring. Notes and `link` edges are always kept. Reading order
  is the order `list_scenes` and the review page already use: scene paths sorted, which for
  imported books is chapter order (`scenes/001-...`, `scenes/002-...`).
- **Operations** (edges taken in both directions, any kind): neighbours within depth *k*, a shortest
  path (BFS, fewest steps), degree (distinct neighbours) and the degree ranking, connected
  components, and orphans (notes with no edge at all).
- **Paragraph co-occurrence** (on request): every `cooccurs` edge gains a second weight,
  `paragraphs`, the number of scene paragraphs that link both notes. A paragraph is a run of lines
  with text; a line that is empty or holds only spaces (`\r\n` included) separates paragraphs. A
  pair that shares a scene but never a paragraph keeps its edge with `paragraphs: 0`, so a view can
  weigh by scene (`weight`) or by paragraph (`paragraphs`) and filter out the zeros.

### Who knows what

Claims with `knowledge` (holder, fact and mode: `displays`, `acquires` or `hears`) become `knows`
edges, one per claim, from the holder's note to the subject's note: `{ kind: "knows", from, to,
mode, fact, scene, claim_id, story_time, editorial_status }`, where `scene` is the claim's
`source_file`, the scene whose text establishes the knowledge.

- **Names.** Holder and subject are free text and resolve exactly like a link (name, then alias,
  folded). A name that matches no note is listed in `unresolved`, one that matches several in
  `ambiguous` with its candidates (`{ claim_id, role: "holder" | "subject", name, scene }`); such a
  claim gives no edge. Nothing is guessed. Edges connect notes only: a subject that is not a note
  (an event, an object nobody wrote a note for) is reported rather than drawn as a separate node, so
  the fix is the author's (write the note or add an alias), and the graph keeps its two node kinds.
- **Which claims.** Proposed and accepted claims count, each edge saying which; rejected claims do
  not. A claim on a scene that no longer exists is left out.
- **`as_of_scene`.** Only claims whose scene is at or before the cut in reading order count, and
  the problems of later claims are hidden too, since they would reveal later knowledge.
- `knows` edges are listed apart from `edges`: they come from claims, not from links, and the
  graph operations below do not walk them.

### Operations in the server

Besides the operations above, `src/domain/story-graph.ts` computes, with no dependency and a fixed
order:

| Operation | Definition | Cost |
| --- | --- | --- |
| PageRank | Edges point the way they are written (`link` note to note, `mention` scene to note), `cooccurs` both ways, parallel edges once, unweighted; damping 0.85; a node with no outgoing edge spreads its rank over all nodes. Rounded to 6 decimals. | at most 100 iterations of O(nodes + edges) |
| Betweenness | Brandes on the undirected graph (any edge, once per pair of neighbours): for each pair of other nodes, the share of their shortest paths through the node, each unordered pair counted once, not normalised. Rounded to 6 decimals. | O(nodes × (nodes + edges)) |
| Link suggestions | Pairs of notes with at least one shared neighbour (a scene that links both, a note linked to both, a note they co-occur with) and no `[[link]]` between them in either direction. **Adamic-Adar** sums `1 / ln(degree)` over the shared neighbours, so a rare shared neighbour weighs more than a hub; **Jaccard** is shared neighbours over all neighbours of the pair. Each suggestion gives `common` (shared neighbours), `via` (the first five by id) and, in the application layer, up to three `anchors`. | the sum of the squared degrees of the neighbours visited |

Rankings and suggestions go highest score first, then by id (suggestions: more shared neighbours
first, then ids). With a node, suggestions are its best `top` partners (`from` is that note);
without, the best `top` pairs of the book (`from` < `to`). A pair that only co-occurs is still a
candidate: sharing scenes without a link is exactly what a suggestion points out. (The drawing below computes
its own suggestions in the browser over the graph as drawn, with a different candidate set.)

**Work cap.** Betweenness and suggestions are not linear, so each counts its steps before or
while working and refuses a graph above 25,000,000 steps (`MAX_GRAPH_WORK`) with a message that
names the operation and points to degree or PageRank, instead of holding the single-threaded
server. Below it, a book of a few thousand notes and scenes answers within the request. The text
cap above still bounds the graph's size; PageRank and `knows` edges are linear.

**Anchors.** An anchor is a plain-text mention of one note in the other's note file (`{ file,
line, column, text, context }`), found like an unlinked mention: the literal passage an assistant
can turn into a link.

**Cost.** Every pass is linear in the text: one forward scan finds code ranges and links, positions
come from precomputed line starts, exclusions are checked by binary search, and sentence boundaries
are found once per text. A note or scene longer than 2,097,152 characters (twice the largest scene
a person can save) is not parsed at all: it is reported in `too_large` by `list_notes` and its
links and mentions are not counted, so one text cannot hold the server. Backlinks return at most
500 mentions of each kind, with `linked_total` and `unlinked_total` counting them all (`read_note`
returns the first 100).

Every list has a fixed order (ids compared by UTF-16 code unit, ties broken by id), so the same
book always gives the same answer. The graph is rebuilt from the files on each call (linear in the
size of the book) instead of cached, so it is never stale after an edit made outside RE;write.

## Where to read it

| Door | What |
| --- | --- |
| MCP (read-only, capability `com.fullfran.rewrite.notes.read@1`) | `list_notes`, `read_note`, `graph_neighbors` (`knows: true` adds the `knows` edges that touch the nodes reached, with the book's `unresolved` and `ambiguous` names, 100 of each at most), `graph_orphans`, `graph_path`, `graph_central` (`metric: degree`, `pagerank` or `betweenness`), `graph_suggest_links` (`node?`, `top?` up to 50, `as_of_scene?`; Adamic-Adar) |
| MCP (proposes, capability `com.fullfran.rewrite.revision.propose@1`) | `propose_note`, and `propose_revision` on a `notas/` file |
| Review door | `GET /review/api/books/:book/notes`, `GET /review/api/books/:book/notes/:name`, `POST /review/api/books/:book/notes/:name` (a person's edit: `{ text, base_blob }`), `GET /review/api/books/:book/graph[?as_of_scene=<scene path>]` |

`GET .../graph` returns the graph as data, read-only: `nodes` (each with `id`, `kind`, `name`,
`type`, `order`, `degree`, and `scenes`, the number of scenes that mention a note, `null` for a
scene), `edges` (`kind`, `from`, `to`, `weight`), `scenes` (every scene path in reading order,
whatever the cut, so a picker can offer them all), `as_of_scene` and `too_large`. An unknown
`as_of_scene` is a `400` that names it. It is built from the same core as the MCP tools.

Optional query parameters add more, only when asked; without them the answer has exactly the fields
above:

| Parameter | Adds |
| --- | --- |
| `metrics=pagerank,betweenness` (either or both) | `pagerank` and `betweenness` on every node |
| `include=knows,paragraphs` (either or both) | `knows` (`{ edges, unresolved, ambiguous }`, see "Who knows what") and the `paragraphs` weight on `cooccurs` edges |
| `suggest=adamic_adar` or `suggest=jaccard`, with `top=1..50` (default 10) | `suggestions: { metric, items }`, the best pairs of the book with their anchors |

Every one respects `as_of_scene`. An unknown value, a `top` out of range, or a graph above the
work cap is a `400` that names the problem.

### From a suggestion to a link

A suggestion never writes. The recommended assistant flow:

1. `graph_suggest_links` (with `node` when the person asks about one note) and show the person the
   pairs and why (`via`).
2. Only if the person wants a link: take an anchor and call `propose_revision` with `file` = the
   anchor's `file`, `find` = its `context` copied exactly, and `replace` = the same text with the
   name written as `[[Nota]]`. Without an anchor, `read_note` one of the two notes and pick a
   literal sentence to extend, for example with "Ver [[Nota]].".
3. The person accepts or rejects the proposal at the review page. Once accepted, the pair has a
   link and is no longer suggested.

There is no other write path: the same proposal flow as any change to a note.

A node in the graph tools is named like a link (a note name or alias, case and accents ignored) or
by a scene path. An ambiguous or unknown name is refused with the next step (`list_notes`). The
tools that return note or manuscript text say that it is data, not instructions.

## The graph drawing

The Grafo panel draws the graph data of `GET .../graph` with [sigma.js](https://www.sigmajs.org)
over [graphology](https://graphology.github.io), all pinned in `editor/package.json` and bundled
by the editor's esbuild build. The operations run in the browser on the graph as drawn (after the
filters), as one undirected graph whose edge between two nodes sums the weights of every typed
edge between them:

| Operation | How |
| --- | --- |
| Degree | distinct neighbours |
| PageRank | `graphology-metrics`, weighted |
| Betweenness | `graphology-metrics`, unweighted, normalised |
| Communities | Louvain (`graphology-communities-louvain`), weighted, with a fixed seed so the same graph always splits the same way |
| Shortest path | fewest steps (`graphology-shortest-path`) |
| Components, orphans | breadth-first search by hand |
| Link suggestions | Adamic-Adar over pairs of notes not joined by any edge; a neighbour with more than 200 connections is skipped, which keeps the pass near linear |
| Layout | ForceAtlas2 (`graphology-layout-forceatlas2`) in a web worker |

Ties are broken by id. Link suggestions are only listed; turning one into a link is a note edit or
an assistant proposal, as for any other text.

**Loading.** The editor module (`/review/editor.js`) does not contain the drawing. The build
writes it and its layout worker as chunks with a content hash in their names
(`editor/dist/chunks/graph-view-<hash>.js`, `layout-worker-<hash>.js`) and lists them in
`editor/dist/manifest.json`. The server reads the manifest once at startup and serves
`/review/chunks/<name>` only for a plain file name listed there and present on disk, with the
editor module's content type, caching (`no-cache` plus an ETag) and CSP; any other name, a dot
segment or an encoded slash is `404`, and no request path reaches the file system. The editor
imports the chunk by the exact name it was built with, the first time a person turns the drawing
on. Without the chunk the drawing says so and the table and the editor work as before.

**Performance.** Positions are kept for the page's lifetime per book and node, so changing a
filter only lays out the new nodes, and the layout runs off the main thread (in the page, with
fewer iterations, only if no worker can start). Choosing a node marks its row first and redraws
the drawing's marks a frame later, without moving the camera; the layout's result is applied in
one update, so the drawing redraws once. The browser job measures a synthetic graph of 2,000
notes and about 6,000 connections (`browser-tests/tests/graph-view.spec.ts`) and prints the times
(`graph performance {...}` in the job log): to draw, to lay out, the first choice, later choices
(row and drawing, each under 1 s) and a filter (under 5 s). The job has no GPU: WebGL runs on
SwiftShader, where a frame of that graph takes about 80 ms but each new drawing state is compiled
on first use, which makes the first frames take seconds there. Those first-use times are printed,
not asserted; on a machine with a GPU they do not occur.

## Exports

Wherever the manuscript is exported as text, links become their shown text with `displayText`
(`src/domain/wikilink.ts`): `[[Elena|la capitana]]` becomes `la capitana`, `[[Elena]]` becomes
`Elena`, `[[Sal#Puerto]]` becomes `Sal`; code and embeds stay as written. Today RE;write has no
manuscript text export: the only export is the findings JSON, whose quotes are literal evidence and
are never transformed, because a quote must match the scene text exactly. A future text export must
use `displayText`.
