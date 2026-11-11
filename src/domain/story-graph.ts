/**
 * Links between notes and scenes, backlinks, and the story graph with its operations. Pure: it
 * works on texts it is given, with no files, no git and no dependencies. Every list it returns has a
 * fixed order, so the same book always gives the same answer.
 */
import { parseFrontmatter } from './note.ts';
import { codeRanges, foldName, foldWithMap, lineStartsOf, parseWikilinks, positionAt, type Wikilink } from './wikilink.ts';

/** The texts of a book: notes by name, scenes in reading order. */
export interface BookText {
  notes: { name: string; text: string }[];
  scenes: { file: string; text: string }[];
}

export type Resolution =
  | { status: 'resolved'; note: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unresolved' };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Finds the note a link names. Names and aliases are compared folded (see foldName). A note name
 * wins over another note's alias; two notes matching the same way are ambiguous, never a guess.
 */
export class NoteIndex {
  private readonly names = new Map<string, string[]>();
  private readonly aliases = new Map<string, string[]>();

  constructor(notes: { name: string; aliases: string[] }[]) {
    const add = (map: Map<string, string[]>, key: string, name: string) => {
      if (!key) return;
      const list = map.get(key) ?? [];
      if (!list.includes(name)) list.push(name);
      map.set(key, list);
    };
    for (const note of notes) {
      add(this.names, foldName(note.name), note.name);
      for (const alias of note.aliases) add(this.aliases, foldName(alias), note.name);
    }
  }

  resolve(target: string): Resolution {
    const key = foldName(target);
    for (const map of [this.names, this.aliases]) {
      const found = [...(map.get(key) ?? [])].sort(byCodeUnit);
      if (found.length === 1) return { status: 'resolved', note: found[0] };
      if (found.length > 1) return { status: 'ambiguous', candidates: found };
    }
    return { status: 'unresolved' };
  }
}

export interface NoteInfo {
  name: string;
  type: string | null;
  aliases: string[];
  /** Frontmatter keys that could not be read, in words for the person. */
  problems: string[];
}

export type SourceKind = 'note' | 'scene';
export interface LinkRef extends Wikilink {
  source_kind: SourceKind;
  /** The note name or the scene path the link is written in. */
  source: string;
  resolution: Resolution;
}

interface Source { kind: SourceKind; id: string; text: string; bodyStart: number }

/**
 * The work cap: a note or scene longer than this, in UTF-16 code units, is not parsed and is reported
 * in `too_large`, so one text cannot hold the server. It is twice the largest scene a person can save.
 */
export const MAX_ANALYSED_CHARS = 2_097_152;

export interface Analysis {
  notes: NoteInfo[];
  /** Scene paths in reading order. */
  scenes: string[];
  index: NoteIndex;
  links: LinkRef[];
  unresolved: LinkRef[];
  ambiguous: (LinkRef & { candidates: string[] })[];
  /** Texts over MAX_ANALYSED_CHARS: their links and mentions are not counted. */
  too_large: { source_kind: SourceKind; source: string; chars: number }[];
  sources: Source[];
}

/** Reads every note's frontmatter and every link, and resolves each link against the notes. */
export function analyseBook(book: BookText): Analysis {
  const notes = [...book.notes].sort((a, b) => byCodeUnit(a.name, b.name));
  const sources: Source[] = [];
  const tooLarge: Analysis['too_large'] = [];
  const infos: NoteInfo[] = notes.map((note) => {
    if (note.text.length > MAX_ANALYSED_CHARS) {
      tooLarge.push({ source_kind: 'note', source: note.name, chars: note.text.length });
      return { name: note.name, type: null, aliases: [], problems: ['the note is too large to analyse'] };
    }
    const front = parseFrontmatter(note.text);
    sources.push({ kind: 'note', id: note.name, text: note.text, bodyStart: front.body_start });
    return { name: note.name, type: front.type, aliases: front.aliases, problems: front.problems };
  });
  for (const scene of book.scenes) {
    if (scene.text.length > MAX_ANALYSED_CHARS) tooLarge.push({ source_kind: 'scene', source: scene.file, chars: scene.text.length });
    else sources.push({ kind: 'scene', id: scene.file, text: scene.text, bodyStart: 0 });
  }
  const index = new NoteIndex(infos);
  const links: LinkRef[] = [];
  for (const source of sources) {
    for (const link of parseWikilinks(source.text)) {
      if (link.start < source.bodyStart) continue;
      links.push({ ...link, source_kind: source.kind, source: source.id, resolution: index.resolve(link.target) });
    }
  }
  return {
    notes: infos,
    scenes: book.scenes.map((scene) => scene.file),
    index,
    links,
    unresolved: links.filter((link) => link.resolution.status === 'unresolved'),
    ambiguous: links.flatMap((link) => (link.resolution.status === 'ambiguous' ? [{ ...link, candidates: link.resolution.candidates }] : [])),
    too_large: tooLarge,
    sources,
  };
}

/** The longest context returned around a mention, in UTF-16 code units, before the two ellipses. */
export const MAX_CONTEXT = 240;
/** The most mentions of each kind backlinks returns; the totals count them all. */
export const MAX_BACKLINKS = 500;

const TERMINATOR = /[.!?…]/;
const SPACE = /\s/;

/** Where sentences start and end in one text, found in one pass and reused for every mention in it. */
interface Sentences { starts: number[]; terminatorEnds: number[]; breaks: number[]; lines: number[] }
const sentenceCache = new WeakMap<Source, Sentences>();

function sentencesOf(source: Source): Sentences {
  let found = sentenceCache.get(source);
  if (found) return found;
  const text = source.text;
  found = { starts: [0], terminatorEnds: [], breaks: [], lines: lineStartsOf(text) };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      found.breaks.push(i);
      if (ch === '\n') found.starts.push(i + 1);
    } else if (TERMINATOR.test(ch)) {
      const followed = i + 1 === text.length || SPACE.test(text[i + 1]);
      if (followed) found.terminatorEnds.push(i + 1);
      if (followed && i + 1 < text.length) found.starts.push(i + 1);
    }
  }
  sentenceCache.set(source, found);
  return found;
}

