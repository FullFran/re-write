# Importing Books from Notion Exports

This guide explains how to import novels and manuscripts into RE;write from a Notion workspace export.

> **Note:** Live Notion API synchronization is **not** part of this tool. This import works entirely offline using Notion's built-in **"Export -> Markdown & CSV"** zip files or extracted folders.

---

## 1. For Writers (e.g. Andrés): Exporting and Inspecting

Non-programmers can export their books from Notion in seconds without sharing their prose before a mapping is configured.

### Step 1: Export from Notion

1. In Notion, navigate to the top-level page or database containing your book (e.g. your "Libros" or "Capítulos" database).
2. Click the `...` menu icon in the top right corner.
3. Select **Export**.
4. In the dialog:
   - **Export format**: `Markdown & CSV`
   - **Include content**: `Everything` (or default)
   - **Include subpages**: Enabled
5. Click **Export**. Notion will generate and download a `.zip` file (e.g. `Export-xxxxxxxx.zip`).

### Step 2: Inspect the Export Safely

Before sending anything, you can safely inspect what databases and pages are inside:

```bash
rewrite notion-inspect /path/to/Export.zip
```

*(You can also run this against an unzipped folder).*

#### Your Manuscript Stays Private
- The inspection **never prints your text, story, or cell values**.
- It only prints database CSV filenames, column headers, row counts, and page filenames with byte sizes.
- The zip reader is strictly read-only and validates file paths safely.

Sample output:

```text
Notion export: /path/to/Export.zip
Databases (1):
  Capítulos.csv (12 rows)
    Columns: Título, Orden, Libro, Estado, Notas
Pages (12):
  El Faro 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md (4,320 bytes)
  La Niebla 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c.md (5,180 bytes)
  ...
```

Notice that not a single sentence of your novel appears. Send this inspection summary (or output of `--json`) to Fran so the mapping can be created.

---

## 2. For Operators (e.g. Fran): Writing a Mapping and Importing

### Declarative Mapping

A mapping tells RE;write which database CSV defines the chapters and which columns to use. Example ([`tests/fixtures/import/example-mapping.json`](../tests/fixtures/import/example-mapping.json)):

```json
{
  "database": "Capítulos.csv",
  "titleColumn": "Título",
  "orderColumn": "Orden",
  "filter": {
    "column": "Libro",
    "value": "El Mar del Norte"
  }
}
```

#### Mapping Fields

- `database`: Name of the CSV file in the export (e.g. `"Capítulos.csv"` or `"Capítulos"`).
- `titleColumn`: *(Optional)* Column containing the chapter title (e.g. `"Título"`, `"Title"`). If omitted, RE;write looks for common title names or falls back to the first column.
- `orderColumn`: *(Optional)* Column containing chapter sequence numbers. If omitted or blank, falls back to the 1-based CSV row order.
- `filter`: *(Optional)* Filter by another column (e.g. if one database holds chapters for multiple books: `{ "column": "Libro", "value": "El Mar del Norte" }`).

### Notion Page File Matching & Header Stripping

- Notion names exported Markdown files using `<Title> <32-hex-id>.md` (for example, `El Faro 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md`). RE;write matches pages by title and ID.
- Notion adds property tables or metadata blocks at the top of page exports (e.g. `Orden: 1`, `Estado: Listo`). RE;write strips these export artefacts cleanly while keeping the `# Title` heading and the story prose.
- If a chapter row in the CSV has no matching Markdown file in the export, it is reported under `refused` as a missing page, without interrupting the other chapters.

### Step 3: Dry Run

Always run a dry run first to verify titles, order, and sizes without modifying the book repository:

```bash
rewrite import-notion /path/to/book /path/to/Export.zip --mapping mapping.json --dry-run
```

Output:

```text
dry run: 2 chapters in /path/to/Export.zip
  [001] El Faro (scenes/001-el-faro.md) - 3,950 bytes
  [002] La Niebla (scenes/002-la-niebla.md) - 4,820 bytes
```

### Step 4: Import

Run the import without `--dry-run`:

```bash
rewrite import-notion /path/to/book /path/to/Export.zip --mapping mapping.json
```

Output:

```text
imported: scenes/001-el-faro.md, scenes/002-la-niebla.md; unchanged: none; refused: none
```

### Idempotency & Safety

- **Stable zero-padded filenames**: Chapters are written to `scenes/001-el-faro.md`, `scenes/002-la-niebla.md`.
- **Idempotent**: Re-running the import with the same export produces zero changes (`unchanged: scenes/...`) and does not create unnecessary git commits.
- **Refuses changed chapters**: If a scene already exists in RE;write with different text (for example, revised by an editor), RE;write refuses to overwrite it, leaving the existing file completely untouched and reporting it under `refused:`.
- **Safe Zip extraction**: The internal zip reader strictly refuses absolute paths, directory traversal (`..`), symlinks, and encryption.
