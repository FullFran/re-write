// The Grafo drawing's layout worker (issue #115): ForceAtlas2 off the page's main thread, so the
// page stays responsive while a large graph settles. Built as its own chunk and started by the
// graph view from the same address; one message in, one out.
import { runLayout } from './layout.js';

self.onmessage = (event) => {
  const { seq, nodes, edges, iterations } = event.data;
  self.postMessage({ seq, positions: runLayout({ nodes, edges, iterations }) });
};
