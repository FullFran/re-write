import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Project } from './project.ts';

const BOOK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface AccessFile {
  books: Record<string, { members: string[] }>;
}

/**
 * The books on a server and who may open each one. Nobody has access by
 * default, and a stranger cannot tell a hidden book from one that does not exist.
 */
export class Library {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  private bookDir(book: string): string {
    return join(this.dataDir, 'books', book);
  }

  private accessPath(): string {
    return join(this.dataDir, 'access.json');
  }

  private access(): AccessFile {
    if (!existsSync(this.accessPath())) return { books: {} };
    return JSON.parse(readFileSync(this.accessPath(), 'utf8')) as AccessFile;
  }

  private isMember(book: string, subject: string): boolean {
    return Object.hasOwn(this.access().books, book) && this.access().books[book].members.includes(subject);
  }

  booksFor(subject: string): string[] {
    const { books } = this.access();
    return Object.keys(books).filter((book) => books[book].members.includes(subject)).sort();
  }

  /** Opens a book for a person. Every path that reaches a book goes through here. */
  open(book: string, subject: string): Project {
    if (!BOOK_ID.test(book) || !this.isMember(book, subject)) throw new Error('unknown book');
    return Project.open(this.bookDir(book));
  }

  /** Administrative: run from the server's shell, never reachable from the MCP or the web. */
  grant(book: string, subject: string): void {
    if (!BOOK_ID.test(book)) throw new Error(`invalid book id: ${book}`);
    if (!existsSync(join(this.bookDir(book), '.rewrite', 'project.json'))) throw new Error('unknown book');
    if (!subject) throw new Error('missing user id');
    const access = this.access();
    const entry = Object.hasOwn(access.books, book) ? access.books[book] : { members: [] };
    if (!entry.members.includes(subject)) entry.members.push(subject);
    access.books[book] = entry;
    mkdirSync(this.dataDir, { recursive: true });
    const temporary = `${this.accessPath()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(access, null, 2)}\n`);
    renameSync(temporary, this.accessPath());
  }

  /** Error text for clients: internal paths stay on the server. */
  publicMessage(error: unknown): string {
    return (error as Error).message.replaceAll(this.dataDir, '<data>');
  }
}
