'use strict';

// Explicit evaluation command; no production server, browser profile, or user database is opened.
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const http: typeof import('node:http') = require('node:http');
const { performance }: typeof import('node:perf_hooks') = require('node:perf_hooks');
const { chromium }: typeof import('@playwright/test') = require('@playwright/test');
const { build }: typeof import('esbuild') = require('esbuild');
const { openArtworkCandidate }: typeof import('./artwork-sqlite') = require('./artwork-sqlite');

const appRoot = path.resolve(__dirname, '../../..');
const histories = (count: any) => Array.from({ length: count }, (_, index) => ({
  id: `work-${index}`, image_id: `image-${index}`, favorite: false,
  prompt: 'Synthetic isolated benchmark metadata. '.repeat(8), created_at: 1_700_000_000_000 + index,
}));
const timed = (action: any) => { const start = performance.now(); action(); return performance.now() - start; };

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-storage-benchmark-'));
  const bundle = await build({
    stdin: { contents: [
      "export * from './src/storage/artworkRepository.ts';",
      "export * from './src/composables/useKVStore.ts';",
      "export * from './src/composables/useImageStore.ts';",
    ].join('\n'), resolveDir: appRoot },
    bundle: true, write: false, format: 'iife', globalName: 'storageFixture', platform: 'browser', logLevel: 'silent',
  });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html');
    response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].text : '<!doctype html><script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find(file => fs.existsSync(file));
  let browser;
  const report: any = {
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    method: 'Three sequential trials per size, fresh private browser context and SQLite directory. No network IPC for SQLite. Durability policies differ; timings do not establish a production speedup.',
    metadata: [], media: [],
  };
  try {
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });
    report.environment.browser = browser.version();
    for (const count of [1_000, 10_000]) {
      for (let trial = 0; trial < 3; trial += 1) {
        const history = histories(count);
        const projects = [{ id: 'project', history_ids: history.slice(0, 10).map(entry => entry.id) }];
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          const indexedDB = await page.evaluate(async ({ history, projects }: any) => {
            const api = window.storageFixture;
            const start = performance.now();
            await api.kvSetMany([
              { key: api.ARTWORK_HISTORY_KEY, value: history },
              { key: api.ARTWORK_PROJECTS_KEY, value: projects },
              { key: api.ARTWORK_TRASH_KEY, value: [] },
            ]);
            const publishMs = performance.now() - start;
            const patchStart = performance.now();
            for (let index = 0; index < 30; index += 1) await api.artworkRepository.patchArtwork(`work-${index}`, { favorite: true });
            const patch30Ms = performance.now() - patchStart;
            const readStart = performance.now();
            const result = await api.kvGet(api.ARTWORK_HISTORY_KEY);
            return { publishMs, patch30Ms, readAllMs: performance.now() - readStart, count: result.length, favorite: result.filter((entry: any) => entry.favorite).length };
          }, { history, projects });
          const candidate = openArtworkCandidate(path.join(root, `metadata-${count}-${trial}`));
          let sqlite;
          try {
            const publishMs = timed(() => candidate.publishMetadata(history, projects, []));
            const patch30Ms = timed(() => { for (let index = 0; index < 30; index += 1) candidate.patch(`work-${index}`, { favorite: true }); });
            let result: any;
            const readAllMs = timed(() => { result = candidate.history(); });
            sqlite = { publishMs, patch30Ms, readAllMs, count: result.length, favorite: result.filter((entry: any) => entry.favorite).length };
          } finally { candidate.close(); }
          assert.equal(indexedDB.count, count); assert.equal(sqlite.count, count);
          assert.equal(indexedDB.favorite, 30); assert.equal(sqlite.favorite, 30);
          report.metadata.push({ count, trial, indexedDB, sqlite });
        } finally { await context.close(); }
      }
    }
    for (let trial = 0; trial < 3; trial += 1) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const indexedDB = await page.evaluate(async () => {
          const api = window.storageFixture;
          const images = Array.from({ length: 64 }, (_, index) => ({
            id: `image-${index}`, blob: new Blob([new Uint8Array(256 * 1024).fill(index)]),
            thumbnail: 'data:image/jpeg;base64,' + globalThis.btoa(String.fromCharCode(...new Uint8Array(16 * 1024).fill(index))),
          }));
          const start = performance.now();
          for (const image of images) {
            await api.imgPutRecord(image);
            await api.kvSet(`thumb:${image.id}`, image.thumbnail);
          }
          const publishMs = performance.now() - start;
          const readStart = performance.now();
          let bytes = 0;
          for (const image of images) {
            bytes += (await (await api.imgGetRecord(image.id)).blob.arrayBuffer()).byteLength;
            bytes += globalThis.atob((await api.kvGet(`thumb:${image.id}`)).split(',')[1]).length;
          }
          return { publishMs, readAllMs: performance.now() - readStart, bytes };
        });
        const images = Array.from({ length: 64 }, (_, index) => [
          { id: `image-${index}`, bytes: Buffer.alloc(256 * 1024, index) },
          { id: `thumb-${index}`, bytes: Buffer.alloc(16 * 1024, index) },
        ]).flat();
        const candidate = openArtworkCandidate(path.join(root, `media-${trial}`));
        let sqlite;
        try {
          const publishMs = timed(() => candidate.importSnapshot('benchmark', { history: [], projects: [], trash: [], images }));
          let bytes = 0;
          const readAllMs = timed(() => { for (const image of images) bytes += candidate.readImage(image.id).length; });
          sqlite = { publishMs, readAllMs, bytes };
        } finally { candidate.close(); }
        assert.equal(indexedDB.bytes, 64 * 272 * 1024); assert.equal(sqlite.bytes, indexedDB.bytes);
        report.media.push({ originals: 64, originalBytes: 262144, thumbnailBytes: 16384, trial, indexedDB, sqlite });
      } finally { await context.close(); }
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aics-storage-benchmark-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
