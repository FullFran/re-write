import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, git, tempDir } from './helpers.ts';
import { Project } from '../src/application/project.ts';
import {
  chapterFilename,
  convertToMarkdown,
  importBook,
  type ChapterInput,
} from '../src/application/book-import.ts';
import {
  formatNotionInspection,
  inspectNotion,
  loadNotionChapters,
  stripNotionPropertyHeader,
  type NotionMapping,
} from '../src/application/notion-export.ts';
import { readZip } from '../src/adapters/zip.ts';

const SECRET_MARKER = 'SECRET_ANDRES_UNPUBLISHED_NOVEL_PROSE_MARKER_998877';
const SECRET_CELL = 'SECRET_CSV_CELL_VALUE_112233';

function buildSyntheticZip(entries: { name: string; content: string | Buffer }[]): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const crc = crc32(dataBuf);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // method 0 = store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    localChunks.push(lh, nameBuf, dataBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    cdChunks.push(cd, nameBuf);
    offset += 30 + nameBuf.length + dataBuf.length;
  }

  const cdTotalSize = cdChunks.reduce((acc, c) => acc + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdTotalSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...cdChunks, eocd]);
}

function createSyntheticNotionFiles(): { name: string; content: string }[] {
  const csv = [
    'Título,Orden,Libro,Notas',
    `El Faro,1,El Mar del Norte,${SECRET_CELL}`,
    'La Niebla,2,El Mar del Norte,Revisar diálogo',
    'La Ciudad,1,Otro Libro,Capítulo ajeno',
    'Capítulo Perdido,3,El Mar del Norte,Sin página md',
  ].join('\n');

  const page1 = `# El Faro

Orden: 1
Libro: El Mar del Norte
Status: Listo

La luz del faro cortaba la oscuridad de la noche en el mar.
`;

  const page2 = `# La Niebla

Orden: 2
Libro: El Mar del Norte

La niebla cubría la costa entera, densa y fría.
${SECRET_MARKER}
`;

  const page3 = `# La Ciudad

Orden: 1
Libro: Otro Libro

Una ciudad lejana bajo la lluvia.
`;

  return [
    { name: 'Capítulos.csv', content: csv },
    { name: 'El Faro 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md', content: page1 },
    { name: 'La Niebla 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c.md', content: page2 },
    { name: 'La Ciudad aabbccddeeff00112233445566778899.md', content: page3 },
  ];
}

function writeSyntheticNotionDir(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const f of createSyntheticNotionFiles()) {
    writeFileSync(join(targetDir, f.name), f.content, 'utf8');
  }
}

