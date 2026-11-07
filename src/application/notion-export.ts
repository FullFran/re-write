import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { readZip } from '../adapters/zip.ts';
import type { ChapterInput } from './book-import.ts';

export interface NotionExportFile {
  name: string; // normalized path with forward slashes
  size: number;
  readText: () => string;
}

export interface NotionMapping {
  database: string;
  titleColumn?: string;
  orderColumn?: string;
  filter?: {
    column: string;
    value: string;
  } | Record<string, string>;
}

export interface DatabaseInspection {
  name: string;
  rowCount: number;
  columns: string[];
}

export interface PageInspection {
  name: string;
  size: number;
}

export interface NotionInspectionReport {
  source: string;
  databases: DatabaseInspection[];
  pages: PageInspection[];
}

export interface LoadedNotionChapter extends ChapterInput {
  pageFile?: string;
}

export interface LoadedNotionExport {
  chapters: LoadedNotionChapter[];
  missing: { order: number; title: string; file: string; reason: string }[];
}

/**
 * Loads all files from either a ZIP file buffer, a ZIP file on disk, or an extracted directory.
 */
export function loadNotionExportFiles(source: string | Buffer): NotionExportFile[] {
  if (Buffer.isBuffer(source)) {
    const zipEntries = readZip(source);
    return zipEntries
      .filter((e) => !e.isDirectory)
      .map((e) => ({
        name: e.name,
        size: e.size,
        readText: () => e.getData().toString('utf8'),
      }));
  }

  if (!existsSync(source)) {
    throw new Error(`Notion export not found: ${source}`);
  }

  const stat = statSync(source);
  if (stat.isDirectory()) {
    const results: NotionExportFile[] = [];
    const walk = (currentDir: string): void => {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          if (entry.name.toLowerCase().endsWith('.zip')) {
            try {
              const zipBuf = readFileSync(fullPath);
              const zEntries = readZip(zipBuf);
              for (const ze of zEntries) {
                if (!ze.isDirectory) {
                  results.push({
                    name: ze.name,
                    size: ze.size,
                    readText: () => ze.getData().toString('utf8'),
                  });
                }
              }
            } catch {
              // ignore invalid zip in folder
            }
          } else {
            const relName = relative(source, fullPath).replace(/\\/g, '/');
            const size = statSync(fullPath).size;
            results.push({
              name: relName,
              size,
              readText: () => readFileSync(fullPath, 'utf8'),
            });
          }
        }
      }
    };
    walk(source);
    return results;
  }

  // ZIP archive
  const buffer = readFileSync(source);
  const zipEntries = readZip(buffer);
  return zipEntries
    .filter((e) => !e.isDirectory)
    .map((e) => ({
      name: e.name,
      size: e.size,
      readText: () => e.getData().toString('utf8'),
    }));
}

/**
 * RFC 4180 compliant CSV parser that handles commas, quotes, and multiline values.
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // Strip UTF-8 BOM if present
  let clean = text;
  if (clean.charCodeAt(0) === 0xfeff) {
    clean = clean.slice(1);
  }

  const lines: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuote = false;
  let i = 0;

  while (i < clean.length) {
    const char = clean[i];

    if (insideQuote) {
      if (char === '"') {
        if (i + 1 < clean.length && clean[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
          continue;
        } else {
          // End quote
          insideQuote = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    }

    if (char === '"') {
      insideQuote = true;
      i++;
    } else if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
      i++;
    } else if (char === '\r') {
      if (i + 1 < clean.length && clean[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentField);
      lines.push(currentRow);
      currentRow = [];
      currentField = '';
      i++;
    } else if (char === '\n') {
      currentRow.push(currentField);
      lines.push(currentRow);
      currentRow = [];
      currentField = '';
      i++;
    } else {
      currentField += char;
      i++;
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    lines.push(currentRow);
  }

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = lines[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let r = 1; r < lines.length; r++) {
    const row = lines[r];
    // Skip empty lines at end
    if (row.length === 1 && !row[0].trim()) continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c] ?? '';
    }
    rows.push(obj);
  }

  return { headers, rows };
}

/**
 * Strips Notion's property header block at the top of an exported page markdown file.
 * Preserves the initial # Title (if present) and the actual markdown body prose.
 */
export function stripNotionPropertyHeader(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let i = 0;

  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return '';

  let titleLine = '';
  if (lines[i].startsWith('# ')) {
    titleLine = lines[i];
    i++;
  }

  let seenProperty = false;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (seenProperty) {
        // End of property block if followed by blank lines or divider
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next < lines.length && (lines[next].trim() === '---' || lines[next].trim() === '***')) {
          i = next + 1;
        }
        break;
      }
      i++;
      continue;
    }
    if (trimmed === '---' || trimmed === '***') {
      i++;
      break;
    }
    // Property line: short key (up to 32 chars) followed by colon:
    // e.g. "Prop: val" or "- Prop: val" or "* Prop: val"
    const propMatch = trimmed.match(/^(?:[-*]\s+)?([A-Za-z0-9\u00C0-\u024F _-]{1,32}):\s*(.*)$/);
    if (propMatch) {
      seenProperty = true;
      i++;
      continue;
    }
    break;
  }

  const remaining = lines.slice(i).join('\n').trim();
  if (titleLine && remaining) {
    return `${titleLine}\n\n${remaining}\n`;
  }
  if (titleLine && !remaining) {
    return `${titleLine}\n`;
  }
  return remaining ? `${remaining}\n` : '';
}

