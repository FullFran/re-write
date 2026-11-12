# The showcase book: La puerta de Sal

`fixtures/la-puerta-de-sal/` is a complete short novel written for RE;write, so a writer (and the
assistant) can try every feature on a book with real structure: the editor and its modes, notes
with wikilinks and backlinks, the story graph and its operations, claims, findings and proposals,
undo and revert, and the assistant. The story is original and synthetic, written for this
repository; it may be published.

It continues the two-scene demo (`fixtures/demo-book/`), which stays untouched because tests and
evals pin its text. Scenes 1 and 2 of the showcase read exactly as the demo: their only change is
a few wikilinks, whose shown text is the original word.

## Outline

### Premise

Sal is a salt town on a river. The stone bridge that joins it to Ribera, on the other bank, holds
the floodgate of the salt pans: whoever opens it with the bridge key decides whether the river
floods the pans or the town. Elena has guarded the bridge for eleven years. A rumour says Bruno,
the keeper of the key, sold it to Ribera and fled. Elena says the key is under the altar slab;
three nights later Clara finds it there, and Elena, who said it, turns out not to have known.

### Cast

| Note | Role |
| --- | --- |
| Elena | Guardian of the bridge. Narrative centre. |
| Clara | Bruno's younger sister, sacristan of the chapel. Finds the key, then the forged ledger. |
| Bruno | Keeper of the key, accused of selling it. Missing; the mystery is where he is. |
| Tomás | The guard of scene 1. Spreads the rumour, later holds the bridge. |
| Anselmo | The salt-tax collector. Keeps the ledger and forged Bruno's debts to take the floodgate. |
| Padre Damián | The priest. Helped Bruno hide the key, then told Anselmo under pressure. |
| Inés | The ferrywoman of Ribera. She crosses the river every day and hides the answer to the mystery. |
| Marcos Ferrer | Lord of Ribera, who wants the floodgate for his own pans. |

### Places and objects

Places: Puente de Sal, Capilla de San Telmo, Casa del Peso, Taberna del Ancla, Ribera, and
Salina Vieja (an orphan note: nothing links it). Objects: Llave del puente, Libro de cuentas.

### Threads

| Thread | Question | Crosses |
| --- | --- | --- |
| La venta de la llave | Did Bruno sell the key? Where is he? | Elena, Clara, Bruno, Inés |
| Las cuentas falsas | Who wrote Bruno's debts? | Anselmo, Clara, Tomás, Elena |
| La crecida | Who opens the floodgate when the river rises? | everyone, at the climax |

A note `Canción de la barquera` is a second orphan, and scene 15 links `[[Salinas del Norte]]`,
a note that does not exist: the one planted unresolved link.

### Scenes and who learns what

| # | Scene | Story day | What happens | Knowledge |
| --- | --- | --- | --- | --- |
| 1 | La puerta de Sal | 1 | The rumour; Elena names the altar slab. | Elena shows she knows where the key is (planted problem A). |
| 2 | El altar | 4 | Clara finds the key; Elena had not known. | Elena and Clara learn where the key is. |
| 3 | La taberna del Ancla | 4 | Tomás and Anselmo feed the rumour; Bruno's debts. | |
| 4 | El paño seco | 5 | Elena, Clara and Damián agree to keep the key hidden. | |
| 5 | La barquera | 6 | Inés crosses; nobody in Ribera bought a key. | |
| 6 | La Casa del Peso | 7 | Anselmo shows Clara Bruno's debts in the ledger. | Clara hears of the debts. |
| 7 | El señor de Ribera | 8 | Marcos Ferrer and Inés; Marcos talks of the altar. | Marcos shows he knows where the key is (planted problem B). |
| 8 | La ronda de noche | 9 | Tomás and Elena patrol; the river rises. | Tomás shows he knows the ledger is forged (planted problem C). |
| 9 | Tinta nueva | 10 | Clara reads the ledger by night. | Clara learns the ledger is forged. |
| 10 | El trato | 11 | Anselmo tells Marcos where the key is, in Inés's boat. | Marcos learns it; Inés overhears. |
| 11 | Lo que dijo Elena | 12 | Clara shows Elena the copied page; Elena admits she guessed. | Elena learns the ledger is forged. |
| 12 | La vergüenza de Tomás | 13 | Elena tells Tomás. | Tomás learns the ledger is forged. |
| 13 | Antes de la lluvia | 0 (flashback) | Bruno and Damián hide the key; Bruno leaves by boat. | Bruno and Damián know where the key is. |
| 14 | La otra orilla | 14 | Elena crosses and finds Bruno alive, hidden by Inés. | The mystery's reveal: Elena learns where Bruno is. |
| 15 | La crecida | 15 | The river floods; Ribera and Anselmo move for the key. | |
| 16 | La capilla vacía | 15 | The slab is empty; Damián confesses he told Anselmo. | Anselmo learned of the altar on day 9 (told later). |
| 17 | La puerta | 15 | Elena opens the floodgate; Tomás holds the bridge; the ledger falls in the river. | |
| 18 | El libro mojado | 16 | The ledger dried and read before the council; Bruno cleared. | |
| 19 | La medida de la sal | 18 | Aftermath on the bridge. | |
| 20 | La losa | 20 | The key goes back under the slab, known by all. | |

### Planted problems

Knowledge-order problems, which `inspect_continuity` (`rewrite check`) finds:

- **A.** Elena says where the key is (day 1) before learning it (day 4). Inherited from the demo;
  scene 11 explains it as a guess, so the honest verdict is a reading the finding already lists
  (guess or lie).
- **B.** Marcos Ferrer speaks of the altar on day 8, but Anselmo tells him on day 11.
- **C.** Tomás says the ledger is forged on day 9, but learns it on day 13.

Problems the age, duration and place rules find, from claims with `attribute` (see
[architecture: continuity rules](architecture.md#continuity-rules)):

- **D (a duration).** Elena has guarded the bridge eleven years in scene 1 and nine in scene 19.
- **E (a place).** The Casa del Peso stands on the Sal bank in scene 6 and in Ribera in scene 17.

The mystery: where Bruno is. Nothing before scene 14 says it, and no who-knows-what edge about it
exists before that scene.

## What the graph shows

Measured on the book and pinned in `fixtures/la-puerta-de-sal/expected.json`:

- **Communities.** Louvain in the Grafo panel draws four groups: the bridge (Elena, Tomás, the
  bridge, the tavern, the rumour thread), the ledger (Bruno, Anselmo, the ledger, the Casa del
  Peso, its thread), the chapel (Clara, the key, the chapel, Padre Damián) and Ribera (Marcos
  Ferrer, Inés, Ribera, the flood thread). Bruno and Clara are go-betweens: Bruno joins the
  ledger and the chapel almost equally.
- **Top bridge.** Elena has the highest betweenness, degree and PageRank: the story passes
  through her.
- **A shortest path.** Marcos Ferrer and Padre Damián never share a scene; the path between them
  goes through Anselmo, the one person who deals with both.
- **Orphans.** `Salina Vieja` and `Canción de la barquera`, two notes nothing links.
- **An unresolved link.** `[[Salinas del Norte]]` in scene 15.
- **Who knows what.** 19 `knows` edges from the claims. With the scene cut at scene 13 there is
  no edge about where Bruno is; at scene 14 there are two, from Elena and from Inés.

## Load it

The loader uses the product's application layer (`Project.init`, `importScenes`, `proposeNote`
and `reviewProposal`, `extractClaims`, `reviewClaim`) and writes only inside the data directory
it is given. It refuses a book that already exists, so it never changes a book someone has worked
on.

```bash
node scripts/load-showcase.ts <data-dir> [--book <id>] [--user <subject>] [--json]
```

It creates `books/<id>` (default `la-puerta-de-sal`) with the 20 scenes, the 20 notes (each one
proposed and accepted, so the review history shows how a note arrives), and the 34 claims from
`annotations.json`: the 25 narrated facts are accepted and form Canon, and the 9 beliefs and
rumours wait in the review queue. `--user` gives that person (their Clerk user id) access.

To browse it in the review page, point a server at the same data directory (`REWRITE_DATA_DIR`,
see [deployment](deployment.md)). The server always needs a Clerk instance: there is no local
mode without sign-in. Loading the showcase into production is a separate decision for the owner;
the loader has no option that reaches a server. Without a server, the CLI reads the same book:

```bash
node src/cli/main.ts canon <data-dir>/books/la-puerta-de-sal
node src/cli/main.ts check <data-dir>/books/la-puerta-de-sal
```

## A guided tour

1. **Concentración.** Open scene 4, *El paño seco*, in Concentración. In *Vista previa en vivo*
   the links show only their text; put the cursor on `padre Damián` to see
   `[[Padre Damián|padre Damián]]`, and switch to *Lectura* to read it clean.
2. **Follow a link.** Open `Clara` from the scene. Her note lists its linked mentions (scenes 2,
   4, 6, 9, ...) and the unlinked ones, where her name appears as plain text.
3. **The graph.** Open the Grafo panel and the drawing: four colours, one per community. Turn on
   the orphans: two notes float alone.
4. **No spoilers.** Slide the scene cut to scene 8: Bruno's note is there, but nothing says where
   he is. Ask for the who-knows-what edges: none about Bruno's whereabouts until scene 14.
5. **A path.** Find the path from Marcos Ferrer to Padre Damián: it goes through Anselmo.
6. **Findings.** Run the continuity check (`check`, or `inspect_continuity` from the assistant):
   three possible contradictions, A, B and C above. A is the honest case for a verdict: scene 11
   says Elena guessed, a reading the finding already lists. B and C are real slips to fix.
7. **A proposal, undo and revert.** Accept a fix for C (for example, make Tomás only suspect in
   scene 8), then use *Revertir cambio de texto* in the review page and see the scene come back.
8. **Ask the assistant.** "¿Dónde está Bruno?" with the cut at scene 10, then without the cut.
   Then "¿Cuántos años lleva Elena en el puente?": Canon holds both answers (D), and a careful
   reader, or the assistant, should notice.

## Tests and eval

`tests/showcase.test.ts` loads the book and checks: every annotation quote is literal and
appears once; every link resolves except the planted one; the orphans, the shortest path, the top
bridge and the designed communities (loosely: their modularity is clearly positive and above any
shuffle of the same group sizes); no who-knows-what edge about the mystery before its scene; and
the continuity check reports exactly A, B and C as knowledge-order problems, and D and E as a
shrinking duration and a place with two values, each citing both literal quotes in Canon. The copy
loaded into production on 2026-11-12 has its claims without `attribute`, so there D and E appear
only after those claims are proposed again with it. The eval journey `showcase-tour` drives the
MCP tools over the book.
