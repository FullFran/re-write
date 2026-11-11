/**
 * Notes, links and the story graph of one book, read from its current files. Read-only: nothing
 * here writes. The analysis is rebuilt on each call from the texts (linear in the size of the book),
 * so it never serves a stale answer after an edit made outside RE;write.
 */
import {
  analyseBook, backlinks, betweenness, buildGraph, central, knowsEdges, linkAnchors, noteNode, pageRank, sceneNode, suggestLinks,
  type Analysis, type GraphNode, type GraphOptions, type LinkRef, type NodeKind, type StoryGraph, type SuggestMetric,
} from '../domain/story-graph.ts';
import type { Project } from './project.ts';

export { GraphTooLargeError } from '../domain/story-graph.ts';

/** Every note and scene of the book, scenes in the reading order of Project.scenes (path order). */
export function analyse(project: Project): Analysis {
  return analyseBook({
    notes: project.notes().map((name) => ({ name, text: project.readNote(name) ?? '' })),
    scenes: project.scenes().map((file) => ({ file, text: project.readScene(file) ?? '' })),
  });
}

export function graphOf(project: Project, asOfScene?: string, options: GraphOptions = {}): { analysis: Analysis; graph: StoryGraph } {
  const analysis = analyse(project);
  if (asOfScene !== undefined && !analysis.scenes.includes(asOfScene)) throw new Error(`unknown scene: ${asOfScene}`);
  return { analysis, graph: buildGraph(analysis, asOfScene, options) };
}

/** Who knows what, from the book's claims, cut at `asOfScene` (see knowsEdges). */
export function knowsOf(project: Project, analysis: Analysis, asOfScene?: string) {
  return knowsEdges(analysis, project.claimViews(), asOfScene);
}

export const CENTRAL_METRICS = ['degree', 'pagerank', 'betweenness'] as const;
export type CentralMetric = (typeof CENTRAL_METRICS)[number];

/**
 * Nodes of one kind ranked by a centrality, highest first, then by id. Each carries its value under
 * the metric's name (`degree`, `pagerank` or `betweenness`).
 */
