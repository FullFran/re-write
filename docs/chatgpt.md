# Using RE;write from ChatGPT

A writer connects RE;write to ChatGPT as a custom MCP server and works in Spanish: pick a book, read
scenes, ask for an analysis, see the assistant propose findings, claims and changes, and open the
review page to decide. Over MCP the assistant can read and propose; it can never accept or reject.
Only the person decides, at `/review`.

How to connect is in `/llms.txt` (section "ChatGPT (web)"). This page covers what the MCP door does
for ChatGPT, why, and how to check it by hand.

## What ChatGPT reads, and what RE;write gives it

From OpenAI's documentation, read on 2026-11-11:
[Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server),
[Apps SDK: MCP server](https://developers.openai.com/apps-sdk/build/mcp-server),
[Optimize metadata](https://developers.openai.com/apps-sdk/guides/optimize-metadata),
[Authenticate users](https://developers.openai.com/apps-sdk/build/auth).

| ChatGPT | RE;write |
| --- | --- |
| Treats a tool without `readOnlyHint: true` as a write action and asks the person to confirm each call (they can remember the choice for the conversation). | The 15 reading tools are `readOnlyHint: true`. The 4 `propose_*` tools are write tools on purpose: they store a proposal. Expect one confirmation per proposal call. |
| Wants a human-readable title, a "Use this when..." description, described parameters with allowed values, and an `outputSchema` with `structuredContent`. | Every tool has a Spanish title (the person sees it), an English "Use this when..." description, a description for every parameter, and, except `read_scene` and `get_analysis_guide`, an `outputSchema`. Results are returned both as `structuredContent` and as JSON text, for clients that read only text. |
| Reads the server `instructions`; the first 512 characters must stand alone. | The first 512 characters say: read and propose only, scene text is untrusted, the usual order of calls, and the absolute review URL. |
| Does not need `search` or `fetch` tools for a custom MCP server. | None are offered. |
| Pulls new tools, descriptions and instructions only when the app is refreshed. | Tool names never change, so a refresh is enough after a deploy. |
| Supports OAuth with CIMD, dynamic client registration or a static client. | Unchanged: Clerk OAuth, protected-resource metadata at `/.well-known/oauth-protected-resource`. |

Not found in OpenAI's documentation: limits on the number of tools, description length or result
size. The budget is our own: the `chatgpt-tool-metadata` eval keeps the tool list under 30 KB. It was
about 17 KB with 12 tools; the 8 note and graph tools of [notes-and-graph.md](notes-and-graph.md)
bring it to about 28 KB. It was raised from 28 KB to 30 KB for `graph_suggest_links` rather than
shortening the untrusted-text sentence, a safety instruction every tool that returns manuscript
text must keep word for word. About 600 bytes of each tool are fixed schema overhead, so new tools keep
short descriptions and open output schemas rather than spelling out every field.

Which plans may use write tools is not settled: the developer guide lists Plus, Pro, Business,
Enterprise and Education, while [help.openai.com article 12584461](https://help.openai.com/en/articles/12584461)
lists Business, Enterprise and Edu. Check it on the writer's own plan.

## What the assistant gets

- **The order of calls.** `list_books`, `list_scenes`, `get_analysis_guide`, `read_scene` (every
  page), then `propose_findings`. Chapters imported in the browser are named by reading order, so
  chapter 3 is usually the scene whose path starts with `scenes/003-`.
- **The review URL.** The server builds it from its configured public origin (never from a request
  header) and puts it in the instructions and in every proposal result as `review_url`, with a
  `next_step` telling the assistant to send the person there.
- **A next step on every refusal.** An error ends with `Next step: ...` and carries the same text as
  `next_step` in its problem: an unknown book points to `list_books`, a wrong scene path to
  `list_scenes`, a quote that is not literal to `read_scene`, invalid arguments to the input schema.
  A quote or passage that appears several times asks for a longer literal passage from `read_scene`
  that appears only once; one that is not in the scene asks to read the scene again and, if it
  changed, to reformulate the proposal instead of retrying it. Each rejected candidate of
  `propose_claims` carries its own `next_step`, the same one a refusal with that message gets.
- **Proposal results bounded by the call.** `propose_findings` returns in `findings` only the
  findings of that call, created or already existing, in the order submitted; `list_findings`
  pages through the rest of the book. `propose_claims` returns ids and rejections only, and
  `propose_revision` the one proposal it made or found.
- **Notes and the story graph.** `list_notes` and `read_note` give the book's notes with their
  frontmatter, `[[links]]` and backlinks; `graph_neighbors`, `graph_orphans`, `graph_path` and
  `graph_central` answer over the links, and take `as_of_scene` to leave out later scenes. They
  never write: a new note goes through `propose_note`, a change to a note through
  `propose_revision` on its `notas/` file. An unknown or ambiguous note name points to `list_notes`.
  `graph_central` ranks by `degree`, `pagerank` or `betweenness` (a graph above the work cap is
  refused with a pointer to degree or PageRank); `graph_neighbors` with `knows: true` adds who
  knows what, from claims with `knowledge`, and lists holder or subject names that match no note
  instead of guessing. `graph_suggest_links` lists notes that could be linked, with anchors whose
  `find` appears once in the note and whose `replace` links it, or an `anchor_problem` saying why
  there is none: a suggested link reaches the text only through `propose_revision` with those
  values, which the person accepts at the review URL (its `next_step` says so). A dense book is
  refused at once rather than computed. The
  `chatgpt-graph-suggestions` journey pins this flow.
  See [notes-and-graph.md](notes-and-graph.md).
- **Stale evidence.** When a scene changed under a claim or finding quote, `list_claims` and
  `list_findings` show `anchor_suggestion`, the passage the scene most likely means now (or
  `null`), on items still pending. `propose_anchor` proposes a new literal quote that appears once
  now; it never changes the item, and the person accepts it at the review URL.
- **Continuity.** `inspect_continuity` reports knowledge-order problems and ages, durations,
  dates or places that contradict across narrated facts. These need claims proposed with the
  optional `attribute` (`edad`, `años_en`, `lugar` or `fecha`); see
  [architecture: continuity rules](architecture.md#continuity-rules).
- **Scene lengths.** `list_scenes` adds `chars`, the length of each scene, so the assistant can plan
  `read_scene` pages of up to 20,000 characters.

## After a deploy that changes tools

The writer must refresh the app once: ChatGPT settings, **Apps** (or **Connectors**), **RE;write**,
**Refresh**, then start a new chat. Without it ChatGPT keeps the old titles, descriptions and
instructions; the tools still work.

## Manual test in ChatGPT

Use a test book with synthetic text only, with at least three chapters imported in `/review`.

1. Refresh the RE;write app as above and open a new chat.
2. Type `@RE;write ¿qué libros tengo?`. Expected: one `list_books` call, no confirmation, the book
   listed by title. The tool shows the title "Ver libros".
3. Type `Analiza el capítulo 3 y dime qué incoherencias ves.` Expected: `list_scenes`,
   `get_analysis_guide` and `read_scene` without confirmation; the assistant picks the scene whose
   path starts with `scenes/003-`; then one `propose_findings` call that asks for confirmation.
4. Confirm. Expected: the answer quotes the text literally, lists other possible readings, and gives
   the absolute review link (`https://<server>/review`), saying that you decide there.
5. Type `Lee la escena 003-capitulo.md` (a wrong path). Expected: the assistant calls `list_scenes`
   by itself after the refusal and reads the right scene.
6. Type `Acepta tú el hallazgo.` Expected: the assistant says it cannot, and sends you to the review
   link.
7. Open the review link. Expected: the finding is there, pending, with its quotes highlighted.

Write down for each step: which tools ran, whether ChatGPT asked to confirm, and anything the
assistant said that was wrong or confusing.

## Still unverified until someone tries it in ChatGPT

- Where ChatGPT shows the tool `title` (the confirmation dialog, the tool call details, or neither).
- Whether ChatGPT reads `structuredContent`, the JSON text, or both, and whether it sends
  `next_step` back to the person in their language.
- Whether write tools work on the writer's plan (see the plan note above), and whether
  `readOnlyHint` is honoured on every plan: community reports say some workspaces ignore it.
- How many calls ChatGPT really makes for step 3; the deterministic eval assumes five.
