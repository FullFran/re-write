/**
 * Notes, links and the story graph of one book, read from its current files. Read-only: nothing
 * here writes. The analysis is rebuilt on each call from the texts (linear in the size of the book),
 * so it never serves a stale answer after an edit made outside RE;write.
 */
import { analyseBook, backlinks, buildGraph, noteNode, sceneNode, type Analysis, type LinkRef, type StoryGraph } from '../domain/story-graph.ts';
import type { Project } from './project.ts';

/** Every note and scene of the book, scenes in the reading order of Project.scenes (path order). */
export function analyse(project: Project): Analysis {
  return analyseBook({
    notes: project.notes().map((name) => ({ name, text: project.readNote(name) ?? '' })),
    scenes: project.scenes().map((file) => ({ file, text: project.readScene(file) ?? '' })),
  });
}

export function graphOf(project: Project, asOfScene?: string): { analysis: Analysis; graph: StoryGraph } {
  const analysis = analyse(project);
  if (asOfScene !== undefined && !analysis.scenes.includes(asOfScene)) throw new Error(`unknown scene: ${asOfScene}`);
  return { analysis, graph: buildGraph(analysis, asOfScene) };
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
  };
}
