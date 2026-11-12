import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readZip } from '../src/adapters/zip.ts';
import { buildDocx } from '../src/adapters/docx.ts';
import { exportManuscript, exportFilename } from '../src/application/export.ts';
import { Project } from '../src/application/project.ts';
import { compileMarkdown, parseMarkdown, type ManuscriptPart } from '../src/domain/manuscript.ts';
import { cli, git, tempDir } from './helpers.ts';

const scene = (file: string, text: string) => ({ file, text });

test('markdown: title page, wikilinks as display text, scene breaks, byte-exact', () => {
  const outline: ManuscriptPart[] = [{ scenes: [
    scene('scenes/01.md', 'Elena miró a [[Marta|la capitana]].\n\nEl mar *brillaba* en [[Sal#Puerto]].\n'),
    scene('scenes/02.md', '\n\nSegundo [[Sal]] y `[[código]]`.\n\n'),
  ] }];
  assert.equal(
    compileMarkdown('El Puente de Sal', outline),
    '# El Puente de Sal\n\nElena miró a la capitana.\n\nEl mar *brillaba* en Sal.\n\n* * *\n\nSegundo Sal y `[[código]]`.\n',
  );
});

test('markdown: a chapter heading per titled part, no break between chapters, empty scenes skipped', () => {
  const outline: ManuscriptPart[] = [
    { title: 'Uno', scenes: [scene('a', 'A'), scene('b', '  \n'), scene('c', 'C')] },
    { title: 'Dos', scenes: [scene('d', 'D')] },
  ];
  assert.equal(compileMarkdown('T', outline), '# T\n\n## Uno\n\nA\n\n* * *\n\nC\n\n## Dos\n\nD\n');
});

test('markdown parser: the subset becomes blocks and runs', () => {
  const blocks = parseMarkdown('## Hola\n\nUn **negrita** y *cursiva* y ***ambas*** y ~~tachado~~ y \\*lit\\*.\nsigue  \nlínea\n\n- uno\n- dos\n\n1. a\n2. b\n\n> cita\n\n***\n\n```\n**no**\n```');
  assert.deepEqual(blocks.map((b) => b.kind).filter((k, i, all) => k !== all[i - 1]), ['heading', 'paragraph', 'list', 'quote', 'break', 'paragraph']);
  const para: any = blocks[1];
  const bold = para.runs.filter((r: any) => r.bold && !r.italic).map((r: any) => r.text);
  assert.deepEqual(bold, ['negrita']);
  assert.ok(para.runs.some((r: any) => r.bold && r.italic && r.text === 'ambas'));
  assert.ok(para.runs.some((r: any) => r.strike && r.text === 'tachado'));
  assert.ok(para.runs.some((r: any) => r.text?.includes('*lit*')));
  assert.ok(para.runs.some((r: any) => r.br), 'a hard break');
  assert.equal(blocks.filter((b) => b.kind === 'list').map((b: any) => b.ordered).join(), 'false,false,true,true');
  assert.equal((blocks[blocks.length - 1] as any).runs[0].text, '**no**', 'code stays literal');
});

test('markdown parser: each newline inside a paragraph is a line break, as the editor shows it', () => {
  const [para]: any = parseMarkdown('Primera línea\nsegunda línea');
  assert.deepEqual(para.runs, [{ text: 'Primera línea' }, { br: true }, { text: 'segunda línea' }]);
});

function docxParts(buf: Buffer): Record<string, string> {
  return Object.fromEntries(readZip(buf).map((e) => [e.name, e.getData().toString('utf8')]));
}

test('docx: package parts present, XML well formed, styles and runs as expected', () => {
  const outline: ManuscriptPart[] = [{ title: 'Capítulo <1>', scenes: [
    scene('a', '# Titulillo\n\nHola **mundo** & *amigos* "x".\n\n- uno\n- dos\n\n1. a\n\n> cita'),
    scene('b', 'Segunda'),
  ] }];
  const parts = docxParts(buildDocx('Mi "libro" & co', outline));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
    assert.ok(name in parts, `${name} present`);
  }
  for (const xml of Object.values(parts)) assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>\n<[A-Za-z:]+/);
  const doc = parts['word/document.xml'];
  assert.match(doc, /<w:pStyle w:val="Title"\/>.*Mi &quot;libro&quot; &amp; co/);
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>.*Capítulo &lt;1&gt;/);
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>.*Titulillo/s);
  assert.match(doc, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">mundo<\/w:t><\/w:r>/);
  assert.match(doc, /<w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">amigos<\/w:t><\/w:r>/);
  assert.match(doc, /<w:pStyle w:val="Quote"\/>/);
  assert.match(doc, /<w:numPr>/);
  assert.match(doc, /\* \* \*/);
  for (const style of ['Normal', 'Title', 'Heading1']) assert.match(parts['word/styles.xml'], new RegExp(`w:styleId="${style}"`));
  assert.match(parts['docProps/core.xml'], /Mi &quot;libro&quot; &amp; co/);
});

