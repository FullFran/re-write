import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { cli, git, tempDir } from './helpers.ts';
import { Project } from '../src/application/project.ts';
import {
  chapterFilename,
  convertToMarkdown,
  importBook,
  type ChapterInput,
} from '../src/application/book-import.ts';
import {
  inspectSqlite,
  readSqliteSource,
  type SqliteMapping,
} from '../src/application/sqlite-source.ts';

const SECRET_MARKER = 'SUPER_SECRET_UNPUBLISHED_ANDRES_NOVEL_PARAGRAPH_998877';

function createSyntheticDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chapters (
      chapter_num INTEGER PRIMARY KEY,
      book_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      format TEXT NOT NULL
    );
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const insert = db.prepare(`
    INSERT INTO chapters (chapter_num, book_id, title, content, format)
    VALUES (?, ?, ?, ?, ?)
  `);

  insert.run(1, 1, 'El Faro', `<h1>El Faro</h1><p>La luz brilla sobre el mar.</p><script>alert("evil");</script>`, 'html');
  insert.run(2, 1, 'La Niebla', `La niebla cubría la costa entera.\n\nNadie podía ver la entrada del puerto. ${SECRET_MARKER}`, 'plain');
  insert.run(3, 1, 'El Regreso', `## El Regreso\n\nEl barco volvió al amanecer con **buenas noticias**.`, 'markdown');
  // Chapter belonging to another book to test filtering
  insert.run(4, 2, 'Otro Libro', `<p>Contenido de otro libro.</p>`, 'html');

  db.exec(`INSERT INTO metadata (key, value) VALUES ('author', 'Andrés'), ('version', '1.0');`);
  db.close();
}