/** The last value <= x in a sorted list, or the first value >= x; -1 / Infinity when there is none. */
function lastAtMost(list: number[], x: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) { const mid = (low + high) >> 1; if (list[mid] <= x) low = mid + 1; else high = mid; }
  return low === 0 ? -1 : list[low - 1];
}
function firstAtLeast(list: number[], x: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) { const mid = (low + high) >> 1; if (list[mid] < x) low = mid + 1; else high = mid; }
  return low === list.length ? Infinity : list[low];
}

/**
 * The sentence holding `[start, end)`: from the previous sentence end (`.`, `!`, `?` or `…` before
 * a space) or line break to the next one, cut around the mention with `…` when it is longer than
 * MAX_CONTEXT.
 */
function sentenceRange(source: Source, start: number, end: number): [number, number] {
  const text = source.text;
  const sentences = sentencesOf(source);
  let from = Math.max(0, lastAtMost(sentences.starts, start));
  const to = Math.min(text.length, firstAtLeast(sentences.terminatorEnds, end + 1), firstAtLeast(sentences.breaks, end));
  while (from < start && SPACE.test(text[from])) from += 1;
  return [from, to];
}

function contextOf(source: Source, start: number, end: number): string {
  const text = source.text;
  const [from, to] = sentenceRange(source, start, end);
  if (to - from <= MAX_CONTEXT) return text.slice(from, to);
  const room = Math.max(0, MAX_CONTEXT - (end - start));
  let left = Math.max(from, start - Math.floor(room / 2));
  let right = Math.min(to, left + Math.max(MAX_CONTEXT, end - start));
  left = Math.max(from, right - Math.max(MAX_CONTEXT, end - start));
  // Never cut a surrogate pair in half.
  if (left > from && /[\uDC00-\uDFFF]/.test(text[left])) left += 1;
  if (right < to && /[\uDC00-\uDFFF]/.test(text[right])) right -= 1;
  return `${left > from ? '…' : ''}${text.slice(left, right)}${right < to ? '…' : ''}`;
}

/** Exported for tests: the context of a mention in a plain text. */
export function sentenceAround(text: string, start: number, end: number): string {
  return contextOf({ kind: 'scene', id: '', text, bodyStart: 0 }, start, end);
}

export interface Mention {
  source_kind: SourceKind;
  source: string;
  line: number;
  column: number;
  context: string;
}

export interface Backlinks {
  note: string;
  /** At most MAX_BACKLINKS, in order; linked_total counts them all. */
  linked: (Mention & { raw: string })[];
  linked_total: number;
  /** The note's name or an alias as plain text: whole words, folded like names, outside links and code. */
  unlinked: (Mention & { text: string })[];
  unlinked_total: number;
}

