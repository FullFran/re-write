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
| Inés | The ferrywoman of Ribera. The go-between: she crosses the river and both stories. |
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

Problems for a reader or the assistant, which no rule in RE;write checks today:

- **D (an age).** Elena has guarded the bridge eleven years in scene 1 and nine in scene 19.
- **E (a place).** The Casa del Peso stands on the Sal bank in scene 6 and in Ribera in scene 17.

The mystery: where Bruno is. Nothing before scene 14 says it, and no who-knows-what edge about it
exists before that scene.
