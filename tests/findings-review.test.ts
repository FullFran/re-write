import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Project } from '../src/application/project.ts';
import { decide } from '../src/application/decision.ts';
import { REVIEW_DECIDE } from '../src/hcs/ids.ts';
import { git, read } from './helpers.ts';
import { reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
const QUOTE = 'Elena llevaba once años custodiando el puente de Sal';

let h: Harness;
let session: string;
let findingId: string;

before(async () => {
  h = await startHarness();
  session = await h.session('user_fran');

  // Propose a narrative finding on the test book
  const project = Project.open(h.bookDir);
  const result = project.proposeFindings([
    {
      question: 'motivation',
      kind: 'fact',
      statement: 'Elena custodia el puente de Sal desde hace once años.',
      characters: ['Elena'],
      evidence: [{ file: SCENE, quote: QUOTE }],
    },
  ], 'assistant_ophelia');
  findingId = result.created[0];
});

after(() => h.close());

test('list findings with evidence status', async () => {
  const res = await reviewApi(h, '/books/sal/findings', session);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.findings), 'findings is an array');
  assert.equal(data.findings.length, 1);

  const f = data.findings[0];
  assert.equal(f.finding_id, findingId);
  assert.equal(f.question, 'motivation');
  assert.equal(f.kind, 'fact');
  assert.equal(f.statement, 'Elena custodia el puente de Sal desde hace once años.');
  assert.deepEqual(f.characters, ['Elena']);
  assert.equal(f.author, 'assistant_ophelia');
  assert.equal(f.evidence_status, 'valid');
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0].file, SCENE);
  assert.equal(f.evidence[0].quote, QUOTE);
  assert.equal(f.evidence[0].status, 'valid');

  // Also accessible through the book queue
  const queueRes = await reviewApi(h, '/books/sal', session);
  assert.equal(queueRes.status, 200);
  const queueData = await queueRes.json();
  const queueFinding = (queueData.finding_views || queueData.findings).find((x: any) => x.finding_id === findingId);
  assert.ok(queueFinding, 'finding is in the book review queue');
  assert.equal(queueFinding.evidence_status, 'valid');
});

test('rate useful then change to noise (latest wins, history kept)', async () => {
  const sceneBefore = read(h.bookDir, SCENE);

  // Rate useful
  const res1 = await reviewApi(h, `/books/sal/findings/${findingId}`, session, {
    verdict: 'useful',
    note: 'ayuda a entender la motivación',
  });
  assert.equal(res1.status, 200);
  const v1 = await res1.json();
  assert.equal(v1.verdict, 'useful');
  assert.equal(v1.by, 'user_fran');
  assert.equal(v1.note, 'ayuda a entender la motivación');

  // Scene text must never change after rating
  assert.equal(read(h.bookDir, SCENE), sceneBefore, 'rating never changes scene text');

  // Change to noise
  const res2 = await reviewApi(h, `/books/sal/findings/${findingId}`, session, {
    verdict: 'noise',
    note: 'en realidad es ruido conocido',
  });
  assert.equal(res2.status, 200);
  const v2 = await res2.json();
  assert.equal(v2.verdict, 'noise');
  assert.equal(v2.by, 'user_fran');
  assert.equal(v2.note, 'en realidad es ruido conocido');

  // Again, scene text must not change
  assert.equal(read(h.bookDir, SCENE), sceneBefore, 'rating never changes scene text');

  // Fetch findings to verify latest wins and history is kept
  const listRes = await reviewApi(h, '/books/sal/findings', session);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  const ratedFinding = listData.findings.find((x: any) => x.finding_id === findingId);
  assert.ok(ratedFinding, 'rated finding found');
  assert.ok(ratedFinding.verdict, 'verdict present');
  assert.equal(ratedFinding.verdict.verdict, 'noise', 'latest verdict wins');
  assert.equal(ratedFinding.verdict.by, 'user_fran');
  assert.equal(ratedFinding.verdict.note, 'en realidad es ruido conocido');

  // History kept
  assert.ok(Array.isArray(ratedFinding.verdict.history), 'verdict history is an array');
  assert.equal(ratedFinding.verdict.history.length, 1, 'history has previous rating');
  assert.equal(ratedFinding.verdict.history[0].verdict, 'useful');
  assert.equal(ratedFinding.verdict.history[0].note, 'ayuda a entender la motivación');
  assert.equal(ratedFinding.verdict.history[0].by, 'user_fran');
});