/** Linked and unlinked mentions of one note, notes first (by name), then scenes in reading order. */
export function backlinks(analysis: Analysis, name: string): Backlinks {
  const info = analysis.notes.find((note) => note.name === name);
  if (!info) throw new Error(`unknown note: ${name}`);
  const byId = new Map(analysis.sources.map((source) => [`${source.kind}\u0000${source.id}`, source]));
  const resolved = analysis.links.filter((link) => link.resolution.status === 'resolved' && link.resolution.note === name);
  const linked = resolved.slice(0, MAX_BACKLINKS).map((link) => {
    const source = byId.get(`${link.source_kind}\u0000${link.source}`)!;
    return { source_kind: link.source_kind, source: link.source, line: link.line, column: link.column, raw: link.raw, context: contextOf(source, link.start, link.end) };
  });
  const terms = [...new Set([info.name, ...info.aliases].map(foldName).filter(Boolean))];
  const unlinked: Backlinks['unlinked'] = [];
  let unlinkedTotal = 0;
  for (const source of analysis.sources) {
    if (source.kind === 'note' && source.id === name) continue;
    const mentions = plainMentions(source, terms);
    unlinkedTotal += mentions.length;
    for (const [start, end] of mentions) {
      if (unlinked.length >= MAX_BACKLINKS) break;
      const { line, column } = positionAt(sentencesOf(source).lines, start);
      unlinked.push({ source_kind: source.kind, source: source.id, line, column, text: source.text.slice(start, end), context: contextOf(source, start, end) });
    }
  }
  return { note: name, linked, linked_total: resolved.length, unlinked, unlinked_total: unlinkedTotal };
}

const WORD = /[\p{L}\p{N}_]/u;

function plainMentions(source: Source, terms: string[]): [number, number][] {
  const raw = codeRanges(source.text);
  for (const match of source.text.matchAll(/!?\[\[[^[\]\r\n]*\]\]/g)) raw.push([match.index, match.index + match[0].length]);
  raw.sort((a, b) => a[0] - b[0]);
  // Disjoint, sorted exclusions, checked by binary search.
  const starts: number[] = [];
  const ends: number[] = [];
  for (const [s, e] of raw) {
    if (ends.length && s <= ends[ends.length - 1]) ends[ends.length - 1] = Math.max(ends[ends.length - 1], e);
    else { starts.push(s); ends.push(e); }
  }
  const excluded = (start: number, end: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) { const mid = (low + high) >> 1; if (starts[mid] < end) low = mid + 1; else high = mid; }
    return low > 0 && ends[low - 1] > start;
  };
  const { folded, at } = foldWithMap(source.text);
  const found: [number, number][] = [];
  for (const term of terms) {
    for (let k = folded.indexOf(term); k !== -1; k = folded.indexOf(term, k + 1)) {
      const after = k + term.length;
      if ((k > 0 && WORD.test(folded[k - 1])) || (after < folded.length && WORD.test(folded[after]))) continue;
      const start = at[k];
      const end = at[after];
      if (start < source.bodyStart || excluded(start, end)) continue;
      found.push([start, end]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept: [number, number][] = [];
  for (const range of found) if (!kept.length || range[0] >= kept[kept.length - 1][1]) kept.push(range);
  return kept;
}

export type NodeKind = 'note' | 'scene';
export type EdgeKind = 'mention' | 'link' | 'cooccurs';
export interface GraphNode {
  /** `note:<name>` or `scene:<path>`. */
  id: string;
  kind: NodeKind;
  name: string;
  type: string | null;
  /** 1-based reading position of a scene; null for notes. */
  order: number | null;
}
export interface GraphEdge {
  kind: EdgeKind;
  from: string;
  to: string;
  /** mention and link: how many links; cooccurs: how many scenes the two notes share. */
  weight: number;
  /** cooccurs only, and only with the `paragraphs` option: how many scene paragraphs the two notes share. */
  paragraphs?: number;
}
export interface StoryGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export const noteNode = (name: string) => `note:${name}`;
export const sceneNode = (file: string) => `scene:${file}`;

export interface GraphOptions {
  /** Add to every cooccurs edge the finer weight `paragraphs`: the scene paragraphs the two notes share. */
  paragraphs?: boolean;
}

/**
 * Notes and scenes as nodes, with typed edges: `mention` (scene to note), `link` (note to note,
 * self-links left out) and `cooccurs` (two notes mentioned in the same scene, from the smaller id to
 * the larger). With `asOfScene`, scenes after it in reading order, and the edges they bring, are
 * left out; notes and links between notes are always kept. A paragraph is a run of lines with text:
 * lines that are empty or hold only spaces separate paragraphs.
 */
export function buildGraph(analysis: Analysis, asOfScene?: string, options: GraphOptions = {}): StoryGraph {
  let scenes = analysis.scenes;
  if (asOfScene !== undefined) {
    const last = scenes.indexOf(asOfScene);
    if (last === -1) throw new Error(`unknown scene: ${asOfScene}`);
    scenes = scenes.slice(0, last + 1);
  }
  const kept = new Set(scenes);
  const nodes: GraphNode[] = [
    ...analysis.notes.map((note) => ({ id: noteNode(note.name), kind: 'note' as const, name: note.name, type: note.type, order: null })),
    ...scenes.map((file, i) => ({ id: sceneNode(file), kind: 'scene' as const, name: file, type: null, order: i + 1 })),
  ].sort((a, b) => byCodeUnit(a.id, b.id));

  const weights = new Map<string, GraphEdge>();
  const bump = (kind: EdgeKind, from: string, to: string) => {
    const key = `${kind}\u0000${from}\u0000${to}`;
    const edge = weights.get(key) ?? { kind, from, to, weight: 0 };
    edge.weight += 1;
    weights.set(key, edge);
  };
  const mentioned = new Map<string, Set<string>>();
  // With the paragraph option: the notes of each paragraph, keyed by scene and paragraph number.
  const inParagraph = new Map<string, Set<string>>();
  const paragraphsOf = new Map(analysis.sources.filter((source) => source.kind === 'scene').map((source) => [source.id, source]));
  for (const link of analysis.links) {
    if (link.resolution.status !== 'resolved') continue;
    const target = link.resolution.note;
    if (link.source_kind === 'note') {
      if (link.source !== target) bump('link', noteNode(link.source), noteNode(target));
    } else if (kept.has(link.source)) {
      bump('mention', sceneNode(link.source), noteNode(target));
      mentioned.set(link.source, (mentioned.get(link.source) ?? new Set()).add(noteNode(target)));
      if (options.paragraphs) {
        const key = `${link.source}\u0000${paragraphNumbers(paragraphsOf.get(link.source)!)[link.line - 1]}`;
        inParagraph.set(key, (inParagraph.get(key) ?? new Set()).add(noteNode(target)));
      }
    }
  }
  for (const notes of mentioned.values()) {
    const list = [...notes].sort(byCodeUnit);
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) bump('cooccurs', list[i], list[j]);
  }
  if (options.paragraphs) {
    for (const edge of weights.values()) if (edge.kind === 'cooccurs') edge.paragraphs = 0;
    for (const notes of inParagraph.values()) {
      const list = [...notes].sort(byCodeUnit);
      for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) weights.get(`cooccurs\u0000${list[i]}\u0000${list[j]}`)!.paragraphs! += 1;
    }
  }
  const edges = [...weights.values()].sort((a, b) => byCodeUnit(a.kind, b.kind) || byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to));
  return { nodes, edges };
}

