# Contribution kinds and module classification

The writing model, evidence checks and human review stay in the host. Analysis and agent procedures are future packages; this document specifies their intended boundaries, not a package loader that exists today. Package outputs are suggestions, never editorial decisions. See [architecture](architecture.md) and [the adoption decision](adr/0001-adopt-hcs.md).

## Module classification

Each row describes the current file and, where it contains a future package, the extraction boundary. No code is moved by this design.

| Module | Host core or package (and kind) | Reason |
| --- | --- | --- |
| `src/adapters/annotation-extractor.ts` | Package: `x-rewrite-extractor` | Fixture annotation input produces claim candidates; host validation remains outside it. |
| `src/adapters/auth.ts` | Host core | Authentication and separation of agent and human doors are host authority. |
| `src/adapters/git.ts` | Host core | Git operations support host-owned book state and decisions. |
| `src/adapters/http-server.ts` | Host core | Routes and enforces the host's HTTP and review boundaries. |
| `src/adapters/json-store.ts` | Host core | Stores host-owned book records. |
| `src/adapters/llms.ts` | Host core now; procedure to package as `skill` | Onboarding is currently served by the host; reusable procedure can move without moving host safety rules. |
| `src/adapters/mcp.ts` | Host core now; procedures as `skill`, additional restrictions as `x-rewrite-instructions` | MCP dispatch and mandatory untrusted-text rules remain host-owned; reusable procedures and narrower instructions may be packaged. |
| `src/adapters/review-page.ts` | Host core | Human review UI is part of the review door. |
| `src/application/library.ts` | Host core | Book membership and access are host authority. |
| `src/application/project.ts` | Host core | Coordinates validation, state, proposals and review; calls analysis rather than delegating decisions. |
| `src/cli/main.ts` | Host core | CLI dispatches host operations; it is not the analysis implementation. |
| `src/domain/anchor.ts` | Host core | Literal evidence and its derived status must not depend on optional code. |
| `src/domain/claim.ts` | Host core | Defines claims, editorial transitions and the canon query. |
| `src/domain/continuity.ts` | Host core and package: `x-rewrite-check` | Finding and verdict types remain core; the knowledge-order heuristic can move to a package. Verdict decisions remain human-only. |
| `src/domain/proposal.ts` | Host core | Proposal identity and exact text changes belong to the review flow. |
| `src/hcs/errors.ts` | Host core | HCS error objects and the closed code set are host infrastructure (HCS-0006). |
| `src/hcs/extensions.ts` | Host core | HCS extension handling is host infrastructure. |
| `src/hcs/ids.ts` | Host core | Defines the host's capability and permission vocabulary. |
| `src/server/main.ts` | Host core | Starts the host and its server. |

## Kind contracts

These are proposed activation contracts. Paths are relative to the unpacked package. Module contributions are ESM files with one default-exported function; the signatures below describe future interfaces using existing domain types, not exports that already exist. Input data is supplied by the host; a permission request is not a grant (HCS-0005-R002). Access is subject to the person's book access and a grant at dispatch (HCS-0005-R001, HCS-0005-R003). No contribution runs during catalog validation (HCS-0001-R010). No kind may write canon or decide a review; only the host's human review door decides. `review.decide` is not grantable to packages.

### `skill`

- **Path and format:** a directory containing an Agent Skills `SKILL.md` Markdown document and its supporting files.
- **Reads and returns:** the procedure may instruct an agent to use host-provided tools on authorized material; it returns instructions to the agent, not a domain decision. It cannot itself grant access.
- **Authority and capabilities:** requests only permissions needed by its declared procedure, for example `com.fullfran.rewrite.book.read` and `com.fullfran.rewrite.claims.propose` for extraction and proposal; it requires `com.fullfran.rewrite.book.read@1` and `com.fullfran.rewrite.claims.propose@1` when using those operations. Other procedures declare their own actual dependencies; none is inherent to the kind.
- **Never:** override host instructions, write canon, decide reviews or execute during validation.

### `mcp-server`

- **Path and format:** an MCP Registry `server.json` JSON descriptor, schema revision 2025-12-11 (HCS-0008-R010).
- **Reads and returns:** the projected server may read only resources authorized by its grants and the subject; its tools return their declared results or proposals. Secret inputs come from grants, not embedded secret values (HCS-0008-R011, HCS-0008-R012).
- **Authority and capabilities:** no fixed RE;write permission or capability is inherent to this kind; an entry declares the least permissions and existing capability references its operations need or provide. An integration reading books, for example, requests `com.fullfran.rewrite.book.read` and requires `com.fullfran.rewrite.book.read@1`.
- **Never:** write canon, decide reviews, embed secret values, or start during validation.