test('html and plain conversion cases including a <script> tag dropped', () => {
  // HTML conversion
  const htmlInput = `
    <h1>Capítulo 1</h1>
    <p>Era una noche <strong>oscura</strong> y <em>tormentosa</em>.</p>
    <script>alert("malicious code execution attempt");</script>
    <p>El vigía miró al mar.<br>Todo estaba en calma.</p>
  `;
  const htmlConverted = convertToMarkdown(htmlInput, 'html');
  assert.doesNotMatch(htmlConverted, /<script/i);
  assert.doesNotMatch(htmlConverted, /malicious code/i);
  assert.doesNotMatch(htmlConverted, /<\/script>/i);
  assert.match(htmlConverted, /^# Capítulo 1/m);
  assert.match(htmlConverted, /\*\*oscura\*\*/);
  assert.match(htmlConverted, /\*tormentosa\*/);
  assert.match(htmlConverted, /El vigía miró al mar\.\nTodo estaba en calma\./);

  // HTML entity decoding
  const entitiesInput = `<p>&laquo;El faro&raquo; &amp; &quot;la niebla&quot; &#8212; &iexcl;hola!</p>`;
  const entitiesConverted = convertToMarkdown(entitiesInput, 'html');
  assert.match(entitiesConverted, /«El faro» & "la niebla" — ¡hola!/);

  // Plain text conversion
  const plainInput = "Primer párrafo con detalles.\n\nSegundo párrafo con más texto.\n";
  const plainConverted = convertToMarkdown(plainInput, 'plain');
  assert.equal(plainConverted, "Primer párrafo con detalles.\n\nSegundo párrafo con más texto.\n");

  // Unsupported format throws clear message
  assert.throws(
    () => convertToMarkdown('{\\rtf1\\ansi test}', 'rtf'),
    /unsupported format.*rtf/i
  );
});

test('chapterFilename produces stable zero-padded order and slug', () => {
  assert.equal(chapterFilename(1, 'El Faro'), '001-el-faro.md');
  assert.equal(chapterFilename(12, 'Capítulo 12: La Niebla'), '012-capitulo-12-la-niebla.md');
  assert.equal(chapterFilename(105, 'Epílogo & Fin!'), '105-epilogo-fin.md');
  assert.equal(chapterFilename(1, '¡¡¡!!!'), '001-scene.md');
});

test('ordered import into scenes', () => {
  const dir = join(tempDir(), 'book');
  const { project } = Project.init(dir, 'Novela Test');

  const chapters: ChapterInput[] = [
    { order: 2, title: 'La Niebla', body: 'Texto dos', format: 'plain' },
    { order: 1, title: 'El Faro', body: '<h1>Texto uno</h1>', format: 'html' },
    { order: 3, title: 'El Regreso', body: 'Texto tres', format: 'markdown' },
  ];

  const result = importBook(project, chapters);
  assert.equal(result.imported.length, 3);
  assert.equal(result.unchanged.length, 0);
  assert.equal(result.refused.length, 0);

  // Assert scenes are ordered and zero-padded
  assert.deepEqual(project.scenes(), [
    'scenes/001-el-faro.md',
    'scenes/002-la-niebla.md',
    'scenes/003-el-regreso.md',
  ]);

  const scene1 = project.readScene('scenes/001-el-faro.md');
  assert.match(scene1!, /^# Texto uno/m);
});

test('idempotent re-import: re-importing the same book is a no-op', () => {
  const dir = join(tempDir(), 'book');
  const { project } = Project.init(dir, 'Novela Test');

  const chapters: ChapterInput[] = [
    { order: 1, title: 'El Faro', body: 'Texto uno', format: 'plain' },
    { order: 2, title: 'La Niebla', body: 'Texto dos', format: 'plain' },
  ];

  const first = importBook(project, chapters);
  assert.equal(first.imported.length, 2);
  const headAfterFirst = project.git.head();

  // Re-import identical chapters
  const second = importBook(project, chapters);
  assert.equal(second.imported.length, 0);
  assert.equal(second.unchanged.length, 2);
  assert.equal(second.refused.length, 0);

  // HEAD unchanged: no new commit made
  assert.equal(project.git.head(), headAfterFirst);
});

test('changed chapter refused and nothing partially written for that item', () => {
  const dir = join(tempDir(), 'book');
  const { project } = Project.init(dir, 'Novela Test');

  const chapters: ChapterInput[] = [
    { order: 1, title: 'El Faro', body: 'Texto original de Fran', format: 'plain' },
  ];
  importBook(project, chapters);

  // Modify scene 1 in the project and commit
  const scene1File = join(project.dir, 'scenes/001-el-faro.md');
  writeFileSync(scene1File, 'Texto editado y comprometido por el autor\n', 'utf8');
  project.git.commit('modificado por autor', ['scenes/001-el-faro.md']);
  const committedText = project.readScene('scenes/001-el-faro.md');

  // Attempt to re-import where chapter 1 has the old text, plus a new chapter 2
  const reimportChapters: ChapterInput[] = [
    { order: 1, title: 'El Faro', body: 'Texto original de Fran', format: 'plain' },
    { order: 2, title: 'La Niebla', body: 'Nuevo capítulo dos', format: 'plain' },
  ];

  const result = importBook(project, reimportChapters);

  // Chapter 1 must be refused
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].file, 'scenes/001-el-faro.md');
  assert.match(result.refused[0].reason, /already exists with different text/i);

  // Nothing partially written for that item: scene 1 remains untouched with the modified text
  assert.equal(project.readScene('scenes/001-el-faro.md'), committedText);

  // Chapter 2 was new, so it was imported successfully
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].file, 'scenes/002-la-niebla.md');
  assert.equal(project.readScene('scenes/002-la-niebla.md'), 'Nuevo capítulo dos\n');
});