const paragraphCache = new WeakMap<Source, number[]>();

/** The paragraph number of each line of a text (0-based lines): it grows at each line with text after a blank line. */
function paragraphNumbers(source: Source): number[] {
  let found = paragraphCache.get(source);
  if (found) return found;
  found = [];
  let paragraph = 0;
  let seenText = false;
  let blankBefore = false;
  for (const line of source.text.split('\n')) {
    if (line.trim() === '') blankBefore = true;
    else {
      if (seenText && blankBefore) paragraph += 1;
      seenText = true;
      blankBefore = false;
    }
    found.push(paragraph);
  }
  paragraphCache.set(source, found);
  return found;
}

const adjacencies = new WeakMap<StoryGraph, Map<string, string[]>>();

/** Neighbours of every node, ignoring edge direction and kind, sorted. */
function adjacency(graph: StoryGraph): Map<string, string[]> {
  let map = adjacencies.get(graph);
  if (map) return map;
  const sets = new Map<string, Set<string>>(graph.nodes.map((node) => [node.id, new Set()]));
  for (const edge of graph.edges) {
    sets.get(edge.from)?.add(edge.to);
    sets.get(edge.to)?.add(edge.from);
  }
  map = new Map([...sets].map(([id, set]) => [id, [...set].sort(byCodeUnit)]));
  adjacencies.set(graph, map);
  return map;
}

function nodeOf(graph: StoryGraph, id: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`unknown node: ${id}`);
  return node;
}

function distances(graph: StoryGraph, from: string, depth = Infinity): Map<string, { distance: number; parent: string | null }> {
  const adj = adjacency(graph);
  const seen = new Map<string, { distance: number; parent: string | null }>([[from, { distance: 0, parent: null }]]);
  let frontier = [from];
  for (let d = 1; d <= depth && frontier.length; d += 1) {
    const next: string[] = [];
    for (const id of frontier) for (const other of adj.get(id) ?? []) {
      if (seen.has(other)) continue;
      seen.set(other, { distance: d, parent: id });
      next.push(other);
    }
    frontier = next;
  }
  return seen;
}

