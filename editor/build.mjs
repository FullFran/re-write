// Bundles the scene editor into one minified ES module, dist/editor.js, which the server serves
// at /review/editor.js, and the graph view (issue #115) into chunks the editor imports only when
// the Grafo drawing opens: dist/chunks/graph-view-<hash>.js and its layout worker,
// dist/chunks/layout-worker-<hash>.js. dist/manifest.json lists the chunks; the server reads it
// once at startup and serves only those names, at /review/chunks/<name>. Run with `npm run
// build` after `npm ci` in this directory.
import { build } from 'esbuild';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = new URL('./dist/', import.meta.url).pathname;
const src = (file) => new URL('./src/' + file, import.meta.url).pathname;
const common = { bundle: true, minify: true, target: ['es2020'], legalComments: 'eof', logLevel: 'warning', metafile: true };

// Each build writes one file; its name comes from the metafile.
const only = (result) => {
  const files = Object.keys(result.metafile.outputs);
  if (files.length !== 1) throw new Error('expected one output, got ' + files.join(', '));
  return basename(files[0]);
};

rmSync(dist, { recursive: true, force: true });
const worker = only(await build({ ...common, entryPoints: { 'layout-worker': src('graph/layout-worker.js') }, outdir: dist + 'chunks', entryNames: '[name]-[hash]', format: 'iife' }));
const graph = only(await build({
  ...common,
  entryPoints: { 'graph-view': src('graph/view.js') },
  outdir: dist + 'chunks',
  entryNames: '[name]-[hash]',
  format: 'esm',
  define: { __LAYOUT_WORKER__: JSON.stringify(worker) },
}));
await build({ ...common, entryPoints: [src('main.js')], outfile: dist + 'editor.js', format: 'esm', define: { __GRAPH_CHUNK__: JSON.stringify('chunks/' + graph) } });
writeFileSync(dist + 'manifest.json', JSON.stringify({ chunks: [graph, worker] }, null, 2) + '\n');

for (const file of ['editor.js', 'chunks/' + graph, 'chunks/' + worker]) {
  const bytes = readFileSync(dist + file);
  console.log(`dist/${file}: ${bytes.length} bytes, ${gzipSync(bytes).length} gzipped`);
}
