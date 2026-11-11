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
function contextOf(source: Source, start: number, end: number): string {
  const text = source.text;
  const sentences = sentencesOf(source);
  let from = Math.max(0, lastAtMost(sentences.starts, start));
  const to = Math.min(text.length, firstAtLeast(sentences.terminatorEnds, end + 1), firstAtLeast(sentences.breaks, end));
  while (from < start && SPACE.test(text[from])) from += 1;
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
}
export interface StoryGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export const noteNode = (name: string) => `note:${name}`;
export const sceneNode = (file: string) => `scene:${file}`;

/**
 * Notes and scenes as nodes, with typed edges: `mention` (scene to note), `link` (note to note,
 * self-links left out) and `cooccurs` (two notes mentioned in the same scene, from the smaller id to
 * the larger). With `asOfScene`, scenes after it in reading order, and the edges they bring, are
 * left out; notes and links between notes are always kept.
 */
export function buildGraph(analysis: Analysis, asOfScene?: string): StoryGraph {
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
  for (const link of analysis.links) {
    if (link.resolution.status !== 'resolved') continue;
    const target = link.resolution.note;
    if (link.source_kind === 'note') {
      if (link.source !== target) bump('link', noteNode(link.source), noteNode(target));
    } else if (kept.has(link.source)) {
      bump('mention', sceneNode(link.source), noteNode(target));
      mentioned.set(link.source, (mentioned.get(link.source) ?? new Set()).add(noteNode(target)));
    }
  }
  for (const notes of mentioned.values()) {
    const list = [...notes].sort(byCodeUnit);
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) bump('cooccurs', list[i], list[j]);
  }
  const edges = [...weights.values()].sort((a, b) => byCodeUnit(a.kind, b.kind) || byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to));
  return { nodes, edges };
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