/** The nodes within `depth` steps of a node (itself at 0), by distance then id, and the edges among them. */
export function neighbors(graph: StoryGraph, id: string, depth: number): { center: string; nodes: (GraphNode & { distance: number })[]; edges: GraphEdge[] } {
  nodeOf(graph, id);
  const reached = distances(graph, id, depth);
  const nodes = graph.nodes
    .filter((node) => reached.has(node.id))
    .map((node) => ({ ...node, distance: reached.get(node.id)!.distance }))
    .sort((a, b) => a.distance - b.distance || byCodeUnit(a.id, b.id));
  return { center: id, nodes, edges: graph.edges.filter((edge) => reached.has(edge.from) && reached.has(edge.to)) };
}

/** A shortest path (fewest steps, any edge, either direction) as node ids, or null when none exists. */
export function shortestPath(graph: StoryGraph, from: string, to: string): string[] | null {
  nodeOf(graph, from);
  nodeOf(graph, to);
  const reached = distances(graph, from);
  if (!reached.has(to)) return null;
  const path = [to];
  for (let at = reached.get(to)!.parent; at !== null; at = reached.get(at)!.parent) path.unshift(at);
  return path;
}

/** Nodes by degree (distinct neighbours), highest first, then by id; optionally only one kind. */
export function central(graph: StoryGraph, kind?: NodeKind): (GraphNode & { degree: number })[] {
  const adj = adjacency(graph);
  return graph.nodes
    .filter((node) => kind === undefined || node.kind === kind)
    .map((node) => ({ ...node, degree: adj.get(node.id)!.length }))
    .sort((a, b) => b.degree - a.degree || byCodeUnit(a.id, b.id));
}

/** Connected components as sorted id lists, largest first, then by their first id. */
export function components(graph: StoryGraph): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    const part = [...distances(graph, node.id).keys()].sort(byCodeUnit);
    part.forEach((id) => seen.add(id));
    result.push(part);
  }
  return result.sort((a, b) => b.length - a.length || byCodeUnit(a[0], b[0]));
}

/** Notes with no edge at all: no scene mentions them and they link to no note and no note to them. */
export function orphans(graph: StoryGraph): GraphNode[] {
  const adj = adjacency(graph);
  return graph.nodes.filter((node) => node.kind === 'note' && adj.get(node.id)!.length === 0);
}

export interface LinkAnchor {
  note: string;
  line: number;
  column: number;
  /** The mention as written. */
  text: string;
  /** Its sentence for reading, cut with … when long. */
  context: string;
  /** An exact passage that appears once in the note: what propose_revision's `find` takes. */
  find: string;
  /** `find` with the mention turned into a link to the other note. */
  replace: string;
}

/** The half-widths tried, in UTF-16 code units, when a mention's sentence is too long or repeated. */
const ANCHOR_WINDOWS = [0, 20, 40, 80, 120];

/**
 * Plain-text mentions of note `ofNote` (its name or an alias, whole words, outside links and code) in
 * the body of note `inNote`, as anchors for a link: each with a `find` that is an exact passage
 * appearing exactly once in the note (its sentence when that is short and unique, else the smallest
 * window around the mention, widened to whole words within its line, that is unique, never cut
 * with an ellipsis) and the `replace` that links it. Mentions with no unique passage are counted in
 * `mentions` but give no anchor. `budget.left` is the text, in UTF-16 code units, the call may still
 * scan; when a note does not fit, nothing is scanned and `unchecked` is true.
 */
