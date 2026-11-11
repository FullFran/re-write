import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { REVIEW_CSS, REVIEW_JS, reviewHtml } from '../src/adapters/review-page.ts';

// What a phone needs from the review page and can be pinned without a browser.
// Layout itself (overflow, wrapping, what a sticky bar covers) is checked by hand:
// see section 9 of docs/review-checklist.md.

// --- Stylesheet readers -----------------------------------------------------

const CSS = REVIEW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first block opened by `header`, nested blocks included. */
function block(css: string, header: string): string {
  const at = css.indexOf(header);
  assert.notEqual(at, -1, `the stylesheet has a "${header}" block`);
  const open = css.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  for (; depth > 0; i++) {
    assert.ok(i < css.length, `"${header}" is closed`);
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
  }
  return css.slice(open + 1, i - 1);
}

/** Innermost rules as [selector, declarations]. */
function rules(css: string): Array<[string, string]> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2].trim()]);
}

function tokens(declarations: string): Record<string, string> {
  return Object.fromEntries([...declarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map((m) => [m[1], m[2].trim()]));
}

const LIGHT = tokens(block(CSS, ':root'));
const DARK = { ...LIGHT, ...tokens(block(block(CSS, '@media (prefers-color-scheme: dark)'), ':root')) };

function resolve(value: string, theme: Record<string, string> = LIGHT): string {
  let out = value;
  for (let i = 0; i < 5 && out.includes('var('); i++) {
    out = out.replace(/var\((--[\w-]+)\)/g, (_, name) => {
      assert.ok(theme[name], `${name} is defined`);
      return theme[name];
    });
  }
  return out;
}

/** First length of a value, in CSS px at the default root size. */
function px(value: string): number {
  const m = /(\d*\.?\d+)(px|rem)/.exec(resolve(value));
  assert.ok(m, `"${value}" has a length`);
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
}

function declaration(declarations: string, property: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(declarations)?.[1].trim();
}

/** Declarations of the top-level rules whose selector list names `tag`. */
function rulesFor(tag: string): string[] {
  const named = new RegExp(`(^|[\\s,])${tag}(?![\\w-])`);
  return rules(CSS).filter(([selector]) => named.test(selector)).map(([, body]) => body);
}

function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is a six-digit hex colour`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --- Minimal DOM: runs the shipped script, as tests/review-page.test.ts does --

class Element {
  tag: string;
  children: Element[] = [];
  ownText = '';
  className = '';
  value = '';
  type = '';
  disabled = false;
  hidden = false;
  tabIndex = -1;
  style: Record<string, string> = {};
  id = '';
  classList = { add() {}, remove() {} };
  attrs: Record<string, string> = {};
  events: Record<string, Function> = {};
  scrolls: any[] = [];
  constructor(tag: string) { this.tag = tag; }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  prepend(node: Element) { this.children.unshift(node); }
  replaceChildren(...nodes: Element[]) { this.ownText = ''; this.children = [...nodes]; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(event: string, fn: Function) { this.events[event] = fn; }
  scrollIntoView(options?: unknown) { this.scrolls.push(options); }
  getElementsByTagName(tag: string): Element[] { return nodes(this, (n) => n !== this && n.tag === tag); }
  focus() {}
}

function nodes(root: Element, match: (node: Element) => boolean): Element[] {
  return [...(match(root) ? [root] : []), ...root.children.flatMap((c) => nodes(c, match))];
}
const byTag = (root: Element, tag: string) => nodes(root, (n) => n.tag === tag);

const DIFF = '--- scene @ base\n+++ scene (proposed)\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n';
const PROPOSAL = { proposal: { proposal_id: 'P-1', rationale: 'Reason', status: 'proposed' }, diff: DIFF, applicable: true };
const CLAIM = { claim_id: 'C-1', statement: 'Statement', anchor: { quote: 'Quote' }, source_file: 'scenes/a.md', editorial_status: 'proposed', epistemic_kind: 'narrated_fact', evidence_status: 'valid', extractor: 'x' };
const FINDING = { finding_id: 'F-1', question: 'motivation', kind: 'fact', statement: 's', author: 'a', evidence: [{ file: 'scenes/a.md', quote: 'scene', status: 'valid' }], verdict: { verdict: 'useful', by: 'r', at: '2026-01-01T00:00:00Z' } };
const QUEUE = { scenes: ['scenes/a.md'], proposals: [PROPOSAL], claims: [CLAIM], canon: [], findings: [], finding_views: [FINDING] };

function page(windowExtras: Record<string, unknown> = {}, queue: unknown = QUEUE) {
  const app = new Element('main');
  const context = runInNewContext(REVIEW_JS + '\n({ proposalCard, claimCard, narrativeFindingCard, renderApp, viewportAnchor })', {
    document: {
      getElementById: (id: string) => (id === 'app' ? app : nodes(app, (n) => n.id === id)[0]),
      createElement: (t: string) => new Element(t),
      createTextNode: (t: string) => Object.assign(new Element('#text'), { textContent: t }),
    },
    window: { addEventListener() {}, Clerk: { session: { getToken: async () => 'session' } }, ...windowExtras },
    setTimeout() {},
    fetch: async (url: string) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => (url.endsWith('/books') ? { books: [{ book_id: 'sal', title: 'Sal' }] } : url.includes('/scenes/') ? { file: 'scenes/a.md', text: 'scene', proposals: [PROPOSAL], findings: [FINDING] } : queue),
    }),
  });
  return { ...context, app };
}

// --- Tests -------------------------------------------------------------------

test('the viewport covers the whole screen and never blocks zooming', () => {
  const viewport = /<meta name="viewport" content="([^"]*)">/.exec(reviewHtml('https://clerk.example', 'pk_test'))?.[1] ?? '';
  assert.match(viewport, /width=device-width/);
  assert.match(viewport, /initial-scale=1(?!\d)/);
  // Without it every env(safe-area-inset-*) is zero.
  assert.match(viewport, /viewport-fit=cover/);
  assert.doesNotMatch(viewport, /user-scalable|maximum-scale/);
});

test('text fields are at least 16 px, so iOS does not zoom the page on focus', () => {
  for (const tag of ['input', 'select', 'textarea']) {
    const sizes = rulesFor(tag).map((body) => declaration(body, 'font') ?? declaration(body, 'font-size')).filter((v) => v !== undefined);
    assert.ok(sizes.length > 0, `a rule sets the font of ${tag}`);
    for (const size of sizes) assert.ok(px(size) >= 16, `${tag} font "${size}" is at least 16 px`);
  }
});

test('controls are at least 44 px tall', () => {
  assert.ok(px(LIGHT['--tap']) >= 44);
  for (const tag of ['button', 'select', 'input', 'summary']) {
    assert.ok(rulesFor(tag).some((body) => declaration(body, 'min-height') === 'var(--tap)'), `${tag} is as tall as a tap target`);
  }
});

test('narrow screens get a sticky decision bar that respects the safe area', () => {
  const narrow = rules(block(CSS, '@media (max-width: 40em)'));
  const bar = narrow.find(([selector]) => selector === '.decision')?.[1] ?? '';
  assert.equal(declaration(bar, 'position'), 'sticky');
  assert.equal(declaration(bar, 'bottom'), '0');
  assert.match(bar, /env\(safe-area-inset-bottom\)/);
  // An opaque bar: the text scrolling under it must not show through.
  assert.equal(declaration(bar, 'background'), 'var(--paper)');
  assert.match(CSS, /env\(safe-area-inset-left\)/);
  assert.match(CSS, /env\(safe-area-inset-right\)/);
});

test('only accept and reject live in the decision bar; a text field never does', async () => {
  const ui = page();
  const decision = (card: Element) => nodes(card, (n) => n.className.split(' ').includes('decision'));
  for (const card of [ui.proposalCard('sal', PROPOSAL, async () => {}), ui.claimCard('sal', CLAIM, async () => {})]) {
    const [bar, ...rest] = decision(card);
    assert.ok(bar, 'the card has a decision bar');
    assert.equal(rest.length, 0);
    assert.ok(bar.className.split(' ').includes('actions'), 'the bar keeps the actions class');
    assert.deepEqual(byTag(bar, 'button').map((b) => b.className), ['accept', 'reject']);
    assert.equal(card.children.at(-1), bar, 'the decision comes last, after what is decided');
  }
  const rated = ui.narrativeFindingCard('sal', FINDING, async () => {});
  assert.equal(byTag(rated, 'input').length, 1);
  assert.equal(decision(rated).length, 0);
});

test('colour roles reach WCAG AA in both themes', () => {
  for (const [name, theme] of [['light', LIGHT], ['dark', DARK]] as const) {
    const c = (token: string) => resolve(theme[token], theme);
    const text: Array<[string, string]> = [
      ['--ink', '--paper'], ['--muted', '--paper'], ['--accept', '--paper'], ['--reject', '--paper'],
      // The filled accept button.
      ['--paper', '--accept'],
      // Diff rows: prose in ink, label in the role colour, on the tinted row.
      ['--ink', '--accept-bg'], ['--accept', '--accept-bg'], ['--ink', '--reject-bg'], ['--reject', '--reject-bg'],
      ['--ink', '--mark'], ['--ink', '--pressed'], ['--muted', '--pressed'],
    ];
    for (const [fg, bg] of text) {
      assert.ok(contrast(c(fg), c(bg)) >= 4.5, `${name}: ${fg} on ${bg} is ${contrast(c(fg), c(bg)).toFixed(2)}`);
    }
    // The boundary of a control is not text: 3:1 is enough.
    assert.ok(contrast(c('--edge'), c('--paper')) >= 3, `${name}: --edge on --paper`);
  }
});

test('additions and deletions differ by more than colour', () => {
  const card = page().proposalCard('sal', PROPOSAL, async () => {});
  assert.equal(nodes(card, (n) => n.className === 'diff-label').map((n) => n.textContent).join('|'), '− Eliminado:|+ Añadido:');
  const decoration = (tag: string) => rulesFor(tag).map((body) => declaration(body, 'text-decoration-line')).find(Boolean);
  assert.equal(decoration('del'), 'line-through');
  assert.equal(decoration('ins'), 'underline');
  // Long lines wrap inside the card instead of scrolling sideways.
  const diffBox = rules(CSS).find(([selector]) => selector === '.visual-diff')?.[1] ?? '';
  assert.equal(declaration(diffBox, 'white-space'), 'pre-wrap');
  assert.match(rulesFor('body').join(';'), /overflow-wrap\s*:\s*anywhere/);
});

test('motion is short and can be switched off', async () => {
  const reduced = block(CSS, '@media (prefers-reduced-motion: reduce)');
  assert.match(reduced, /transition\s*:\s*none/);

  for (const [reduce, behavior] of [[true, 'auto'], [false, 'smooth']] as const) {
    const ui = page({ matchMedia: (query: string) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' }) });
    await ui.renderApp('sal', 'scenes/a.md');
    const viewer = nodes(ui.app, (n) => n.className === 'scene-viewer')[0];
    assert.deepEqual(viewer.scrolls.map((s) => s.behavior), [behavior]);
  }
  // A browser without matchMedia keeps the previous behaviour.
  const plain = page();
  await plain.renderApp('sal', 'scenes/a.md');
  assert.deepEqual(nodes(plain.app, (n) => n.className === 'scene-viewer')[0].scrolls.map((s) => s.behavior), ['smooth']);
});

test('the rendered page has labelled controls and no permanent dialog', async () => {
  const html = reviewHtml('https://clerk.example', 'pk_test');
  assert.doesNotMatch(html, /<dialog|role="dialog"|aria-modal/);
  const ui = page();
  await ui.renderApp('sal', 'scenes/a.md');
  // The refresh waits while a dialog is open: one that never closes would stop it for good.
  assert.equal(nodes(ui.app, (n) => n.tag === 'dialog' || n.attrs.role === 'dialog' || 'aria-modal' in n.attrs).length, 0);
  const controls = nodes(ui.app, (n) => n.tag === 'input' || n.tag === 'select');
  assert.ok(controls.length >= 6);
  for (const control of controls) assert.ok(control.attrs['aria-label'], `${control.tag} ${control.type} has a label`);
  assert.match(CSS, /:focus-visible\s*\{[^}]*outline\s*:/);
});

test('a quote that opens its scene works from the keyboard', () => {
  const opened: string[] = [];
  const ui = page();
  const card = ui.narrativeFindingCard('sal', FINDING, async () => {}, (file: string) => opened.push(file));
  const quote = byTag(card, 'blockquote')[0];
  assert.equal(quote.tabIndex, 0);
  const pressed = (key: string) => { let prevented = false; quote.events.keydown({ key, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(pressed('Tab'), false);
  assert.deepEqual(opened, []);
  assert.equal(pressed('Enter'), true);
  assert.equal(pressed(' '), true);
  assert.deepEqual(opened, ['scenes/a.md', 'scenes/a.md']);
  quote.events.click();
  assert.equal(opened.length, 3);
  // Without a scene to open, the quote is plain text.
  const plain = byTag(ui.narrativeFindingCard('sal', FINDING, async () => {}), 'blockquote')[0];
  assert.equal(plain.tabIndex, -1);
  assert.equal(plain.events.keydown, undefined);
});

test('the chosen rating is exposed as pressed, not only drawn', () => {
  const card = page().narrativeFindingCard('sal', FINDING, async () => {});
  const pressed = Object.fromEntries(byTag(card, 'button').map((b) => [b.textContent, b.attrs['aria-pressed']]));
  assert.deepEqual(pressed, { 'Me ayuda': 'true', Ruido: 'false' });
});

// --- Navigating a long page with one thumb -----------------------------------

const PHONE = { matchMedia: (query: string) => ({ matches: query === '(max-width: 40em)' }) };
const DECIDED = { proposal: { proposal_id: 'P-2', rationale: 'Earlier', status: 'accepted', result_commit: 'abcdef123456' }, diff: DIFF, applicable: false };
const CANONICAL = { ...CLAIM, claim_id: 'C-2', editorial_status: 'accepted' };
const FULL = { ...QUEUE, proposals: [PROPOSAL, DECIDED], claims: [CLAIM, CANONICAL], canon: [CANONICAL] };
const PENDING_TITLES = ['Cambios propuestos', 'Hallazgos de la trama', 'Posibles problemas', 'Afirmaciones por revisar'];
const REFERENCE_TITLES = ['Importar escenas Markdown', 'Importar desde Notion', 'Navegar escenas', 'Canon', 'Afirmaciones fuera del Canon', 'Afirmaciones rechazadas', 'Historial de cambios del manuscrito'];

const sectionOf = (app: Element, title: string) => nodes(app, (n) => n.tag === 'section' && byTag(n, 'h2')[0]?.textContent === title)[0];
const foldOf = (section: Element) => nodes(section, (n) => n.className === 'fold')[0];
const bodyOf = (section: Element) => nodes(section, (n) => n.className === 'fold-body')[0];
const unfolded = (app: Element) => [...PENDING_TITLES, ...REFERENCE_TITLES].filter((title) => foldOf(sectionOf(app, title)).attrs['aria-expanded'] === 'true');

test('what waits for a decision comes before tools and reference', async () => {
  const ui = page();
  await ui.renderApp('sal');
  assert.deepEqual(byTag(ui.app, 'h2').map((h) => h.textContent), ['Crear un nuevo libro', ...PENDING_TITLES, ...REFERENCE_TITLES]);
});

test('the section navigation is a landmark with pending counts and one current link', async () => {
  const ui = page();
  await ui.renderApp('sal');
  const [nav, ...others] = byTag(ui.app, 'nav');
  assert.equal(others.length, 0);
  assert.equal(nav.attrs['aria-label'], 'Secciones');
  const links = byTag(nav, 'a');
  assert.deepEqual(links.map((a) => a.children[0].textContent), ['Cambios', 'Hallazgos', 'Problemas', 'Afirmaciones', 'Importar', 'Escenas', 'Canon', 'Historial']);
  // One pending proposal and one pending claim; the only finding is already rated.
  assert.deepEqual(links.map((a) => a.attrs['aria-label']), [
    'Cambios propuestos: 1 pendiente', 'Hallazgos de la trama', 'Posibles problemas', 'Afirmaciones por revisar: 1 pendiente',
    'Importar escenas Markdown', 'Navegar escenas', 'Canon', 'Historial de cambios del manuscrito',
  ]);
  assert.deepEqual(links.map((a) => nodes(a, (n) => n.className === 'count')[0]).map((c) => (c.hidden ? '' : c.textContent)), ['1', '', '', '1', '', '', '', '']);
  for (const link of links) {
    const target = nodes(ui.app, (n) => '#' + n.id === (link as any).href)[0];
    assert.equal(target?.tag, 'section', `${(link as any).href} is a section of the page`);
  }
  assert.deepEqual(links.map((a) => a.attrs['aria-current']), ['location', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
});

test('on a phone tools and reference start folded, and a choice survives a re-render', async () => {
  const desktop = page({}, FULL);
  await desktop.renderApp('sal');
  assert.deepEqual(unfolded(desktop.app), [...PENDING_TITLES, ...REFERENCE_TITLES]);

  const ui = page(PHONE, FULL);
  await ui.renderApp('sal');
  // Empty reference sections stay open: they are one line.
  assert.deepEqual(unfolded(ui.app), [...PENDING_TITLES, 'Afirmaciones fuera del Canon', 'Afirmaciones rechazadas']);
  for (const title of [...PENDING_TITLES, ...REFERENCE_TITLES]) {
    const section = sectionOf(ui.app, title);
    assert.equal(bodyOf(section).hidden, foldOf(section).attrs['aria-expanded'] !== 'true', title);
    assert.ok(bodyOf(section).id);
    assert.equal(foldOf(section).attrs['aria-controls'], bodyOf(section).id);
    // Folded, not removed: the form is still in the page.
    assert.equal(section.children.length, 2);
  }
  assert.equal(byTag(bodyOf(sectionOf(ui.app, 'Importar desde Notion')), 'input').length, 1);

  foldOf(sectionOf(ui.app, 'Historial de cambios del manuscrito')).events.click();
  foldOf(sectionOf(ui.app, 'Cambios propuestos')).events.click();
  const chosen = [...PENDING_TITLES.slice(1), 'Afirmaciones fuera del Canon', 'Afirmaciones rechazadas', 'Historial de cambios del manuscrito'];
  assert.deepEqual(unfolded(ui.app), chosen);
  assert.equal(bodyOf(sectionOf(ui.app, 'Cambios propuestos')).hidden, true);
  await ui.renderApp('sal');
  assert.deepEqual(unfolded(ui.app), chosen);
});

test('a section with nothing in it says so in one line, and an empty book opens its import form', async () => {
  const ui = page(PHONE, { ...QUEUE, scenes: [], proposals: [] });
  await ui.renderApp('sal');
  assert.equal(sectionOf(ui.app, 'Cambios propuestos').textContent, 'Cambios propuestos' + 'Ningún cambio pendiente.');
  assert.equal(sectionOf(ui.app, 'Canon').textContent, 'Canon' + 'El canon está vacío.');
  assert.deepEqual(unfolded(ui.app).filter((title) => title.startsWith('Importar') || title === 'Navegar escenas'), ['Importar escenas Markdown', 'Navegar escenas']);
});

test('a navigation link unfolds its section and goes there without touching the address', async () => {
  const ui = page(PHONE, FULL);
  await ui.renderApp('sal');
  const link = byTag(byTag(ui.app, 'nav')[0], 'a').find((a) => a.children[0].textContent === 'Historial')!;
  const section = sectionOf(ui.app, 'Historial de cambios del manuscrito');
  let prevented = false;
  link.events.click({ preventDefault() { prevented = true; } });
  // Clerk's components route through the hash.
  assert.equal(prevented, true);
  assert.equal(foldOf(section).attrs['aria-expanded'], 'true');
  assert.equal(bodyOf(section).hidden, false);
  assert.equal(section.scrolls.length, 1);
  assert.deepEqual(byTag(ui.app, 'a').filter((a) => a.attrs['aria-current'] === 'location'), [link]);
});

test('a quote opens its scene even when the scene list is folded', async () => {
  const ui = page(PHONE, { ...FULL, finding_views: [{ ...FINDING, verdict: undefined }] });
  await ui.renderApp('sal');
  const scenes = sectionOf(ui.app, 'Navegar escenas');
  assert.equal(bodyOf(scenes).hidden, true);
  byTag(sectionOf(ui.app, 'Hallazgos de la trama'), 'blockquote')[0].events.click();
  assert.equal(bodyOf(scenes).hidden, false);
  assert.equal(foldOf(scenes).attrs['aria-expanded'], 'true');
});

test('the navigation bar sticks to the top, scrolls sideways and leaves room for what it would cover', () => {
  const rule = (css: string, selector: string) => rules(css).find(([s]) => s === selector)?.[1] ?? '';
  const bar = rule(CSS, '.section-nav');
  assert.equal(declaration(bar, 'position'), 'sticky');
  assert.equal(declaration(bar, 'top'), '0');
  assert.equal(declaration(bar, 'background'), 'var(--paper)');
  assert.match(bar, /env\(safe-area-inset-top\)/);
  assert.equal(declaration(rule(CSS, '.section-nav ul'), 'overflow-x'), 'auto');
  assert.equal(declaration(rule(CSS, '.section-nav a'), 'min-height'), 'var(--tap)');
  assert.equal(declaration(rule(CSS, '.fold'), 'min-height'), 'var(--tap)');
  assert.ok(px(LIGHT['--nav-h']) >= 44);
  // A jump lands below the bar; the error and the notice float below it too.
  assert.match(declaration(rule(CSS, 'section, article, .scene-viewer'), 'scroll-margin-top') ?? '', /var\(--nav-h\)/);
  assert.match(declaration(rule(CSS, 'main:has(> .section-nav) > [role=alert]:first-child'), 'top') ?? '', /var\(--nav-h\)/);
  assert.match(declaration(rule(CSS, '.notice'), 'top') ?? '', /var\(--nav-h\)/);
  // Wide screens: a side column, so nothing is covered at the top.
  const wide = block(CSS, '@media (min-width: 75em)');
  assert.equal(declaration(rule(wide, '.section-nav'), 'position'), 'fixed');
  assert.equal(tokens(block(wide, ':root'))['--nav-h'], '0px');
});

test('the refresh anchor is a card on screen, never one inside a folded section', () => {
  const ui = page();
  const card = (id: string, top: number, shown: boolean) => Object.assign(new Element('article'), { id, offsetParent: shown ? ui.app : null, getBoundingClientRect: () => ({ top }) });
  // A card without a box reports top 0, like the first card on screen would.
  ui.app.append(card('above', -300, true), card('folded', 0, false), card('reading', 120, true));
  assert.deepEqual({ ...ui.viewportAnchor() }, { id: 'reading', top: 120 });
});
