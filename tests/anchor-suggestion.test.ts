import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessAnchor, buildAnchor, MAX_SUGGESTION_CHARS, suggestAnchor } from '../src/domain/anchor.ts';

const ORIGINAL = 'Llovía sobre el puerto. Mara guardó la llave de bronce en el bolsillo. Nadie la vio salir.';
const QUOTE = 'Mara guardó la llave de bronce en el bolsillo.';
const anchor = buildAnchor(ORIGINAL, QUOTE);

// The suggestion must be something a person can accept: a literal quote that appears once.
function acceptable(text: string, suggestion: { quote: string; start: number }): void {
  const rebuilt = buildAnchor(text, suggestion.quote);
  assert.equal(rebuilt.start, suggestion.start);
  assert.equal(assessAnchor(rebuilt, text).status, 'valid');
}

test('a quote that moved to new surroundings is suggested at its new position', () => {
  const text = 'Nadie la vio salir. Pasó una semana.\n\nAl volver, Mara guardó la llave de bronce en el bolsillo. Luego cerró.';
  assert.equal(assessAnchor(anchor, text).status, 'stale');
  const suggestion = suggestAnchor(anchor, text);
  assert.deepEqual(suggestion, { quote: QUOTE, start: text.indexOf(QUOTE), how: 'moved' });
  acceptable(text, suggestion!);
});

test('a quote that now appears twice is suggested at the copy whose context is closest, widened until it is unique', () => {
  const text = 'En el sueño, Mara guardó la llave de bronce en el bolsillo. Despertó.\n\nLlovía sobre el muelle. Mara guardó la llave de bronce en el bolsillo. Nadie la vio salir.';
  assert.equal(assessAnchor(anchor, text).reason, 'ambiguous');
  const suggestion = suggestAnchor(anchor, text)!;
  assert.equal(suggestion.how, 'moved');
  assert.ok(suggestion.quote.includes(QUOTE));
  assert.ok(suggestion.start <= text.lastIndexOf(QUOTE) && suggestion.start + suggestion.quote.length >= text.lastIndexOf(QUOTE) + QUOTE.length,
    'the suggestion covers the second copy, the one with the old context');
  acceptable(text, suggestion);
});

test('an edited quote is suggested as the closest passage by shared words', () => {
  const text = 'Llovía sobre el puerto. Mara escondió la llave de bronce en el abrigo. Nadie la vio salir.';
  assert.equal(assessAnchor(anchor, text).status, 'orphaned');
  const suggestion = suggestAnchor(anchor, text);
  assert.deepEqual(suggestion, { quote: 'Mara escondió la llave de bronce en el abrigo', start: text.indexOf('Mara escondió'), how: 'similar' });
  acceptable(text, suggestion!);
});

test('a removed quote has no suggestion', () => {
  const text = 'Llovía sobre el puerto. Nadie la vio salir.';
  assert.equal(suggestAnchor(anchor, text), null);
  assert.equal(suggestAnchor(anchor, null), null);
});

test('a text over the work cap is not searched', () => {
  const text = `${'x'.repeat(MAX_SUGGESTION_CHARS)} ${QUOTE} y más`;
  assert.equal(suggestAnchor(anchor, text), null);
});
