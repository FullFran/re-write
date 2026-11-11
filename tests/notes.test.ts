import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Project, SceneConflictError, SceneNotFoundError } from '../src/application/project.ts';
import { git, newBook, tempDir } from './helpers.ts';

/** A book with notes committed the way a person's own git would. */
function bookWith(notes: Record<string, string>): Project {
  const dir = newBook();
  mkdirSync(join(dir, 'notas'), { recursive: true });
  for (const [name, text] of Object.entries(notes)) writeFileSync(join(dir, 'notas', `${name}.md`), text);
  if (Object.keys(notes).length) {
    git(dir, 'add', 'notas');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'notes');
  }
  return new Project(dir);
}

test('notes are the regular Markdown files with valid names directly in a real notas/ directory', () => {
  const project = bookWith({ Elena: 'Capitana.', 'Puente de Sal': '---\ntype: lugar\n---\n' });
  const outside = join(tempDir(), 'secreto.md');
  writeFileSync(outside, 'fuera del libro');
  symlinkSync(outside, join(project.dir, 'notas', 'Enlace.md'));
  writeFileSync(join(project.dir, 'notas', '.oculta.md'), 'x');
  writeFileSync(join(project.dir, 'notas', 'texto.txt'), 'x');
  mkdirSync(join(project.dir, 'notas', 'sub'));
  writeFileSync(join(project.dir, 'notas', 'sub', 'Dentro.md'), 'x');
  assert.deepEqual(project.notes(), ['Elena', 'Puente de Sal']);
  assert.equal(project.readNote('Elena'), 'Capitana.');
  assert.equal(project.readNote('Enlace'), null, 'a symlink is never read');
  assert.equal(project.readNote('Nadie'), null);
  assert.throws(() => project.readNote('a/../b'), /cannot contain "\/"/);
});

test('a notas/ directory that is a symlink holds no notes', () => {
  const dir = newBook();
  const real = join(tempDir(), 'notas-reales');
  mkdirSync(real);
  writeFileSync(join(real, 'Elena.md'), 'x');
  symlinkSync(real, join(dir, 'notas'), 'dir');
  const project = new Project(dir);
  assert.deepEqual(project.notes(), []);
  assert.equal(project.readNote('Elena'), null);
});

test('proposing a new note writes nothing; accepting it creates the note and the record in one commit', () => {
  const project = bookWith({});
  const head = project.git.head();
  const text = '---\ntype: personaje\naliases: [la capitana]\n---\nCustodia el puente.\n';
  const { proposal, created } = project.proposeNote({ name: 'Elena', text, rationale: 'Ficha del personaje', proposed_by: 'agent' });
  assert.equal(created, true);
  assert.equal(proposal.file, 'notas/Elena.md');
  assert.equal(proposal.creates, true);
  assert.equal(existsSync(join(project.dir, 'notas', 'Elena.md')), false);
  assert.deepEqual(project.proposeNote({ name: 'Elena', text, rationale: 'Ficha del personaje' }).created, false, 'a retry creates no duplicate');
  const shown = project.showProposal(proposal.proposal_id);
  assert.equal(shown.applicable, true);
  assert.match(shown.diff, /^\+Custodia el puente\.$/m);
  const proposedAt = project.git.head();
  assert.equal(git(project.dir, 'rev-parse', 'HEAD~1'), head);

  project.reviewProposal(proposal.proposal_id, 'accept', 'user_fran');
  assert.equal(readFileSync(join(project.dir, 'notas', 'Elena.md'), 'utf8'), text);
  assert.equal(git(project.dir, 'rev-parse', 'HEAD~1'), proposedAt, 'exactly one commit');
  assert.deepEqual(git(project.dir, 'diff', '--name-only', proposedAt, 'HEAD').split('\n').sort(),
    [`.rewrite/proposals/${proposal.proposal_id}.json`, 'notas/Elena.md']);
  assert.equal(git(project.dir, 'status', '--porcelain'), '');
  assert.deepEqual(project.notes(), ['Elena']);
  assert.equal(project.showProposal(proposal.proposal_id).applicable, false);
});

test('a new note is refused for a bad name, an existing note, or a name equal to one but for case or accents', () => {
  const project = bookWith({ Ángel: 'x' });
  const propose = (name: string) => () => project.proposeNote({ name, text: 'x', rationale: 'r' });
  assert.throws(propose('a/b'), /cannot contain "\/"/);
  assert.throws(propose('Ángel'), /already exists/);
  assert.throws(propose('angel'), /"angel" differs from the existing note "Ángel" only by case or accents/);
  assert.equal(project.proposals.all().length, 0);
});