/**
 * Inspects a Notion export directory or ZIP safely without ever returning or printing
 * cell values or page text.
 */
export function inspectNotion(source: string | Buffer): NotionInspectionReport {
  const files = loadNotionExportFiles(source);
  const databases: DatabaseInspection[] = [];
  const pages: PageInspection[] = [];

  for (const file of files) {
    const base = basename(file.name);
    if (base.endsWith('.csv')) {
      try {
        const text = file.readText();
        const { headers, rows } = parseCsv(text);
        databases.push({
          name: file.name,
          rowCount: rows.length,
          columns: headers,
        });
      } catch {
        // ignore malformed
      }
    } else if (base.endsWith('.md')) {
      pages.push({
        name: file.name,
        size: file.size,
      });
    }
  }

  databases.sort((a, b) => a.name.localeCompare(b.name));
  pages.sort((a, b) => a.name.localeCompare(b.name));

  return {
    source: typeof source === 'string' ? source : 'export.zip',
    databases,
    pages,
  };
}

export function formatNotionInspection(report: NotionInspectionReport): string {
  const lines: string[] = [
    `Notion export: ${report.source}`,
    `Databases (${report.databases.length}):`,
  ];

  if (report.databases.length === 0) {
    lines.push('  none');
  } else {
    for (const db of report.databases) {
      lines.push(`  ${db.name} (${db.rowCount} row${db.rowCount === 1 ? '' : 's'})`);
      lines.push(`    Columns: ${db.columns.join(', ') || 'none'}`);
    }
  }

  lines.push(`Pages (${report.pages.length}):`);
  if (report.pages.length === 0) {
    lines.push('  none');
  } else {
    for (const p of report.pages) {
      lines.push(`  ${p.name} (${p.size.toLocaleString('en-US')} bytes)`);
    }
  }

  return lines.join('\n');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Finds the page markdown file for a chapter title in the Notion export files.
 * Notion page files are named: "<Title> <32-hex-id>.md"
 */
export function findNotionPageFile(title: string, files: NotionExportFile[]): NotionExportFile | undefined {
  const mdFiles = files.filter((f) => f.name.endsWith('.md'));

  // 1. Exact title prefix with 32-hex ID pattern: `^Title [0-9a-fA-F]{32}\.md$`
  const exactRegex = new RegExp(`^${escapeRegex(title.trim())}\\s+[0-9a-fA-F]{32}\\.md$`, 'i');
  for (const f of mdFiles) {
    const base = basename(f.name);
    if (exactRegex.test(base)) {
      return f;
    }
  }

  // 2. Exact match if no ID suffix was appended
  for (const f of mdFiles) {
    const base = basename(f.name);
    if (base.toLowerCase() === `${title.trim().toLowerCase()}.md`) {
      return f;
    }
  }

  // 3. Slug normalized match
  const titleSlug = normalizeTitle(title);
  if (titleSlug) {
    for (const f of mdFiles) {
      const base = basename(f.name).replace(/\.md$/i, '');
      // Strip trailing 32-hex if present: `<Title> <32hex>`
      const stripped = base.replace(/\s+[0-9a-fA-F]{32}$/, '');
      if (normalizeTitle(stripped) === titleSlug) {
        return f;
      }
    }
  }

  return undefined;
}

/**
 * Finds the database CSV file in Notion export files.
 * Supports matching by exact name, normalized name, prefix, or 32-hex ID pattern.
 * If both `<name> <id>.csv` and `<name> <id>_all.csv` exist, prefers `_all.csv`.
 */
export function findNotionDatabaseFile(
  mappingDb: string,
  files: NotionExportFile[]
): NotionExportFile | undefined {
  const csvFiles = files.filter((f) => f.name.toLowerCase().endsWith('.csv'));
  if (csvFiles.length === 0) return undefined;

  const target = mappingDb.trim();
  const targetBase = basename(target).toLowerCase();
  const targetNoCsv = targetBase.replace(/\.csv$/i, '');
  const targetClean = targetNoCsv.replace(/\s+[0-9a-fA-F]{32}(?:_all)?$/i, '').trim();
  const targetSlug = normalizeTitle(targetClean);

  const scored: { file: NotionExportFile; score: number; isAll: boolean }[] = [];

  for (const f of csvFiles) {
    const fBase = basename(f.name);
    const fBaseLower = fBase.toLowerCase();
    const fBaseNoCsv = fBaseLower.replace(/\.csv$/i, '');
    const isAll = fBaseNoCsv.endsWith('_all');
    const fWithoutAll = isAll ? fBaseNoCsv.slice(0, -4).trim() : fBaseNoCsv;
    const fClean = fWithoutAll.replace(/\s+[0-9a-fA-F]{32}$/i, '').trim();
    const fSlug = normalizeTitle(fClean);

    let score = -1;

    if (fBaseLower === targetBase || fBaseLower === `${targetBase}.csv`) {
      score = 100;
    } else if (fBaseNoCsv === targetNoCsv || fWithoutAll === targetNoCsv) {
      score = 90;
    } else if (fClean === targetClean) {
      score = 80;
    } else if (targetSlug && fSlug === targetSlug) {
      score = 70;
    } else if (targetClean && fClean.startsWith(targetClean)) {
      score = 60;
    } else if (targetClean && fBaseLower.startsWith(targetClean)) {
      score = 50;
    }

    if (score > 0) {
      scored.push({ file: f, score, isAll });
    }
  }

  if (scored.length === 0) {
    return undefined;
  }

  // Sort candidates:
  // 1. Prefer _all.csv when both exist
  // 2. Highest match score
  scored.sort((a, b) => {
    if (a.isAll !== b.isAll) {
      return a.isAll ? -1 : 1;
    }
    return b.score - a.score;
  });

  return scored[0].file;
}

/**
 * Loads chapters from a Notion export according to a declarative mapping.
 */
export function loadNotionChapters(source: string | Buffer, mapping: NotionMapping): LoadedNotionExport {
  const files = loadNotionExportFiles(source);

  // Find the database CSV, preferring _all.csv when pairs exist
  const dbFile = findNotionDatabaseFile(mapping.database, files);

  if (!dbFile) {
    throw new Error(`Database CSV not found in Notion export: "${mapping.database}"`);
  }

  const { headers, rows } = parseCsv(dbFile.readText());

  // Determine title column
  let titleCol = mapping.titleColumn;
  if (!titleCol) {
    const candidates = ['title', 'título', 'titulo', 'name', 'nombre', 'capítulo', 'capitulo'];
    for (const c of candidates) {
      const found = headers.find((h) => h.toLowerCase() === c);
      if (found) {
        titleCol = found;
        break;
      }
    }
  }
  if (!titleCol) {
    titleCol = headers[0]; // fallback to first column
  }
  if (!titleCol) {
    throw new Error('Database CSV has no columns');
  }

  // Determine order column (optional)
  let orderCol = mapping.orderColumn;
  if (!orderCol && mapping.orderColumn !== undefined) {
    orderCol = mapping.orderColumn;
  }

  const chapters: LoadedNotionChapter[] = [];
  const missing: { order: number; title: string; file: string; reason: string }[] = [];

  let rowIndex = 0;
  for (const row of rows) {
    rowIndex++;

    // Apply filter if specified
    if (mapping.filter) {
      let filterCol: string | undefined;
      let filterVal: string | undefined;
      if ('column' in mapping.filter && 'value' in mapping.filter) {
        filterCol = mapping.filter.column;
        filterVal = mapping.filter.value;
      } else {
        const entries = Object.entries(mapping.filter);
        if (entries.length > 0) {
          filterCol = entries[0][0];
          filterVal = entries[0][1];
        }
      }

      if (filterCol && filterVal !== undefined) {
        // Find row field case-insensitively
        const actualCol = Object.keys(row).find((k) => k.toLowerCase() === filterCol!.toLowerCase());
        const rowVal = actualCol ? row[actualCol] : undefined;
        if (rowVal?.trim() !== filterVal.trim()) {
          continue; // filtered out
        }
      }
    }

    const title = (row[titleCol] ?? '').trim();
    if (!title) continue;

    // Order: from column or 1-based index
    let order: number;
    if (orderCol && row[orderCol] !== undefined && row[orderCol].trim() !== '') {
      const parsed = Number(row[orderCol].trim());
      order = isNaN(parsed) ? rowIndex : parsed;
    } else {
      order = rowIndex;
    }

    // Match page file
    const pageFile = findNotionPageFile(title, files);
    if (!pageFile) {
      missing.push({
        order,
        title,
        file: `scenes/${String(order).padStart(3, '0')}-${normalizeTitle(title) || 'scene'}.md`,
        reason: `missing page file in Notion export for "${title}"`,
      });
      continue;
    }

    const rawMarkdown = pageFile.readText();
    const cleanBody = stripNotionPropertyHeader(rawMarkdown);

    chapters.push({
      order,
      title,
      body: cleanBody,
      format: 'markdown',
      pageFile: pageFile.name,
    });
  }

  chapters.sort((a, b) => a.order - b.order);
  return { chapters, missing };
}
