# Importing Books from SQLite

This guide explains how to import whole books into RE;write from a SQLite database file (for example, from desktop novel-writing or note-taking applications).

It has two sections:
1. **For writers (like Andrés)**: How to safely share the structure of your database without sharing your book's text or story.
2. **For technical operators (like Fran)**: How to write a declarative mapping, test with `--dry-run`, and run the import.

---

## 1. For Writers: Inspecting Your Database Safely

If your writing tool saves your novel in a SQLite database, RE;write needs to know how the tables and columns are organized (its schema) in order to import it.

### Your Words Stay Private

You do **not** need to send your manuscript. The `inspect-sqlite` command:
- **Never prints your text**: It inspects only structural metadata: table names, column names, column data types, row counts, and character length ranges (min/avg/max).
- **Checks formatting without revealing content**: It checks whether text looks like HTML, RTF, Markdown, or plain text, without printing any words or sentences.
- **Opens the database strictly read-only**: It cannot modify, corrupt, or alter your file in any way.

### How to Run the Inspection

Run:

```bash
rewrite inspect-sqlite /path/to/tu-novela.sqlite
```

You can save the output to a file or copy and paste it:

```bash
rewrite inspect-sqlite /path/to/tu-novela.sqlite > inspeccion.txt
```

Or for machine-readable JSON:

```bash
rewrite inspect-sqlite /path/to/tu-novela.sqlite --json > inspeccion.json
```

### What the Output Looks Like

```text
database: /path/to/tu-novela.sqlite
tables:
  chapters (12 rows)
    chapter_num INTEGER (primary key)
    book_id INTEGER
    title TEXT: length min 7, avg 15, max 32; format: plain text
    content TEXT: length min 1200, avg 4350, max 9800; format: HTML
    format TEXT: length min 4, avg 4, max 4; format: plain text
  metadata (2 rows)
    key TEXT (primary key): length min 6, avg 6, max 7; format: plain text
    value TEXT: length min 3, avg 4, max 6; format: plain text
```

Notice that not a single word of your story appears in this output. Send `inspeccion.txt` or `inspeccion.json` to Fran.

---

## 2. For Technical Operators: Writing a Mapping and Importing

Once you receive the schema inspection, create a declarative JSON mapping file that tells RE;write which table and columns contain the book's chapters.

### Mapping Schema

An example mapping is stored in [`tests/fixtures/import/example-mapping.json`](../tests/fixtures/import/example-mapping.json):

```json
{
  "table": "chapters",
  "columns": {
    "order": "chapter_num",
    "title": "title",
    "body": "content",
    "format": "format"
  },
  "filter": "book_id = 1",
  "orderBy": "chapter_num ASC",
  "defaultFormat": "markdown"
}
```

#### Fields

- `table`: The name of the table or view containing the chapters.
- `columns`:
  - `order`: Column containing the sequence number of the chapter (e.g. `1`, `2`, `3`). RE;write zero-pads this for file naming (`001`, `002`).
  - `title`: Column containing the chapter title (e.g. `"El Faro"`). Slugs are generated automatically (`001-el-faro.md`).
  - `body`: Column containing the text content of the chapter.
  - `format`: *(Optional)* Column containing the format of the body: `"markdown"`, `"plain"`, or `"html"`.
- `defaultFormat`: *(Optional)* Fallback format if `format` column is omitted or null in a row (`"markdown"`, `"plain"`, or `"html"`). Defaults to `"markdown"`.
- `filter`: *(Optional)* SQL `WHERE` clause condition (e.g. `"book_id = 1"`).
- `orderBy`: *(Optional)* SQL `ORDER BY` clause (e.g. `"chapter_num ASC"`).
- `query`: *(Optional alternative)* A complete `SELECT` query if complex joins or expressions are needed. When `query` is used, `table`, `filter`, and `orderBy` are omitted.

### Supported and Unsupported Formats

- **Markdown (`markdown`)**: Kept as-is, with line endings normalized.
- **Plain text (`plain`)**: Normalizes line breaks and paragraph spacing.
- **HTML (`html`)**: Converted conservatively to Markdown:
  - Headings (`<h1>`..`<h6>`) become `#`..`######`.
  - Paragraphs (`<p>`) and line breaks (`<br>`) are preserved as Markdown paragraphs and breaks.
  - Emphasis (`<strong>`, `<b>`, `<em>`, `<i>`) becomes `**` and `*`.
  - HTML entities (`&laquo;`, `&mdash;`, `&aacute;`, numeric entities) are decoded.
  - Scripts (`<script>`), styles (`<style>`), and unknown tags are stripped. Scripts are **never executed or retained**.
- **RTF and other formats**:
  > **Important:** RTF (Rich Text Format) and proprietary formats (DOCX, EPUB) are **not converted yet** and will fail with a clear error:
  > `unsupported format: "rtf". Only markdown, plain, and html are supported.`
  > If the inspection reports RTF format in the body column, an RTF conversion adapter must be added before importing.

### Step 1: Dry Run

Always run a dry run first. The database is opened read-only and no files or git commits are created in the book repository:

```bash
rewrite import-sqlite /path/to/book /path/to/novel.sqlite --mapping mapping.json --dry-run
```

Output:

```text
dry run: 3 chapters in /path/to/novel.sqlite
  [001] El Faro (scenes/001-el-faro.md) - 1420 bytes (html)
  [002] La Niebla (scenes/002-la-niebla.md) - 2350 bytes (plain)
  [003] El Regreso (scenes/003-el-regreso.md) - 980 bytes (markdown)
```

### Step 2: Running the Import

When the dry run looks correct, run the import without `--dry-run`:

```bash
rewrite import-sqlite /path/to/book /path/to/novel.sqlite --mapping mapping.json
```

Output:

```text
imported: scenes/001-el-faro.md, scenes/002-la-niebla.md, scenes/003-el-regreso.md; unchanged: none; refused: none
```

### Idempotency and Refusal Rules

- **Idempotent**: Re-importing the same database against the same book is a safe no-op. Chapters with identical content are reported under `unchanged:` and no new git commit is made.
- **Changed chapters are refused**: If a chapter already exists in the book with different text (for example, if an author or editor has revised it in RE;write), the import refuses to overwrite it:
  `scenes/001-el-faro.md already exists with different text; edit it through a proposal`
  Nothing is partially written for that chapter, preserving the author's work.
