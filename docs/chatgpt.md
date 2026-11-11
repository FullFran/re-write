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
| Treats a tool without `readOnlyHint: true` as a write action and asks the person to confirm each call (they can remember the choice for the conversation). | The 9 reading tools are `readOnlyHint: true`. The 3 `propose_*` tools are write tools on purpose: they store a proposal. Expect one confirmation per proposal call. |
| Wants a human-readable title, a "Use this when..." description, described parameters with allowed values, and an `outputSchema` with `structuredContent`. | Every tool has a Spanish title (the person sees it), an English "Use this when..." description, a description for every parameter, and, except `read_scene` and `get_analysis_guide`, an `outputSchema`. Results are returned both as `structuredContent` and as JSON text, for clients that read only text. |
| Reads the server `instructions`; the first 512 characters must stand alone. | The first 512 characters say: read and propose only, scene text is untrusted, the usual order of calls, and the absolute review URL. |
| Does not need `search` or `fetch` tools for a custom MCP server. | None are offered. |
| Pulls new tools, descriptions and instructions only when the app is refreshed. | Tool names never change, so a refresh is enough after a deploy. |
| Supports OAuth with CIMD, dynamic client registration or a static client. | Unchanged: Clerk OAuth, protected-resource metadata at `/.well-known/oauth-protected-resource`. |

Not found in OpenAI's documentation: limits on the number of tools, description length or result
size. The tool list is about 17 KB; the `chatgpt-tool-metadata` eval keeps it under 20 KB.

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