test('inspect never prints a body (assert a unique marker string in the fixture body is absent from output)', () => {
  const dbDir = tempDir();
  const dbPath = join(dbDir, 'fixture.db');
  createSyntheticDb(dbPath);

  // Programmatic API inspection
  const report = inspectSqlite(dbPath);
  assert.equal(report.tables.length, 2);
  const chaptersTable = report.tables.find(t => t.name === 'chapters');
  assert.ok(chaptersTable);
  assert.equal(chaptersTable.rowCount, 4);

  const contentCol = chaptersTable.columns.find(c => c.name === 'content');
  assert.ok(contentCol?.textStats);
  assert.ok(contentCol.textStats.min > 0);
  assert.ok(contentCol.textStats.max >= contentCol.textStats.min);

  // CLI execution: text output
  const textRun = cli('inspect-sqlite', dbPath);
  assert.equal(textRun.code, 0);
  assert.doesNotMatch(textRun.stdout, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(textRun.stderr, new RegExp(SECRET_MARKER));
  assert.match(textRun.stdout, /chapters/);
  assert.match(textRun.stdout, /chapter_num/);
  assert.match(textRun.stdout, /content/);
  assert.match(textRun.stdout, /format/);

  // CLI execution: json output
  assert.doesNotMatch(JSON.stringify(textRun.json), new RegExp(SECRET_MARKER));
});

test('dry run writes nothing', () => {
  const dbDir = tempDir();
  const dbPath = join(dbDir, 'fixture.db');
  createSyntheticDb(dbPath);

  const mappingPath = join(ROOT_DIR, 'tests/fixtures/import/example-mapping.json');

  const bookDir = join(tempDir(), 'dry-book');
  cli('init', bookDir);

  const run = cli('import-sqlite', bookDir, dbPath, '--mapping', mappingPath, '--dry-run');
  assert.equal(run.code, 0);

  // Assert nothing was written to scenes/
  const scenes = Project.open(bookDir).scenes();
  assert.equal(scenes.length, 0);

  // Dry run output shows chapters and sizes but NO body text / marker
  assert.doesNotMatch(run.stdout, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(JSON.stringify(run.json), new RegExp(SECRET_MARKER));
  assert.match(run.stdout, /El Faro/);
  assert.match(run.stdout, /La Niebla/);
  assert.match(run.stdout, /El Regreso/);
});

test('read-only open: the db file bytes unchanged after import', () => {
  const dbDir = tempDir();
  const dbPath = join(dbDir, 'fixture.db');
  createSyntheticDb(dbPath);

  const mappingPath = join(ROOT_DIR, 'tests/fixtures/import/example-mapping.json');

  const beforeBytes = readFileSync(dbPath);
  const beforeHash = createHash('sha256').update(beforeBytes).digest('hex');

  const bookDir = join(tempDir(), 'imported-book');
  cli('init', bookDir);

  const run = cli('import-sqlite', bookDir, dbPath, '--mapping', mappingPath);
  assert.equal(run.code, 0);

  const afterBytes = readFileSync(dbPath);
  const afterHash = createHash('sha256').update(afterBytes).digest('hex');

  // Byte-for-byte identical database file
  assert.equal(afterHash, beforeHash);
  assert.deepEqual(afterBytes, beforeBytes);

  // Verify book import succeeded
  const project = Project.open(bookDir);
  assert.deepEqual(project.scenes(), [
    'scenes/001-el-faro.md',
    'scenes/002-la-niebla.md',
    'scenes/003-el-regreso.md',
  ]);
});

test('sqlite source with declarative mapping filters by book_id and orders rows', () => {
  const dbDir = tempDir();
  const dbPath = join(dbDir, 'fixture.db');
  createSyntheticDb(dbPath);

  const mapping: SqliteMapping = {
    table: 'chapters',
    columns: {
      order: 'chapter_num',
      title: 'title',
      body: 'content',
      format: 'format',
    },
    filter: 'book_id = 1',
    orderBy: 'chapter_num ASC',
  };

  const rows = readSqliteSource(dbPath, mapping);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'El Faro');
  assert.equal(rows[1].title, 'La Niebla');
  assert.equal(rows[2].title, 'El Regreso');

  // Test SQL query mapping
  const queryMapping: SqliteMapping = {
    query: `SELECT chapter_num as [order], title, content as body, format FROM chapters WHERE book_id = 1 ORDER BY chapter_num DESC`,
  };
  const queryRows = readSqliteSource(dbPath, queryMapping);
  assert.equal(queryRows.length, 3);
  assert.equal(queryRows[0].title, 'El Regreso');
  assert.equal(queryRows[1].title, 'La Niebla');
  assert.equal(queryRows[2].title, 'El Faro');
});

const ROOT_DIR = join(import.meta.dirname, '..');
