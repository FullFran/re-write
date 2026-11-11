// Search and replace inside the scene (issue #101), on @codemirror/search. Ctrl/Cmd+F, or the
// Buscar button of the toolbar (phones have no Ctrl+F), opens a panel with Spanish labels: the
// words to find, Siguiente / Anterior, Distinguir mayúsculas, Palabra completa, Expresión
// regular, and the replacement with Reemplazar / Reemplazar todo. A replacement edits the raw
// Markdown exactly as typing would: one transaction per press, its own undo step, nothing
// converted around it, so saving is unchanged.
//
// The panel is drawn in a container the page can place (the editor's sticky head), so on a
// phone it stays above the text and the on-screen keyboard instead of scrolling away.
import { closeSearchPanel, findNext, findPrevious, openSearchPanel, search, searchPanelOpen } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, panels } from '@codemirror/view';

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

// The page's tokens (docs/design.md): controls at least --tap high, 16 px text so iOS does not
// zoom, matches marked with --mark and the current one also outlined (not by colour alone).
const theme = EditorView.theme({
  '.cm-panels': { backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '.cm-panels-top': { borderBottom: 'none' },
  '.cm-panel.cm-search': {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-1) var(--space-2)',
    padding: '0 calc(var(--tap) + var(--space-2)) var(--space-2) 0', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-md)',
  },
  '.cm-panel.cm-search br': { display: 'block', flexBasis: '100%', height: '0', content: '""' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { margin: '0' },
  '.cm-panel.cm-search .cm-textfield': {
    flex: '1 1 12em', minWidth: '0', minHeight: 'var(--tap)', boxSizing: 'border-box', padding: '0 var(--space-3)',
    font: 'inherit', fontSize: 'var(--text-md)', color: 'var(--ink)', backgroundColor: 'var(--paper)',
    border: '1px solid var(--edge)', borderRadius: 'var(--radius)',
  },
  '.cm-panel.cm-search .cm-button': {
    minHeight: 'var(--tap)', padding: '0 var(--space-3)', font: 'inherit', fontSize: 'var(--text-sm)', color: 'var(--ink)',
    backgroundColor: 'var(--paper)', backgroundImage: 'none', border: '1px solid var(--edge)', borderRadius: 'var(--radius)',
  },
  '.cm-panel.cm-search .cm-button:hover': { backgroundColor: 'var(--pressed)' },
  '.cm-panel.cm-search .cm-button:disabled': { opacity: '0.5' },
  // Selecting every match makes many cursors, which nothing else on the desk does.
  '.cm-panel.cm-search [name=select]': { display: 'none' },
  '.cm-panel.cm-search label': {
    display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', minHeight: 'var(--tap)',
    fontSize: 'var(--text-sm)', whiteSpace: 'nowrap', cursor: 'pointer',
  },
  '.cm-panel.cm-search input[type=checkbox]': { width: '1.25rem', height: '1.25rem', margin: '0' },
  '.cm-panel.cm-search [name=close]': {
    position: 'absolute', top: '0', right: '0', width: 'var(--tap)', height: 'var(--tap)', padding: '0',
    fontSize: 'var(--text-xl)', lineHeight: '1', color: 'var(--ink)', backgroundColor: 'transparent',
    border: '1px solid transparent', borderRadius: 'var(--radius)', cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': { backgroundColor: 'var(--pressed)' },
  '.cm-searchMatch': { backgroundColor: 'var(--mark)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--mark)', outline: '2px solid var(--ink)' },
});

/** The search extension, its panel drawn at the top of `container` (or of the editor). */
export function sceneSearch(container) {
  return [
    search({ top: true }),
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
