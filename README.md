# RE;write

A **vibe writing harness**: narrative memory with evidence and human review. RE;write does not supply a model: agents such as ChatGPT, OpenCode or Claude Code connect through its MCP, read scenes and propose claims, findings and changes. Only a person can accept them.

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

Books can be created directly from the browser at `/review` (where signed-in writers can create a book, upload Markdown scenes, and navigate chapters without opening a terminal), or managed through the CLI:

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
| `notion-inspect <export.zip\|dir>` | Safely inspects Notion export databases and pages without revealing text ([guide](docs/import.md)) |
| `import-notion <book-dir> <export.zip\|dir> --mapping <file.json> [--dry-run]` | Imports chapters from a Notion export via declarative mapping ([guide](docs/import.md)) |
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
| `catalog validate <catalog.json>` | Checks an HCS catalog document |
| `catalog apply <catalog.json> --state <dir> [--store <dir>] [--grants <data-dir>]` | Installs a catalog as a new generation; runs no package code; each entry needs a grant for every permission its package requests |
| `catalog status --state <dir>` | Shows the active generation and entry states |
| `grant <data-dir> <book> <user-id>` | Gives a person access to a book on a server |
| `revoke <data-dir> <book> <user-id>` | Removes that access; it applies to the person's next call |
| `package-grant <data-dir> <entry> <permission>` | Grants a package entry one permission; review decisions are never grantable |
| `package-revoke <data-dir> <entry> <permission>` | Revokes it; it applies to the next operation |

Add `--json` to any command. Exit codes: 0 for success, 1 for a refusal, 2 for a usage error.

## HCS checks

Until HCS is public, fetching its private artefacts and running traceability checks are local-only. The reference runner will run in M7 ([#44](https://github.com/FullFran/re-write/issues/44)); it does not run against re-write yet. CI can validate the pin without private access. See [HCS pin and local checks](docs/hcs.md).

## Direction

RE;write is being rebuilt as an application of the Harness Composition Specification: see [ADR-0001](docs/adr/0001-adopt-hcs.md), [architecture](docs/architecture.md) and the [roadmap](docs/roadmap.md).
