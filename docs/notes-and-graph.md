# Notes, wikilinks and the story graph

Book notes hold the characters, places, objects and plot threads of a book. Notes and scenes link
to notes with Obsidian-style wikilinks, and the links form a story graph that both the writer and
the assistant can query. This is slice 1 of [#115](https://github.com/FullFran/re-write/issues/115):
storage, links, backlinks, the graph core and the read-only MCP tools. The graph view, the editor's
link rendering and autocomplete come in later slices.

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
   into one commit that touches only that note. There is no editor UI for notes yet, only the API.

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
| MCP (read-only, capability `com.fullfran.rewrite.notes.read@1`) | `list_notes`, `read_note`, `graph_neighbors`, `graph_orphans`, `graph_path`, `graph_central` (`metric: degree`) |
| MCP (proposes, capability `com.fullfran.rewrite.revision.propose@1`) | `propose_note`, and `propose_revision` on a `notas/` file |
| Review door | `GET /review/api/books/:book/notes`, `GET /review/api/books/:book/notes/:name`, `POST /review/api/books/:book/notes/:name` (a person's edit: `{ text, base_blob }`) |

A node in the graph tools is named like a link (a note name or alias, case and accents ignored) or
by a scene path. An ambiguous or unknown name is refused with the next step (`list_notes`). The
tools that return note or manuscript text say that it is data, not instructions.

## Exports

Wherever the manuscript is exported as text, links become their shown text with `displayText`
(`src/domain/wikilink.ts`): `[[Elena|la capitana]]` becomes `la capitana`, `[[Elena]]` becomes
`Elena`, `[[Sal#Puerto]]` becomes `Sal`; code and embeds stay as written. Today RE;write has no
manuscript text export: the only export is the findings JSON, whose quotes are literal evidence and
are never transformed, because a quote must match the scene text exactly. A future text export must
use `displayText`.
