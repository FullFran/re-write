import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { startHarness, reviewUpload, reviewApi } from './server-helpers.ts';

const SECRET_MARKER = 'SECRET_ANDRES_UNPUBLISHED_NOVEL_PROSE_MARKER_998877';
const SECRET_CELL = 'SECRET_CSV_CELL_VALUE_112233';

interface SyntheticZipEntry {
  name: string;
  content: string | Buffer;
  method?: number;
  declaredUncompressedSize?: number;
  overrideCrc?: number;
  flags?: number;
}

function buildSyntheticZip(entries: SyntheticZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawData = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const method = entry.method ?? 0;
    const compressedData = method === 8 ? deflateRawSync(rawData) : rawData;
    const uncompressedSize = entry.declaredUncompressedSize ?? rawData.length;
    const compressedSize = compressedData.length;
    const crc = entry.overrideCrc ?? crc32(rawData);
    const flags = entry.flags ?? 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressedSize, 18);
    lh.writeUInt32LE(uncompressedSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    localChunks.push(lh, nameBuf, compressedData);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    cdChunks.push(cd, nameBuf);
    offset += 30 + nameBuf.length + compressedData.length;
  }

  const cdTotalSize = cdChunks.reduce((acc, c) => acc + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdTotalSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...cdChunks, eocd]);
}

function createSyntheticNotionFiles(): SyntheticZipEntry[] {
  const csv = [
    'Título,Orden,Libro,Notas',
    `"El Faro",1,"El Mar del Norte","Nota: ${SECRET_CELL}"`,
    '"La Niebla",2,"El Mar del Norte","Segunda nota"',
  ].join('\n');

  const page1 = [
    '# El Faro',
    '',
    'Estado: Borrador',
    'Autor: Andrés',
    '',
    `Era una noche oscura y tormentosa en el faro. ${SECRET_MARKER}`,
    'El mar golpeaba contra las rocas.',
  ].join('\n');

  const page2 = [
    '# La Niebla',
    '',
    'La niebla cubría la costa silenciosa.',
  ].join('\n');

  return [
    { name: 'Capitulos 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.csv', content: csv, method: 8 },
    { name: 'El Faro 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md', content: page1, method: 8 },
    { name: 'La Niebla 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c.md', content: page2, method: 8 },
  ];
}

const standardMapping = {
  database: 'Capitulos.csv',
  titleColumn: 'Título',
  orderColumn: 'Orden',
};

test('inspect returns structure and no marker text', async () => {
  const h = await startHarness();
  try {
    const token = await h.session('user_fran');
    const zip = buildSyntheticZip(createSyntheticNotionFiles());

    const res = await reviewUpload(h, '/books/sal/notion-inspect', token, zip);
    assert.equal(res.status, 200);

    const bodyText = await res.text();
    // Safe inspection: never returns cell values or novel text
    assert.ok(!bodyText.includes(SECRET_MARKER), 'inspection must not reveal manuscript text');
    assert.ok(!bodyText.includes(SECRET_CELL), 'inspection must not reveal database cell text');

    const data = JSON.parse(bodyText);
    assert.ok(Array.isArray(data.databases), 'should return databases array');
    assert.equal(data.databases.length, 1);
    assert.equal(data.databases[0].rowCount, 2);
    assert.deepEqual(data.databases[0].columns, ['Título', 'Orden', 'Libro', 'Notas']);

    assert.ok(Array.isArray(data.pages), 'should return pages array');
    assert.equal(data.pages.length, 2);
    assert.ok(data.pages.some((p: { name: string; size: number }) => p.name.includes('El Faro')));
    assert.ok(data.pages.some((p: { name: string; size: number }) => p.name.includes('La Niebla')));
  } finally {
    h.close();
  }
});

test('dry run writes nothing', async () => {
  const h = await startHarness();
  try {
    const token = await h.session('user_fran');
    const zip = buildSyntheticZip(createSyntheticNotionFiles());

    const initialScenes = h.library.open('sal', 'user_fran').scenes();
    assert.deepEqual(initialScenes, ['scenes/escena-01.md', 'scenes/escena-02.md']);

    const res = await reviewUpload(
      h,
      '/books/sal/notion-import?dryRun=true',
      token,
      zip,
      { 'x-notion-mapping': encodeURIComponent(JSON.stringify(standardMapping)) }
    );
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.dryRun, true);
    assert.ok(Array.isArray(data.chapters));
    assert.equal(data.chapters.length, 2);
    assert.equal(data.chapters[0].title, 'El Faro');
    assert.equal(data.chapters[0].order, 1);
    assert.equal(data.chapters[0].file, 'scenes/001-el-faro.md');
    assert.equal(data.chapters[1].title, 'La Niebla');
    assert.equal(data.chapters[1].order, 2);
    assert.equal(data.chapters[1].file, 'scenes/002-la-niebla.md');
    // Ensure size is reported and no body text is returned
    assert.ok(typeof data.chapters[0].size === 'number' && data.chapters[0].size > 0);
    assert.equal((data.chapters[0] as any).body, undefined);

    // Repository scenes are untouched
    const afterScenes = h.library.open('sal', 'user_fran').scenes();
    assert.deepEqual(afterScenes, initialScenes);
  } finally {
    h.close();
  }
});

