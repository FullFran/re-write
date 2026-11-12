# Exporting the manuscript

A novelist who writes in RE;write must be able to take the whole book out, in a form Word or any
Markdown tool opens. The export reads the book and changes nothing: it makes no commit and writes
no file inside the book.

## What goes in

- **Title page**: the book title (`Project.title()`).
- **Scenes in book order**: `Project.scenes()` today (the sorted scene paths). The compile step is
  a pure function over an ordered outline, `[{ title?, scenes: [{ file, title?, text }] }]`
  (`src/domain/manuscript.ts`), so book structure with chapters only has to produce that outline.
  A part with a `title` is a chapter and gets a heading; a part without one is just its scenes.
- **Scene text as written.** Markdown is kept in the `.md` export. Wikilinks become their shown
  text with `displayText` (`src/domain/wikilink.ts`): `[[Elena|la capitana]]` is `la capitana`,
  `[[Elena]]` is `Elena`, `[[Sal#Puerto]]` is `Sal`. Code and embeds stay as written.
- **Notes (`notas/`) are not part of the manuscript** and are never read. Scenes with only blank
  text are skipped, so no scene break is left dangling.

## Scene separators

- A chapter (a titled part) starts with a heading: `## Title` in Markdown, Heading 1 on a new page
  in Word. The book title is `# Title` / the Title style.
- Between two scenes of the same part there is a scene break, the conventional `* * *`: on its own
  line in Markdown (a thematic break), and a centred paragraph in Word.
- A scene break typed inside a scene (`***`) is a thematic break too: it stays as written in
  Markdown and becomes the same centred `* * *` in Word.

## Markdown output

```
# El Puente de Sal

First scene text.

* * *

Second scene text.
```

## Word (.docx) output

No dependency: a minimal WordprocessingML package (`[Content_Types].xml`, `_rels/.rels`,
`word/document.xml`, `word/styles.xml`, `word/numbering.xml`, `docProps/core.xml`) zipped by the
writer in `src/adapters/zip.ts`. The output is deterministic.

Supported Markdown, as the editor writes it: headings (Heading 1 to 3; deeper levels use Heading 3),
paragraphs, **bold**, *italic*, ***both***, ~~strikethrough~~, bullet and numbered lists (three
levels, each numbered list restarts at 1), block quotes (Quote style), line breaks (every newline
inside a paragraph is kept as a line break, as the editor shows it; a trailing backslash or two
spaces are accepted and removed), scene breaks and code (code and fenced blocks become plain text lines). Anything else
(tables, raw HTML, images, links) stays as plain text and is never dropped: a link `[text](url)`
becomes `text (url)`. Control characters that XML 1.0 forbids are removed; `& < > "` are escaped.

## Where to find it

- **Review page**: the **Exportar libro** buttons in the writing desk's head, **Markdown** and
  **Word**. Any member of the book can download.
- **HTTP**: `GET /review/api/books/<id>/export?format=md|docx` for a member; the answer is an
  attachment named from the book title (`El-Puente-de-Sal.docx`). Without `format` the same URL
  keeps answering with the findings JSON, as before. A non-member gets the answer of a book that
  does not exist; an unknown format is a 400.
- **CLI**: `rewrite export <dir> --format md|docx --out <file>`.

There is no agent or MCP tool for this: an export is a person's act.