test('html and plain conversion cases including a <script> tag dropped', () => {
  const htmlInput = `
    <h1>Capítulo 1</h1>
    <p>Era una noche <strong>oscura</strong> y <em>tormentosa</em>.</p>
    <script>alert("malicious");</script>
    <p>Línea uno.<br>Línea dos.</p>
  `;
  const converted = convertToMarkdown(htmlInput, 'html');
  assert.doesNotMatch(converted, /<script/i);
  assert.doesNotMatch(converted, /malicious/);
  assert.match(converted, /^# Capítulo 1/m);
  assert.match(converted, /\*\*oscura\*\*/);
  assert.match(converted, /\*tormentosa\*/);
  assert.match(converted, /Línea uno\.\nLínea dos\./);

  // Entities
  const entities = `<p>&laquo;El faro&raquo; &amp; &quot;la niebla&quot; &#8212; &iexcl;hola!</p>`;
  assert.match(convertToMarkdown(entities, 'html'), /«El faro» & "la niebla" — ¡hola!/);

  // Plain
  const plain = 'Párrafo uno.\n\nPárrafo dos.\n';
  assert.equal(convertToMarkdown(plain, 'plain'), plain);

  // Unsupported format throws clear error
  assert.throws(() => convertToMarkdown('{\\rtf1 test}', 'rtf'), /unsupported format.*rtf/i);
});

test('chapterFilename produces stable zero-padded order and slug', () => {
  assert.equal(chapterFilename(1, 'El Faro'), '001-el-faro.md');
  assert.equal(chapterFilename(12, 'Capítulo 12: La Niebla'), '012-capitulo-12-la-niebla.md');
  assert.equal(chapterFilename(105, 'Epílogo & Fin!'), '105-epilogo-fin.md');
});

test('stripNotionPropertyHeader removes property block but retains title and body', () => {
  const notionMd = `# Capítulo Uno

Autor: Andrés
Orden: 1
Libro: El Mar del Norte
Status: En progreso

Este es el inicio de la novela tras la cabecera.
`;
  const cleaned = stripNotionPropertyHeader(notionMd);
  assert.doesNotMatch(cleaned, /Autor: Andrés/);
  assert.doesNotMatch(cleaned, /Status: En progreso/);
  assert.match(cleaned, /^# Capítulo Uno\n\nEste es el inicio de la novela/);
});

test('ordered import into scenes from Notion export', () => {
  const exportDir = join(tempDir(), 'notion-export');
  writeSyntheticNotionDir(exportDir);

  const bookDir = join(tempDir(), 'book');
  const { project } = Project.init(bookDir, 'Novela');

  const mapping: NotionMapping = {
    database: 'Capítulos.csv',
    titleColumn: 'Título',
    orderColumn: 'Orden',
    filter: { column: 'Libro', value: 'El Mar del Norte' },
  };

  const { chapters } = loadNotionChapters(exportDir, mapping);
  const result = importBook(project, chapters);

  assert.equal(result.imported.length, 2);
  assert.equal(result.unchanged.length, 0);
  assert.equal(result.refused.length, 0);

  assert.deepEqual(project.scenes(), [
    'scenes/001-el-faro.md',
    'scenes/002-la-niebla.md',
  ]);

  const scene1 = project.readScene('scenes/001-el-faro.md');
  assert.match(scene1!, /^# El Faro/m);
  assert.doesNotMatch(scene1!, /Status: Listo/);
});

test('idempotent re-import: re-importing the same Notion export is a no-op', () => {
  const exportDir = join(tempDir(), 'notion-export');
  writeSyntheticNotionDir(exportDir);

  const bookDir = join(tempDir(), 'book');
  const { project } = Project.init(bookDir, 'Novela');

  const mapping: NotionMapping = {
    database: 'Capítulos.csv',
    titleColumn: 'Título',
    orderColumn: 'Orden',
    filter: { column: 'Libro', value: 'El Mar del Norte' },
  };

  const { chapters } = loadNotionChapters(exportDir, mapping);
  importBook(project, chapters);
  const head = project.git.head();

  const second = importBook(project, chapters);
  assert.equal(second.imported.length, 0);
  assert.equal(second.unchanged.length, 2);
  assert.equal(second.refused.length, 0);
  assert.equal(project.git.head(), head);
});

test('changed chapter refused and nothing partially written for that item', () => {
  const exportDir = join(tempDir(), 'notion-export');
  writeSyntheticNotionDir(exportDir);

  const bookDir = join(tempDir(), 'book');
  const { project } = Project.init(bookDir, 'Novela');

  const mapping: NotionMapping = {
    database: 'Capítulos.csv',
    titleColumn: 'Título',
    orderColumn: 'Orden',
    filter: { column: 'Libro', value: 'El Mar del Norte' },
  };

  const { chapters } = loadNotionChapters(exportDir, mapping);
  // Import only chapter 1 first
  importBook(project, [chapters[0]]);

  // Author edits scene 1 in project
  const scene1Path = join(project.dir, 'scenes/001-el-faro.md');
  writeFileSync(scene1Path, 'Texto modificado por el autor en RE;write\n', 'utf8');
  project.git.commit('autor edita escena 1', ['scenes/001-el-faro.md']);
  const headBefore = project.git.head();

  // Re-importing chapters 1 and 2: chapter 1 is refused, chapter 2 imported
  const result = importBook(project, chapters);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].file, 'scenes/001-el-faro.md');
  assert.match(result.refused[0].reason, /already exists with different text/);

  // Scene 1 remains untouched
  assert.equal(project.readScene('scenes/001-el-faro.md'), 'Texto modificado por el autor en RE;write\n');

  // Chapter 2 is imported
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].file, 'scenes/002-la-niebla.md');
  assert.notEqual(project.git.head(), headBefore);
});

test('filter by book imports only chapters for requested book', () => {
  const exportDir = join(tempDir(), 'notion-export');
  writeSyntheticNotionDir(exportDir);

  const mapping: NotionMapping = {
    database: 'Capítulos.csv',
    filter: { column: 'Libro', value: 'Otro Libro' },
  };

  const { chapters } = loadNotionChapters(exportDir, mapping);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, 'La Ciudad');
});

test('missing page reported when CSV lists a row with no markdown file', () => {
  const exportDir = join(tempDir(), 'notion-export');
  writeSyntheticNotionDir(exportDir);

  const mapping: NotionMapping = {
    database: 'Capítulos.csv',
    filter: { column: 'Libro', value: 'El Mar del Norte' },
  };

  const { chapters, missing } = loadNotionChapters(exportDir, mapping);
  assert.equal(chapters.length, 2);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].title, 'Capítulo Perdido');
  assert.match(missing[0].reason, /missing page file in Notion export/i);
});

