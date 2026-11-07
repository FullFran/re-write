import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { cli, FIXTURES, git, read } from './helpers.ts';
import { reviewApi, startHarness } from './server-helpers.ts';

for (const kind of ['claims', 'proposals', 'findings']) {
  test(`${kind}: 2,000-character notes survive intact; 2,001 are refused without mutation`, async () => {
    const h = await startHarness();
    try {
      cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
      const session = await h.session();
      const queue = async () => (await reviewApi(h, '/books/sal', session)).json();
      const initial = await queue();
      let id: string;
      let body: object;
      if (kind === 'proposals') {
        id = cli('propose', h.bookDir, '--file', 'scenes/escena-01.md', '--find', 'once años', '--replace', 'doce años', '--rationale', 'r').json.proposal.proposal_id;
        body = { decision: 'reject' };
      } else if (kind === 'claims') {
        id = initial.claims[0].claim_id;
        body = { decision: 'reject' };
      } else {
        id = initial.findings[0].finding_id;
        body = { verdict: 'confirmed' };
      }
      const before = await queue();
      const head = git(h.bookDir, 'rev-parse', 'HEAD');
      const scene = read(h.bookDir, 'scenes/escena-01.md');
      const refused = await reviewApi(h, `/books/sal/${kind}/${id}`, session, { ...body, note: 'x'.repeat(2001) });
      assert.equal(refused.status, 400);
      assert.equal((await refused.json()).error, 'La nota supera el límite de 2000 caracteres.');
      assert.deepEqual(await queue(), before, 'rejection preserves decisions and history');
      assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);
      assert.equal(read(h.bookDir, 'scenes/escena-01.md'), scene);
      const note = 'ñ'.repeat(2000);
      const accepted = await reviewApi(h, `/books/sal/${kind}/${id}`, session, { ...body, note });
      assert.equal(accepted.status, 200);
      const after = await queue();
      const stored = kind === 'proposals' ? after.proposals.find((p: any) => p.proposal.proposal_id === id).proposal
        : after[kind].find((item: any) => (item.claim_id || item.finding_id) === id);
      assert.equal(kind === 'findings' ? stored.verdict.note : stored.history.at(-1).note, note);
      assert.equal(read(h.bookDir, 'scenes/escena-01.md'), scene);
    } finally {
      h.close();
    }
  });
}
