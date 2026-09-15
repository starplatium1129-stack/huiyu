'use strict';

import { PathOrFileDescriptor } from 'node:fs';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const http: typeof import('node:http') = require('node:http');
const zlib: typeof import('node:zlib') = require('node:zlib');
const express: typeof import('express') = require('express');
const { precompressed }: typeof import('../../server/precompressed') = require('../../server/precompressed');

async function fixture(run: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-compression-'));
  const assets = path.join(root, 'external-assets');
  fs.mkdirSync(assets); fs.mkdirSync(path.join(root, 'data'));
  const write = (file: PathOrFileDescriptor, value = '{"version":1}', compressed = true) => {
    fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, value);
    if (compressed) { fs.writeFileSync(file + '.br', zlib.brotliCompressSync(Buffer.from(value))); fs.writeFileSync(file + '.gz', zlib.gzipSync(value)); }
  };
  const app = express();
  app.use((req, res, next) => { res.vary('Origin'); next(); });
  app.use(precompressed(root, { assetsRoot:assets }));
  app.use('/assets', express.static(assets, { dotfiles:'deny' }));
  app.use('/data', (req, res, next) => { if (!(require('../../server/public-data') as typeof import('../../server/public-data')).includes(req.path.slice(1))) return res.sendStatus(404); next(); }, express.static(path.join(root, 'data')));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = (url: unknown, accept: unknown) => new Promise((resolve, reject) => {
    http.get({ host:'127.0.0.1', port:server.address().port, path:url, headers:{ 'Accept-Encoding':accept } }, res => {
      const chunks: any = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks), encoding = res.headers['content-encoding'];
        const body = encoding === 'br' ? zlib.brotliDecompressSync(bytes) : encoding === 'gzip' ? zlib.gunzipSync(bytes) : bytes;
        resolve({ status:res.statusCode, headers:res.headers, body:body.toString() });
      });
    }).on('error', reject);
  });
  try { await run({ root, assets, write, get }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive:true, force:true }); }
}

test('compression negotiation respects quality, exclusions, and existing Vary values', async () => fixture(async ({ assets, write, get }: any) => {
  write(path.join(assets, 'sample.json'));
  const gzip = await get('/assets/sample.json', 'br;q=0, gzip;q=1');
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.match(gzip.headers.vary, /Origin/); assert.match(gzip.headers.vary, /Accept-Encoding/);
  assert.equal((await get('/assets/sample.json', 'br;q=.2, gzip;q=.9')).headers['content-encoding'], 'gzip');
  const plain = await get('/assets/sample.json', 'br;q=0, gzip;q=0');
  assert.equal(plain.headers['content-encoding'], undefined); assert.equal(plain.body, '{"version":1}');
}));

test('stale or missing compressed variants fall back without serving old content', async () => fixture(async ({ assets, write, get }: any) => {
  const file = path.join(assets, 'sample.json'); write(file); fs.unlinkSync(file + '.br');
  assert.equal((await get('/assets/sample.json', 'br, gzip')).headers['content-encoding'], 'gzip');
  fs.writeFileSync(file, '{"version":2}'); const future = new Date(Date.now() + 3000); fs.utimesSync(file, future, future);
  const fresh = await get('/assets/sample.json', 'br, gzip');
  assert.equal(fresh.headers['content-encoding'], undefined); assert.equal(fresh.body, '{"version":2}');
  fs.unlinkSync(file); assert.equal((await get('/assets/sample.json', 'gzip')).status, 404);
}));

test('compressed assets keep source boundaries and mutable-data cache policy', async () => fixture(async ({ root, assets, write, get }: any) => {
  write(path.join(root, 'assets', 'sample.json'), '{"wrong":true}'); write(path.join(assets, 'sample.json'), '{"right":true}');
  assert.equal((await get('/assets/sample.json', 'br')).body, '{"right":true}');
  write(path.join(assets, '.hidden', 'secret.json'));
  assert.notEqual((await get('/assets/.hidden/secret.json', 'br')).status, 200);
  write(path.join(root, 'data', 'character-reference-view.json'));
  assert.equal((await get('/data/character-reference-view.json', 'br')).headers['cache-control'], 'no-cache');
  write(path.join(root, 'data', 'private.json'));
  assert.equal((await get('/data/private.json', 'br')).status, 404);
}));
