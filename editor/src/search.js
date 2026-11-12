// Search and replace inside the scene (issue #101), on @codemirror/search. Ctrl/Cmd+F, or the
// Buscar button of the toolbar (phones have no Ctrl+F), opens a panel with Spanish labels: the
// words to find, Siguiente / Anterior, Distinguir mayúsculas, Palabra completa, Expresión
// regular, and the replacement with Reemplazar / Reemplazar todo. A replacement edits the raw
// Markdown exactly as typing would: one transaction per press, its own undo step, nothing
// converted around it, so saving is unchanged.
//
// The panel is drawn in a container the page can place (the editor's sticky head), so on a
// phone it stays above the text and the on-screen keyboard instead of scrolling away.
import {
  closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, SearchQuery, searchPanelOpen, setSearchQuery,
} from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, panels, runScopeHandlers } from '@codemirror/view';

// Every phrase the search panel and its screen-reader announcements use, in Spanish.
export const SEARCH_PHRASES = {
  Find: 'Buscar',
  Replace: 'Reemplazar',
  next: 'Siguiente',
  previous: 'Anterior',
  all: 'Seleccionar todas',
  'match case': 'Distinguir mayúsculas',
  regexp: 'Expresión regular',
  'by word': 'Palabra completa',
  replace: 'Reemplazar',
  'replace all': 'Reemplazar todo',
  close: 'Cerrar búsqueda',
  'current match': 'Coincidencia actual',
  'on line': 'en la línea',
  'replaced match on line $': 'Reemplazada la coincidencia de la línea $',
  'replaced $ matches': 'Reemplazadas $ coincidencias',
  'Go to line': 'Ir a la línea',
  go: 'Ir',
};

// Only the keys that search: Ctrl/Cmd+F opens, Enter / F3 / Ctrl/Cmd+G go to the next match
// (with Shift the previous one), Escape closes and gives the text its focus back.
const keys = [
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor search-panel' },
  { key: 'F3', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-g', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
];

/**
 * The panel, in three rows so it stays short on a phone: the words to find with Anterior,
 * Siguiente and the close button; the replacement with Reemplazar and Reemplazar todo (only
 * when the text is editable); the three options, which scroll sideways on a narrow screen.
 * The query follows every input, so pasted or dictated words search as typed ones do.
 */
export function createSearchPanel(view) {
  const doc = view.dom.ownerDocument;
  const say = (phrase) => view.state.phrase(phrase);
  const make = (tag, attrs = {}, children = []) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  };
  const field = (phrase, extra = {}) => make('input', { class: 'cm-textfield', name: phrase === 'Find' ? 'search' : 'replace', type: 'text', placeholder: say(phrase), 'aria-label': say(phrase), autocomplete: 'off', spellcheck: 'false', ...extra });
  const button = (name, phrase, run, label) => {
    const btn = make('button', { class: 'cm-button', name, type: 'button' }, [label ?? say(phrase)]);
    btn.addEventListener('click', () => run(view));
    return btn;
  };
  const option = (name, phrase) => {
    const box = make('input', { type: 'checkbox', name });
    return { box, label: make('label', {}, [box, say(phrase)]) };
  };

  let query = getSearchQuery(view.state);
  const find = field('Find', { 'main-field': 'true' });
  const replace = field('Replace');
  const matchCase = option('case', 'match case');
  const byWord = option('word', 'by word');
  const regexp = option('re', 'regexp');
  const close = button('close', 'close', closeSearchPanel, '×');
  close.setAttribute('aria-label', say('close'));

  function show(next) {
    query = next;
    find.value = next.search;
    replace.value = next.replace;
    matchCase.box.checked = next.caseSensitive;
    byWord.box.checked = next.wholeWord;
    regexp.box.checked = next.regexp;
  }
  function commit() {
    const next = new SearchQuery({ search: find.value, replace: replace.value, caseSensitive: matchCase.box.checked, wholeWord: byWord.box.checked, regexp: regexp.box.checked });
    if (!next.eq(query)) {
      query = next;
      view.dispatch({ effects: setSearchQuery.of(next) });
    }
  }
  show(query);

  const rows = [make('div', { class: 'cm-search-row' }, [find, button('prev', 'previous', findPrevious), button('next', 'next', findNext), close])];
  if (!view.state.readOnly) rows.push(make('div', { class: 'cm-search-row' }, [replace, button('replace', 'replace', replaceNext), button('replaceAll', 'replace all', replaceAll)]));
  rows.push(make('div', { class: 'cm-search-row cm-search-options' }, [matchCase.label, byWord.label, regexp.label]));
  const dom = make('div', { class: 'cm-search', role: 'search' }, rows);
  dom.addEventListener('input', commit);
  dom.addEventListener('change', commit);
  dom.addEventListener('keydown', (event) => {
    if (runScopeHandlers(view, event, 'search-panel')) event.preventDefault();
    else if (event.key === 'Enter' && event.target === find) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === 'Enter' && event.target === replace) {
      event.preventDefault();
      ((event.ctrlKey || event.metaKey) ? replaceAll : replaceNext)(view);
    }
  });

  return {
    dom,
    top: true,
    mount: () => find.select(),
    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) if (effect.is(setSearchQuery) && !effect.value.eq(query)) show(effect.value);
      }
    },
  };
}

