# ADR-0002: Two engines, one generation per MCP session or engine run

**Status:** Proposed (2026-11-11)

## Context

[ADR-0001](0001-adopt-hcs.md) makes RE;write an HCS host. HCS-0008 says how a host projects a generation into an engine, and defines an engine as the agent runtime a host starts and configures.

RE;write's users mostly bring their own agent: ChatGPT, Claude Code, OpenCode or another MCP client connects to RE;write's MCP endpoint. RE;write does not start those clients, cannot configure them and never sees their model requests. HCS-0008 does not cover them. A second group, writers without an agent of their own, needs one that RE;write runs.

An earlier decision stands: the connected client supplies the model. RE;write pays for a model only where it runs the engine itself.

## Decision

1. RE;write serves two engines: connected MCP clients, which it does not start, and one embedded engine, which it starts (Pi first).
2. For a connected client, the projection is what its MCP session sees: tools, prompts, instructions, and skills as resources. It is built from exactly one generation and fixed for the session's life. A new generation applies to new sessions only.
3. For the embedded engine, RE;write follows HCS-0008 as written. Each run gets a projection that points at the generation directory, never at the moving pointer, with RE;write's own MCP server as a host-owned server.
4. HCS-0008 applies to MCP sessions by analogy, as RE;write's own rule, with "MCP session" in place of "engine run". Requirements that need a host-started engine apply only to the embedded engine. The table is in [engines.md, section 4](../engines.md#4-which-hcs-0008-requirements-apply-where).
5. The missing HCS pattern, projection into a connected client the host does not start, is reported to HCS as [FullFran/hcs#15](https://github.com/FullFran/hcs/issues/15). RE;write claims no HCS-0008 host-level conformance for MCP sessions until HCS defines that case.

## Consequences

- The MCP session adapter comes first ([#36](https://github.com/FullFran/re-write/issues/36)); the embedded engine adapter second ([#40](https://github.com/FullFran/re-write/issues/40)).
- Both engines use the MCP door, so neither can accept or reject anything (ADR-0001, decision 6).
- The MCP session rules are provisional twice over: HCS-0008 is Provisional, and the analogy is RE;write's. They are replaced when HCS, MCP or Agent Skills define client-side installation.
- The MCP endpoint is stateless today and has no session to pin a generation to. That and the other points no issue decides are listed in [engines.md, section 7](../engines.md#7-open-questions); this ADR does not decide them.

## Alternatives considered

- **Treat connected clients as outside the generation model and keep fixed tools.** No analogy needed. Packages would then never reach the agents most users have.
- **Only an embedded engine.** HCS-0008 would apply cleanly. RE;write would pay for every model call and users could not bring their own agent.
- **Wait for HCS to define connected clients before building.** Avoids a local rule. Blocks M5 on a specification with one other host.
