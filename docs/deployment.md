# Deployment

The server runs as one container behind HTTPS, with Clerk issuing tokens. Run **one replica**, because all writes rely on one process handling them in turn.

Production data is copied every day, encrypted, and a restore from those copies has been tested (see [Updating and backups](#updating-and-backups)). Two facts stay true and every writer should know them before loading real text: **everyone with access to a book can read all of it**, and **a connected assistant sends the text it reads to its own model provider**. The writer decides what to share.

## 1. Clerk

Create a separate application and go straight to a **production instance**. It needs a domain you own and DNS records, which the Clerk dashboard lists.

| Setting | Value | Why |
| --- | --- | --- |
| Sign-in | Email and password only | No Google app to set up for now |
| Email verification | On | Clerk only links Google to an account later without extra steps if the email was verified |
| Sign-up mode | Restricted | Only invited people can create an account |
| OAuth applications | Client ID Metadata Documents on | ChatGPT can register itself; turn on Dynamic Client Registration only if the client needs it |
| OAuth access tokens | JWT, with the `aud` claim | The server checks the audience |
| Default scopes | Set them | Some MCP clients omit scopes when registering |

Later, adding Google needs your own Google OAuth credentials. Clerk then links it to an existing account when Google returns a verified email that matches.

## 2. Container

Build from the `Dockerfile`, mount a named volume at `/data`, and expose port 8080 through HTTPS. Keep the original `Host` header at the proxy, or requests get 403.

| Variable | Example | Purpose |
| --- | --- | --- |
| `MCP_OAUTH_ISSUER` | `https://clerk.example.com` | Clerk Frontend API URL, exactly as it appears in `iss` |
| `MCP_OAUTH_RESOURCE` | `https://rewrite.example.com/mcp` | The public MCP URL and the token audience |
| `CLERK_PUBLISHABLE_KEY` | `pk_live_...` | Clerk sign-in on the review page; it is public by design |
| `REWRITE_DATA_DIR` | `/data` | Already set in the image |
| `PORT` | `8080` | Already set in the image |
| `REWRITE_LOG_SALT` | (deployment secret) | HMAC-SHA256 key for pseudonymous subject and book identifiers; keep stable within the deployment |

The embedded engine (chat with an assistant from the browser, using the writer's own ChatGPT account) is off by default and has its own settings and build argument: see [engine.md](engine.md) before enabling it.

The server refuses to start if a setting is missing or the URLs are not HTTPS. It needs no Clerk secret key, and **it has no setting that turns authentication off**.

## Read the metadata request log

The server writes one JSON line per HTTP request and an additional line per MCP JSON-RPC call to stdout. Docker captures them without a log file or collector:

```bash
docker logs rewrite 2>&1 | grep '"event":"http.request"'
docker logs rewrite 2>&1 | grep '"event":"mcp.call"'
docker logs rewrite 2>&1 | grep '"request_id":"<x-request-id from the response>"'
docker logs --since 30m rewrite 2>&1 | grep '"tool":"read_scene"'
```

Replace `rewrite` with the container name. Every response has a server-generated `x-request-id` header (client-supplied ids are ignored), shared by its HTTP and MCP records.

| Record | Metadata |
| --- | --- |
| Both | `event`, ISO `timestamp`, `request_id`, `duration_ms`, `door` (`mcp`, `review`, `public`), pseudonymous `subject` |
| `http.request` | HTTP `method`, allowlisted `route` template, `status`, optional hashed `book`; errors contain only a known RFC 9457 problem `type` or HCS code in `error` (otherwise `error`) |
| `mcp.call` | Allowlisted JSON-RPC `method`, known `tool` for `tools/call`, optional hashed `book`, and `result`: `ok`, a known product problem type, an HCS code, or `error` |

Dynamic paths are templates such as `/review/api/books/:book/import` and `/review/api/books/:book/scenes/:file`. Unknown paths are `unmatched`; unknown methods and tools are `unknown`, never echoed. Aborted HTTP requests have status 499. JSON-RPC notifications are not calls and do not produce a separate MCP record.

**Never logged:** manuscript text, quotes, statements, titles, scene or upload file names, concrete request paths, query strings, headers, tokens, raw Clerk subject ids, raw book slugs, MCP arguments or results, error messages or problem `detail`. Authentication failures retain a `reason` from the closed set `expired`, `audience`, `issuer`, `signature`, `malformed`, `other` (derived from known JWT error codes, never the message). Unexpected HTTP 500s retain `error_name` only when the Error subclass name matches `^[A-Za-z]+Error$`, otherwise `Error`. These safe fields preserve the previous rejection/internal-error diagnostics without their free text.

Set `REWRITE_LOG_SALT` to a strong randomly generated secret through the deployment's environment configuration. It is not printed. Subject ids and book slugs use the first 16 hex characters of HMAC-SHA256 with that key, stable across restarts and both doors. With no salt, startup warns once: authenticated subjects and book ids become `unset`, while unauthenticated requests use subject `anon`. There is no unkeyed-hash fallback. Rotating the salt breaks correlation with earlier records. Treat the pseudonyms as sensitive metadata and configure Docker log retention on the host.

This is a first step toward [#42](https://github.com/FullFran/re-write/issues/42), using the `metadata` privacy boundary of [#6](https://github.com/FullFran/re-write/issues/6), not the complete OpenTelemetry profile. Traces, lifecycle events and selectable `off`/`masked` levels remain outside this change; #42 stays open.

## Updating and backups

Production follows `main`. A deploy agent on the server, configured in the infra repository, checks `main` every two minutes. When it finds a new commit it checks it out into its own directory, builds the image from this `Dockerfile` on the server and recreates the single container with the same volume and settings. Nothing is pushed to the server and no image registry is involved: **merging to `main` is deploying.**

The agent does not wait for the new container to become healthy before recording the commit as deployed, and the old container is already gone by then. So a broken image takes production down until the next commit lands. That is why **CI must be green before merging**: the `CI` workflow runs the tests and builds the image from a checkout whose files are readable only by their owner (as the server's checkout is), then starts it and waits until its healthcheck reports healthy.

**What is deployed.** The agent records, per app, the last commit it deployed and a history of deploys and failed builds. Read them on the infra side; this repository has no endpoint that reports the commit.

**Rolling back.**

1. Usual way: revert the bad commit on `main` (`git revert <sha>`, through a pull request with green CI). The agent deploys the revert like any other commit.
2. Without touching `main`: the agent always deploys the head of the branch it is configured to follow, and forcing a deploy redeploys that head. To run an older commit, push a branch that points at it, point the app at that branch in the infra repository and force a deploy there. Point it back at `main` once `main` is fixed.

`scripts/backup-r2.sh` encrypts the data volume with `gpg`, uploads it to an R2 bucket, then downloads that copy and compares it. It reads its settings from `~/.config/rewrite-backup/r2.env`. On the production server it runs from cron every day at 03:30 server time (02:30 UTC) and appends one line per run to `~/.local/state/rewrite-backup.log`. **Keep a copy of the passphrase outside the server**: without it the copies cannot be read, and a copy that lives only on the server is lost with the server.

| Question | Answer |
| --- | --- |
| What is copied | The whole data volume: every book repository with its `.rewrite/` state, `access.json` and `grants.json`. Host HCS state is not used in production yet; when it is, it must live in the same volume |
| When | Once a day at 03:30 server time (02:30 UTC), a cron entry on the server |
| How long | Set by the bucket's expiry rule (30 days) |
| Consistency | The archive is taken while the service runs, without stopping it. Writes are rare and each one is a single JSON rename plus a git commit, so a copy taken mid-write can at worst miss that last operation; the restore drill runs `git fsck` on every book to catch a damaged repository |
| Key recovery | The passphrase lives in the server's env file and in a second copy off the server. Check that both still match before you rely on them |

**Restore drill.** `scripts/restore-drill.sh [object-name]` proves a copy can be brought back without touching production. On the server it downloads the newest copy (or the one named), decrypts it, restores it into a new volume, starts the image production runs on that volume as a separate container with no published port, and checks that:

- the service becomes healthy on the restored data;
- every restored file is byte-identical to the archive;
- every book opens, its git history passes `git fsck`, and each person can reach exactly the books `access.json` lists for them, while an unknown person reaches none.

It prints counts and verdicts only, never manuscript text, and removes the volume and container when it ends, whether it passed or failed. Run it before loading a private manuscript and after changing how data is stored. When the script is not on the server, stream it from a checkout of this repository so nothing new is written there: `ssh <server> 'bash -s' < scripts/restore-drill.sh`.

**Last verified on 2026-11-11** on the production server: the schedule above was in place, the log showed a successful copy every day from 2026-11-02 to 2026-11-11 (the 7 runs of the last week all succeeded), and the drill restored that morning's copy, the service became healthy on it, all 136 files were identical to the archive, both books opened and passed `git fsck`, access checks (2 books x 3 subjects) had 0 failures, and no drill volume or container was left behind.

**Restoring for real:** stop the container, run the same steps as the drill into the production volume (`gpg --decrypt` the object, extract the archive into the data volume, give it to the image's `node` user), then start the container again.

Clerk browser sessions last 7 days unless a paid plan changes that.

## 3. Create a book and give access

Books can be created directly from the browser at `/review`: any signed-in user can create a book, upload Markdown scenes, and automatically becomes its only member.

Alternatively, an administrator can create a book and manage access via the CLI in the container. Nobody has access by default. Clerk says who a person is; `grant` says which book they can open. Find the user id (`user_...`) in the Clerk dashboard, then run this in the container:

```bash
alias rewrite="node /app/src/cli/main.ts"
rewrite init /data/books/demo-book --title "La puerta de Sal"
rewrite import /data/books/demo-book /app/fixtures/demo-book/escena-01.md /app/fixtures/demo-book/escena-02.md
rewrite grant /data demo-book user_xxx
```

`rewrite revoke /data demo-book user_xxx` removes that access; the person's next call is refused, with no restart.

Packages get authority the same way, one permission at a time, and nothing by default. A package's own requests never grant anything. The grantable permissions are `com.fullfran.rewrite.book.read`, `book.import`, `claims.propose`, `findings.propose` and `revision.propose` (all under `com.fullfran.rewrite.`); accepting, rejecting and verdicts stay with people on the review page and cannot be granted:

```bash
rewrite package-grant /data com.example.reader com.fullfran.rewrite.book.read
rewrite package-revoke /data com.example.reader com.fullfran.rewrite.book.read
```

Grants live in `/data/grants.json` and are read on every call, so a revocation applies to the next operation.

## 4. Connect a client

- **ChatGPT:** add a custom MCP server with the `/mcp` URL and OAuth.
- **Other agents:** configure the same URL as a remote MCP server.

People review at `https://rewrite.example.com/review`. Setup steps for an assistant guiding a new user are served at `/llms.txt`.

## 5. Check after deploying

Do these with the synthetic book only.

1. `GET /health` answers `{"status":"ok"}`, and `POST /mcp` with no token answers 401.
2. ChatGPT logs in through Clerk and `list_books` shows the book.
3. **A write works:** `propose_claims` with one literal quote creates a proposed claim. This is not yet proven on the 20 EUR ChatGPT plan.
4. The review page signs in and shows that claim. The real Clerk sign-in form has loaded; a full sign-in has not been tried yet.
5. An account with no `grant` sees no books.
6. Repeat 2 and 3 in ChatGPT Work.
7. Open a new chat a day later and see whether login is asked again.
8. Look at a real Clerk access token and session token. The two doors tell them apart by `aud`, `sid` and `azp`; if the real tokens carry a distinct `typ`, require it too.

## Security boundaries

- **Two doors.** An agent's access token opens only `/mcp`, and a browser session opens only `/review/api`. So the MCP can propose but cannot approve.
- **This is not a sandbox for the people involved.** Anyone with shell access to the container can do anything. And a person who pastes their own browser session token into an agent would give it their review rights.
- **Coauthors of one book see all of it.** Permissions are per book, not per scene.
- **Book text goes to each person's model provider** when their agent reads it.
- **With the embedded engine enabled, the server stores each connected writer's ChatGPT credential**, encrypted with `REWRITE_ENGINE_KEY`, inside the data volume. Whoever holds the volume and the key holds those logins. See [engine.md](engine.md#security-boundaries).
- **The server listens on all interfaces.** With the embedded engine enabled, a reverse proxy on the same host must add a forwarding header (`X-Forwarded-For`, `Forwarded`, `Via` or `X-Real-IP`) to what it forwards. Without one, a request from outside looks to the server like its own engine process on loopback, and a leaked engine token would work remotely. See [engine.md](engine.md#enable-it).
