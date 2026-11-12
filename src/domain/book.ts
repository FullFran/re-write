/**
 * The book manifest: the order of the scenes, the chapters they sit in, their display titles and
 * the archived scenes. Pure: no files, no git. The manifest never renames or moves a scene file,
 * because findings, claims and proposals anchor to scene paths and git versions.
 *
 * Stored as `.rewrite/book.json` (docs/book-structure.md). Without it the order is the sorted path.
 */

export const MANIFEST_VERSION = 1;
export const MAX_TITLE_CHARS = 120;

export interface ManifestChapter {
  id: string;
  title: string;
  /** Scene paths in reading order. */
  scenes: string[];
}

export interface BookManifest {
  version: typeof MANIFEST_VERSION;
  /** Chapters in reading order. */
  chapters: ManifestChapter[];
  /** Scenes outside any chapter, in reading order. They come after every chapter. */
  loose: string[];
  /** Display titles by scene path. The file name never changes. */
  titles: Record<string, string>;
  /** Scenes taken out of the book without deleting them. */
  archived: string[];
}

export interface OutlineScene {
  file: string;
  /** The display title stored in the manifest, or null when the scene has none. */
  title: string | null;
}
export interface OutlineChapter {
  id: string;
  title: string;
  scenes: OutlineScene[];
}

/**
 * The book as the person sees it. Reading order is every chapter's scenes in chapter order, then
 * `loose`; `Project.scenes()` returns exactly those files. `version` identifies the manifest the
 * outline was read from and is what a structural write must send back.
 */
export interface BookOutline {
  version: string;
  chapters: OutlineChapter[];
  loose: OutlineScene[];
  archived: OutlineScene[];
}

export type StructureOp =
  | { op: 'create_scene'; title: string; chapter?: string | null; position?: number; heading?: boolean }
  | { op: 'retitle_scene'; file: string; title: string }
  | { op: 'archive_scene'; file: string }
  | { op: 'unarchive_scene'; file: string }
  | { op: 'create_chapter'; title: string; position?: number }
  | { op: 'retitle_chapter'; chapter: string; title: string }
  | { op: 'remove_chapter'; chapter: string }
  | { op: 'move_scene'; file: string; chapter: string | null; position?: number }
  | { op: 'move_chapter'; chapter: string; position: number };

export type StructureErrorKind = 'invalid' | 'not_found';

/** An operation the book cannot do; the message can be shown to the person. */
export class BookStructureError extends Error {
  readonly kind: StructureErrorKind;
  constructor(kind: StructureErrorKind, message: string) {
    super(message);
    this.name = 'BookStructureError';
    this.kind = kind;
  }
}

const SCENE_PATH = /^scenes\/[^/]+\.md$/;
// C0/C1 controls, line and paragraph separators, and bidirectional overrides.
const FORBIDDEN_IN_TITLE = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/** The trimmed title, or throws when it is empty, too long or has control characters. */
export function checkTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new BookStructureError('invalid', 'El título debe ser texto.');
  const title = raw.trim();
  if (!title) throw new BookStructureError('invalid', 'El título no puede estar vacío.');
  if (!title.isWellFormed() || FORBIDDEN_IN_TITLE.test(title)) {
    throw new BookStructureError('invalid', 'El título tiene caracteres de control no permitidos.');
  }
  if ([...title].length > MAX_TITLE_CHARS) {
    throw new BookStructureError('invalid', `El título no puede pasar de ${MAX_TITLE_CHARS} caracteres.`);
  }
  return title;
}

/** A file name stem from a title: lowercase, no accents, letters, digits and dashes. Never empty. */
export function slugOf(title: string): string {
  const slug = title.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || 'escena';
}

/** `scenes/<slug>.md`, numbered when that path or a case-insensitive twin is taken. */
export function newScenePath(title: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((file) => file.toLowerCase()));
  const base = slugOf(title);
  let file = `scenes/${base}.md`;
  for (let n = 2; used.has(file.toLowerCase()); n += 1) file = `scenes/${base}-${n}.md`;
  return file;
}

/** A manifest read from disk, with anything of an unexpected shape dropped. Null when it is not one. */
export function parseManifest(value: unknown): BookManifest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== MANIFEST_VERSION) return null;
  const files = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string' && SCENE_PATH.test(f)) : [];
  const chapters: ManifestChapter[] = [];
  if (Array.isArray(raw.chapters)) {
    for (const c of raw.chapters as Record<string, unknown>[]) {
      if (c && typeof c.id === 'string' && typeof c.title === 'string' && !chapters.some((k) => k.id === c.id)) {
        chapters.push({ id: c.id, title: c.title, scenes: files(c.scenes) });
      }
    }
  }
  const titles: Record<string, string> = {};
  if (raw.titles && typeof raw.titles === 'object') {
    for (const [file, title] of Object.entries(raw.titles as Record<string, unknown>)) {
      if (SCENE_PATH.test(file) && typeof title === 'string') titles[file] = title;
    }
  }
  return { version: MANIFEST_VERSION, chapters, loose: files(raw.loose), titles, archived: files(raw.archived) };
}

export function emptyManifest(): BookManifest {
  return { version: MANIFEST_VERSION, chapters: [], loose: [], titles: {}, archived: [] };
}

/**
 * The manifest laid over the scene files that exist: entries without a file are dropped, a scene
 * listed twice counts once, an archived scene leaves the order, and scenes the manifest does not
 * know come last in sorted-path order. `existing` must be sorted. Without a manifest it is the
 * sorted path order, as before the manifest existed.
 */