// The page's tokens (docs/design.md): controls at least --tap high, 16 px text so iOS does not
// zoom, matches marked with --mark and the current one also outlined (not by colour alone).
const theme = EditorView.theme({
  '.cm-panels': { backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '.cm-panels-top': { borderBottom: 'none' },
  '.cm-panel.cm-search': { display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', padding: '0 0 var(--space-2)', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-md)' },
  '.cm-search-row': { display: 'flex', alignItems: 'center', gap: 'var(--space-1)', minWidth: '0' },
  '.cm-search-options': { gap: 'var(--space-3)', overflowX: 'auto', overscrollBehaviorX: 'contain' },
  '.cm-search .cm-textfield': {
    flex: '1 1 8em', minWidth: '0', minHeight: 'var(--tap)', boxSizing: 'border-box', margin: '0', padding: '0 var(--space-3)',
    font: 'inherit', fontSize: 'var(--text-md)', color: 'var(--ink)', backgroundColor: 'var(--paper)',
    border: '1px solid var(--edge)', borderRadius: 'var(--radius)',
  },
  '.cm-search .cm-button': {
    flex: 'none', minHeight: 'var(--tap)', margin: '0', padding: '0 var(--space-2)', font: 'inherit', fontSize: 'var(--text-sm)', color: 'var(--ink)',
    backgroundColor: 'var(--paper)', backgroundImage: 'none', border: '1px solid var(--edge)', borderRadius: 'var(--radius)', cursor: 'pointer',
  },
  '.cm-search .cm-button:hover': { backgroundColor: 'var(--pressed)' },
  '.cm-search [name=close]': { width: 'var(--tap)', padding: '0', fontSize: 'var(--text-xl)', lineHeight: '1', borderColor: 'transparent' },
  '.cm-search label': { display: 'inline-flex', flex: 'none', alignItems: 'center', gap: 'var(--space-1)', minHeight: 'var(--tap)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap', cursor: 'pointer' },
  '.cm-search input[type=checkbox]': { width: '1.25rem', height: '1.25rem', margin: '0' },
  '.cm-searchMatch': { backgroundColor: 'var(--mark)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--mark)', outline: '2px solid var(--ink)' },
});

/** The search extension, its panel drawn at the top of `container` (or of the editor). */
export function sceneSearch(container) {
  return [
    search({ top: true, createPanel: createSearchPanel }),
    container ? panels({ topContainer: container }) : [],
    EditorState.phrases.of(SEARCH_PHRASES),
    keymap.of(keys),
    theme,
  ];
}

/**
 * The toolbar's Buscar button: opens the panel with the words to find selected, or closes it
 * when it is open. `aria-expanded` says which.
 */
export function searchButton(view, doc = document) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'format-search';
  btn.textContent = 'Buscar';
  btn.setAttribute('aria-keyshortcuts', 'Control+F');
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('mousedown', (event) => event.preventDefault());
  btn.addEventListener('click', () => {
    if (searchPanelOpen(view.state)) {
      closeSearchPanel(view);
      view.focus();
    } else {
      openSearchPanel(view);
    }
  });
  return {
    dom: btn,
    refresh(state) {
      btn.setAttribute('aria-expanded', String(searchPanelOpen(state)));
    },
  };
}
