import { buildDocx } from '../adapters/docx.ts';
import { compileMarkdown, type ManuscriptPart } from '../domain/manuscript.ts';
import type { Project } from './project.ts';

export const EXPORT_FORMATS = ['md', 'docx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ManuscriptExport {
  filename: string;
  contentType: string;
  body: Buffer;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function isExportFormat(value: string | null | undefined): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value ?? '');
}

/** A file name safe in a header and on any file system: ASCII letters, digits and hyphens from the book title. */
export function exportFilename(title: string, format: ExportFormat): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${slug || 'libro'}.${format}`;
}

/**
 * The book's outline in reading order (docs/book-structure.md): one titled part per chapter, then
 * the scenes outside any chapter as an untitled part. Archived scenes and notes (notas/) are left out.
 */
export function manuscriptOutline(project: Project): ManuscriptPart[] {
  const book = project.outline();
  const scenes = (list: { file: string; title: string | null }[]) => list.flatMap(({ file, title }) => {
    const text = project.readScene(file);
    return text === null ? [] : [{ file, text, ...(title ? { title } : {}) }];
  });
  return [
    ...book.chapters.map((chapter) => ({ title: chapter.title, scenes: scenes(chapter.scenes) })),
    { scenes: scenes(book.loose) },
  ];
}

/** Compiles the manuscript. Reads only: no commit, no change to any book file. */
export function exportManuscript(project: Project, format: ExportFormat, outline: ManuscriptPart[] = manuscriptOutline(project)): ManuscriptExport {
  const title = project.title();
  const body = format === 'md' ? Buffer.from(compileMarkdown(title, outline), 'utf8') : buildDocx(title, outline);
  return { filename: exportFilename(title, format), contentType: CONTENT_TYPES[format], body };
}
