# HCS-0008 Host adapter: projecting a generation into an engine

| Field | Value |
| --- | --- |
| Status | Draft |
| Provisional | yes (HCS-0000 section 4) |
| Superseded when | a neutral body (for example an AAIF project) publishes an engine-neutral format for installing skills, MCP servers and instructions into an agent runtime, or MCP and Agent Skills define client-side installation; this document then profiles that format or is withdrawn |
| Version | 0.1.0-draft |
| Requires | HCS-0001, HCS-0003, HCS-0004, HCS-0005, HCS-0006 |
| Replaces | none |

## 1. Scope

Resolution (HCS-0003) and distribution (HCS-0007) end with a set of prepared entries that the host has selected. Something still has to turn that set into the configuration an agent engine reads at start: where its skills are, which MCP servers it connects to, which instructions it loads, which permissions it enforces. This document calls that step **projection** and the host component that performs it a **host adapter**. It defines what an adapter receives, what it must do with each contribution, the precedence between host-owned settings and generation content, how it reports what it could not project, which generation an engine run sees, and when a new generation counts as confirmed.

The first host does this step ad hoc, for skills only, in two places, and confirms a generation on one of them without checking that the engine loaded anything; MCP, policy and instruction packages arrive and are reported active while no engine reads them ([host-adapter-standards.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/research/host-adapter-standards.md) section 1). Every requirement below traces to one of those gaps or to an adopted standard.

No existing standard covers projection into an agent engine ([host-adapter-standards.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/research/host-adapter-standards.md) section 3), so this document is **Provisional** ([ADR-0016](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0016-host-adapter-contract-is-provisional.md)). It reuses, and does not restate:

| Need | Standard | How |
| --- | --- | --- |
| Skill format | Agent Skills ([agent-skills.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/agent-skills.md)) | adopted as is; the adapter moves directories, never edits them |
| MCP server descriptor | MCP Registry `server.json`, schema 2025-12-11 ([mcp-registry-server-json.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/mcp-registry-server-json.md)) | profiled: no secret values inside a generation ([ADR-0017](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0017-mcp-descriptors-profile-server-json.md)) |
| Instructions | AGENTS.md ([agents-md.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/agents-md.md)) | content convention for instruction contributions, which stay extension kinds ([ADR-0018](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0018-instructions-and-policies-stay-extension-kinds.md)) |
| Layered precedence | UAPI.6 vendor and administrator layers ([uapi-config-files.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/uapi-config-files.md)) | model for host-owned settings ([ADR-0019](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0019-host-owned-settings-take-precedence.md)) |
| Confirm after health, bounded retry | UAPI.1 boot counting, systemd Automatic Boot Assessment ([uapi-boot-counting.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/uapi-boot-counting.md)) | state model with one attempt ([ADR-0020](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0020-confirm-after-health-one-attempt.md)) |
| Health check semantics | Kubernetes startup probes, gRPC health ([kubernetes-probes.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/kubernetes-probes.md), [grpc-health.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/grpc-health.md)) | outcome only; HCS names no protocol |
| Errors | HCS-0006 | existing codes only ([ADR-0021](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0021-projection-reuses-existing-error-codes.md)) |

