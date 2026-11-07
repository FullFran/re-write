# HCS pin and local checks

RE;write adopts the Harness Composition Specification as described in [ADR-0001](adr/0001-adopt-hcs.md). The contract version is `0.1`, pinned in `hcs.pin.json` to commit `9f40641ebdff9aae73e797b1223b54bcc43a41b7` of `FullFran/hcs`. Private HCS content must not be committed to this repository.

To update the pin, change `hcs.pin.json` (and the supported version constant if the contract version changes), run `npm run hcs:fetch`, and regenerate the traceability matrix with `npm run hcs:trace`. Fetch requires an authenticated `gh` with access to HCS, or `HCS_SOURCE_DIR` pointing to a checkout at the pinned commit. The fetched schemas, requirements and conformance materials live in ignored `.hcs/<commit>/`.

Until HCS is public, CI can run the pin-format test in `npm test` without private access. Fetching, the traceability drift check (`npm run hcs:trace:check`) and the reference runner run locally only. `docs/conformance/traceability.md` is generated from the pinned `requirements.json` and `docs/conformance/traceability.map.json`; edit the map, never the matrix.

## Package archives

Packages are deterministic gzip-compressed ustar archives. Verification checks the compressed size and content hash before unpacking. Extraction uses a fresh temporary sibling directory, seals the extracted tree read-only, and renames it into place only after success.

Pending HCS OQ-0001-6, re-write applies a local safety rule: absolute paths, parent segments, backslashes, NULs, duplicate paths, links, special files and OCI whiteouts are refused. Unsafe members produce `integrity_mismatch` with `x-rewrite-archive`, `x-rewrite-member` and `x-rewrite-reason` details. Extraction defaults to at most 256 MiB of unpacked data and 10,000 members; callers can configure these limits.

## Lifecycle and generations

A host state directory holds one immutable directory per prepared desired set:

```text
<state>/
  active                     {"generation": n}, replaced atomically (temp file, fsync, rename)
  status.json                entry states of the active generation (HCS-0004-R002)
  lock                       present while a writer changes the state: {"pid": ..., "at": ...}
  generations/<n>/
    generation.json          catalog id and version, entries in activation order
    entries/<entry id>/      unpacked, sealed (read-only) package tree
```

`applyDesiredSet` (`src/hcs/host-state.ts`) moves each entry through `discovered`, `validated`, `resolved`, `authorized` and `prepared` before any package code can run (HCS-0004-R001). Resolution is all-or-nothing: any error keeps the previous generation active. Every new desired set is prepared in a NEW generation directory; the content of a prepared generation is never modified (HCS-0007-R017). Once every selected entry is prepared, the host stops the previous generation in reverse activation order (HCS-0004-R004), switches the `active` pointer in one step and activates the new entries in activation order.

Rollback (HCS-0004-R003): if any selected entry fails to reach `active`, the host stops the entries this transition started in reverse activation order, restores the previous pointer and restarts the previous entries, so every entry returns to the state it had before. If a rollback step fails or times out, that entry is reported `failed` with `x-rewrite-rollback: incomplete`, the pointer is still restored, the remaining entries are still rolled back, and the apply rejects with every error, the original failure first.

Deadlines (HCS-0004-R007): each step (authorize, fetch, activate, stop, including rollback steps) runs under a per-step deadline (default 30 s). An activator receives an `AbortSignal`; on expiry the host aborts it, records the entry as `failed` with `timeout` and stops waiting. An activator that ignores its signal violates the activator contract: its background work is outside the host's guarantees.

Single writer (#10): every apply takes `<state>/lock` with an exclusive create. A second writer is refused with a `HostBusyError` (a re-write refusal, not an HCS error); a lock whose process is no longer alive is taken over. The lock is held until the transition, including rollback, has finished, and is released afterwards.

Dispatch (`src/hcs/registry.ts`): only capabilities of `active` entries are callable; any other state reports `unsupported_capability` (HCS-0004-R005), and `draining` entries take no new calls (HCS-0004-R006). In-flight calls are not tracked yet. `generationCapabilities(stateDir)` exposes host built-ins plus the active generation to the MCP adapter.

### Try it

The CLI activator runs no package code: activation only makes an entry's `provides` capabilities callable.

```sh
work=$(mktemp -d)
node src/cli/main.ts package fixtures/packages/fixture-annotations --out "$work/annotations.tar.gz" --json
node src/cli/main.ts package fixtures/packages/knowledge-order --out "$work/knowledge-order.tar.gz" --json
# Write $work/catalog.json with both entries: the contentHash and size printed above, mediaType
# application/vnd.oci.image.layer.v1.tar+gzip, locations ["file://$work/<archive>"], and one
# contribution each (x-rewrite-extractor and x-rewrite-check, path index.mjs, with provides).
node src/cli/main.ts catalog validate "$work/catalog.json"
node src/cli/main.ts catalog apply "$work/catalog.json" --state "$work/state"
# Copy the catalog to $work/bad.json and change one contentHash: the apply fails with
# integrity_mismatch and generation 1 stays active.
node src/cli/main.ts catalog apply "$work/bad.json" --state "$work/state"
node src/cli/main.ts catalog status --state "$work/state"
```