export function resolveManifest(manifest: BookManifest | null, existing: string[]): { chapters: ManifestChapter[]; loose: string[]; archived: string[] } {
  const have = new Set(existing);
  const m = manifest ?? emptyManifest();
  const archived = [...new Set(m.archived)].filter((f) => have.has(f));
  const hidden = new Set(archived);
  const seen = new Set<string>();
  const take = (files: string[]): string[] => files.filter((f) => {
    if (!have.has(f) || hidden.has(f) || seen.has(f)) return false;
    seen.add(f);
    return true;
  });
  const chapters = m.chapters.map((c) => ({ ...c, scenes: take(c.scenes) }));
  const loose = take(m.loose);
  loose.push(...existing.filter((f) => !hidden.has(f) && !seen.has(f)));
  return { chapters, loose, archived };
}

/** Every operation but creating a scene; creating needs the file to exist, which the caller decides. */
export interface Applied {
  manifest: BookManifest;
  /** The scene file the operation creates, if any. */
  created?: string;
  /** A short phrase for the commit message. */
  summary: string;
}

function findChapter(manifest: BookManifest, id: unknown): ManifestChapter {
  const chapter = manifest.chapters.find((c) => c.id === id);
  if (!chapter) throw new BookStructureError('not_found', 'Ese capítulo ya no existe.');
  return chapter;
}

function insertAt<T>(list: T[], item: T, position: number | undefined): void {
  if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
    throw new BookStructureError('invalid', 'La posición no es válida.');
  }
  list.splice(position === undefined ? list.length : Math.min(position, list.length), 0, item);
}

function newChapterId(manifest: BookManifest): string {
  const used = new Set(manifest.chapters.map((c) => c.id));
  let n = manifest.chapters.length + 1;
  while (used.has(`c${n}`)) n += 1;
  return `c${n}`;
}

function knownScene(manifest: BookManifest, file: unknown): string {
  const all = new Set([...manifest.chapters.flatMap((c) => c.scenes), ...manifest.loose, ...manifest.archived]);
  if (typeof file !== 'string' || !all.has(file)) throw new BookStructureError('not_found', 'Esa escena ya no existe.');
  return file;
}

function detach(manifest: BookManifest, file: string): void {
  for (const c of manifest.chapters) c.scenes = c.scenes.filter((f) => f !== file);
  manifest.loose = manifest.loose.filter((f) => f !== file);
}

/**
 * Applies one operation to a manifest that already lists every scene (see resolveManifest) and
 * returns the new one. `existing` is every scene file, archived included, for name clashes.
 */
export function applyOperation(current: BookManifest, op: StructureOp, existing: string[]): Applied {
  const manifest: BookManifest = structuredClone(current);
  switch (op.op) {
    case 'create_scene': {
      const title = checkTitle(op.title);
      const target = op.chapter == null ? null : findChapter(manifest, op.chapter);
      const file = newScenePath(title, existing);
      insertAt(target ? target.scenes : manifest.loose, file, op.position);
      manifest.titles[file] = title;
      return { manifest, created: file, summary: `create scene ${file}` };
    }
    case 'retitle_scene': {
      const file = knownScene(manifest, op.file);
      manifest.titles[file] = checkTitle(op.title);
      return { manifest, summary: `retitle scene ${file}` };
    }
    case 'archive_scene': {
      const file = knownScene(manifest, op.file);
      if (manifest.archived.includes(file)) return { manifest, summary: `archive scene ${file}` };
      detach(manifest, file);
      manifest.archived.push(file);
      return { manifest, summary: `archive scene ${file}` };
    }
    case 'unarchive_scene': {
      const file = knownScene(manifest, op.file);
      if (!manifest.archived.includes(file)) return { manifest, summary: `restore scene ${file}` };
      manifest.archived = manifest.archived.filter((f) => f !== file);
      manifest.loose.push(file);
      return { manifest, summary: `restore scene ${file}` };
    }
    case 'create_chapter': {
      const title = checkTitle(op.title);
      const id = newChapterId(manifest);
      insertAt(manifest.chapters, { id, title, scenes: [] }, op.position);
      return { manifest, summary: `create chapter ${id}` };
    }
    case 'retitle_chapter': {
      const chapter = findChapter(manifest, op.chapter);
      chapter.title = checkTitle(op.title);
      return { manifest, summary: `retitle chapter ${chapter.id}` };
    }
    case 'remove_chapter': {
      const chapter = findChapter(manifest, op.chapter);
      if (chapter.scenes.length) {
        throw new BookStructureError('invalid', 'El capítulo no está vacío: mueve o archiva sus escenas primero.');
      }
      manifest.chapters = manifest.chapters.filter((c) => c !== chapter);
      return { manifest, summary: `remove chapter ${chapter.id}` };
    }
    case 'move_scene': {
      const file = knownScene(manifest, op.file);
      if (manifest.archived.includes(file)) throw new BookStructureError('invalid', 'Restaura la escena antes de moverla.');
      const target = op.chapter == null ? null : findChapter(manifest, op.chapter);
      detach(manifest, file);
      // After detach the target list is the one the position refers to.
      insertAt(target ? manifest.chapters.find((c) => c.id === target.id)!.scenes : manifest.loose, file, op.position);
      return { manifest, summary: `move scene ${file}` };
    }
    case 'move_chapter': {
      const chapter = findChapter(manifest, op.chapter);
      manifest.chapters = manifest.chapters.filter((c) => c.id !== chapter.id);
      insertAt(manifest.chapters, chapter, op.position);
      return { manifest, summary: `move chapter ${chapter.id}` };
    }
    default:
      throw new BookStructureError('invalid', 'Operación desconocida.');
  }
}
