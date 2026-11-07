import { DatabaseSync } from 'node:sqlite';
import type { ChapterInput } from './book-import.ts';

export interface SqliteMappingColumns {
  order: string;
  title: string;
  body: string;
  format?: string;
}

export interface SqliteMapping {
  table?: string;
  query?: string;
  columns?: Partial<SqliteMappingColumns>;
  order?: string;
  title?: string;
  body?: string;
  format?: string;
  defaultFormat?: 'markdown' | 'plain' | 'html' | string;
  filter?: string;
  orderBy?: string;
}

export interface TextStats {
  min: number;
  avg: number;
  max: number;
  format: 'HTML' | 'RTF' | 'Markdown' | 'plain text';
}

export interface ColumnInspection {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  textStats?: TextStats;
}

export interface TableInspection {
  name: string;
  rowCount: number;
  columns: ColumnInspection[];
}

export interface InspectionReport {
  file: string;
  tables: TableInspection[];
}

function detectFormat(samples: string[]): TextStats['format'] {
  if (samples.length === 0) return 'plain text';

  let rtfCount = 0;
  let htmlCount = 0;
  let mdCount = 0;

  for (const s of samples) {
    if (/^\s*\{\\rtf/i.test(s) || /\\rtf1/i.test(s)) {
      rtfCount++;
    } else if (/<\s*(?:p|div|br|h[1-6]|span|html|body|table|ul|ol|li|em|strong|b|i|a|section|article)\b[^>]*>/i.test(s)) {
      htmlCount++;
    } else if (/(?:^#{1,6}\s+|^\s*[-*+]\s+|^\s*>\s+|\*\*[^*]+\*\*|_[^_]+_|\[.+\]\(.+\))/m.test(s)) {
      mdCount++;
    }
  }

  if (rtfCount > 0) return 'RTF';
  if (htmlCount > 0 && htmlCount >= samples.length * 0.2) return 'HTML';
  if (mdCount > 0 && mdCount >= samples.length * 0.2) return 'Markdown';
  return 'plain text';
}

/**
 * Safely inspects a SQLite database without ever returning or printing row content.
 */
export function inspectSqlite(filePath: string): InspectionReport {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const tablesStmt = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `);
    const tableRows = tablesStmt.all() as { name: string }[];
    const tables: TableInspection[] = [];

    for (const { name: tableName } of tableRows) {
      const countStmt = db.prepare(`SELECT count(*) as count FROM "${tableName}"`);
      const rowCount = Number((countStmt.get() as { count: number }).count);

      const infoStmt = db.prepare(`PRAGMA table_info("${tableName}")`);
      const rawCols = infoStmt.all() as {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }[];

      const columns: ColumnInspection[] = [];

      for (const col of rawCols) {
        const typeUpper = (col.type || '').toUpperCase();
        let isText =
          typeUpper.includes('TEXT') ||
          typeUpper.includes('CHAR') ||
          typeUpper.includes('CLOB') ||
          typeUpper.includes('STR') ||
          typeUpper.includes('VARCHAR');

        if (!isText && rowCount > 0) {
          try {
            const sampleTypeStmt = db.prepare(
              `SELECT typeof("${col.name}") as t FROM "${tableName}" WHERE "${col.name}" IS NOT NULL LIMIT 5`
            );
            const sampleTypes = sampleTypeStmt.all() as { t: string }[];
            if (sampleTypes.some((st) => st.t === 'text')) {
              isText = true;
            }
          } catch {
            // ignore
          }
        }

        let textStats: TextStats | undefined;
        if (isText && rowCount > 0) {
          try {
            const statsStmt = db.prepare(`
              SELECT
                min(length("${col.name}")) as min_len,
                avg(length("${col.name}")) as avg_len,
                max(length("${col.name}")) as max_len
              FROM "${tableName}"
              WHERE "${col.name}" IS NOT NULL
            `);
            const statsRow = statsStmt.get() as {
              min_len: number | null;
              avg_len: number | null;
              max_len: number | null;
            } | null;

            if (statsRow && statsRow.min_len !== null) {
              const samplesStmt = db.prepare(`
                SELECT "${col.name}" as val FROM "${tableName}"
                WHERE "${col.name}" IS NOT NULL LIMIT 50
              `);
              const samples = (samplesStmt.all() as { val: string }[]).map((r) => String(r.val));
              textStats = {
                min: Number(statsRow.min_len),
                avg: Math.round(Number(statsRow.avg_len)),
                max: Number(statsRow.max_len),
                format: detectFormat(samples),
              };
            }
          } catch {
            // ignore
          }
        }

        columns.push({
          name: col.name,
          type: col.type || 'BLOB',
          primaryKey: col.pk > 0,
          notNull: col.notnull === 1,
          ...(textStats ? { textStats } : {}),
        });
      }

      tables.push({
        name: tableName,
        rowCount,
        columns,
      });
    }

    return { file: filePath, tables };
  } finally {
    db.close();
  }
}

export function formatInspection(report: InspectionReport): string {
  const lines: string[] = [`database: ${report.file}`, 'tables:'];
  for (const table of report.tables) {
    lines.push(`  ${table.name} (${table.rowCount} row${table.rowCount === 1 ? '' : 's'})`);
    for (const col of table.columns) {
      const parts = [`    ${col.name} ${col.type}`];
      if (col.primaryKey) parts.push('(primary key)');
      if (col.notNull) parts.push('(not null)');
      let line = parts.join(' ');
      if (col.textStats) {
        line += `: length min ${col.textStats.min}, avg ${col.textStats.avg}, max ${col.textStats.max}; format: ${col.textStats.format}`;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * Reads chapters/scenes from a SQLite database opened read-only, driven by a declarative mapping.
 */
export function readSqliteSource(filePath: string, mapping: SqliteMapping): ChapterInput[] {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    let sql: string;
    let orderCol = mapping.columns?.order ?? mapping.order ?? 'order';
    let titleCol = mapping.columns?.title ?? mapping.title ?? 'title';
    let bodyCol = mapping.columns?.body ?? mapping.body ?? 'body';
    let formatCol = mapping.columns?.format ?? mapping.format;

    if (mapping.query) {
      sql = mapping.query;
    } else if (mapping.table) {
      const selectCols = [`"${orderCol}"`, `"${titleCol}"`, `"${bodyCol}"`];
      if (formatCol) selectCols.push(`"${formatCol}"`);
      sql = `SELECT ${selectCols.join(', ')} FROM "${mapping.table}"`;
      if (mapping.filter) sql += ` WHERE ${mapping.filter}`;
      if (mapping.orderBy) sql += ` ORDER BY ${mapping.orderBy}`;
      else sql += ` ORDER BY "${orderCol}" ASC`;
    } else {
      throw new Error('SQLite mapping must specify either "table" or "query"');
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];

    const chapters: ChapterInput[] = [];
    for (const row of rows) {
      // Find keys case-insensitively if exact key is not directly present
      const getVal = (colName: string): unknown => {
        if (Object.hasOwn(row, colName)) return row[colName];
        const lower = colName.toLowerCase();
        for (const [k, v] of Object.entries(row)) {
          if (k.toLowerCase() === lower) return v;
        }
        return undefined;
      };

      const orderVal = Number(getVal(orderCol));
      if (isNaN(orderVal)) {
        throw new Error(`Invalid order value in column "${orderCol}": ${getVal(orderCol)}`);
      }

      const titleVal = String(getVal(titleCol) ?? '');
      const bodyVal = String(getVal(bodyCol) ?? '');
      const rawFormat = formatCol ? getVal(formatCol) : undefined;
      const formatVal = rawFormat ? String(rawFormat) : (mapping.defaultFormat ?? 'markdown');

      chapters.push({
        order: orderVal,
        title: titleVal,
        body: bodyVal,
        format: formatVal,
      });
    }

    if (!mapping.query && !mapping.orderBy) {
      chapters.sort((a, b) => a.order - b.order);
    }
    return chapters;
  } finally {
    db.close();
  }
}