export function linkAnchors(analysis: Analysis, inNote: string, ofNote: string, max = 3, budget = { left: Infinity }): { mentions: number; unchecked: boolean; anchors: LinkAnchor[] } {
  const info = analysis.notes.find((note) => note.name === ofNote);
  if (!info) throw new Error(`unknown note: ${ofNote}`);
  const source = analysis.sources.find((s) => s.kind === 'note' && s.id === inNote);
  if (!source) return { mentions: 0, unchecked: false, anchors: [] };
  const text = source.text;
  if (budget.left < text.length) return { mentions: 0, unchecked: true, anchors: [] };
  budget.left -= text.length;
  const unique = (from: number, to: number) => {
    const passage = text.slice(from, to);
    const first = text.indexOf(passage);
    budget.left -= 2 * text.length;
    return text.indexOf(passage, first + 1) === -1;
  };
  const terms = [...new Set([info.name, ...info.aliases].map(foldName).filter(Boolean))];
  const mentions = plainMentions(source, terms);
  const lines = sentencesOf(source).lines;
  const anchors: LinkAnchor[] = [];
  for (const [start, end] of mentions) {
    if (anchors.length >= max) break;
    if (budget.left < 0) return { mentions: mentions.length, unchecked: true, anchors };
    const [sentenceFrom, sentenceTo] = sentenceRange(source, start, end);
    let found: [number, number] | null = sentenceTo - sentenceFrom <= MAX_CONTEXT && unique(sentenceFrom, sentenceTo) ? [sentenceFrom, sentenceTo] : null;
    const { line } = positionAt(lines, start);
    const lineFrom = lines[line - 1];
    const lineEnd = text.indexOf('\n', start);
    const lineTo = lineEnd === -1 ? text.length : lineEnd;
    for (const half of ANCHOR_WINDOWS) {
      if (found) break;
      let from = Math.max(lineFrom, start - half);
      let to = Math.min(lineTo, end + half);
      // Widen to whole words, so a passage never starts or ends inside a word (or a surrogate pair).
      while (from > lineFrom && !SPACE.test(text[from - 1])) from -= 1;
      while (to < lineTo && !SPACE.test(text[to])) to += 1;
      if (to - from <= MAX_CONTEXT && unique(from, to)) found = [from, to];
    }
    if (!found) continue;
    const written = text.slice(start, end);
    const link = written === info.name ? `[[${info.name}]]` : `[[${info.name}|${written}]]`;
    const find = text.slice(found[0], found[1]);
    anchors.push({
      note: inNote, line, column: start - lineFrom + 1, text: written, context: contextOf(source, start, end),
      find, replace: `${text.slice(found[0], start)}${link}${text.slice(end, found[1])}`,
    });
  }
  return { mentions: mentions.length, unchecked: false, anchors };
}

/** What knowsEdges reads from a claim: the fields of a stored claim it needs, nothing else. */
export interface KnowledgeClaim {
  claim_id: string;
  subject: string;
  source_file: string;
  editorial_status: string;
  story_time?: number;
  knowledge?: { holder: string; fact: string; mode: 'displays' | 'acquires' | 'hears' };
}
export interface KnowsEdge {
  kind: 'knows';
  /** The note of the character who knows (the claim's knowledge.holder). */
  from: string;
  /** The note the knowledge is about (the claim's subject). */
  to: string;
  mode: 'displays' | 'acquires' | 'hears';
  fact: string;
  /** The scene whose text establishes it: the claim's source_file. */
  scene: string;
  claim_id: string;
  story_time: number | null;
  editorial_status: string;
}
export interface KnowsProblem { claim_id: string; role: 'holder' | 'subject'; name: string; scene: string }

/**
 * Who knows what, as edges between notes: one `knows` edge per claim with knowledge that is not
 * rejected, from the holder's note to the subject's note. Holder and subject are free text, resolved
 * like a wikilink (name, then alias, folded); a name that matches no note or several is reported in
 * `unresolved` or `ambiguous` and gives no edge. With `asOfScene`, only claims whose scene is at or
 * before it in reading order count, problems included. Claims on a scene that no longer exists are
 * left out. Edges come in reading order of their scene, then by claim id.
 */
export function knowsEdges(analysis: Analysis, claims: KnowledgeClaim[], asOfScene?: string): { edges: KnowsEdge[]; unresolved: KnowsProblem[]; ambiguous: (KnowsProblem & { candidates: string[] })[] } {
  let scenes = analysis.scenes;
  if (asOfScene !== undefined) {
    const last = scenes.indexOf(asOfScene);
    if (last === -1) throw new Error(`unknown scene: ${asOfScene}`);
    scenes = scenes.slice(0, last + 1);
  }
  const position = new Map(scenes.map((file, i) => [file, i]));
  const kept = claims
    .filter((claim) => claim.knowledge && claim.editorial_status !== 'rejected' && position.has(claim.source_file))
    .sort((a, b) => position.get(a.source_file)! - position.get(b.source_file)! || byCodeUnit(a.claim_id, b.claim_id));
  const edges: KnowsEdge[] = [];
  const unresolved: KnowsProblem[] = [];
  const ambiguous: (KnowsProblem & { candidates: string[] })[] = [];
  for (const claim of kept) {
    const knowledge = claim.knowledge!;
    const ends: string[] = [];
    for (const [role, name] of [['holder', knowledge.holder], ['subject', claim.subject]] as const) {
      const found = analysis.index.resolve(name);
      const problem = { claim_id: claim.claim_id, role, name, scene: claim.source_file };
      if (found.status === 'resolved') ends.push(noteNode(found.note));
      else if (found.status === 'ambiguous') ambiguous.push({ ...problem, candidates: found.candidates });
      else unresolved.push(problem);
    }
    if (ends.length < 2) continue;
    edges.push({
      kind: 'knows', from: ends[0], to: ends[1], mode: knowledge.mode, fact: knowledge.fact, scene: claim.source_file,
      claim_id: claim.claim_id, story_time: claim.story_time ?? null, editorial_status: claim.editorial_status,
    });
  }
  return { edges, unresolved, ambiguous };
}

