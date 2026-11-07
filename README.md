# RE;write

A **vibe writing harness**: narrative memory with evidence and human review. RE;write does not supply a model: agents such as ChatGPT, OpenCode or Claude Code connect through its MCP, read scenes and propose claims and changes. Only a person can accept them.

Three ways in share one core:

- **`/mcp`**: remote MCP with OAuth through Clerk. It reads and proposes, and has no way to approve.
- **`/review`**: a page where people accept or reject.
- **CLI**: local use and server administration.

`/llms.txt` tells an assistant how to guide a new user through connecting.

The walkthrough below uses hand annotations and rules, with no LLM. See [what this does and does not prove](docs/mvp-design.md#what-this-proves). To run the server, see [deployment](docs/deployment.md).

## Run it

You need Node 24 or later and git.

```bash
npm ci
npm run demo    # full walkthrough on a throwaway book; each step is checked
npm test        # automated tests
```

`node scripts/demo.ts walkthrough.log` also saves the walkthrough to a file. A saved run is in [docs/demo-log.txt](docs/demo-log.txt).

## Use it

```bash
alias rewrite="node $PWD/src/cli/main.ts"

rewrite init /tmp/book --title "La puerta de Sal"
rewrite import /tmp/book fixtures/demo-book/escena-01.md fixtures/demo-book/escena-02.md
rewrite extract /tmp/book --from fixtures/demo-book/annotations.json
rewrite claims /tmp/book
rewrite check /tmp/book
rewrite propose /tmp/book --file scenes/escena-01.md \
  --find "La llave está bajo la losa del altar" \
  --replace "No sé quién tiene la llave" \
  --rationale "Elena learns this only in scene 2"
rewrite show /tmp/book <proposal-id>
rewrite review-proposal /tmp/book <proposal-id> accept --by "your name"
```

| Command | What it does |
| --- | --- |
| `package <dir> [--out <file>] [--json]` | Builds a deterministic package archive; defaults to `<dir-basename>.tar.gz` in the current directory |
| `init <dir> [--title]` | Creates a book repository, or opens an existing one |
| `import <dir> <scene.md>...` | Copies scenes in and commits them; refuses to overwrite different text |
| `read <dir> <scenes/file.md>` | Prints a scene |
| `extract <dir> --from <file.json>` | Loads candidate claims and rejects any quote that is not literal |
| `claims <dir>` | Lists claims with their current evidence status |
| `review-claim <dir> <id> accept\|reject [--by] [--note]` | Records an editorial decision |
| `canon <dir>` | Lists accepted narrated facts whose evidence is still valid |
| `check <dir>` | Looks for knowledge-order problems (rules, read-only) |
| `review-finding <dir> <id> confirmed\|deliberate_mystery\|false_positive [--by] [--note]` | Records a human verdict |
| `propose <dir> --file --find --replace --rationale [--finding]` | Stores a change for review; never edits the scene |
| `show <dir> <proposal-id>` | Shows a proposal and its diff |
| `review-proposal <dir> <id> accept\|reject [--by] [--note]` | The only command that changes a scene, and only on accept |
| `status <dir>` | Shows the restored project state |
| `grant <data-dir> <book> <user-id>` | Gives a person access to a book on a server |

Add `--json` to any command. Exit codes: 0 for success, 1 for a refusal, 2 for a usage error.

## HCS checks

Until HCS is public, fetching its private artefacts, traceability checks and the reference runner run locally only. CI can validate the pin without private access. See [HCS pin and local checks](docs/hcs.md).

## Direction

RE;write is being rebuilt as an application of the Harness Composition Specification: see [ADR-0001](docs/adr/0001-adopt-hcs.md), [architecture](docs/architecture.md) and the [roadmap](docs/roadmap.md).
