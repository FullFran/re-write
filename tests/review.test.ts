import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cli, FIXTURES, git, read } from './helpers.ts';
import { startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
let h: Harness;
before(async () => {
  h = await startHarness();
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
});
after(() => h.close());

function api(path: string, token?: string, body?: unknown) {
  return fetch(`${h.base}/review/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function propose(find: string, replace: string): string {
  return cli('propose', h.bookDir, '--file', SCENE, '--find', find, '--replace', replace, '--rationale', 'r').json.proposal.proposal_id;
}

test('the root sends people to the review page, which is where Clerk returns them after sign-up', async () => {
  const res = await fetch(`${h.base}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/review');
});

test('llms.txt is public plain text with the setup steps, the public URL and no secrets', async () => {
  assert.equal((await fetch(`${h.base}/llms.txt`, { method: 'HEAD' })).status, 200);
  const res = await fetch(`${h.base}/llms.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/plain/);
  const text = await res.text();
  assert.ok(text.includes(h.resource));
  assert.ok(text.includes(`${h.base}/review`));
  for (const client of ['ChatGPT', 'OpenCode', 'Claude Code', 'Pi']) assert.ok(text.includes(client), client);
  assert.match(text, /synthetic/i);
  assert.match(text, /only a person/i);
  assert.doesNotMatch(text, /sk_(live|test)_|user_[A-Za-z0-9]{10,}|@gmail/);
  assert.ok(!text.includes(h.data));
  assert.ok(!text.includes(h.config.clerkPublishableKey));
});

test('the page loads without a login, with no data in it and a strict policy', async () => {
  const res = await fetch(`${h.base}/review`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/html/);
  const csp = res.headers.get('content-security-policy')!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  // Clerk's bot protection loads from its own CDN, seen when testing against the real service.
  assert.match(csp, /script-src[^;]*https:\/\/\*\.protect\.clerk\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/\*\.protect\.clerk\.com:\*/);
  const html = await res.text();
  assert.ok(html.includes(h.config.clerkPublishableKey));
  assert.ok(!html.includes('once años'));
  const script = await fetch(`${h.base}/review/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type')!, /javascript/);
  assert.doesNotMatch(await script.text(), /innerHTML/);
});

test('the review API refuses no token, a bad token and, above all, an agent token', async () => {
  const agent = await h.access();
  const calls = [
    () => api('/books'),
    () => api('/books', 'garbage'),
    () => api('/books', agent),
    () => api('/books/sal', agent),
    () => api('/books/sal/proposals/P-0000000000', agent, { decision: 'accept' }),
    () => api('/books/sal/claims/C-0000000000', agent, { decision: 'accept' }),
    () => api('/books/sal/findings/F-0000000000', agent, { verdict: 'confirmed' }),
  ];
  for (const call of calls) assert.equal((await call()).status, 401);
});

test('an agent token that also claims a session is still refused, because it has an audience', async () => {
  const forged = await h.access('user_fran', { sid: 'sess_1', azp: h.base });
  assert.equal((await api('/books', forged)).status, 401);
});

test('a session token from another origin, or without one, is refused', async () => {
  assert.equal((await api('/books', await h.session('user_fran', { azp: 'https://evil.example' }))).status, 401);
  const noAzp = await h.sign({ iss: h.issuer, sub: 'user_fran', sid: 'sess_1' });
  assert.equal((await api('/books', noAzp)).status, 401);
  const noSid = await h.sign({ iss: h.issuer, sub: 'user_fran', azp: h.base });
  assert.equal((await api('/books', noSid)).status, 401);
});

test('a member sees the queue of the book, and a stranger gets the same 404 as for a missing book', async () => {
  const session = await h.session();
  const books = await (await api('/books', session)).json();
  assert.deepEqual(books.books, [{ book_id: 'sal', title: 'La puerta de Sal' }]);
  const queue = await (await api('/books/sal', session)).json();
  assert.equal(queue.claims.length, 5);
  assert.ok(Array.isArray(queue.findings) && Array.isArray(queue.proposals));
  const stranger = await h.session('user_other');
  assert.deepEqual((await (await api('/books', stranger)).json()).books, []);
  const hidden = await api('/books/sal', stranger);
  const missing = await api('/books/nope', stranger);
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await hidden.json(), await missing.json());
  const write = await api(`/books/sal/claims/${queue.claims[0].claim_id}`, stranger, { decision: 'accept' });
  assert.equal(write.status, 404);
});

test('a person accepts a proposal from the page: new commit, and the decision records their account', async () => {
  const id = propose('Fuera empezaba a llover', 'Fuera seguía lloviendo');
  const session = await h.session();
  const before = read(h.bookDir, SCENE);
  assert.ok(before.includes('Fuera empezaba a llover'));
  const shown = await (await api('/books/sal', session)).json();
  const queued = shown.proposals.find((p: any) => p.proposal.proposal_id === id);
  assert.match(queued.diff, /^\+.*Fuera seguía lloviendo/m);
  assert.equal(queued.applicable, true);
  const res = await api(`/books/sal/proposals/${id}`, session, { decision: 'accept', note: 'mejor así' });
  assert.equal(res.status, 200);
  assert.ok(read(h.bookDir, SCENE).includes('Fuera seguía lloviendo'));
  const proposal = cli('show', h.bookDir, id).json.proposal;
  assert.equal(proposal.status, 'accepted');
  assert.equal(proposal.history[0].by, 'user_fran');
  assert.equal(proposal.history[0].note, 'mejor así');
  assert.equal(proposal.result_commit, git(h.bookDir, 'rev-parse', 'HEAD'));
});

test('a person rejects a proposal: the text does not move', async () => {
  const id = propose('El guardia no preguntó', 'El guardia calló');
  const before = read(h.bookDir, SCENE);
  const res = await api(`/books/sal/proposals/${id}`, await h.session(), { decision: 'reject' });
  assert.equal(res.status, 200);
  assert.equal(read(h.bookDir, SCENE), before);
  assert.equal(cli('show', h.bookDir, id).json.proposal.status, 'rejected');
});

test('a person reviews a claim, and an accepted rumor still does not reach canon', async () => {
  const session = await h.session();
  const { claims } = await (await api('/books/sal', session)).json();
  const rumor = claims.find((c: any) => c.epistemic_kind === 'rumor');
  const res = await api(`/books/sal/claims/${rumor.claim_id}`, session, { decision: 'accept' });
  assert.equal(res.status, 200);
  const after = await (await api('/books/sal', session)).json();
  assert.equal(after.claims.find((c: any) => c.claim_id === rumor.claim_id).editorial_status, 'accepted');
  assert.ok(!after.canon.some((c: any) => c.claim_id === rumor.claim_id));
});

test('a person gives a verdict on a finding', async () => {
  const session = await h.session();
  const { findings } = await (await api('/books/sal', session)).json();
  const res = await api(`/books/sal/findings/${findings[0].finding_id}`, session, { verdict: 'deliberate_mystery' });
  assert.equal(res.status, 200);
  const after = await (await api('/books/sal', session)).json();
  assert.equal(after.findings[0].verdict.verdict, 'deliberate_mystery');
  assert.equal(after.findings[0].verdict.by, 'user_fran');
});

test('invalid decisions, ids and bodies are refused without changing anything', async () => {
  const session = await h.session();
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const { claims } = await (await api('/books/sal', session)).json();
  assert.equal((await api(`/books/sal/claims/${claims[0].claim_id}`, session, { decision: 'approve' })).status, 400);
  assert.equal((await api('/books/sal/findings/F-x', session, { verdict: 'nope' })).status, 400);
  assert.equal((await api('/books/sal/claims/C-none', session, { decision: 'accept' })).status, 409);
  assert.equal((await api('/books/sal/proposals/..%2F..%2Fproject', session, { decision: 'accept' })).status, 409);
  assert.equal((await fetch(`${h.base}/review/api/books/sal/claims/${claims[0].claim_id}`, {
    method: 'POST', headers: { authorization: `Bearer ${session}` }, body: '{nope',
  })).status, 400);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);
});

