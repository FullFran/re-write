// Graph operations of the Grafo view (issue #115, docs/notes-and-graph.md), on graphology. The
// input is the review door's graph data (GET .../graph), already cut by the page's filters. Every
// result has a fixed order (ties broken by id), so the same graph always reads the same.
import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import betweenness from 'graphology-metrics/centrality/betweenness.js';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import { bidirectional } from 'graphology-shortest-path/unweighted.js';

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One undirected simple graph: the typed edges between two nodes (a link both ways, a link and a
 * co-occurrence) become one edge whose `weight` is their sum, with `cooccurs` (the co-occurrence
 * weight, which the drawing uses for thickness) and the `kinds` it joins. Edges to nodes missing
 * from `data.nodes` are left out.
 */
export function toGraph(data) {
  const graph = new UndirectedGraph();
  for (const node of data.nodes) {
    graph.addNode(node.id, { kind: node.kind, type: node.type ?? null, label: node.label ?? node.name, order: node.order ?? null });
  }
  for (const edge of data.edges) {
    if (edge.from === edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    const cooccurs = edge.kind === 'cooccurs' ? edge.weight : 0;
    const key = graph.edge(edge.from, edge.to);
    if (key === undefined) {
      graph.addEdge(edge.from, edge.to, { weight: edge.weight, cooccurs, kinds: [edge.kind] });
      continue;
    }
    const attrs = graph.getEdgeAttributes(key);
    const kinds = attrs.kinds.includes(edge.kind) ? attrs.kinds : [...attrs.kinds, edge.kind].sort();
    graph.replaceEdgeAttributes(key, { weight: attrs.weight + edge.weight, cooccurs: attrs.cooccurs + cooccurs, kinds });
  }
  return graph;
}

/** The metric of every node: degree (distinct neighbours), PageRank or betweenness (normalised). */
export function metric(graph, name) {
  if (name === 'degree') {
    const out = {};
    graph.forEachNode((id) => (out[id] = graph.degree(id)));
    return out;
  }
  if (name === 'pagerank') return graph.size ? pagerank(graph, { getEdgeWeight: 'weight' }) : uniform(graph);
  if (name === 'betweenness') return betweenness(graph, { getEdgeWeight: null, normalized: true });
  throw new Error('unknown metric: ' + name);
}

function uniform(graph) {
  const out = {};
  graph.forEachNode((id) => (out[id] = 1 / graph.order));
  return out;
}

/** The top `limit` nodes by a metric, highest first, as [{ id, value }]. */
export function ranking(graph, name, limit = 10) {
  const values = metric(graph, name);
  return Object.keys(values)
    .map((id) => ({ id, value: values[id] }))
    .sort((a, b) => b.value - a.value || byId(a.id, b.id))
    .slice(0, limit);
}

// A small seeded generator, so Louvain gives the same communities on every run.
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Louvain communities (subplots, factions), weighted by `weight`. `of` maps every node to its
 * community index (for its colour); `list` holds the communities of two or more nodes, largest
 * first, each with its members by degree; `singletons` counts the nodes alone.
 */
export function communities(graph) {
  const raw = graph.size ? louvain(graph, { getEdgeWeight: 'weight', rng: seeded(115) }) : {};
  const groups = new Map();
  graph.forEachNode((id) => {
    const key = id in raw ? raw[id] : 'alone:' + id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  });
  const sorted = [...groups.values()]
    .map((members) => members.sort((a, b) => graph.degree(b) - graph.degree(a) || byId(a, b)))
    .sort((a, b) => b.length - a.length || byId(a[0], b[0]));
  const of = {};
  sorted.forEach((members, index) => members.forEach((id) => (of[id] = index)));
  const list = sorted.filter((members) => members.length >= 2).map((members, index) => ({ index, members }));
  return { of, list, singletons: sorted.length - list.length };
}

/** The fewest-steps path between two nodes as their ids, or null when there is none. */
export function shortestPath(graph, from, to) {
  if (!graph.hasNode(from) || !graph.hasNode(to)) return null;
  if (from === to) return [from];
  return bidirectional(graph, from, to);
}

/** Connected components, largest first, each sorted by id. */
export function components(graph) {
  const seen = new Set();
  const parts = [];
  graph.forEachNode((start) => {
    if (seen.has(start)) return;
    const part = [start];
    seen.add(start);
    for (let i = 0; i < part.length; i++) {
      graph.forEachNeighbor(part[i], (next) => {
        if (!seen.has(next)) {
          seen.add(next);
          part.push(next);
        }
      });
    }
    parts.push(part.sort(byId));
  });
  return parts.sort((a, b) => b.length - a.length || byId(a[0], b[0]));
}

/** The nodes with no edge at all, by id. */
export function orphans(graph) {
  return graph.filterNodes((id) => graph.degree(id) === 0).sort(byId);
}

/**
 * Link suggestions: pairs of notes that share neighbours (of any kind) but are not joined, best
 * Adamic-Adar first (each shared neighbour w adds 1 / ln(degree of w), so a rare common
 * acquaintance counts more than a hub). A neighbour with more than `maxHub` connections is
 * skipped, which keeps the pass near linear on large books. Suggestions only: nothing is written.
 */
export function suggestions(graph, limit = 10, maxHub = 200) {
  const pairs = new Map();
  graph.forEachNode((hub) => {
    const degree = graph.degree(hub);
    if (degree < 2 || degree > maxHub) return;
    const weight = 1 / Math.log(degree);
    const notes = graph.neighbors(hub).filter((id) => graph.getNodeAttribute(id, 'kind') === 'note').sort(byId);
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (graph.hasEdge(notes[i], notes[j])) continue;
        const key = notes[i] + '\u0000' + notes[j];
        const pair = pairs.get(key) || { a: notes[i], b: notes[j], shared: 0, score: 0 };
        pair.shared += 1;
        pair.score += weight;
        pairs.set(key, pair);
      }
    }
  });
  return [...pairs.values()]
    .map((pair) => ({ ...pair, score: Number(pair.score.toFixed(4)) }))
    .sort((x, y) => y.score - x.score || y.shared - x.shared || byId(x.a, y.a) || byId(x.b, y.b))
    .slice(0, limit);
}
