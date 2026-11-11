// The Grafo drawing (issue #115, docs/notes-and-graph.md): the story graph drawn with sigma.js
// (WebGL) over graphology, with the "Análisis" panel of graph operations. Built as its own chunk,
// which the editor module imports only when a person opens the drawing, so the editor's first
// load does not grow. The page owns the data, the filters and the selection; this module draws
// what it is given and reports clicks. The drawing is never the only way to the data: the page's
// table holds the same nodes, and every list here is made of buttons.
import Sigma from 'sigma';
import { communities, components, metric, orphans, ranking, shortestPath, suggestions, toGraph } from './analysis.js';
import { layoutIterations, runLayout, seedPosition } from './layout.js';

/* global __LAYOUT_WORKER__ */
const LAYOUT_WORKER = typeof __LAYOUT_WORKER__ === 'string' ? __LAYOUT_WORKER__ : null;

// Categorical colours, one set per theme, each at least 3:1 against its own --paper.
const PALETTE = {
  light: ['#0072b2', '#c4500a', '#00795a', '#b4467f', '#7a6200', '#5a52a3', '#2f7d8c', '#8c4a2f'],
  dark: ['#56b4e9', '#f0883e', '#3fc79a', '#e08ac0', '#e0c341', '#a59bf0', '#5fc3d3', '#d99a7a'],
};
const TYPES = [['personaje', 'Personaje'], ['lugar', 'Lugar'], ['objeto', 'Objeto'], ['trama', 'Trama'], ['otra', 'Otra']];
const METRICS = [['degree', 'Grado'], ['pagerank', 'PageRank'], ['betweenness', 'Intermediación']];
const TOP = 10;
const COLLATOR = new Intl.Collator('es');
const LIST_CAP = 50;