test('a refused review answers 409 with a reason', async () => {
  const session = await h.session();
  const { claims } = await (await api('/books/sal', session)).json();
  const id = claims.find((c: any) => c.editorial_status === 'proposed').claim_id;
  await api(`/books/sal/claims/${id}`, session, { decision: 'reject' });
  const opposite = await api(`/books/sal/claims/${id}`, session, { decision: 'accept' });
  assert.equal(opposite.status, 409);
  assert.match((await opposite.json()).error, /already rejected/);
});

test('a malformed path escape is a 404, not a server error', async () => {
  assert.equal((await api('/books/%E0%A4%A', await h.session())).status, 404);
});

test('the review API only answers on its documented paths', async () => {
  assert.equal((await api('/other/sal', await h.session())).status, 404);
});

test('a review session for one book cannot read or decide in another book', async () => {
  const other = join(h.data, 'books', 'otra');
  cli('init', other, '--title', 'Otra');
  cli('import', other, join(FIXTURES, 'escena-01.md'), join(FIXTURES, 'escena-02.md'));
  cli('extract', other, '--from', join(FIXTURES, 'annotations.json'));
  const proposal = cli('propose', other, '--file', SCENE, '--find', 'once años', '--replace', 'doce años', '--rationale', 'r').json.proposal.proposal_id;
  h.library.grant('otra', 'user_ana');
  const owner = await h.session('user_ana');
  const { claims, findings } = await (await api('/books/otra', owner)).json();
  const head = git(other, 'rev-parse', 'HEAD');
  const session = await h.session();
  const missing = await (await api('/books/nope', session)).json();
  assert.deepEqual((await (await api('/books', session)).json()).books.map((b: any) => b.book_id), ['sal']);
  for (const [path, body] of [
    ['/books/otra', undefined],
    [`/books/otra/claims/${claims[0].claim_id}`, { decision: 'accept' }],
    [`/books/otra/proposals/${proposal}`, { decision: 'accept' }],
    ...(findings.length ? [[`/books/otra/findings/${findings[0].finding_id}`, { verdict: 'confirmed' }]] : []),
  ] as [string, unknown][]) {
    const res = await api(path, session, body);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), missing, path);
  }
  assert.equal(git(other, 'rev-parse', 'HEAD'), head);
  assert.ok((await (await api('/books/otra', owner)).json()).claims.every((c: any) => c.editorial_status === 'proposed'));
});

test('removing a person\'s book access closes the review door on the next request', async () => {
  const book = join(h.data, 'books', 'breve');
  cli('init', book, '--title', 'Breve');
  cli('import', book, join(FIXTURES, 'escena-01.md'));
  h.library.grant('breve', 'user_eva');
  const session = await h.session('user_eva');
  assert.equal((await api('/books/breve', session)).status, 200);
  h.library.revoke('breve', 'user_eva');
  assert.equal((await api('/books/breve', session)).status, 404);
  assert.deepEqual((await (await api('/books', session)).json()).books, []);
});

test('continuity review refuses narrative verdicts with invalid-input', async () => {
  const session = await h.session('user_fran');
  const before = cli('check', h.bookDir).json;
  const id = before.findings[0].finding_id;
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  for (const verdict of ['useful', 'noise']) {
    const res = await api(`/books/sal/findings/${id}`, session, { verdict });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.type, /invalid-input/);
    assert.match(body.error, /continuity.*confirmed, deliberate_mystery, false_positive/);
    assert.deepEqual(cli('check', h.bookDir).json, before);
    assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);
  }
});