test('import creates scenes in order', async () => {
  const h = await startHarness();
  try {
    const token = await h.session('user_fran');
    const zip = buildSyntheticZip(createSyntheticNotionFiles());

    const res = await reviewUpload(
      h,
      '/books/sal/notion-import',
      token,
      zip,
      { 'x-notion-mapping': encodeURIComponent(JSON.stringify(standardMapping)) }
    );
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data.imported));
    assert.equal(data.imported.length, 2);
    assert.equal(data.imported[0].file, 'scenes/001-el-faro.md');
    assert.equal(data.imported[1].file, 'scenes/002-la-niebla.md');
    assert.deepEqual(data.unchanged, []);
    assert.deepEqual(data.refused, []);

    // Scenes exist in project repository
    const project = h.library.open('sal', 'user_fran');
    const scenes = project.scenes();
    assert.ok(scenes.includes('scenes/001-el-faro.md'));
    assert.ok(scenes.includes('scenes/002-la-niebla.md'));

    const faroText = project.readScene('scenes/001-el-faro.md');
    assert.ok(faroText?.includes('# El Faro'));
    assert.ok(faroText?.includes('Era una noche oscura y tormentosa en el faro.'));
    // Property table was stripped
    assert.ok(!faroText?.includes('Estado: Borrador'));
  } finally {
    h.close();
  }
});

test('re-import is a no-op', async () => {
  const h = await startHarness();
  try {
    const token = await h.session('user_fran');
    const zip = buildSyntheticZip(createSyntheticNotionFiles());

    // First import
    const res1 = await reviewUpload(
      h,
      '/books/sal/notion-import',
      token,
      zip,
      { 'x-notion-mapping': encodeURIComponent(JSON.stringify(standardMapping)) }
    );
    assert.equal(res1.status, 200);

    const headBefore = h.library.open('sal', 'user_fran').git.head();

    // Re-import the same export
    const res2 = await reviewUpload(
      h,
      '/books/sal/notion-import',
      token,
      zip,
      { 'x-notion-mapping': encodeURIComponent(JSON.stringify(standardMapping)) }
    );
    assert.equal(res2.status, 200);

    const data2 = await res2.json();
    assert.deepEqual(data2.imported, []);
    assert.equal(data2.unchanged.length, 2);
    assert.equal(data2.unchanged[0].file, 'scenes/001-el-faro.md');
    assert.equal(data2.unchanged[1].file, 'scenes/002-la-niebla.md');
    assert.deepEqual(data2.refused, []);

    // Git HEAD did not move
    const headAfter = h.library.open('sal', 'user_fran').git.head();
    assert.equal(headAfter, headBefore);
  } finally {
    h.close();
  }
});

test('non-member gets 404', async () => {
  const h = await startHarness();
  try {
    // user_andres has no grant on book 'sal'
    const token = await h.session('user_andres');
    const zip = buildSyntheticZip(createSyntheticNotionFiles());

    // Inspect
    const inspectRes = await reviewUpload(h, '/books/sal/notion-inspect', token, zip);
    assert.equal(inspectRes.status, 404);

    // Import
    const importRes = await reviewUpload(
      h,
      '/books/sal/notion-import',
      token,
      zip,
      { 'x-notion-mapping': encodeURIComponent(JSON.stringify(standardMapping)) }
    );
    assert.equal(importRes.status, 404);
  } finally {
    h.close();
  }
});

