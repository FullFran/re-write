# HCS pin and local checks

RE;write adopts the Harness Composition Specification as described in [ADR-0001](adr/0001-adopt-hcs.md). The contract version is `0.1` (`HCS_VERSION` in `src/hcs/version.ts`). [FullFran/hcs](https://github.com/FullFran/hcs) is public under Apache 2.0, and RE;write consumes it the way its README recommends ("How to pin HCS"): it pins one release tag and vendors that release's artefact.

- `vendor/hcs/PIN.json` records the release `version`, the `sha256` of its tarball and its `url`.
- `vendor/hcs/<version>/` is the release as published: `spec/`, `schemas/`, `requirements/requirements.json`, `conformance/`, `index.json`, `LICENSE` and `SHA256SUMS`. Never edit anything under it: `tests/hcs-vendor.test.ts` checks every file against `SHA256SUMS` and fails on one changed byte, one extra file, or a second vendored version. `.gitattributes` marks it `-text` so git keeps the bytes.

`npm test` runs the vendor check and the conformance measurement, so CI runs them too. CI also runs the traceability drift check (`npm run hcs:trace:check`). `docs/conformance/traceability.md` is generated from the vendored `requirements.json` and `docs/conformance/traceability.map.json`; edit the map, never the matrix.

## Conformance: measured, not imposed

HCS is a set of shared patterns, not a cage: re-write follows it where it fits and may diverge where the product needs to. [`tests/hcs-conformance.test.ts`](../tests/hcs-conformance.test.ts) feeds every case of the vendored release to the re-write code that owns it ([`tests/fixtures/hcs/conformance.ts`](../tests/fixtures/hcs/conformance.ts)) and classifies it:

| Status | Meaning |
| --- | --- |
| `pass` | re-write reaches the case's verdict |
| `fail` | it reaches another one: fix it here, or record it as a divergence, or discuss it in HCS |
| `not-applicable` | a host-level case (needs a running host), a level re-write has no runner for, or a rule in `notApplicable` |
| `divergence` | re-write does it another way on purpose; listed in `divergences` |

Rules live in [`tests/fixtures/hcs/divergences.json`](../tests/fixtures/hcs/divergences.json): each names a `requirement`, a `reason` and optionally the `cases` it covers. They are printed, never skipped silently, and a rule that matches no case of the vendored release fails the test.

The test fails only on a **regression**: a case that passes in [`tests/fixtures/hcs/baseline.json`](../tests/fixtures/hcs/baseline.json) and does not pass now. A new case that fails does not block anything; it shows up as `fail` in the report. After fixing a `fail` or moving to a new release, regenerate the baseline with `HCS_BASELINE=write node --test tests/hcs-conformance.test.ts` and review its diff in the pull request. `node --test --test-reporter=tap tests/hcs-conformance.test.ts` prints the per-level table.

Measured with HCS `0.1.0-draft.6`: 98 pass, 0 fail, 240 not applicable (94 host, 41 projection, 37 distribution, 17 recovery, 7 client, 44 document cases of schemas without a runner), 0 divergences.

## Updating to a new HCS release

One pull request per HCS release:

1. Copy the version and the tarball `sha256` from the release notes (`gh release view v<version> -R FullFran/hcs`).
2. `npm run hcs:sync -- <version> <sha256>`. It downloads `https://github.com/FullFran/hcs/releases/download/v<version>/hcs-<version>.tar.gz`, refuses it unless its digest is the one you gave, unpacks it in memory (regular files and folders only: no links, special files, absolute paths or `..`), checks every file against the release's `SHA256SUMS`, writes `vendor/hcs/<version>/` through a staging folder and then `vendor/hcs/PIN.json`. A refused release leaves the previous tree and pin untouched. Nothing from the release is executed. Exit codes: 0 vendored, 1 refused, 2 usage error.
3. Remove the previous version with `git rm -r vendor/hcs/<previous>`; the script only replaces its own folder.
4. Read the release notes (`-draft` releases may change things incompatibly), run the conformance test and decide for each new `fail`: fix it, list it as a divergence, or leave it as `fail`. Then regenerate the baseline (`HCS_BASELINE=write`).
5. Regenerate the matrix with `npm run hcs:trace` and map any new requirement in `docs/conformance/traceability.map.json`.

A release of another contract version (for example `0.2.x`) is refused until `HCS_VERSION` is changed, because instance documents carry `hcsVersion`.

The reference runner (`vendor/hcs/<version>/conformance/runner/run.py`) will run against re-write in M7 ([#44](https://github.com/FullFran/re-write/issues/44)).

## Package archives

Packages are deterministic gzip-compressed ustar archives. The host reads a package from its content-addressed store (`<store>/<algorithm>/<digest>`, default `<state>/store`, `--store <dir>` on `rewrite catalog apply`) or else from the entry's `https:` `locations` in order; any other location, including `file:`, is refused and reported like an unavailable location. Verification checks the compressed size and content hash before unpacking. When the entry declares `contentId` (HCS-0001-R017, R018), the host then decompresses the archive under a bound on the whole decompressed stream and compares the digest of the exact uncompressed tar with it, before reading permission requests or extracting anything; a malformed identity, a failed or over-limit decompression and a different digest all report `integrity_mismatch` with HCS-0001-R018. An entry without `contentId` keeps the transport-only verification. `rewrite` does not produce `contentId` yet and makes no decision from it (no deduplication, no skipped activation). Extraction uses a fresh temporary sibling directory, seals the extracted tree read-only, and renames it into place only after success.

Pending HCS OQ-0001-6, re-write applies a local safety rule: absolute paths, parent segments, backslashes, NULs, duplicate paths, links, special files and OCI whiteouts are refused. Unsafe members produce `integrity_mismatch` with `x-rewrite-archive`, `x-rewrite-member` and `x-rewrite-reason` details. Extraction defaults to at most 256 MiB of unpacked data and 10,000 members; callers can configure these limits.

## Lifecycle and generations

A host state directory holds one immutable directory per prepared desired set:

```text
<state>/
  active                     {"generation": n}, replaced atomically (temp file, fsync, rename)
  status.json                entry states of the active generation (HCS-0004-R002)
  lock                       present while a writer changes the state: {"pid": ..., "start": ..., "at": ...}
  generations/<n>/
    generation.json          catalog id and version, entries in activation order
    entries/<entry id>/      unpacked, sealed (read-only) package tree
```

`applyDesiredSet` (`src/hcs/host-state.ts`) moves each entry through `discovered`, `validated`, `resolved`, `authorized` and `prepared` before any package code can run (HCS-0004-R001). Resolution is all-or-nothing: any error keeps the previous generation active. Every new desired set is prepared in a NEW generation directory; the content of a prepared generation is never modified (HCS-0007-R017). Once every selected entry is prepared, the host stops the previous generation in reverse activation order (HCS-0004-R004), switches the `active` pointer in one step and activates the new entries in activation order.

Rollback (HCS-0004-R003): if any selected entry fails to reach `active`, the host stops the entries this transition started in reverse activation order, restores the previous pointer and restarts the previous entries, so every entry returns to the state it had before. If a rollback step fails or times out, that entry is reported `failed` with `x-rewrite-rollback: incomplete`, the pointer is still restored, the remaining entries are still rolled back, and the apply rejects with every error, the original failure first.

Deadlines (HCS-0004-R007): each step (authorize, fetch, activate, stop, including rollback steps) runs under a per-step deadline (default 30 s). An activator, and the `authorize` hook as an optional second argument, receive an `AbortSignal`; package downloads in the authorize and prepare steps are aborted with it. On expiry the host aborts the signal, records the entry as `failed` with `timeout` and stops waiting. An activator that ignores its signal violates the activator contract: its background work is outside the host's guarantees.

Single writer (#10): every apply takes `<state>/lock` with an exclusive create (`wx`). A second writer is refused with a `HostBusyError` (a re-write refusal, not an HCS error). The lock records the writer's PID and, on Linux, its process start time (field 22 of `/proc/<pid>/stat`). A lock is stale when its process is no longer alive, or when its PID is alive but belongs to a process with a different start time (a reused PID); locks that only record `pid` are still read. A process never moves or renames another process's lock. To remove a stale lock, a writer must first hold a takeover mutex `<state>/lock.takeover` created with exclusive create and recording its PID and start time. While holding the mutex, the writer re-reads `<state>/lock` and unlinks it only if its content is byte-identical to the inspected stale content and its holder is still not held (dead or start mismatch). The writer then releases the takeover mutex (unlinking only if still its own) and retries the exclusive create of the lock. If `<state>/lock.takeover` exists and its holder is alive, the host is treated as busy (`HostBusyError`). If the takeover mutex holder is dead, it is not removed automatically: a `HostBusyError`-derived refusal (`HostTakeoverLockError`) is thrown naming `<state>/lock.takeover` to remove by hand. A writer releases `<state>/lock` only if it still holds its own content. The lock is held until the transition, including rollback, has finished, and is released afterwards.

Dispatch (`src/hcs/registry.ts`): only capabilities of `active` entries are callable; any other state reports `unsupported_capability` (HCS-0004-R005), and `draining` entries take no new calls (HCS-0004-R006). In-flight calls are not tracked yet. `generationCapabilities(stateDir)` exposes host built-ins plus the active generation to the MCP adapter.

Authorization (HCS-0005): the default `authorize` hook of `applyDesiredSet` authorizes an entry only when every permission its package requests is granted in `grants.json` (`--grants <data-dir>` on `rewrite catalog apply`, default the state directory). The hook stays injectable. HCS 0.1 leaves open where requests live (OQ-0005-3) and the catalog has no standard member for them, so re-write reads them from an HCS-0005 request document named `requests.json` at the root of the package: `{"hcsVersion": "0.1", "entry": "<entry id>", "requests": [{"permission": "...", "reason": "..."}]}`. A package without that file requests nothing. The host reads the document from the verified archive in the `authorize` step, before `prepared`, without unpacking or running anything; a document that is malformed, too large or names another entry is denied with `permission_denied`, and a missing grant reports `permission_denied` with HCS-0005-R001. Requests, their `x-` members and Agent Skills `allowed-tools` never become grants (HCS-0005-R002, R004). At call time, `src/application/decision.ts` checks the same grants again for operations a package performs (HCS-0005-R003); see [Architecture, section 5](architecture.md#5-authority-and-the-review-boundary).

### Try it

`npm run hcs:try` (or `bash scripts/hcs-try.sh [work-dir]`) walks the host core end to end with the two fixture packages and prints each step: deterministic builds, catalog validation, an apply refused without grants (`permission_denied`), grants for what each package requests in its `requests.json`, an apply that reaches `active`, a wrong digest that fails with `integrity_mismatch` while the previous generation stays active, and a package that also provides a host built-in (`ambiguous_provider`). The CLI activator runs no package code: activation only makes an entry's `provides` capabilities callable. Prepared generations are sealed read-only, so remove a work directory with `chmod -R u+w <dir> && rm -rf <dir>`.

An empty or unreadable-as-JSON `lock.takeover` is a retryable host-busy refusal
that names the file. It is not evidence of an abandoned holder. Manual removal
is requested only when a parsed holder record identifies a dead process.