Out of scope: how a host starts, stops or supervises an engine process; engine-specific file layouts and flags (non-normative [appendix A](#appendix-a-engine-mappings-non-normative)); how a host stores secrets; new contribution kinds (issue #3).

## 2. Terms

- **Generation:** the prepared, unpacked content of the entries a host selected for one desired set (HCS-0003 step 6, HCS-0004 `prepared`), identified by a generation id and never modified after it is prepared (HCS-0007-R017).
- **Engine:** the agent runtime a host starts and configures (for example a coding agent CLI or an agent server).
- **Engine run:** one engine process, or one engine session the host creates, from start to stop.
- **Host adapter:** the host component that turns a generation into an engine's configuration for one engine.
- **Projection:** the configuration an adapter produces for one engine run: files, command-line arguments or environment values the engine reads at start. Its shape is engine-specific.
- **Engine-level name:** a name the engine uses to tell configured items apart: a skill `name`, an MCP server name, a permission rule's target.
- **Host-owned setting:** an engine setting the host declares non-negotiable for a generation, for example the permission policy, a content-safety proxy, an MCP server the host itself provides, or a name the host reserves. The host declares the list; HCS defines no vocabulary for it (HCS-0005 section 1).
- **Host-provided default:** an engine setting the host supplies but does not own, for example a skill bundled with the host application. A generation contribution with the same engine-level name replaces it.
- **Confirmed generation:** the last generation that passed section 7; the generation a host returns to.

## 3. Inputs and outputs

An adapter receives:

1. the generation: its id and, in activation order, each selected entry with its id, version, the root of its unpacked content and its contributions (HCS-0001 section 3.2);
2. the host-owned settings and host-provided defaults for the target engine;
3. the secrets the host grants to each entry (HCS-0005), by name;
4. the contribution kinds the adapter can project for the target engine.

It produces:

1. the projection for one engine run;
2. for each entry, either "projected" or the HCS-0006 errors that prevented it.

The host decides from the second output which entries it may report `active` on that engine (R005). An entry the engine cannot take does not stop the transition (R017); the other projection errors count against the host's activation policy (HCS-0003 step 6).

## 4. One generation per engine run

**[HCS-0008-R001]** A host MUST derive each engine run's projection from exactly one generation and MUST make the projection reference that generation by an identifier that does not change during the run, never by a pointer the host moves to the next generation.

**[HCS-0008-R002]** A host MUST NOT change what a running engine reads through its projection; it MUST move an engine to another generation only by starting a new engine run from a new projection.

R001 and R002 are the atomicity rule seen from the engine: an engine run sees one generation, whole. An `active` pointer switched atomically ([kubernetes-probes.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/kubernetes-probes.md), `AtomicWriter`) is a correct way to choose the generation of the next run; a projection that names the pointer itself is not, because an engine that rescans during the run can see the next generation, or a mix.

## 5. Every contribution is projected or reported

**[HCS-0008-R003]** An adapter MUST, for every contribution of every entry in the generation, either project it into the engine run or report an HCS-0006 error with the entry's id; it MUST NOT leave a contribution out silently.

**[HCS-0008-R004]** An adapter MUST report `unsupported_contribution` for an entry that has a contribution whose kind it cannot project into its engine.

**[HCS-0008-R005]** A host MUST NOT report an entry as `active` unless every contribution of that entry was projected into the engine run.

**[HCS-0008-R017]** A host MUST NOT fail or roll back a move to a new generation only because an adapter reported `unsupported_contribution`; it MUST treat the reported entry as not selected for activation on that engine and MUST keep it reported until a generation or an engine change lets the adapter project it.

R005 is HCS-0001-R008 applied at projection time: a host that implements a kind for resolution but whose engine ignores it does not implement that kind on that engine. R017 keeps that per-engine fact from deciding the fate of the whole generation: the `all-or-nothing` policy (HCS-0003 step 6, required by DISTRO-1, HCS-0007-R016) governs whether the signed catalog is accepted and resolved, and HCS-0004-R003 applies to the entries selected for activation on the engine; an entry the engine cannot take was never selected there. Other projection errors (`ambiguous_provider`, `permission_denied`, `manifest_invalid`) are failures and count against the activation policy ([ADR-0022](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0022-host-adapter-open-questions-decided.md), decision 2).

## 6. Projection rules

### 6.1 Name collisions

**[HCS-0008-R006]** When two contributions of one generation would project the same engine-level name, an adapter MUST project neither and MUST report `ambiguous_provider` for each entry involved.

Engines resolve such a collision in undocumented or order-dependent ways (recursive directory scans, last writer wins); the adapter is the last point where it is still visible. A collision with a host-provided default is not a collision: the generation contribution replaces the default.

### 6.2 Host-owned settings take precedence

**[HCS-0008-R007]** An adapter MUST NOT produce a projection in which a generation contribution replaces, removes or widens a host-owned setting, and MUST report `permission_denied` for that entry.

To **widen** a setting is to allow an operation the host-owned setting denies or asks about, to disable a host-owned component (a safety proxy, an MCP server, a hook), or to change where a host-owned component points. A contribution MAY narrow a host-owned setting: deny or ask about an operation the host allows. A generation never receives authority by configuring an engine (HCS-0005-R002).

### 6.3 Skills

**[HCS-0008-R008]** An adapter MUST NOT modify the files of a `skill` contribution's directory when it projects the skill.

**[HCS-0008-R009]** An adapter SHOULD project a skill under its Agent Skills `name`, without a prefix or namespace added by the engine.

The skill directory is Agent Skills as is: the adapter places it, or a link to it, where the engine discovers skills. R009 is a SHOULD because some engines only load a packaged skill under a plugin namespace (appendix A).

### 6.4 MCP servers

**[HCS-0008-R010]** An adapter MUST read an `mcp-server` contribution's `path` as an MCP Registry `server.json` document of schema revision 2025-12-11, and MUST report `manifest_invalid` for an entry whose document does not validate against that schema.

**[HCS-0008-R011]** A `server.json` document in a generation MUST NOT give a `value` or a `default` to an input whose `isSecret` is true; an adapter MUST report `manifest_invalid` for an entry that has one.

**[HCS-0008-R012]** An adapter MUST take the value of a secret input only from the secrets the host grants to that entry, MUST NOT write it inside the generation, and MUST report `permission_denied` for an entry with a required secret input that has no granted value.

Inputs are environment variables, headers, arguments and URL variables (`KeyValueInput` and `Input` in the schema). The engine-level name of an MCP server is the adapter's choice (appendix A); it is subject to R006 and R007 like any other name. Where the engine can resolve a reference at start (for example an environment placeholder), the adapter SHOULD write the reference rather than the value, so that the projection holds no secret either.

### 6.5 Instructions, policies and other extension kinds

HCS-0001 defines two core kinds, `skill` and `mcp-server`. Instruction files, agent definitions, commands and policies are extension kinds of the distribution (`x-<distribution>-...`) until a second harness needs them in core (README rule 1, [ADR-0018](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0018-instructions-and-policies-stay-extension-kinds.md)). R003 to R007 apply to them unchanged: the adapter projects them or reports them, and they never override a host-owned setting. A distribution that ships instruction contributions SHOULD use plain Markdown in the AGENTS.md convention and define no structure inside the file. A policy contribution is a narrowing (section 6.2): it can only make a host-owned permission stricter.

### 6.6 Guards on the model transport

A host-owned setting can be a guard on what reaches the model, for example a content-safety proxy that masks personal data. Placing it in an engine's message hooks does not cover every request: engines commonly let a hook that throws continue with the unmodified data, and they send model requests of their own (context compaction, branch summaries, cache warming) that never pass through those hooks. All of them pass through the engine's model transport ([ADR-0025](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0025-host-guards-fail-closed.md)).

**[HCS-0008-R019]** A host that declares a guard on model requests as a host-owned setting MUST place it where every model request of an engine run passes through it, including the requests the engine makes for itself, and MUST NOT count a hook inside the engine as that guard.

**[HCS-0008-R020]** When such a guard is unavailable or fails on a request, a host MUST ensure that the request does not reach the model provider.

The places that meet R019 are the model transport itself: a host-provided model provider or base URL that the projection sets as a host-owned setting (R007 keeps a contribution from moving it), or an egress proxy the engine cannot bypass. Engine hooks may add a second layer; they never replace it.

## 7. Confirm after health

**[HCS-0008-R013]** A host MUST NOT confirm a generation until an engine run started from its projection has passed the host's health check within the host's deadline.

**[HCS-0008-R014]** A host whose engine reports which skills or MCP servers it loaded MUST fail the health check when a projected skill or MCP server is missing from that report.

**[HCS-0008-R015]** When the health check of a new generation fails or its deadline passes, a host MUST report the generation as failed with `plugin_failed` or `timeout`, MUST start an engine run from the confirmed generation, and MUST NOT start the failed generation again automatically.

**[HCS-0008-R016]** When the engine run started from the confirmed generation after a failure also fails its health check, a host MUST stop and report it, and MUST NOT start a further rollback or retry until a new desired set or an operator action arrives.

**[HCS-0008-R018]** A host that reports the health of an engine run SHOULD report one of the states `healthy`, `unhealthy` or `unknown`, and SHOULD report the failure itself with the codes of R015.

R018 follows how the most widely used health mechanisms report health: a state plus, at most, a free-text or code reason, never a dedicated error code. Kubernetes pod conditions have `status` `True`, `False` or `Unknown` with a machine-readable `reason`; gRPC health returns `SERVING`, `NOT_SERVING` or `UNKNOWN`; boot assessment marks an entry good or bad ([kubernetes-probes.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/kubernetes-probes.md), [grpc-health.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/grpc-health.md), [uapi-boot-counting.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/uapi-boot-counting.md)). No HCS-0006 code is added for a failed health check ([ADR-0022](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0022-host-adapter-open-questions-decided.md), decision 3).

This is UAPI.1 boot counting with one try ([uapi-boot-counting.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/standards/uapi-boot-counting.md)): a new generation is indeterminate until the running engine, not the installer, proves it; a failed one is not retried; there is exactly one rollback and never a loop. It refines HCS-0007-R018 for engines. The health check itself is host-defined (an HTTP status, a gRPC `Check`, a command); R014 adds the one check every host can make when its engine exposes it. A host with no confirmed generation (first start) that fails R013 stops and reports under R016.

## 8. Conformance

`projection` cases run the reference projection in `conformance/runner/run.py`: the input states the generation, the kinds the adapter projects, the host-owned settings and the granted secrets; the expected output is the errors per entry and the entries the host may report active (`selected`). R001, R002, R008, R013 to R016, R019 and R020 need a running engine and have `host` cases only, reported `pending`. R017 is checked by `projection` cases under `all-or-nothing`. R009 and R018 are SHOULDs and have no cases. R010 is checked by the reference runner only for the members `server.json` requires (`name`, `description`, `version`); full schema validation is the adapter's.

## 9. Open questions

Closed by [ADR-0022](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0022-host-adapter-open-questions-decided.md) (2026-11-06): OQ-0008-1 (no core `instructions` kind until a second harness), OQ-0008-4 (no health-check code; R018), OQ-0008-5 (unprojectable entries are reported, not fatal; R017), OQ-0008-6 (no host adapter profile until a second host).

- OQ-0008-2: a shared vocabulary for host-owned settings (permission policy, safety proxy, reserved names), so two hosts can declare them the same way (HCS-0005 OQ-0005-1).
- OQ-0008-3: whether projection outcomes need their own status document, or HCS-0004 status with HCS-0006 errors is enough. The first host needs only the latter.

## Appendix A. Engine mappings (non-normative)

Observed by the first host on 2026-11-06 at the engine versions shown; not verified independently and not part of the contract. Engine behaviour changes between versions; an adapter pins the versions it supports (HCS-0001 `compatibility.hosts`).

| Concern | OpenCode 1.18.32, 1.19.5 | Pi 1.5.0 | Claude Code 2.1.318 |
| --- | --- | --- | --- |
| Skills | `skills.paths` (recursive scan for `SKILL.md`), in a config file or the `OPENCODE_CONFIG_CONTENT` environment value | `--skill <dir>` (repeatable) or `settings.json` `{"skills":[<dir>]}` | `--add-dir <dir>` loads `<dir>/.claude/skills/<name>/SKILL.md`; `--plugin-dir <package>` loads one package as a plugin with names `<plugin>:<skill>` (R009 not met); a folder of packages without manifests loads nothing; `permissions.additionalDirectories` does not load skills |
| MCP servers | `mcp{}`; headers accept `{env:VAR}` references | `~/.pi/agent/mcp.json` | managed `managed-mcp.json` |
| Instructions | `instructions[]` | not observed | managed `CLAUDE.md` |
| Permissions | `permission{}` | not observed | managed `managed-settings.json` |
| Host-owned layer | host config file, not writable by generation content | not observed | `/etc/claude-code/` managed files, highest precedence |

Consequences for an adapter, in this document's terms:

- One generation per run (R001): point `skills.paths`, `--skill` or `--add-dir` at the resolved generation directory (`<generation>/...`), not at `active/...`.
- Claude Code needs a view of the generation in its own layout: a per-run directory with `.claude/skills/<name>` links to each skill directory of the generation (R008 forbids copying with changes, not linking).
- MCP: translate `server.json` into the engine's MCP block; write secret inputs as environment references the host fills (R012).
- An engine column marked "not observed" means the adapter reports `unsupported_contribution` for that kind (R004) until a mapping exists; the rest of the generation proceeds (R017).
- Agent and command definitions are engine-specific and stay per-engine extension kinds outside the normative text; an engine that cannot take them reports them under R004 ([ADR-0022](https://github.com/FullFran/hcs/blob/v0.1.0-draft.2/docs/adr/0022-host-adapter-open-questions-decided.md), decision 6).