export function ranking(graph: StoryGraph, metric: CentralMetric, kind?: NodeKind): (GraphNode & Record<string, unknown>)[] {
  if (metric === 'degree') return central(graph, kind);
  const values = metric === 'pagerank' ? pageRank(graph) : betweenness(graph);
  return graph.nodes
    .filter((node) => kind === undefined || node.kind === kind)
    .map((node) => ({ ...node, [metric]: values.get(node.id)! }))
    .sort((a, b) => (b[metric] as number) - (a[metric] as number) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The most anchors one suggestion carries. */
export const MAX_ANCHORS = 3;

/** The most note text, in UTF-16 code units, one call may scan for anchors, whatever the notes' sizes. */
export const MAX_ANCHOR_SCAN = 16_000_000;

/** Why a suggestion has no anchor, in the person's language (Spanish), or null when it has one. */
export const ANCHOR_PROBLEMS = {
  absent: 'no aparece en el texto: ninguna de las dos notas nombra a la otra',
  repeated: 'el pasaje no es único: cada mención se repite igual en la nota',
  unchecked: 'las notas son demasiado largas para buscar un pasaje',
} as const;

/**
 * Link suggestions (see suggestLinks), each with up to MAX_ANCHORS anchors: plain-text mentions of
 * one note in the other's file, with a `find` that is an exact passage appearing once in that file
 * and the `replace` that links it, ready for propose_revision. A suggestion with no anchor says why
 * in `anchor_problem`.
 */
export function suggestionsOf(project: Project, analysis: Analysis, graph: StoryGraph, query: { metric: SuggestMetric; node?: string; top: number }) {
  const budget = { left: MAX_ANCHOR_SCAN };
  return suggestLinks(graph, query).map((suggestion) => {
    const from = suggestion.from.slice('note:'.length);
    const to = suggestion.to.slice('note:'.length);
    const found = [linkAnchors(analysis, from, to, MAX_ANCHORS, budget), linkAnchors(analysis, to, from, MAX_ANCHORS, budget)];
    const anchors = found.flatMap((side) => side.anchors)
      .slice(0, MAX_ANCHORS)
      .map(({ note, ...where }) => ({ file: project.notePath(note), ...where }));
    const anchor_problem = anchors.length ? null
      : found.some((side) => side.unchecked) ? ANCHOR_PROBLEMS.unchecked
      : found.some((side) => side.mentions > 0) ? ANCHOR_PROBLEMS.repeated
      : ANCHOR_PROBLEMS.absent;
    return { ...suggestion, anchors, anchor_problem };
  });
}

/** A graph query parameter with a value the endpoint does not know. */
export class GraphQueryError extends Error {}

export interface GraphQuery {
  metrics?: ('pagerank' | 'betweenness')[];
  include?: ('knows' | 'paragraphs')[];
  suggest?: SuggestMetric;
  top?: number;
}

/** The most suggestions one call returns. */
export const MAX_SUGGESTIONS = 50;

/**
 * Reads the optional graph parameters: `metrics` (pagerank, betweenness), `include` (knows,
 * paragraphs), comma-separated, `suggest` (adamic_adar or jaccard) and `top` (1 to 50, default 10).
 * An unknown value is refused, never ignored; absent parameters ask for nothing more.
 */
export function graphQuery(params: URLSearchParams): GraphQuery {
  const list = <T extends string>(name: string, allowed: readonly T[]): T[] | undefined => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    return raw.split(',').map((value) => {
      if (!(allowed as readonly string[]).includes(value)) throw new GraphQueryError(`unknown ${name} value: ${value}; use ${allowed.join(', ')}`);
      return value as T;
    });
  };
  const query: GraphQuery = {};
  const metrics = list('metrics', ['pagerank', 'betweenness'] as const);
  const include = list('include', ['knows', 'paragraphs'] as const);
  const suggest = list('suggest', ['adamic_adar', 'jaccard'] as const);
  if (metrics) query.metrics = metrics;
  if (include) query.include = include;
  if (suggest) {
    if (suggest.length > 1) throw new GraphQueryError('suggest takes one value: adamic_adar or jaccard');
    query.suggest = suggest[0];
  }
  const top = params.get('top');
  if (top !== null) {
    if (!/^\d+$/.test(top) || Number(top) < 1 || Number(top) > MAX_SUGGESTIONS) throw new GraphQueryError(`top must be a whole number from 1 to ${MAX_SUGGESTIONS}`);
    query.top = Number(top);
  }
  return query;
}

/**
 * The graph node a person or an assistant names: a scene path ("scenes/..."), or a note name or
 * alias, resolved like a wikilink. An ambiguous name is refused with its candidates.
 */
export function nodeFor(analysis: Analysis, graph: StoryGraph, ref: string): string {
  if (ref.startsWith('scenes/')) {
    const id = sceneNode(ref);
    if (!graph.nodes.some((node) => node.id === id)) throw new Error(`unknown scene: ${ref}`);
    return id;
  }
  const found = analysis.index.resolve(ref);
  if (found.status === 'ambiguous') throw new Error(`"${ref}" is ambiguous: it names the notes ${found.candidates.join(', ')}; use one of those names`);
  if (found.status === 'unresolved') throw new Error(`unknown note: ${ref}`);
  return noteNode(found.note);
}

/** Unresolved or ambiguous links grouped by what they name, with the first place each appears. */
export function groupLinks(links: LinkRef[]): { target: string; occurrences: number; first: { source: string; line: number; column: number }; candidates?: string[] }[] {
  const groups = new Map<string, { target: string; occurrences: number; first: { source: string; line: number; column: number }; candidates?: string[] }>();
  for (const link of links) {
    const group = groups.get(link.target);
    if (group) { group.occurrences += 1; continue; }
    groups.set(link.target, {
      target: link.target,
      occurrences: 1,
      first: { source: link.source, line: link.line, column: link.column },
      ...(link.resolution.status === 'ambiguous' ? { candidates: link.resolution.candidates } : {}),
    });
  }
  return [...groups.values()];
}

/** One note with its frontmatter, its outgoing links and its backlinks. */
export function noteView(project: Project, name: string) {
  const text = project.readNote(name);
  if (text === null) throw new Error(`note not found: ${name}`);
  const analysis = analyse(project);
  const info = analysis.notes.find((note) => note.name === name)!;
  return {
    name,
    file: project.notePath(name),
    type: info.type,
    aliases: info.aliases,
    problems: info.problems,
    text,
    blob: project.git.blobOf(project.notePath(name)),
    links: analysis.links
      .filter((link) => link.source_kind === 'note' && link.source === name)
      .map(({ target, section, shown, line, column, resolution }) => ({ target, section, shown, line, column, resolution })),
    backlinks: backlinks(analysis, name),
  };
}

/** Every note with its frontmatter, and the links that name no note or more than one. */
export function notesSummary(project: Project) {
  const analysis = analyse(project);
  return {
    notes: analysis.notes.map((note) => ({ ...note, file: project.notePath(note.name) })),
    unresolved: groupLinks(analysis.unresolved),
    ambiguous: groupLinks(analysis.ambiguous),
    /** Notes and scenes too large to analyse: their links and mentions are not counted. */
    too_large: analysis.too_large,
  };
}

/**
 * The graph as data for the review page: every node with its degree (distinct neighbours) and, for
 * a note, how many scenes mention it; the typed edges; and every scene path in reading order, so a
 * slider can offer any of them. With `asOfScene` the later scenes and their edges are left out.
 * `query` (see graphQuery) adds, only when asked: `pagerank` and `betweenness` on every node, the
 * `paragraphs` weight on cooccurs edges, `knows` edges, and the book's best link `suggestions`.
 */
export function graphData(project: Project, asOfScene?: string, query: GraphQuery = {}) {
  const include = new Set(query.include);
  const { analysis, graph } = graphOf(project, asOfScene, { paragraphs: include.has('paragraphs') });
  const degree = new Map(central(graph).map((node) => [node.id, node.degree]));
  const scenes = new Map<string, number>();
  for (const edge of graph.edges) if (edge.kind === 'mention') scenes.set(edge.to, (scenes.get(edge.to) ?? 0) + 1);
  // Requested extras only: with no query the answer has exactly the fields it always had.
  const metrics = (query.metrics ?? []).map((metric) => [metric, metric === 'pagerank' ? pageRank(graph) : betweenness(graph)] as const);
  return {
    as_of_scene: asOfScene ?? null,
    scenes: analysis.scenes,
    nodes: graph.nodes.map((node) => ({
      ...node, degree: degree.get(node.id)!, scenes: node.kind === 'note' ? scenes.get(node.id) ?? 0 : null,
      ...Object.fromEntries(metrics.map(([metric, values]) => [metric, values.get(node.id)!])),
    })),
    edges: graph.edges,
    too_large: analysis.too_large,
    ...(include.has('knows') ? { knows: knowsOf(project, analysis, asOfScene) } : {}),
    ...(query.suggest ? { suggestions: { metric: query.suggest, items: suggestionsOf(project, analysis, graph, { metric: query.suggest, top: query.top ?? 10 }) } } : {}),
  };
}