test('accepting a new note never overwrites: a file that appeared meanwhile, or a near-duplicate note, refuses it', () => {
  const project = bookWith({});
  const first = project.proposeNote({ name: 'Elena', text: 'propuesta', rationale: 'r' }).proposal;
  const second = project.proposeNote({ name: 'ELENA', text: 'otra', rationale: 'r' }).proposal;
  writeFileSync(join(project.dir, 'notas', 'Elena.md'), 'escrita a mano');
  const head = project.git.head();
  assert.throws(() => project.reviewProposal(first.proposal_id, 'accept', 'user_fran'), /notas\/Elena\.md already exists; nothing was written/);
  assert.equal(readFileSync(join(project.dir, 'notas', 'Elena.md'), 'utf8'), 'escrita a mano');
  assert.equal(project.proposals.get(first.proposal_id)!.status, 'proposed');
  assert.throws(() => project.reviewProposal(second.proposal_id, 'accept', 'user_fran'), /differs from the existing note "Elena" only by case or accents/);
  assert.equal(project.git.head(), head);
});

test('an existing note changes through propose_revision like a scene, and only on accept', () => {
  const project = bookWith({ Elena: 'Capitana del puente.\n' });
  const { proposal } = project.proposeRevision({ file: 'notas/Elena.md', find: 'Capitana', replace: 'Guardiana', rationale: 'r' });
  assert.equal(project.readNote('Elena'), 'Capitana del puente.\n');
  project.reviewProposal(proposal.proposal_id, 'accept', 'user_fran');
  assert.equal(project.readNote('Elena'), 'Guardiana del puente.\n');
  assert.throws(() => project.proposeRevision({ file: 'notas/../../fuera.md', find: 'a', replace: 'b', rationale: 'r' }), /inside scenes\/ \(a scene\) or notas\/ \(a note\)/);
});

test('a note creation cannot be reverted or proposed again automatically', () => {
  const project = bookWith({});
  const { proposal } = project.proposeNote({ name: 'Elena', text: 'x', rationale: 'r' });
  project.reviewProposal(proposal.proposal_id, 'accept', 'user_fran');
  const accepted = project.proposals.get(proposal.proposal_id)!;
  assert.throws(() => project.revertProposal(proposal.proposal_id, 'user_fran', accepted.history.length), /Esta propuesta creó una nota/);
  assert.throws(() => project.reproposeRevision(proposal.proposal_id, 'user_fran'), /Esta propuesta creó una nota/);
});

test('a person edits a note on top of the version they opened, in one commit', () => {
  const project = bookWith({ Elena: 'Capitana.\n' });
  const blob = project.git.blobOf('notas/Elena.md');
  const head = project.git.head();
  const saved = project.editNote({ name: 'Elena', base_blob: blob, text: 'Capitana del puente.\n', by: 'user_fran' });
  assert.equal(saved.changed, true);
  assert.equal(saved.file, 'notas/Elena.md');
  assert.equal(project.readNote('Elena'), 'Capitana del puente.\n');
  assert.equal(git(project.dir, 'rev-parse', 'HEAD~1'), head);
  assert.equal(git(project.dir, 'log', '-1', '--format=%s'), 'rewrite: edit notas/Elena.md');
  assert.throws(() => project.editNote({ name: 'Elena', base_blob: blob, text: 'otra', by: 'u' }), SceneConflictError);
  assert.throws(() => project.editNote({ name: 'Nadie', base_blob: blob, text: 'otra', by: 'u' }), SceneNotFoundError);
});

test('a new note is refused while notas/<name>.md has uncommitted changes, at proposal and at accept', () => {
  const project = bookWith({ Elena: 'Capitana.\n' });
  rmSync(join(project.dir, 'notas', 'Elena.md'));
  assert.throws(() => project.proposeNote({ name: 'Elena', text: 'Nueva.\n', rationale: 'r' }), /notas\/Elena\.md has uncommitted changes/);

  const later = bookWith({ Faro: 'Un faro.\n' });
  const { proposal } = later.proposeNote({ name: 'Ana', text: 'x', rationale: 'r' });
  git(later.dir, 'mv', 'notas/Faro.md', 'notas/Ana.md');
  git(later.dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'rename');
  rmSync(join(later.dir, 'notas', 'Ana.md'));
  const head = later.git.head();
  assert.throws(() => later.reviewProposal(proposal.proposal_id, 'accept', 'user_fran'), /notas\/Ana\.md has uncommitted changes/);
  assert.equal(existsSync(join(later.dir, 'notas', 'Ana.md')), false);
  assert.equal(later.git.head(), head);
  assert.equal(later.showProposal(proposal.proposal_id).applicable, false);
});
