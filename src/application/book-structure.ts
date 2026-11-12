import type { BookOutline } from '../domain/book.ts';
import type { Project } from './project.ts';

/** Words as the desk counts them: letters and digits, with inner apostrophes and hyphens. */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
export const countWords = (text: string): number => (text.match(WORD) ?? []).length;

export interface TreeScene {
  file: string;
  /** Display title: the manifest title, else the first Markdown heading, else the file name. */
  title: string;
  words: number;
}
export interface TreeChapter {
  id: string;
  title: string;
  words: number;
  scenes: TreeScene[];
}
export interface BookTree {
  version: string;
  chapters: TreeChapter[];
  loose: TreeScene[];
  archived: TreeScene[];
  /** Words of the active scenes only. */
  total_words: number;
}

/** The first `# Heading` line of a scene, or null. */
function heading(text: string): string | null {
  const match = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
  return match ? match[1].trim().slice(0, 120) || null : null;
}

const fileName = (file: string): string => file.replace(/^scenes\//, '').replace(/\.md$/, '');

/** The outline with what the book tree shows: display titles and word counts. Read-only. */
export function bookTree(project: Project, outline: BookOutline = project.outline()): BookTree {
  const scene = ({ file, title }: { file: string; title: string | null }): TreeScene => {
    const text = project.readScene(file) ?? '';
    return { file, title: title ?? heading(text) ?? fileName(file), words: countWords(text) };
  };
  const sum = (scenes: TreeScene[]): number => scenes.reduce((n, s) => n + s.words, 0);
  const chapters = outline.chapters.map((c) => {
    const scenes = c.scenes.map(scene);
    return { id: c.id, title: c.title, words: sum(scenes), scenes };
  });
  const loose = outline.loose.map(scene);
  return {
    version: outline.version,
    chapters,
    loose,
    archived: outline.archived.map(scene),
    total_words: chapters.reduce((n, c) => n + c.words, 0) + sum(loose),
  };
}