test('oversize body returns 413', async () => {
  const h = await startHarness();
  try {
    const token = await h.session('user_fran');

    // 50 MB + 1024 bytes
    const oversizeBytes = 50 * 1024 * 1024 + 1024;
    const chunk = Buffer.alloc(1024 * 1024, 0); // 1 MB chunk

    // Custom fetch streaming body over 50 MB
    const { Readable } = await import('node:stream');
    let sent = 0;
    const stream = new Readable({
      read() {
        if (sent >= oversizeBytes) {
          this.push(null);
        } else {
          const toSend = Math.min(chunk.length, oversizeBytes - sent);
          this.push(chunk.subarray(0, toSend));
          sent += toSend;
        }
      },
    });

    const res = await fetch(`${h.base}/review/api/books/sal/notion-inspect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/zip',
      },
      body: Readable.toWeb(stream) as any,
      duplex: 'half',
    } as any);

    assert.equal(res.status, 413);
  } finally {
    h.close();
  }
});

test('a malicious zip (traversal, bomb) is refused with a clear message and nothing written', async () => {
  const h = await startHarness();
  try {
    const token = await h.session('user_fran');
    const initialScenes = h.library.open('sal', 'user_fran').scenes();

    // 1. Path traversal entry
    const traversalZip = buildSyntheticZip([
      { name: 'Capitulos.csv', content: 'Título,Orden\n"Evil",1', method: 0 },
      { name: '../evil.md', content: 'malicious payload', method: 0 },
    ]);

    const resTraversal = await reviewUpload(
      h,
      '/books/sal/notion-import',
      token,
      traversalZip,
      { 'x-notion-mapping': encodeURIComponent(JSON.stringify({ database: 'Capitulos.csv' })) }
    );
    assert.equal(resTraversal.status, 400);
    const bodyTraversal = await resTraversal.json();
    assert.ok(
      bodyTraversal.error?.includes('traversal') || bodyTraversal.detail?.includes('traversal'),
      `error message must mention traversal: ${JSON.stringify(bodyTraversal)}`
    );

    // 2. Zip bomb / member expansion attack (decompressed size exceeds declared)
    const bombZip = buildSyntheticZip([
      {
        name: 'Capitulos.csv',
        content: 'Título,Orden\n"Bomb",1',
        method: 8,
      },
      {
        name: 'Bomb.md',
        content: Buffer.alloc(50000, 'A'),
        method: 8,
        declaredUncompressedSize: 10, // lie about uncompressed size
      },
    ]);

    const resBomb = await reviewUpload(
      h,
      '/books/sal/notion-import',
      token,
      bombZip,
      { 'x-notion-mapping': encodeURIComponent(JSON.stringify({ database: 'Capitulos.csv' })) }
    );
    assert.equal(resBomb.status, 400);
    const bodyBomb = await resBomb.json();
    assert.ok(
      bodyBomb.error || bodyBomb.detail,
      `error message must be present: ${JSON.stringify(bodyBomb)}`
    );

    // Ensure nothing was written
    const afterScenes = h.library.open('sal', 'user_fran').scenes();
    assert.deepEqual(afterScenes, initialScenes);
  } finally {
    h.close();
  }
});

test('multipart upload and alternative routes work, reporting missing page in refused', async () => {
  const h = await startHarness();
  try {
    const token = await h.session('user_fran');

    // Create export with a missing page for chapter 2
    const files = [
      {
        name: 'Capitulos.csv',
        content: 'Título,Orden,Libro\n"Capítulo Uno",1,"Libro A"\n"Capítulo Dos",2,"Libro A"',
        method: 0,
      },
      {
        name: 'Capítulo Uno.md',
        content: '# Capítulo Uno\n\nTexto del primer capítulo.',
        method: 0,
      },
      // Capítulo Dos.md is missing!
    ];
    const zip = buildSyntheticZip(files);

    // 1. Inspect via /books/sal/notion/inspect using multipart
    const fdInspect = new FormData();
    fdInspect.append('file', new Blob([zip]), 'export.zip');
    const resInspect = await fetch(`${h.base}/review/api/books/sal/notion/inspect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: fdInspect,
    });
    assert.equal(resInspect.status, 200);
    const inspectData = await resInspect.json();
    assert.equal(inspectData.databases.length, 1);
    assert.equal(inspectData.pages.length, 1);

    // 2. Dry run via /books/sal/notion/preview using multipart
    const fdDry = new FormData();
    fdDry.append('file', new Blob([zip]), 'export.zip');
    fdDry.append('mapping', JSON.stringify({ database: 'Capitulos.csv' }));
    fdDry.append('dryRun', 'true');
    const resDry = await fetch(`${h.base}/review/api/books/sal/notion/preview`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: fdDry,
    });
    assert.equal(resDry.status, 200);
    const dryData = await resDry.json();
    assert.equal(dryData.dryRun, true);
    assert.equal(dryData.chapters.length, 2);
    assert.equal(dryData.chapters[0].status, 'would_import');
    assert.equal(dryData.chapters[1].status, 'missing_page');

    // 3. Import via /books/sal/notion/import using multipart
    const fdImport = new FormData();
    fdImport.append('file', new Blob([zip]), 'export.zip');
    fdImport.append('mapping', JSON.stringify({ database: 'Capitulos.csv' }));
    const resImport = await fetch(`${h.base}/review/api/books/sal/notion/import`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: fdImport,
    });
    assert.equal(resImport.status, 200);
    const importData = await resImport.json();
    assert.equal(importData.imported.length, 1);
    assert.equal(importData.imported[0].file, 'scenes/001-capitulo-uno.md');
    assert.equal(importData.refused.length, 1);
    assert.equal(importData.refused[0].order, 2);
    assert.ok(importData.refused[0].reason.includes('missing page file'));
  } finally {
    h.close();
  }
});