test('docx: control characters never produce invalid XML and text is never dropped', () => {
  const doc = docxParts(buildDocx('T', [{ scenes: [scene('a', 'a\u0001b <html> | tabla |\tfin [enlace](http://x.y)')] }]))['word/document.xml'];
  assert.doesNotMatch(doc, /\u0001/);
  assert.match(doc, /&lt;html&gt;/);
  assert.match(doc, /\| tabla \|/);
  assert.match(doc, /enlace/);
  assert.match(doc, /http:\/\/x\.y/);
});

function fixtureBook(): string {
  const dir = tempDir();
  const { project } = Project.init(join(dir, 'book'), 'El Puente de Sal');
  mkdirSync(join(project.dir, 'scenes'), { recursive: true });
  writeFileSync(join(project.dir, 'scenes', '02-b.md'), 'Segunda [[Elena|ella]].\n');
  writeFileSync(join(project.dir, 'scenes', '01-a.md'), 'Primera.\n');
  mkdirSync(join(project.dir, 'notas'), { recursive: true });
  writeFileSync(join(project.dir, 'notas', 'Elena.md'), 'SECRETO DE NOTA\n');
  git(project.dir, 'add', '-A');
  git(project.dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'book');
  return project.dir;
}

test('exportManuscript: scenes in order, notes excluded, nothing written', () => {
  const dir = fixtureBook();
  const project = Project.open(dir);
  const before = git(dir, 'status', '--porcelain') + git(dir, 'rev-list', '--all', '--count');
  const out = exportManuscript(project, 'md');
  assert.equal(out.body.toString(), '# El Puente de Sal\n\nPrimera.\n\n* * *\n\nSegunda ella.\n');
  assert.doesNotMatch(out.body.toString(), /SECRETO/);
  assert.equal(out.filename, 'El-Puente-de-Sal.md');
  assert.equal(out.contentType, 'text/markdown; charset=utf-8');
  const docx = exportManuscript(project, 'docx');
  assert.equal(docx.filename, 'El-Puente-de-Sal.docx');
  assert.doesNotMatch(docxParts(docx.body)['word/document.xml'], /SECRETO/);
  assert.equal(git(dir, 'status', '--porcelain') + git(dir, 'rev-list', '--all', '--count'), before, 'no commit, no change');
});

test('exportManuscript follows the book: chapters as headings, book order, archived scenes left out', () => {
  const dir = fixtureBook();
  writeFileSync(join(dir, 'scenes', '03-c.md'), 'Tercera.\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'third');
  const project = Project.open(dir);
  const step = (op: any) => project.editStructure(project.outline().version, op, 'user_fran');
  step({ op: 'create_chapter', title: 'Uno' });
  const chapter = project.outline().chapters[0].id;
  step({ op: 'move_scene', file: 'scenes/02-b.md', chapter, position: 0 });
  step({ op: 'move_scene', file: 'scenes/01-a.md', chapter });
  step({ op: 'archive_scene', file: 'scenes/03-c.md' });
  assert.equal(exportManuscript(project, 'md').body.toString(), '# El Puente de Sal\n\n## Uno\n\nSegunda ella.\n\n* * *\n\nPrimera.\n');
  assert.match(docxParts(exportManuscript(project, 'docx').body)['word/document.xml'], /<w:pStyle w:val="Heading1"\/>.*Uno/);
});

test('exportFilename is a safe ASCII name from the title', () => {
  assert.equal(exportFilename('¿Qué será, Ñandú?/../x', 'md'), 'Que-sera-Nandu-x.md');
  assert.equal(exportFilename('***', 'docx'), 'libro.docx');
  assert.equal(exportFilename('"quoted"\r\nheader: x', 'md'), 'quoted-header-x.md');
});

test('CLI: rewrite export writes the file, reports it, and fails clearly on bad input', () => {
  const dir = fixtureBook();
  const out = join(tempDir(), 'libro.docx');
  const ok = cli('export', dir, '--format', 'docx', '--out', out);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(existsSync(out));
  assert.match(docxParts(readFileSync(out))['word/document.xml'], /Primera/);
  assert.match(ok.stdout, /libro\.docx/);
  const md = join(tempDir(), 'libro.md');
  assert.equal(cli('export', dir, '--format', 'md', '--out', md).code, 0);
  assert.match(readFileSync(md, 'utf8'), /^# El Puente de Sal\n/);
  assert.notEqual(cli('export', dir, '--format', 'pdf', '--out', md).code, 0);
  assert.notEqual(cli('export', dir, '--format', 'md').code, 0, '--out is required');
  assert.notEqual(cli('export', join(dir, 'nope'), '--format', 'md', '--out', md).code, 0);
});