test('zip traversal entry refused', () => {
  const evilZip = buildSyntheticZip([
    { name: '../evil.txt', content: 'malicious payload' },
  ]);

  assert.throws(
    () => readZip(evilZip),
    /path traversal/i
  );

  const absoluteZip = buildSyntheticZip([
    { name: '/root/evil.txt', content: 'malicious payload' },
  ]);

  assert.throws(
    () => readZip(absoluteZip),
    /absolute path/i
  );
});

test('inspect never prints page text or cell values (unique marker absent)', () => {
  const exportDir = join(tempDir(), 'notion-dir');
  writeSyntheticNotionDir(exportDir);

  // Programmatic inspection and text formatting
  const report = inspectNotion(exportDir);
  const formatted = formatNotionInspection(report);
  assert.doesNotMatch(formatted, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(formatted, new RegExp(SECRET_CELL));
  assert.match(formatted, /Capítulos\.csv/);
  assert.match(formatted, /Columns: Título, Orden, Libro, Notas/);

  // Inspect directory via CLI (--json by default in helper)
  const dirRun = cli('notion-inspect', exportDir);
  assert.equal(dirRun.code, 0);
  assert.doesNotMatch(dirRun.stdout, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(dirRun.stdout, new RegExp(SECRET_CELL));
  assert.doesNotMatch(JSON.stringify(dirRun.json), new RegExp(SECRET_MARKER));
  assert.doesNotMatch(JSON.stringify(dirRun.json), new RegExp(SECRET_CELL));
  assert.equal(dirRun.json.databases[0].name, 'Capítulos.csv');
  assert.deepEqual(dirRun.json.databases[0].columns, ['Título', 'Orden', 'Libro', 'Notas']);

  // Inspect ZIP via CLI
  const zipPath = join(tempDir(), 'notion-export.zip');
  writeFileSync(zipPath, buildSyntheticZip(createSyntheticNotionFiles()));

  const zipRun = cli('notion-inspect', zipPath);
  assert.equal(zipRun.code, 0);
  assert.doesNotMatch(zipRun.stdout, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(zipRun.stdout, new RegExp(SECRET_CELL));
  assert.doesNotMatch(JSON.stringify(zipRun.json), new RegExp(SECRET_MARKER));
  assert.doesNotMatch(JSON.stringify(zipRun.json), new RegExp(SECRET_CELL));
  assert.equal(zipRun.json.databases[0].name, 'Capítulos.csv');
});

test('dry run writes nothing', () => {
  const zipPath = join(tempDir(), 'notion-export.zip');
  writeFileSync(zipPath, buildSyntheticZip(createSyntheticNotionFiles()));

  const bookDir = join(tempDir(), 'dry-book');
  cli('init', bookDir);

  const mappingPath = join(ROOT_DIR, 'tests/fixtures/import/example-mapping.json');

  const run = cli('import-notion', bookDir, zipPath, '--mapping', mappingPath, '--dry-run');
  assert.equal(run.code, 0);

  // Assert nothing written to scenes/
  const scenes = Project.open(bookDir).scenes();
  assert.equal(scenes.length, 0);

  // Dry run output shows titles and sizes but no body text or markers
  assert.doesNotMatch(run.stdout, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(JSON.stringify(run.json), new RegExp(SECRET_MARKER));
  assert.match(run.stdout, /El Faro/);
  assert.match(run.stdout, /La Niebla/);
  assert.match(run.stdout, /Capítulo Perdido/);
});

test('import-notion CLI imports from zip and reports missing page in refused', () => {
  const zipPath = join(tempDir(), 'notion-export.zip');
  writeFileSync(zipPath, buildSyntheticZip(createSyntheticNotionFiles()));

  const bookDir = join(tempDir(), 'cli-book');
  cli('init', bookDir);

  const mappingPath = join(ROOT_DIR, 'tests/fixtures/import/example-mapping.json');

  const run = cli('import-notion', bookDir, zipPath, '--mapping', mappingPath);
  assert.equal(run.code, 0);

  const project = Project.open(bookDir);
  assert.deepEqual(project.scenes(), [
    'scenes/001-el-faro.md',
    'scenes/002-la-niebla.md',
  ]);

  // Missing page was reported under refused
  assert.equal(run.json.refused.length, 1);
  assert.equal(run.json.refused[0].title, 'Capítulo Perdido');
  assert.match(run.json.refused[0].reason, /missing page file in Notion export/i);
});

const ROOT_DIR = join(import.meta.dirname, '..');
