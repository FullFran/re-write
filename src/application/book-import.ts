import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from './project.ts';

export interface ChapterInput {
  order: number;
  title: string;
  body: string;
  format?: 'markdown' | 'plain' | 'html' | string;
}

export interface ChapterImportItem {
  order: number;
  title: string;
  file: string;
}

export interface ChapterRefusedItem extends ChapterImportItem {
  reason: string;
}

export interface BookImportResult {
  imported: ChapterImportItem[];
  unchanged: ChapterImportItem[];
  refused: ChapterRefusedItem[];
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  iexcl: '¡',
  iquest: '¿',
  copy: '©',
  reg: '®',
  trade: '™',
  aacute: 'á',
  Aacute: 'Á',
  eacute: 'é',
  Eacute: 'É',
  iacute: 'í',
  Iacute: 'Í',
  oacute: 'ó',
  Oacute: 'Ó',
  uacute: 'ú',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  ccedil: 'ç',
  Ccedil: 'Ç',
};

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return '';
      }
    })
    .replace(/&([a-zA-Z]+);/g, (match, name) => {
      return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
    });
}

/**
 * Small, conservative converter from HTML/plain to Markdown.
 * Drops scripts, styles, and unwanted tags; converts headings, paragraphs,
 * line breaks, emphasis; decodes entities.
 */
export function convertToMarkdown(body: string, format: string = 'markdown'): string {
  const normFormat = format.toLowerCase().trim();
  if (normFormat !== 'markdown' && normFormat !== 'plain' && normFormat !== 'html') {
    throw new Error(`unsupported format: "${format}". Only markdown, plain, and html are supported.`);
  }

  if (normFormat === 'markdown') {
    const normalized = body.replace(/\r\n/g, '\n').trimEnd();
    return normalized ? `${normalized}\n` : '';
  }

  if (normFormat === 'plain') {
    const lines = body.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
    const collapsed = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return collapsed ? `${collapsed}\n` : '';
  }

  // HTML conversion
  let html = body.replace(/\r\n/g, '\n');

  // Strip script, style, noscript, and comments completely
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // Headings h1..h6
  html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    return `\n\n${'#'.repeat(Number(level))} ${content.trim()}\n\n`;
  });

  // Paragraphs
  html = html.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
    return `\n\n${content.trim()}\n\n`;
  });

  // Blockquotes
  html = html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    return `\n\n> ${content.trim()}\n\n`;
  });

  // Line breaks and horizontal rules
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  // Bold / strong
  html = html.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, content) => {
    return `**${content}**`;
  });

  // Italic / em
  html = html.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, content) => {
    return `*${content}*`;
  });

  // Inline code
  html = html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => {
    return `\`${content}\``;
  });

  // Strip any remaining HTML tags
  html = html.replace(/<[^>]+>/g, '');

  // Decode entities
  html = decodeHtmlEntities(html);

  // Clean up whitespace
  const lines = html.split('\n').map((l) => l.trimEnd());
  const cleaned = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned ? `${cleaned}\n` : '';
}

export function slugify(title: string): string {
  const clean = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'scene';
}

export function chapterFilename(order: number, title: string): string {
  const padded = String(Math.max(0, Math.floor(order))).padStart(3, '0');
  const slug = slugify(title);
  return `${padded}-${slug}.md`;
}

/**
 * Imports an ordered list of chapters into a RE;write project.
 * Uses a temp directory and reuses Project.importScenes for copying and git commits.
 * Re-importing unchanged chapters is a no-op.
 * Changed chapters are refused with clear reporting.
 */
export function importBook(project: Project, chapters: ChapterInput[]): BookImportResult {
  const sorted = [...chapters].sort((a, b) => a.order - b.order);
  const tempDir = mkdtempSync(join(tmpdir(), 'rewrite-book-import-'));

  const imported: ChapterImportItem[] = [];
  const unchanged: ChapterImportItem[] = [];
  const refused: ChapterRefusedItem[] = [];
  const candidateFiles: { file: string; item: ChapterImportItem }[] = [];

  try {
    for (const chapter of sorted) {
      const format = chapter.format ?? 'markdown';
      const converted = convertToMarkdown(chapter.body, format);
      const filename = chapterFilename(chapter.order, chapter.title);
      const relative = `scenes/${filename}`;
      const targetPath = join(project.dir, relative);
      const item: ChapterImportItem = {
        order: chapter.order,
        title: chapter.title,
        file: relative,
      };

      if (existsSync(targetPath)) {
        const existing = readFileSync(targetPath, 'utf8');
        if (existing === converted) {
          unchanged.push(item);
        } else {
          refused.push({
            ...item,
            reason: `${relative} already exists with different text; edit it through a proposal`,
          });
        }
        continue;
      }

      const tempFilePath = join(tempDir, filename);
      writeFileSync(tempFilePath, converted, 'utf8');
      candidateFiles.push({ file: tempFilePath, item });
    }

    if (candidateFiles.length > 0) {
      const { imported: actuallyImported } = project.importScenes(candidateFiles.map((c) => c.file));
      for (const importedRel of actuallyImported) {
        const match = candidateFiles.find((c) => c.item.file === importedRel);
        if (match) {
          imported.push(match.item);
        }
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return { imported, unchanged, refused };
}