/**
 * The most steps betweenness or link suggestions may take on one graph. Betweenness costs about
 * nodes × (nodes + edges) steps and suggestions the sum of each neighbour's degree squared; above
 * this the call is refused with GraphTooLargeError instead of holding the single-threaded server.
 */
export const MAX_GRAPH_WORK = 25_000_000;

export class GraphTooLargeError extends Error {
  constructor(operation: string, nodes: number, edges: number) {
    super(`the graph is too large for ${operation} (${nodes} nodes, ${edges} edges); use degree or pagerank instead`);
    this.name = 'GraphTooLargeError';
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * PageRank of every node, in node order, rounded to six decimals. Edges point the way they are
 * written (link: note to note, mention: scene to note) and co-occurrence points both ways; parallel
 * edges count once. Damping 0.85; a node with no outgoing edge spreads its rank over every node.
 * At most 100 iterations of O(nodes + edges) each, stopping earlier once the ranks settle.
 */
export function pageRank(graph: StoryGraph, damping = 0.85): Map<string, number> {
  const ids = graph.nodes.map((node) => node.id);
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  // Outgoing arcs as one flat list per node (CSR), each distinct (from, to) once.
  const seen = new Set<number>();
  const arcFrom: number[] = [];
  const arcTo: number[] = [];
  const addArc = (from: number, to: number) => {
    if (seen.has(from * n + to)) return;
    seen.add(from * n + to);
    arcFrom.push(from);
    arcTo.push(to);
  };
  for (const edge of graph.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    addArc(from, to);
    if (edge.kind === 'cooccurs') addArc(to, from);
  }
  const degree = new Int32Array(n);
  for (const from of arcFrom) degree[from] += 1;
  const first = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) first[i + 1] = first[i] + degree[i];
  const fill = first.slice(0, n);
  const targets = new Int32Array(arcFrom.length);
  for (let k = 0; k < arcFrom.length; k += 1) targets[fill[arcFrom[k]]++] = arcTo[k];
  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  for (let iteration = 0; iteration < 100 && n > 0; iteration += 1) {
    let dangling = 0;
    for (let i = 0; i < n; i += 1) if (degree[i] === 0) dangling += rank[i];
    next.fill((1 - damping) / n + (damping * dangling) / n);
    for (let i = 0; i < n; i += 1) {
      if (degree[i] === 0) continue;
      const share = (damping * rank[i]) / degree[i];
      for (let k = first[i]; k < first[i + 1]; k += 1) next[targets[k]] += share;
    }
    let change = 0;
    for (let i = 0; i < n; i += 1) change += Math.abs(next[i] - rank[i]);
    [rank, next] = [next, rank];
    if (change < 1e-12) break;
  }
  return new Map(ids.map((id, i) => [id, round6(rank[i])]));
}

/**
 * Betweenness centrality (Brandes) of every node, in node order: for each pair of other nodes, the
 * share of their shortest paths that pass through it, summed. Edges count in both directions, once
 * per pair of neighbours, so each unordered pair is counted once. O(nodes × (nodes + edges)), refused
 * above `maxWork`.
 */
export function betweenness(graph: StoryGraph, maxWork = MAX_GRAPH_WORK): Map<string, number> {
  const adj = adjacency(graph);
  const ids = graph.nodes.map((node) => node.id);
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const near = ids.map((id) => adj.get(id)!.map((other) => index.get(other)!));
  const arcs = near.reduce((sum, list) => sum + list.length, 0);
  if (n * (n + arcs) > maxWork) throw new GraphTooLargeError('betweenness', n, arcs / 2);
  const score = new Float64Array(n);
  const sigma = new Float64Array(n);
  const delta = new Float64Array(n);
  const distance = new Int32Array(n);
  const order = new Int32Array(n);
  for (let s = 0; s < n; s += 1) {
    sigma.fill(0);
    delta.fill(0);
    distance.fill(-1);
    sigma[s] = 1;
    distance[s] = 0;
    let head = 0;
    let tail = 0;
    order[tail++] = s;
    while (head < tail) {
      const v = order[head++];
      for (const w of near[v]) {
        if (distance[w] < 0) { distance[w] = distance[v] + 1; order[tail++] = w; }
        if (distance[w] === distance[v] + 1) sigma[w] += sigma[v];
      }
    }
    // The visit order reversed is farthest first: each node's dependency is complete before its parents read it.
    for (let k = tail - 1; k > 0; k -= 1) {
      const w = order[k];
      for (const v of near[w]) if (distance[v] === distance[w] - 1) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      score[w] += delta[w];
    }
  }
  return new Map(ids.map((id, i) => [id, round6(score[i] / 2)]));
}

export type SuggestMetric = 'adamic_adar' | 'jaccard';
export interface LinkSuggestion {
  from: string;
  to: string;
  score: number;
  /** How many neighbours the two notes share. */
  common: number;
  /** The first shared neighbours by id, at most MAX_VIA: why the pair is suggested. */
  via: string[];
}
export const MAX_VIA = 5;

/**
 * The most steps link suggestions may take. Measured on the CI machine so that the largest accepted
 * graph answers well within a second (docs/notes-and-graph.md); the cost is known before any work.
 */
export const MAX_SUGGEST_WORK = 2_000_000;

/**
 * The steps suggestLinks would take, computed in O(nodes + edges) before any work: for each note it
 * starts from, the degrees of its neighbours summed (each neighbour's neighbours are visited).
 */
export function suggestionCost(graph: StoryGraph, node?: string): number {
  const adj = adjacency(graph);
  const kind = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  if (node !== undefined) return (adj.get(node) ?? []).reduce((sum, w) => sum + adj.get(w)!.length, 0);
  let cost = 0;
  for (const [w, around] of adj) {
    let notes = 0;
    for (const v of around) if (kind.get(v) === 'note') notes += 1;
    cost += around.length * notes;
  }
  return cost;
}

/**
 * Notes that could be linked: pairs of notes with at least one shared neighbour (a scene that
 * mentions both, a note linked to both, a note they co-occur with) and no `[[link]]` between them in
 * either direction. Adamic-Adar sums 1 / ln(degree) over the shared neighbours, so a rare shared
 * neighbour weighs more than a hub; Jaccard divides the shared neighbours by all the neighbours of
 * the pair. With `node`, its best `top` partners (from = node); without, the best `top` pairs of the
 * book (from < to). Highest score first, then more shared neighbours, then ids. Costs the sum of the
 * squared degrees of the neighbours visited (suggestionCost), refused above `maxWork` before any work.
 */
export function suggestLinks(graph: StoryGraph, query: { metric: SuggestMetric; node?: string; top: number }, maxWork = MAX_SUGGEST_WORK): LinkSuggestion[] {
  const adj = adjacency(graph);
  const kind = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  if (query.node !== undefined) {
    if (!kind.has(query.node)) throw new Error(`unknown node: ${query.node}`);
    if (kind.get(query.node) !== 'note') throw new Error(`suggestions are between notes; ${query.node} is a scene`);
  }
  const linked = new Set<string>();
  for (const edge of graph.edges) if (edge.kind === 'link') linked.add(`${edge.from}\u0000${edge.to}`).add(`${edge.to}\u0000${edge.from}`);
  if (suggestionCost(graph, query.node) > maxWork) throw new GraphTooLargeError('link suggestions', graph.nodes.length, graph.edges.length);
  const sources = query.node !== undefined ? [query.node] : graph.nodes.filter((node) => node.kind === 'note').map((node) => node.id);
  const pairs: { from: string; to: string; sum: number; common: number; via: string[] }[] = [];
  for (const u of sources) {
    // The partners of one note, keyed by the other note only.
    const partners = new Map<string, { from: string; to: string; sum: number; common: number; via: string[] }>();
    for (const w of adj.get(u)!) {
      const around = adj.get(w)!;
      const weight = 1 / Math.log(around.length);
      for (const v of around) {
        if (v === u || kind.get(v) !== 'note' || (query.node === undefined && v < u)) continue;
        let pair = partners.get(v);
        if (!pair) { pair = { from: u, to: v, sum: 0, common: 0, via: [] }; partners.set(v, pair); }
        pair.sum += weight;
        pair.common += 1;
        if (pair.via.length < MAX_VIA) pair.via.push(w);
      }
    }
    for (const pair of partners.values()) if (!linked.has(`${u}\u0000${pair.to}`)) pairs.push(pair);
  }
  return pairs
    .map(({ from, to, sum, common, via }) => ({
      from, to, common, via,
      score: round6(query.metric === 'adamic_adar' ? sum : common / (adj.get(from)!.length + adj.get(to)!.length - common)),
    }))
    .sort((a, b) => b.score - a.score || b.common - a.common || byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to))
    .slice(0, query.top)
    .map(({ from, to, score, common, via }) => ({ from, to, score, common, via }));
}
