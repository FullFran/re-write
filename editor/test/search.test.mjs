import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { SEARCH_PHRASES, sceneSearch } from '../src/search.js';

// The phrases @codemirror/search shows or announces, read from the installed package, so an
// upgrade that adds one fails here instead of showing English in the panel.
function packagePhrases() {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('@codemirror/search'), 'utf8');
  const found = new Set();
  for (const match of source.matchAll(/phrase\((?:view, )?"([^"]+)"/g)) found.add(match[1]);
  return [...found].sort();
}

test('every phrase of the search panel and its announcements is in Spanish', () => {
  const phrases = packagePhrases();
  assert.ok(phrases.includes('Find') && phrases.includes('replace all'), 'the package source was read');
  const state = EditorState.create({ extensions: sceneSearch(null) });
  for (const phrase of phrases) {
    assert.ok(Object.hasOwn(SEARCH_PHRASES, phrase), `"${phrase}" has a Spanish phrase`);
    assert.equal(state.phrase(phrase), SEARCH_PHRASES[phrase]);
  }
  assert.equal(state.phrase('Find'), 'Buscar');
  assert.equal(state.phrase('replace all'), 'Reemplazar todo');
  assert.equal(state.phrase('replaced $ matches', 3), 'Reemplazadas 3 coincidencias');
});