test('rating refused for a non-member (same 404 as a missing book) and from the MCP door', async () => {
  const stranger = await h.session('user_stranger');
  const hidden = await reviewApi(h, `/books/sal/findings/${findingId}`, stranger, { verdict: 'useful' });
  const missing = await reviewApi(h, `/books/missing/findings/${findingId}`, stranger, { verdict: 'useful' });
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await hidden.json(), await missing.json(), 'existence not leaked to stranger');

  // MCP door: agent token receives 401 on review API
  const agent = await h.access('user_fran');
  const mcpAttempt = await reviewApi(h, `/books/sal/findings/${findingId}`, agent, { verdict: 'useful' });
  assert.equal(mcpAttempt.status, 401, 'agent token refused on review door');

  // MCP door: decide() refuses REVIEW_DECIDE permission through mcp door
  const decision = decide({
    library: h.library,
    subject: 'user_fran',
    book: 'sal',
    door: 'mcp',
    permission: REVIEW_DECIDE,
    entry: null,
  });
  assert.equal(decision.allow, false, 'review decide cannot be reached through mcp door');
});

test('export contains ratings and no full scene text', async () => {
  const res = await reviewApi(h, '/books/sal/export', session);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);

  const exported = await res.json();
  assert.equal(exported.book, 'sal');
  assert.ok(Array.isArray(exported.findings), 'findings is an array');
  assert.ok(exported.findings.length > 0);

  const exportedFinding = exported.findings.find((x: any) => x.finding_id === findingId);
  assert.ok(exportedFinding, 'exported finding is present');
  assert.ok(exportedFinding.rating || exportedFinding.verdict, 'rating/verdict present');
  const rating = exportedFinding.rating || exportedFinding.verdict;
  assert.equal(rating.verdict, 'noise');
  assert.equal(rating.note, 'en realidad es ruido conocido');

  // Check quotes are present, but full scene text is not included
  const jsonStr = JSON.stringify(exported);
  assert.ok(jsonStr.includes(QUOTE), 'quote is in export');

  // Text that is only in the scene outside the quote must not be present in export
  const fullScene = read(h.bookDir, SCENE);
  assert.ok(fullScene.includes('y conocía cada grieta de sus piedras'));
  assert.ok(!jsonStr.includes('y conocía cada grieta de sus piedras'), 'full scene text is not exported');

  // Also accessible via /books/sal/findings/export
  const altRes = await reviewApi(h, '/books/sal/findings/export', session);
  assert.equal(altRes.status, 200);
  const altExported = await altRes.json();
  assert.equal(altExported.book, 'sal');
});

test('scene view returns citing findings', async () => {
  const res = await reviewApi(h, `/books/sal/scenes/${encodeURIComponent(SCENE)}`, session);
  assert.equal(res.status, 200);
  const sceneData = await res.json();
  assert.ok(Array.isArray(sceneData.findings), 'scene findings is an array');
  const citing = sceneData.findings.find((x: any) => x.finding_id === findingId);
  assert.ok(citing, 'finding citing this scene is present');
});

test('stale evidence shown as stale after the scene changes', async () => {
  // Edit scene text around the quote
  const scenePath = join(h.bookDir, SCENE);
  const originalText = readFileSync(scenePath, 'utf8');
  const modifiedText = originalText.replace(
    'y conocía cada grieta de sus piedras.',
    'y contemplaba las aguas oscuras bajo los arcos.',
  );
  writeFileSync(scenePath, modifiedText, 'utf8');
  git(h.bookDir, 'commit', '-am', 'edit scene 1 context');

  const res = await reviewApi(h, '/books/sal/findings', session);
  assert.equal(res.status, 200);
  const data = await res.json();
  const finding = data.findings.find((x: any) => x.finding_id === findingId);
  assert.ok(finding, 'finding is present');
  assert.equal(finding.evidence_status, 'stale', 'overall evidence status turns stale');
  assert.equal(finding.evidence[0].status, 'stale', 'quote evidence status turns stale');
});
