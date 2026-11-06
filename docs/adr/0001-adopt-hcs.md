# ADR-0001: Build RE;write as an application of the Harness Composition Specification

**Status:** Proposed (2026-11-06)

## Context

RE;write is a writing harness: agents connect over MCP, read scenes and propose claims and revisions, and only a person can accept them. The first vertical slice proved the safety rails (literal evidence, derived evidence status, human-only approval, state in the book repository) as one hard-wired program. The next steps add analysis features (extractors, continuity and craft checks, importers), more engines (connected MCP clients, and an embedded engine for writers without their own agent), and a deployment that must stay correct as it updates itself.

Each of those needs answers every agent harness needs: what a harness is made of, how its parts depend on each other, how they are installed, verified, activated and rolled back, who grants them authority, how they reach an engine, how they fail and how they are observed. Inventing those answers inside RE;write would make them product decisions nobody else can reuse or check.

The Harness Composition Specification (HCS) collects those answers. It reuses widely used standards first (MCP, Agent Skills, AGENTS.md, OCI layers, TUF properties with DSSE signing, OpenTelemetry, CloudEvents, RFC 9457, UAPI boot counting), profiles them, and marks what it has to invent as Provisional. It has one host so far, a harness for a team. HCS itself says it is not a standard until two independent hosts pass the same conformance profile.

## Decision

1. RE;write adopts HCS and is built as its second host. HCS documents are cited by document and requirement id (for example HCS-0003-R004).
2. RE;write pins one HCS contract (`hcsVersion: "0.1"`) and consumes its schemas, requirement list and reference cases by a pinned reference. HCS text is not copied into this repository.
3. Reusable patterns and standards belong to HCS; product work belongs to RE;write. When RE;write needs a pattern HCS lacks, the gap is taken to HCS, and RE;write implements a local, clearly named stand-in (`x-rewrite-*`) until HCS decides.
4. RE;write owns the extension namespace `x-rewrite` and the identifier prefix `com.fullfran.rewrite` for capabilities and permissions (HCS-0000 section 7, HCS-0002-R004).
5. The writing domain (scenes, claims, evidence, proposals, review, versions, entities) stays host core. Analysis parts (extractors, checks, importers, agent skills and instructions) become HCS packages. See [architecture.md](../architecture.md).
6. Human approval is a host-owned boundary: no package grant, generation content or MCP session can accept or reject anything (HCS-0005-R002, HCS-0008-R007).
7. Conformance is claimed only from a generated report: CORE-0 first, then DISTRO-1, with host-level cases where RE;write can run them.

## Consequences

- The work is planned as milestones that follow HCS layers: foundation, core (CORE-0), authority, signed distribution (DISTRO-1), host adapter, observability and conformance, with product milestones on top. See [roadmap.md](../roadmap.md).
- RE;write's existing guarantees map onto HCS terms without changing behaviour: the two doors become a host-owned setting, content-derived ids keep retries harmless, and the single-process write path becomes the serialized writer of installed state.
- HCS is private today. Until it is published, the conformance job runs only where HCS is reachable, and this repository cites it without quoting it.
- HCS-0008 covers engines the host starts. Connected MCP clients are not started by RE;write, so their projection is a RE;write rule by analogy until HCS defines one; that gap is reported to HCS.
- Some HCS requirements do not apply to a server-only writing harness (for example multi-platform packages). The traceability matrix lists them with the reason.

## Alternatives considered

- **Keep RE;write as one program and add features directly.** Fastest for the next feature; every later engine, update and permission question would be answered ad hoc and unchecked.
- **Adopt only MCP and Agent Skills, without HCS.** Covers tools and procedures but not resolution, lifecycle, signed updates, grants or projection, which RE;write needs anyway.
- **Put RE;write's product rules into HCS.** Rejected: HCS keeps only what every harness needs (HCS README rule 4).
