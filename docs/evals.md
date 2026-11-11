# Agent-journey evals

`npm test` checks units and pins the public MCP contract. The evals check something else: **what
the harness guarantees along a whole agent journey**, so that a change can be measured before and
after.

They are deterministic. The agent's interface is the real MCP server; only its reasoning is
replaced by a script. No model is called and nothing touches the network, so a failing check is a
broken guarantee of the harness, never a bad day of a model. Model quality (extraction and
narrative judgment) is a separate question, tracked in
[#3](https://github.com/FullFran/re-write/issues/3).

## Run them

```bash
npm run eval                                   # all journeys; writes evals/results/results.json
npm run eval -- --out /tmp/before.json         # choose where the results go
npm run eval -- --compare before.json after.json
```

`npm run eval` prints one row per check and exits 1 when any check fails:

```text
| journey              | check                               | status | note |
| -------------------- | ----------------------------------- | ------ | ---- |
| agent-cannot-approve | no tool accepts, rejects or reviews | PASS   |      |
| agent-cannot-approve | accept_claim is refused             | PASS   |      |
```

To measure a change, run the evals on both commits and compare:

```bash
git switch main      && npm run eval -- --out /tmp/before.json
git switch my-branch && npm run eval -- --out /tmp/after.json
npm run eval -- --compare /tmp/before.json /tmp/after.json
```

`--compare` exits 1 when a check that passed now fails. It only compares journeys present in both
runs. A journey or check that exists on one side only is listed as `SKIP`, because it says nothing
about the change.

CI runs the same command in the `eval` job, fails on any `FAIL`, and keeps `results.json` as the
`eval-results` artifact of the run.

## The first set

| Journey | Guarantee it pins |
| --- | --- |
| `onboarding` | The onboarding text (`/llms.txt`) leads to tool calls the harness really offers. |
| `literal-quote-claim` | A claim backed by a literal quote is stored as proposed, with valid evidence. |
| `fabricated-quote` | A fabricated quote never reaches the book. |
| `agent-cannot-approve` | An agent cannot approve anything. |
| `stale-evidence` | Stale evidence never looks current. |
| `retried-proposal` | A retried proposal is not duplicated. |
| `rumor-not-canon` | A rumor cannot reach canon. |

## ChatGPT-shaped journeys

These follow what a writer asks ChatGPT, on a three-chapter book whose scenes are named the way the
browser import names them (`evals/journeys/books/capitulos/003-la-carta.md`). See `docs/chatgpt.md`.

| Journey | Guarantee it pins |
| --- | --- |
| `chatgpt-chapter-analysis` | "Analiza el capítulo 3" takes the documented calls, reads a long scene page by page, stores only a proposal, and hands the person the review URL. |
| `chatgpt-error-recovery` | Every refusal names the tool to call next, an ambiguous or absent passage asks for a longer or present one from read_scene, a refused proposal stores nothing, and following the hint works. |
| `notes-and-graph` | Links in scenes become notes only when a person accepts the proposal; backlinks and the graph tools follow the links, `as_of_scene` leaves out later scenes, and reading the graph writes nothing. Its book is `evals/journeys/books/grafo/`. |
| `chatgpt-tool-metadata` | Every tool has a title and says when to use it, only proposals are write tools, the tool list stays under 28 KB, and the first 512 characters of the instructions give the order of calls and the review URL. |

The in-memory build gives the server the review URL `https://rewrite.invalid/review`, built from the
journey resource the same way the HTTP server builds it from its configured origin.

## Journey format

A journey is one JSON file in `evals/journeys/`. JSON keeps the repository free of a YAML parser
dependency.

```json
{
  "id": "fabricated-quote",
  "title": "Propose a claim with a fabricated quote",
  "guarantee": "A fabricated quote never reaches the book.",
  "book": { "id": "sal", "title": "La puerta de Sal", "scenes": ["fixtures/demo-book/escena-01.md"] },
  "steps": [
    { "id": "before", "do": "book_state" },
    {
      "id": "claim",
      "do": "call",
      "tool": "propose_claims",
      "args": { "book": "sal", "extractor": "scripted-agent", "candidates": [] },
      "checks": [
        { "name": "the fabricated claim is not created", "path": "claim.data.created", "equals": [] }
      ]
    },
    {
      "id": "after",
      "do": "book_state",
      "checks": [
        { "name": "the book has no new commit", "path": "after.commits", "equals": { "ref": "before.commits" } }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Must equal the file name without `.json`. |
| `title`, `guarantee` | What the agent does, and the property of the harness the journey pins. |
| `book` | The fixture book: its id, its title and the scene files to import, relative to the repository root. Synthetic text only. |
| `steps` | What happens, in order. Each step has an `id` (lower snake case, unique), an action in `do`, and optional `checks`. |

Each journey gets a fresh temporary `HOME`, data directory and book, removed when it ends. The
scripted agent connects as the one person who can open the book.

### Actions

| `do` | Who acts | Fields | Result |
| --- | --- | --- | --- |
| `read_onboarding` | agent | none | `text` (the `/llms.txt` body), `advertised_tools` (sorted), `first_calls` (the tools "Step 3" asks for) |
| `list_tools` | agent | none | `names`, `missing_title`, `missing_when` (no "Use this" description), `writes` (no `readOnlyHint: true`), all sorted; `bytes` (size of the tool list as JSON); `instructions_head` (first 512 characters of the server instructions) |
| `call` | agent | `tool`, `args` | `is_error`, `data` (the parsed JSON reply, or `null`), `text`, `problem` (the `structuredContent`: a problem with its `next_step` on a refusal, the structured result on success), `rpc_error` |
| `person_edits_scene` | person | `file`, `find` (must appear once), `replace` | `file` |
| `person_reviews_claim` | person | `claim_id`, `decision` (`accept` or `reject`) | `changed`, `editorial_status` |
| `person_reviews_proposal` | person | `proposal_id`, `decision` (`accept` or `reject`, required: no default) | `changed`, `status`, `file` |
| `book_state` | observer | none | `commits`, `claims`, `canon` (claim ids), `findings` and `proposals` (counts), `scenes` (file to text), `notes` (note name to text) |

The person's actions happen outside the MCP connection, as they do in `/review` and in the
person's own editor. `book_state` reads the book directly, so a check can prove what was stored and
committed, whatever the agent was told.

### Checks

A check has a `name`, a `path` and exactly one matcher.

- `path` is dotted and starts at the id of this step or an earlier one: `claim.data.rejected.0.reason`.
  `length` works on arrays and strings, and `*` maps over an array: `claims.data.claims.*.evidence_status`.
- Matchers: `equals` and `not_equals` (deep), `matches` (regular expression against a string),
  `none_match` (no string of an array matches), `contains` and `not_contains` (substring, or array element),
  `at_most` (a number no larger than the expected one).
- `{ "ref": "step.path" }` stands for a value an earlier step produced. It works in step fields and
  in the expected value of a matcher.

Avoid paths whose value changes between runs, such as timestamps and commit hashes: the observed
value is recorded as evidence, and two runs of the same commit must produce the same file.

### Fail closed

A journey that cannot run is `FAIL`, never `SKIP`:

- a file that is not valid JSON, an unknown action or matcher, a path that starts at a step that
  has not run, or a journey with no checks fails with a `journey loads` check;
- a step that throws fails with a `step <id> runs` check, and every later check fails as `not run`;
- a path that finds nothing fails;
- a directory with no journeys makes the command exit 1.

## results.json

```json
{
  "schema": "rewrite.eval-results/v1",
  "version": "0.1.0",
  "commit": "c7e61d169e6742b65d36d5b5ecf4b250a06756c1",
  "dirty": false,
  "build": "in-memory",
  "summary": { "journeys": { "pass": 7, "fail": 0 }, "checks": { "pass": 53, "fail": 0 } },
  "journeys": [
    {
      "id": "agent-cannot-approve",
      "title": "Try to approve over MCP",
      "guarantee": "An agent cannot approve anything.",
      "status": "PASS",
      "checks": [
        { "check": "accept_claim is refused", "status": "PASS", "note": "", "evidence": "true" }
      ]
    }
  ]
}
```

`version` comes from `package.json`. `commit` is the checkout the run measured, and `dirty` tells
whether it had uncommitted changes (`unknown` and `null` outside a git checkout). `evidence` is the
observed value, cut at 160 characters; `note` says why a check failed. The file holds no timestamp,
so it is identical for two runs of the same code.

## Runner self-test

A check that cannot fail proves nothing. `tests/evals.test.ts` runs the shipped journeys against
deliberately broken builds and expects the matching journey to fail: one build exposes an
`accept_claim` tool over MCP, another advertises in the onboarding text a tool the harness does not
offer, and a third adds a tool whose description pushes the tool list past its budget.

## Not included

- **HTTP mode.** The runner drives the MCP server in memory. Running the same journeys against a
  started server needs a runner that can also reach the book's state from outside the process.
- **Real-agent mode** (`--agent`). Running the journeys with a real agent is local-only work with
  its own integrity rule (the agent must never read the expected outcomes), and it never belongs in CI.
