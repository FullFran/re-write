# Importing Books from Notion Exports

This guide explains how to import novels and manuscripts into RE;write from a Notion workspace export.

> **Note:** Live Notion API synchronization is **not** part of this tool. This import works entirely offline using Notion's built-in **"Export -> Markdown & CSV"** zip files or extracted folders.

---

## 1. For Writers (e.g. Andrés): Importing from the Browser

Writers do not need to install Node, run command-line tools, or configure JSON files. The entire import workflow can be completed directly from the browser at `/review`.

### Step 1: Export from Notion

1. In Notion, navigate to the top-level page or database containing your book (e.g. your "Libros" or "Capítulos" database).
2. Click the `...` menu icon in the top right corner.
3. Select **Export**.
4. In the dialog:
   - **Export format**: `Markdown & CSV`
   - **Include content**: `Everything` (or default)
   - **Include subpages**: Enabled
5. Click **Export**. Notion will generate and download a `.zip` file (e.g. `Export-xxxxxxxx.zip`).

#### Nested ZIP Parts
When a manuscript or workspace is large, Notion's export often produces an outer `.zip` file that contains one or more inner part zips (such as `Export-<uuid>-Part-1.zip` and `Export-<uuid>-Part-2.zip`).

**You do not need to unzip, re-compress, or reorganize anything.** Upload the single downloaded zip file as-is. RE;write automatically detects and unpacks nested zip parts in order.

### Step 2: Upload, Inspect, and Import in the Browser

1. Open RE;write in your browser and sign in at `/review`.
2. Select your book (or create one).
3. In the **"Importar desde Notion"** section, click **"Seleccionar archivo"** and choose your exported `.zip` file (up to 50 MB).
4. Click **"Inspeccionar exportación"**:
   - RE;write checks the archive safely and displays the structure: database CSV files, row counts, column names, and total page count.
   - **Privacy guaranteed**: The inspection **never** displays story text, novel prose, or cell values.
5. In the **"Configurar correspondencia (Mapping)"** form:
   - **Base de datos de capítulos**: Select the database containing your chapter list (e.g. `Capítulos.csv` or `_all.csv`).
   - **Columna de título**: Select the column with chapter titles (e.g. `Título`).
   - **Columna de orden**: Select the chapter sequence column, or choose `"orden de la tabla"` to follow the database's natural row order.
   - **Filtrar por columna (opcional)**: If your database contains chapters for multiple books, select the filter column (e.g. `Libro`) and enter the value to match.
6. Click **"Vista previa"** (dry run):
   - RE;write calculates the chapter order, target scene filenames (`scenes/001-titulo.md`), sizes, and highlights any missing markdown pages without modifying the book repository.
7. Click **"Importar"**:
   - The chapters are imported into the book, committed to Git version control, and become available in the scene browser immediately.
   - Re-running the import on the same export is a harmless no-op (`unchanged`). If an existing chapter was edited in RE;write, the import safely refuses to overwrite it (`refused`).
   - The uploaded zip file is held only in memory for the request duration and is never permanently stored on the server.

---

## 2. For Operators (e.g. Fran): Inspecting, Mapping, and Importing

Operators use the RE;write CLI to inspect the archive safely, create a declarative mapping, preview with a dry run, and import chapters into the book's repository.

### Step 1: Inspect the Export Safely

Run `notion-inspect` on the export zip (or unzipped folder):

```bash
rewrite notion-inspect /path/to/Export.zip
```

#### Safe and Private Inspection
- **Your manuscript stays private**: The inspection **never prints novel text, story prose, or database cell values**.
- It only reports database CSV filenames, column headers, row counts, and page filenames with byte sizes.
- **Nested zips**: If the archive contains nested parts (`Part-1.zip`, `Part-2.zip`), `notion-inspect` traverses inner zips automatically.
- **CSV Pairs (`_all.csv`)**: Notion exports database views as pairs: `<name> <id>.csv` (the active view) and `<name> <id>_all.csv` (the full database). Both are listed so you can see the complete row count.

Sample output:

```text
Notion export: /path/to/Export.zip
Databases (2):
  Capítulos 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.csv (10 rows)
    Columns: Título, Orden, Libro, Estado, Notas
  Capítulos 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d_all.csv (12 rows)
    Columns: Título, Orden, Libro, Estado, Notas
Pages (12):
  El Faro 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md (4,320 bytes)
  La Niebla 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c.md (5,180 bytes)
  ...
```

### Step 2: Configure Declarative Mapping

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
  - **`_all.csv` preference**: When both `<name> <id>.csv` and `<name> <id>_all.csv` exist in the export, RE;write automatically prefers `_all.csv` to capture the complete database without requiring you to type the 32-hex ID.
- `titleColumn`: *(Optional)* Column containing chapter titles (e.g. `"Título"`, `"Title"`). If omitted, RE;write looks for common title names or falls back to the first column.
- `orderColumn`: *(Optional)* Column containing chapter sequence numbers. If omitted or blank, falls back to the 1-based CSV row order.
- `filter`: *(Optional)* Filter by another column (e.g. if one database holds chapters for multiple books: `{ "column": "Libro", "value": "El Mar del Norte" }`).

### Step 3: Dry Run

Always run a dry run first to verify chapter titles, sequence order, and page file matching without modifying the book repository:

```bash
rewrite import-notion /path/to/book /path/to/Export.zip --mapping mapping.json --dry-run
```

Sample output:

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

Sample output:

```text
imported: scenes/001-el-faro.md, scenes/002-la-niebla.md; unchanged: none; refused: none
```

---

## 3. Idempotency and Security Guarantees

- **Nested ZIP Support**: Supports one level of inner ZIPs (`Part-1.zip`, `Part-2.zip`) in natural order, sharing the total size and member limits.
- **Zip Bomb & Archive Hardening**:
  - Inflates deflated entries with `maxOutputLength` matching declared size to prevent decompression expansion attacks.
  - Refuses members where output length differs from declared uncompressed size.
  - Verifies CRC-32 checksums from central directory headers on every decompressed entry.
  - Validates local file header signatures and ensures local header name and extra fields keep data offsets safely within buffer boundaries.
  - Rejects absolute paths, directory traversal (`..`), symlinks, and encryption.
- **UTF-8 Name Handling**: Respects general purpose flag bit 11 (Language Encoding Flag) for UTF-8 filenames, supporting accented titles and special characters (`á`, `é`, `í`, `ó`, `ú`, `ñ`) seamlessly.
- **Header Stripping**: Cleans Notion property metadata tables at the top of markdown files while preserving `# Title` headers and body prose (even paragraphs containing colons).
- **Stable Scene Naming**: Generates zero-padded, slugified filenames (`scenes/001-el-faro.md`).
- **Idempotent**: Re-running the import with the same export produces zero changes (`unchanged: scenes/...`) without creating extra commits.
- **Refuses Changed Chapters**: If a scene file already exists in RE;write with different text (e.g. edited by an author or reviewer), RE;write refuses to overwrite it, reporting it under `refused:` and keeping disk state intact.