### `x-rewrite-extractor`

- **Path and format:** an ESM module, default export `(scene: { source_file: string; text: string }) => ClaimCandidate[]`, with `ClaimCandidate` from `src/domain/claim.ts`.
- **Reads and returns:** receives the authorized scene and returns candidates with literal quotes; the host validates quotes and controls any proposal storage.
- **Authority and capabilities:** requests `com.fullfran.rewrite.book.read` and `com.fullfran.rewrite.claims.propose`; requires `com.fullfran.rewrite.book.read@1` and `com.fullfran.rewrite.claims.propose@1`; provides `com.fullfran.rewrite.claims.extract@1`.
- **Never:** write canon, decide reviews, bypass host validation, or run during validation.

### `x-rewrite-check`

- **Path and format:** an ESM module, default export `(claims: ClaimView[]) => Finding[]`, using `ClaimView` and `Finding` from `src/domain/claim.ts` and `src/domain/continuity.ts`.
- **Reads and returns:** receives authorized claim views and returns findings with citations and alternatives, without verdicts. Future narrative-model inputs need an explicit contract before use.
- **Authority and capabilities:** requests `com.fullfran.rewrite.book.read` and `com.fullfran.rewrite.findings.propose`; requires `com.fullfran.rewrite.claims.read@1`; the knowledge-order check provides `com.fullfran.rewrite.continuity.check@1`.
- **Never:** write canon, decide reviews, attach verdicts, or run during validation. Findings are heuristics; coordinate evaluation with [#3](https://github.com/FullFran/re-write/issues/3) and exploratory craft diagnostics with [#19](https://github.com/FullFran/re-write/issues/19).

### `x-rewrite-importer`

- **Path and format:** an ESM module, default export `(records: unknown[]) => { claims: ClaimCandidate[]; revisions: Array<Pick<Proposal, 'file' | 'find' | 'replace' | 'rationale'>> }`, using `ClaimCandidate` and `Proposal` from the domain. These are drafts, not stored `Proposal` records.
- **Reads and returns:** receives authorized external records and returns claim candidates and revision drafts; the host validates and creates proposals. Source-specific access is separately authorized.
- **Authority and capabilities:** requests `com.fullfran.rewrite.book.import`; requires `com.fullfran.rewrite.claims.propose@1` and `com.fullfran.rewrite.revision.propose@1` when submitting those respective drafts. It provides no existing RE;write capability by default.
- **Never:** write canon, decide reviews, bypass proposal validation, or run during validation.

### `x-rewrite-instructions`

- **Path and format:** a Markdown file in the AGENTS.md convention.
- **Reads and returns:** the host reads the file and projects additional agent restrictions; it returns instruction text, not a decision. Manuscript content is not needed to load it.
- **Authority and capabilities:** requests no RE;write permissions and provides or requires no RE;write capability by default. Any tool use instructed by the text still needs the relevant separate grants and capability dependencies.
- **Never:** weaken host instructions, write canon, decide reviews or run during validation. Host-owned settings win (HCS-0008-R007).

## First packages

| Package | Contribution and capability | Requested permissions | Extraction boundary |
| --- | --- | --- | --- |
| `com.fullfran.rewrite.fixture-annotations` | `x-rewrite-extractor`, providing `com.fullfran.rewrite.claims.extract@1` | `com.fullfran.rewrite.book.read`, `com.fullfran.rewrite.claims.propose` | Move the fixture annotation adapter into a module conforming to the scene-input contract; its current JSON fixture loader will need adaptation. Keep literal quote validation, proposal storage and review in the host. |
| `com.fullfran.rewrite.knowledge-order` | `x-rewrite-check`, providing `com.fullfran.rewrite.continuity.check@1` | `com.fullfran.rewrite.book.read`, `com.fullfran.rewrite.findings.propose` | Move the knowledge-order heuristic and its private helpers from `src/domain/continuity.ts`; keep shared finding and verdict types, verdict recording and human review in the host. |

These are planned packages, not currently installed contributions. The fixture extractor is deterministic annotation input, not an independent narrative evaluator; neither it nor a continuity finding replaces human editorial authority.

## Supported kinds

The host supports exactly `skill`, `mcp-server`, `x-rewrite-extractor`, `x-rewrite-check`, `x-rewrite-importer` and `x-rewrite-instructions`. The catalog reader ([#25](https://github.com/FullFran/re-write/issues/25)) accepts any kind the grammar allows (HCS-0001-R006); resolution ([#27](https://github.com/FullFran/re-write/issues/27)) refuses to activate an entry with any other kind and reports `unsupported_contribution` (HCS-0001-R008). This is planned behavior until those issues land.
