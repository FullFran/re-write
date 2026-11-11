// Bundles the scene editor into one minified ES module, dist/editor.js, which the server
// serves at /review/editor.js. Run with `npm run build` after `npm ci` in this directory.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const outfile = new URL('./dist/editor.js', import.meta.url).pathname;
await build({
  entryPoints: [new URL('./src/main.js', import.meta.url).pathname],
  outfile,
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2020'],
  legalComments: 'eof',
  logLevel: 'warning',
});
const bytes = readFileSync(outfile);
console.log(`dist/editor.js: ${bytes.length} bytes, ${gzipSync(bytes).length} gzipped`);
