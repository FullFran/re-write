# Book structure

A book is its scene files (`scenes/*.md`) plus an optional manifest that says in which order they
are read, which chapter each sits in, what each is called on screen, and which are archived.

Scene files never move or get renamed: findings, claims and proposals anchor to scene paths and git
versions. Reorganising the book only edits `.rewrite/book.json`.

## Manifest: `.rewrite/book.json`

```json
{
  "version": 1,
  "chapters": [
    { "id": "c1", "title": "La llegada", "scenes": ["scenes/puerta.md", "scenes/lluvia.md"] }
  ],
  "loose": ["scenes/epilogo.md"],
  "titles": { "scenes/puerta.md": "La puerta" },
  "archived": ["scenes/borrador-viejo.md"]
}
```

- `chapters`: in reading order. `id` is stable (`c1`, `c2`, ...), `title` is the display title, `scenes` are
  scene paths in reading order.
- `loose`: scenes outside any chapter, in reading order. They come after every chapter.
- `titles`: display title by scene path. A scene without one shows its first Markdown heading, else its file name.
- `archived`: scenes taken out of the book. They are not in `Project.scenes()`, the graph, exports or the MCP scene
  list, but the files stay, and their findings, claims and proposals keep working and can be opened by path.

## Reading order

`Project.scenes()` is the single source of book order: every chapter's scenes, then `loose`, then any scene the
manifest does not list (for example one added by `import`) in sorted-path order. Entries whose file no longer
exists, repeated entries, archived scenes and paths that are not a regular `scenes/*.md` file are ignored.
Without a manifest the order is the sorted `scenes/*.md`, as before, so imported books (`scenes/001-...`) keep
working unchanged. A manifest that is not valid JSON is treated as absent, and structural writes are refused
until it is fixed.

`Project.outline()` returns the structure for display and export: `{ version, chapters: [{ id, title, scenes:
[{ file, title }] }], loose, archived }`. `title` is the manifest title or null. Reading order is the chapters'
scenes followed by `loose`, i.e. exactly `scenes()`. `Project.archivedScenes()` lists the archived files.

## Changing the structure

Person-only, through the review door (`POST /review/api/books/:id/structure`), never through MCP. Each call is
one operation, one git commit (`rewrite: <summary>` with an `Edited-by:` trailer) that touches the manifest and,
for a new scene, the new file.

The body carries `version` (the `version` of the tree the person saw: a hash of the manifest file, or `"none"`
before the first write) and `op`:

| `op` | fields |
| --- | --- |
| `create_scene` | `title`, `chapter` (id, or omitted for the end of the book), `position`, `heading` (write `# title`) |
| `retitle_scene` | `file`, `title` |
| `archive_scene`, `unarchive_scene` | `file` (restoring puts the scene at the end) |
| `create_chapter` | `title`, `position` |
| `retitle_chapter` | `chapter`, `title` |
| `remove_chapter` | `chapter` (only when empty) |
| `move_scene` | `file`, `chapter` (id or null), `position` |
| `move_chapter` | `chapter`, `position` |

A different `version` than the current one is refused with 409 and the current tree; nothing is written. Titles
are trimmed, 1 to 120 characters, without control characters. A new scene's path is `scenes/<slug>.md` from the
title (lowercase, no accents), numbered when taken; it never replaces a file. Nothing deletes a scene.

`GET /review/api/books/:id/tree` returns the tree with display titles and word counts (per scene, per chapter,
and the total of active scenes).
