// The Grafo drawing's layout (issue #115): ForceAtlas2 on plain arrays, so the same code runs in
// the layout worker (layout-worker.js) and, when no worker can start, on the page.
import { UndirectedGraph } from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

// FNV-1a over the id's UTF-16 code units.
function hash(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
}

/** Where a node without a cached position starts: fixed by its id, inside the unit disc. */
export function seedPosition(id) {
  const angle = hash(id, 2166136261) * 2 * Math.PI;
  const radius = Math.sqrt(hash(id, 374761393));
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/**
 * How many iterations a layout takes: fewer when most positions come from the cache (the
 * drawing only settles the new nodes) and fewer on large graphs, where each one costs more.
 * None when every position is cached.
 */
export function layoutIterations(order, cached) {
  if (order === 0 || cached >= order) return 0;
  const fresh = order <= 300 ? 300 : order <= 1000 ? 150 : 80;
  return cached / order >= 0.8 ? Math.ceil(fresh / 4) : fresh;
}

/**
 * Runs ForceAtlas2. `nodes` are { id, x, y } starting positions, `edges` are [from index,
 * to index, weight]. Returns [x, y] for each node, in the same order.
 */
export function runLayout({ nodes, edges, iterations }) {
  if (!nodes.length) return [];
  const graph = new UndirectedGraph();
  for (const node of nodes) graph.addNode(node.id, { x: node.x, y: node.y });
  for (const [from, to, weight] of edges) {
    if (from !== to) graph.mergeEdge(nodes[from].id, nodes[to].id, { weight });
  }
  if (iterations > 0 && graph.size > 0) {
    const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: graph.order > 500, edgeWeightInfluence: 0.5 };
    forceAtlas2.assign(graph, { iterations, settings, getEdgeWeight: 'weight' });
  }
  return nodes.map((node) => [graph.getNodeAttribute(node.id, 'x'), graph.getNodeAttribute(node.id, 'y')]);
}
