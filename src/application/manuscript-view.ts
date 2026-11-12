/**
 * The whole manuscript in one read (the Libro place of the review page): every scene in the
 * book's reading order (Project.scenes) with its chapter, title, text and word count. Read-only.
 */
import type { Project } from './project.ts';

/** Text sent in one response; scenes past it keep their counts but come without text. */
export const MANUSCRIPT_TEXT_CAP = 16 * 1024 * 1024;

export interface ManuscriptScene {
  file: string;
  title: string;
  /** The chapter the scene is in (docs/book-structure.md), or null outside any chapter. */
  chapter: string | null;
  words: number;
  /** Absent when the caller asked for counts only; null when the size cap left it out. */
  text?: string | null;
}

export interface Manuscript {
  title: string;
  scenes: ManuscriptScene[];
  total_words: number;
  /** True when at least one scene's text was left out because of the size cap. */
  truncated: boolean;
}

/** Words as a writer counts them: letters and digits, with inner apostrophes and hyphens. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** A scene's title is its first heading; a scene without one is named by its file. */
export function sceneHeading(text: string, file: string): string {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
  return heading ? heading[1] : file.replace(/^scenes\//, '').replace(/\.md$/, '');
}

export function manuscriptView(project: Project, options: { withText?: boolean; maxBytes?: number } = {}): Manuscript {
  const withText = options.withText ?? true;
  const cap = options.maxBytes ?? MANUSCRIPT_TEXT_CAP;
  let sent = 0;
  let truncated = false;
  const scenes: ManuscriptScene[] = [];
  // The outline gives each scene its chapter and its title from the manifest; scenes() the order.
  const outline = project.outline();
  const placed = new Map<string, { chapter: string | null; title: string | null }>();
  for (const chapter of outline.chapters) for (const s of chapter.scenes) placed.set(s.file, { chapter: chapter.title, title: s.title });
  for (const s of outline.loose) placed.set(s.file, { chapter: null, title: s.title });
  for (const file of project.scenes()) {
    const text = project.readScene(file) ?? '';
    const where = placed.get(file);
    const scene: ManuscriptScene = { file, title: where?.title ?? sceneHeading(text, file), chapter: where?.chapter ?? null, words: countWords(text) };
    if (withText) {
      const size = Buffer.byteLength(text);
      if (sent + size <= cap) {
        sent += size;
        scene.text = text;
      } else {
        scene.text = null;
        truncated = true;
      }
    }
    scenes.push(scene);
  }
  return { title: project.title(), scenes, total_words: scenes.reduce((n, s) => n + s.words, 0), truncated };
}