// Positions survive closing the panel and changing the filters, so a node stays where the person
// last saw it and only new nodes are laid out. Keyed by book and node id.
const positions = new Map();

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, onClick, className) {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
function select(label, options, value, onChange) {
  const wrap = el('label', label + ' ');
  const field = el('select');
  for (const [key, text] of options) {
    const option = el('option', text);
    option.value = key;
    field.append(option);
  }
  field.value = value;
  field.addEventListener('change', () => onChange(field.value));
  wrap.append(field);
  return { wrap, field };
}
const number = (value, metricName) => (metricName === 'degree' ? String(value) : value.toLocaleString('es', { maximumFractionDigits: 3, minimumFractionDigits: 3 }));
const count = (n, one, many) => n.toLocaleString('es') + ' ' + (n === 1 ? one : many);

/**
 * Creates the drawing. `onSelect(id)` chooses a node (the page marks its row and announces it),
 * `onPath(ids)` reports the highlighted path (empty when cleared), `announce(text)` speaks
 * through the page's live region. Returns { node, show(data, options), select(id), destroy() }.
 */
export function createGraphView({ book, onSelect = () => {}, onPath = () => {}, announce = () => {} }) {
  const st = {
    data: null, graph: null, sigma: null, selected: null, path: [], pathEdges: new Set(),
    sizeBy: 'degree', colorBy: 'community', rankBy: 'degree', comms: null, sizes: null,
    worker: null, seq: 0, colors: null, failed: false,
  };
  const node = el('div', undefined, 'graph-view');
  const controls = el('div', undefined, 'graph-controls graph-view-controls');
  const sizeBy = select('Tamaño', [['degree', 'Grado'], ['pagerank', 'PageRank']], st.sizeBy, (value) => {
    st.sizeBy = value;
    paint();
  });
  const colorBy = select('Color', [['community', 'Comunidad'], ['type', 'Tipo']], st.colorBy, (value) => {
    st.colorBy = value;
    paint();
  });
  const camera = (action) => () => st.sigma && st.sigma.getCamera()[action]({ duration: 200 });
  const zoomIn = button('Acercar', camera('zoomIn'));
  const zoomOut = button('Alejar', camera('zoomOut'));
  const fit = button('Encajar', camera('reset'));
  controls.append(sizeBy.wrap, colorBy.wrap, zoomIn, zoomOut, fit);
  const canvas = el('div', undefined, 'graph-canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('data-layout', 'pending');
  const legend = el('ul', undefined, 'graph-legend');
  legend.setAttribute('aria-label', 'Leyenda de colores');
  const analysis = el('details', undefined, 'graph-analysis');
  analysis.open = !window.matchMedia('(max-width: 40em)').matches;
  const summary = el('summary', 'Análisis');
  const analysisBody = el('div');
  analysis.append(summary, analysisBody);
  analysis.addEventListener('toggle', () => analysis.open && renderAnalysis());
  node.append(controls, canvas, legend, analysis);

  // The theme's colours, read from the page's tokens (docs/design.md); WebGL needs real colours.
  function readColors() {
    const css = getComputedStyle(node);
    const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    st.colors = {
      ink: token('--ink', '#1c1b19'), paper: token('--paper', '#faf8f4'), muted: token('--muted', '#625d54'),
      line: token('--line', '#d9d4ca'), edge: token('--edge', '#8a8478'), path: token('--accept', '#1f6b45'),
      palette: dark ? PALETTE.dark : PALETTE.light,
    };
  }
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    readColors();
    paint();
  };
  scheme.addEventListener('change', onScheme);

  const typeIndex = (attrs) => (attrs.kind === 'scene' ? -2 : TYPES.findIndex(([key]) => key === attrs.type));
  function colorOf(id, attrs) {
    const { palette, muted, edge } = st.colors;
    if (st.colorBy === 'type') {
      const index = typeIndex(attrs);
      return index === -2 ? edge : index === -1 ? muted : palette[index];
    }
    const index = st.comms.of[id];
    const group = st.comms.list[index];
    return group && index < palette.length ? palette[index] : muted;
  }

  // Node sizes from the chosen metric, square-root scaled between 4 and 16 px.
  function computeSizes() {
    const values = metric(st.graph, st.sizeBy);
    let max = 0;
    for (const id in values) max = Math.max(max, values[id]);
    const sizes = {};
    for (const id in values) sizes[id] = 4 + (max > 0 ? 12 * Math.sqrt(values[id] / max) : 0);
    st.sizes = sizes;
  }

  function nodeReducer(id, data) {
    const attrs = st.graph.getNodeAttributes(id);
    const out = { ...data, label: attrs.label, size: st.sizes[id], color: colorOf(id, attrs), labelColor: st.colors.ink, backdropColor: st.colors.paper };
    const onPath = st.path.length > 0 && st.path.includes(id);
    if (st.path.length) {
      if (onPath) Object.assign(out, { highlighted: true, labelVisibility: 'visible', size: out.size * 1.25 });
      else out.opacity = 0.2;
    } else if (st.selected && st.graph.hasNode(st.selected)) {
      if (id === st.selected) Object.assign(out, { highlighted: true, labelVisibility: 'visible', size: out.size * 1.4 });
      else if (!st.graph.areNeighbors(id, st.selected)) out.opacity = 0.3;
    }
    if (id === st.selected) out.labelVisibility = 'visible';
    return out;
  }
  function edgeReducer(key, data) {
    const attrs = st.graph.getEdgeAttributes(key);
    const out = { ...data, size: 1 + Math.min(5, 1.5 * Math.log2(1 + attrs.cooccurs)), color: st.colors.edge };
    if (st.path.length) {
      if (st.pathEdges.has(key)) Object.assign(out, { color: st.colors.path, size: out.size + 3 });
      else out.opacity = 0.12;
    } else if (st.selected && st.graph.hasNode(st.selected)) {
      const [a, b] = st.graph.extremities(key);
      if (a !== st.selected && b !== st.selected) out.opacity = 0.2;
    }
    return out;
  }

  function mountSigma() {
    try {
      st.sigma = new Sigma(st.graph, canvas, {
        nodeReducer, edgeReducer,
        settings: {
          // One finger or the wheel scrolls the page; two fingers, or Ctrl/Cmd with the wheel, move the drawing.
          gestureTarget: 'shared',
          sharedGestureWheelMessage: 'Usa Ctrl + rueda para acercar el grafo',
          sharedGestureAppleWheelMessage: 'Usa ⌘ + rueda para acercar el grafo',
          sharedGestureTouchMessage: 'Usa dos dedos para mover el grafo',
          allowInvalidContainer: true, labelRenderedSizeThreshold: 9, minCameraRatio: 0.05, maxCameraRatio: 10, stagePadding: 24 },
      });
    } catch {
      st.failed = true;
      canvas.removeAttribute('role');
      canvas.replaceChildren(el('p', 'Este navegador no puede dibujar el grafo. La tabla tiene los mismos datos.', 'meta graph-view-error'));
      return;
    }
    st.sigma.on('clickNode', ({ node: id }) => onSelect(id));
    st.sigma.on('enterNode', () => (canvas.style.cursor = 'pointer'));
    st.sigma.on('leaveNode', () => (canvas.style.cursor = ''));
    new ResizeObserver(() => st.sigma && st.sigma.resize()).observe(canvas);
  }

  function paint() {
    if (!st.graph) return;
    computeSizes();
    renderLegend();
    if (st.sigma) st.sigma.refresh();
    if (analysis.open) renderAnalysis();
  }

  // Lays out the nodes without a cached position, off the main thread when a worker can start.
  function layout() {
    const ids = st.graph.nodes();
    const cached = ids.filter((id) => positions.has(book + '\n' + id)).length;
    const iterations = layoutIterations(ids.length, cached);
    const seq = ++st.seq;
    if (!iterations) {
      canvas.setAttribute('data-layout', 'done');
      return;
    }
    canvas.setAttribute('data-layout', 'running');
    const index = new Map(ids.map((id, i) => [id, i]));
    const message = {
      seq,
      iterations,
      nodes: ids.map((id) => ({ id, x: st.graph.getNodeAttribute(id, 'x'), y: st.graph.getNodeAttribute(id, 'y') })),
      edges: st.graph.mapEdges((key, attrs, from, to) => [index.get(from), index.get(to), attrs.weight]),
    };
    const apply = (result) => {
      if (result.seq !== st.seq || !st.graph) return;
      result.positions.forEach(([x, y], i) => {
        const id = ids[i];
        if (!st.graph.hasNode(id)) return;
        st.graph.mergeNodeAttributes(id, { x, y });
        positions.set(book + '\n' + id, { x, y });
      });
      canvas.setAttribute('data-layout', 'done');
    };
    const inPage = () => apply({ seq, positions: runLayout({ ...message, iterations: Math.min(iterations, 40) }) });
    if (!st.worker && LAYOUT_WORKER && typeof Worker === 'function') {
      try {
        st.worker = new Worker(new URL(LAYOUT_WORKER, import.meta.url));
      } catch {
        st.worker = null;
      }
    }
    if (!st.worker) return inPage();
    st.worker.onmessage = (event) => apply(event.data);
    st.worker.onerror = () => {
      st.worker = null;
      if (seq === st.seq) inPage();
    };
    st.worker.postMessage(message);
  }

  /**
   * Draws `data` ({ nodes, edges } with each node's `label`), already cut by the page's filters.
   * `selected` is the page's chosen node.
   */
  function show(data, options = {}) {
    if (!st.colors) readColors();
    st.data = data;
    st.selected = options.selected || null;
    const graph = toGraph(data);
    graph.forEachNode((id) => {
      const cached = positions.get(book + '\n' + id);
      graph.mergeNodeAttributes(id, cached || seedPosition(id));
    });
    st.graph = graph;
    st.comms = communities(graph);
    if (st.path.length && !st.path.every((id) => graph.hasNode(id))) setPath([], true);
    else setPathEdges();
    computeSizes();
    canvas.setAttribute('data-nodes', String(graph.order));
    canvas.setAttribute('data-edges', String(graph.size));
    canvas.setAttribute('aria-label', 'Dibujo del grafo: ' + count(graph.order, 'nodo', 'nodos') + ' y ' + count(graph.size, 'conexión', 'conexiones') + '. La tabla tiene los mismos datos.');
    if (!st.sigma && !st.failed) mountSigma();
    else if (st.sigma) st.sigma.setGraph(graph);
    renderLegend();
    if (analysis.open) renderAnalysis();
    layout();
  }

  function setPathEdges() {
    st.pathEdges = new Set();
    for (let i = 1; i < st.path.length; i++) {
      const key = st.graph && st.graph.edge(st.path[i - 1], st.path[i]);
      if (key !== undefined) st.pathEdges.add(key);
    }
    canvas.setAttribute('data-path', st.path.join('\n'));
  }
  function setPath(ids, quiet) {
    st.path = ids;
    setPathEdges();
    if (st.sigma) st.sigma.refresh();
    onPath(ids);
    if (!quiet && !ids.length) announce('Camino quitado.');
  }

  function selectNode(id) {
    st.selected = id;
    canvas.setAttribute('data-selected', id || '');
    if (!st.sigma) return;
    st.sigma.refresh();
    const shown = id && st.graph.hasNode(id) && st.sigma.getNodeDisplayData(id);
    if (shown) st.sigma.getCamera().animate({ x: shown.x, y: shown.y }, { duration: 300 });
  }

  const labelOf = (id) => (st.graph.hasNode(id) ? st.graph.getNodeAttribute(id, 'label') : id);
  const pick = (id) => button(labelOf(id), () => onSelect(id), 'graph-pick');

  function renderLegend() {
    const items = [];
    if (st.colorBy === 'type') {
      for (const [key, label] of TYPES) {
        if (st.graph.someNode((id, attrs) => attrs.kind === 'note' && attrs.type === key)) items.push([st.colors.palette[TYPES.findIndex(([k]) => k === key)], label]);
      }
      if (st.graph.someNode((id, attrs) => attrs.kind === 'note' && !TYPES.some(([k]) => k === attrs.type))) items.push([st.colors.muted, 'Sin tipo']);
      if (st.graph.someNode((id, attrs) => attrs.kind === 'scene')) items.push([st.colors.edge, 'Escena']);
    } else {
      st.comms.list.slice(0, st.colors.palette.length).forEach((group, i) => items.push([st.colors.palette[i], 'Comunidad ' + (i + 1) + ': ' + labelOf(group.members[0])]));
      if (st.comms.list.length > st.colors.palette.length || st.comms.singletons) items.push([st.colors.muted, 'Otras y sueltas']);
    }
    legend.replaceChildren(...items.map(([color, text]) => {
      const item = el('li');
      const swatch = el('span', undefined, 'graph-swatch');
      swatch.style.background = color;
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, document.createTextNode(text));
      return item;
    }));
  }

  // The operations panel: rankings, communities, shortest path, orphans and components, and
  // link suggestions. Recomputed when shown and when the drawn graph changes.
  const pathState = { from: '', to: '' };
  function renderAnalysis() {
    if (!st.graph) return;
    const graph = st.graph;
    const sections = [];

    const rankSection = el('section', undefined, 'graph-op');
    rankSection.setAttribute('aria-label', 'Centralidad');
    const rankList = el('ol', undefined, 'graph-ranking');
    const fillRanking = () => {
      rankList.replaceChildren(...ranking(graph, st.rankBy, TOP).map((row) => {
        const item = el('li');
        item.append(pick(row.id), el('span', ' ' + number(row.value, st.rankBy), 'meta'));
        return item;
      }));
    };
    const rankBy = select('Ordenar por', METRICS, st.rankBy, (value) => {
      st.rankBy = value;
      fillRanking();
    });
    rankSection.append(el('h3', 'Centralidad'), el('p', 'Quién sostiene la historia: el grado cuenta conexiones; PageRank pesa también las de sus vecinos; la intermediación mide quién hace de puente.', 'meta'), rankBy.wrap, rankList);
    fillRanking();
    sections.push(rankSection);

    const commSection = el('section', undefined, 'graph-op');
    commSection.setAttribute('aria-label', 'Comunidades');
    const commList = el('ol', undefined, 'graph-communities');
    st.comms.list.forEach((group, i) => {
      const item = el('li');
      const swatch = el('span', undefined, 'graph-swatch');
      swatch.style.background = i < st.colors.palette.length ? st.colors.palette[i] : st.colors.muted;
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, el('span', 'Comunidad ' + (i + 1) + ' (' + group.members.length + '): '));
      for (const id of group.members.slice(0, 8)) item.append(pick(id));
      if (group.members.length > 8) item.append(el('span', ' y ' + (group.members.length - 8) + ' más', 'meta'));
      commList.append(item);
    });
    commSection.append(el('h3', 'Comunidades'), el('p', 'Grupos que se conectan más entre sí que con el resto (Louvain): subtramas, bandos.', 'meta'));
    commSection.append(st.comms.list.length ? commList : el('p', 'Ningún grupo de dos o más nodos.', 'meta'));
    if (st.comms.singletons) commSection.append(el('p', count(st.comms.singletons, 'nodo suelto', 'nodos sueltos') + '.', 'meta'));
    sections.push(commSection);

    const pathSection = el('section', undefined, 'graph-op');
    pathSection.setAttribute('aria-label', 'Camino más corto');
    const choices = graph.nodes().map((id) => [id, labelOf(id)]).sort((a, b) => COLLATOR.compare(a[1], b[1]));
    if (!pathState.from || !graph.hasNode(pathState.from)) pathState.from = st.selected && graph.hasNode(st.selected) ? st.selected : (choices[0] || [''])[0];
    if (!pathState.to || !graph.hasNode(pathState.to)) pathState.to = (choices.find(([id]) => id !== pathState.from) || [''])[0];
    const from = select('Desde', choices, pathState.from, (value) => (pathState.from = value));
    const to = select('Hasta', choices, pathState.to, (value) => (pathState.to = value));
    const result = el('div', undefined, 'graph-path-result');
    const showPath = () => {
      if (!st.path.length) return result.replaceChildren();
      const steps = el('ol', undefined, 'graph-path');
      steps.setAttribute('aria-label', 'Camino');
      for (const id of st.path) {
        const item = el('li');
        item.append(pick(id));
        steps.append(item);
      }
      result.replaceChildren(el('p', count(st.path.length - 1, 'paso', 'pasos') + ':', 'meta'), steps, button('Quitar camino', () => {
        setPath([]);
        showPath();
      }));
    };
    const find = button('Buscar camino', () => {
      const ids = shortestPath(graph, pathState.from, pathState.to);
      if (!ids) {
        setPath([], true);
        result.replaceChildren(el('p', 'No hay camino entre ' + labelOf(pathState.from) + ' y ' + labelOf(pathState.to) + ' con estos filtros.', 'meta'));
        announce('No hay camino entre ' + labelOf(pathState.from) + ' y ' + labelOf(pathState.to) + '.');
        return;
      }
      setPath(ids);
      showPath();
      announce('Camino de ' + labelOf(ids[0]) + ' a ' + labelOf(ids[ids.length - 1]) + ': ' + count(ids.length - 1, 'paso', 'pasos') + ', por ' + ids.map(labelOf).join(', ') + '.');
    });
    pathSection.append(el('h3', 'Camino más corto'), el('div', undefined, 'graph-controls'), result);
    pathSection.children[1].append(from.wrap, to.wrap, find);
    showPath();
    sections.push(pathSection);

    const loneSection = el('section', undefined, 'graph-op');
    loneSection.setAttribute('aria-label', 'Huérfanas y componentes');
    const parts = components(graph);
    const alone = orphans(graph);
    loneSection.append(el('h3', 'Huérfanas y componentes'),
      el('p', count(parts.length, 'componente', 'componentes') + (parts.length ? '; el mayor tiene ' + count(parts[0].length, 'nodo', 'nodos') : '') + '. ' + (alone.length ? count(alone.length, 'nodo sin conexiones', 'nodos sin conexiones') + ' (hilos olvidados):' : 'Ningún nodo sin conexiones.'), 'meta'));
    if (alone.length) {
      const list = el('ul', undefined, 'graph-orphans');
      for (const id of alone.slice(0, LIST_CAP)) {
        const item = el('li');
        item.append(pick(id));
        list.append(item);
      }
      loneSection.append(list);
      if (alone.length > LIST_CAP) loneSection.append(el('p', 'Y ' + (alone.length - LIST_CAP) + ' más en la tabla (marca «Solo huérfanas»).', 'meta'));
    }
    sections.push(loneSection);

    const suggestSection = el('section', undefined, 'graph-op');
    suggestSection.setAttribute('aria-label', 'Enlaces sugeridos');
    const pairs = suggestions(graph, TOP);
    suggestSection.append(el('h3', 'Enlaces sugeridos'), el('p', 'Comparten muchos vecinos pero nunca coinciden (Adamic-Adar). Solo son sugerencias: no se cambia nada.', 'meta'));
    if (pairs.length) {
      const list = el('ol', undefined, 'graph-suggestions');
      for (const pair of pairs) {
        const item = el('li');
        item.append(pick(pair.a), el('span', ' y '), pick(pair.b), el('span', ' · comparten ' + count(pair.shared, 'vecino', 'vecinos') + ' (' + pair.score.toLocaleString('es', { maximumFractionDigits: 2 }) + ')', 'meta'));
        list.append(item);
      }
      suggestSection.append(list);
    } else suggestSection.append(el('p', 'Ninguna pareja por ahora.', 'meta'));
    sections.push(suggestSection);

    analysisBody.replaceChildren(...sections);
  }

  function destroy() {
    st.seq++;
    scheme.removeEventListener('change', onScheme);
    if (st.worker) st.worker.terminate();
    st.worker = null;
    if (st.sigma) st.sigma.kill();
    st.sigma = null;
    st.graph = null;
  }

  return { node, show, select: selectNode, destroy };
}
