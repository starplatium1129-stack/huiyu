'use strict';

import { ReadStream } from 'node:fs';
import { Server,IncomingMessage,ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
const { once }: typeof import('node:events') = require('node:events');
const zlib: typeof import('node:zlib') = require('node:zlib');
const express: typeof import('express') = require('express');
const compression: typeof import('compression') = require('compression');
const { precompressed }: typeof import('../../server/precompressed') = require('../../server/precompressed');
const { maintenanceReadBarrier }: typeof import('../../routes/maintenance-read-barrier') = require('../../routes/maintenance-read-barrier');
const { acquireMaintenanceLease }: typeof import('../lib/maintenance-lease') = require('../lib/maintenance-lease');
const { previewMaintenanceRecovery, applyMaintenanceRecovery }: typeof import('../lib/maintenance-recovery') = require('../lib/maintenance-recovery');
const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
const { createFixture, spawnWorker, tree }: typeof import('./maintenance-recovery-fixture') = require('./maintenance-recovery-fixture');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function application(f: any, position: string) {
  const body = Buffer.from(JSON.stringify({ neutral: 'plain test content '.repeat(256) }));
  const source = io.path.join(f.options.rootDir, 'data/scenes.json');
  io.fs.writeFileSync(source, body);
  io.fs.writeFileSync(source + '.gz', zlib.gzipSync(body));
  io.fs.writeFileSync(source + '.br', zlib.brotliCompressSync(body));
  const app = express();
  const started = deferred();
  const finish = deferred();
  app.use((req, res, next) => req.headers['x-fixture-deny'] ? res.status(403).end('authorization denied') : next());
  const fence = maintenanceReadBarrier(f.options);
  const callbackProbe = (_req: any, res: any) => {
    res.setHeader('Content-Type', 'application/json');
    const buffer = Buffer.from('{"copied":true}');
    res.write(buffer, () => { buffer.fill(0); res.end(); });
  };
  if (position === 'before-compression') app.use('/data', fence);
  // Test callbacks at the barrier's input. The installed compression middleware
  // itself drops write callbacks; its real encoding paths are tested separately.
  if (position === 'before-compression') app.get('/data/callback.json', callbackProbe);
  app.use(compression({ threshold: 0 }));
  if (position === 'after-compression') app.use('/data', fence);
  if (position === 'after-compression') app.get('/data/callback.json', callbackProbe);
  app.use(precompressed(f.options.rootDir));
  // The existing router may still install its local fallback. It must be harmless.
  app.use('/data', fence);
  app.get('/data/delayed.json', (_req, res) => {
    res.writeHead(200, 'OK', { 'Content-Type': 'application/json', 'ETag': '"old"' });
    res.flushHeaders();
    res.write('{"old":');
    started.resolve!(res);
    finish.promise.then(() => res.end('true}'));
  });
  app.use('/data', express.static(io.path.join(f.options.rootDir, 'data')));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    source, body, started, finish,
    get(url: any = '/data/scenes.json', headers: any = {}, method: any = 'GET', onResponse: any = () => {}) {
      return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: server.address!().port, path: url, headers, method, agent: false }, response => {
          onResponse(response);
          const chunks: any = [];
          response.on('data', chunk => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.setTimeout(15000, () => request.destroy(new Error('fixture HTTP timeout: ' + position + ' ' + method + ' ' + url + ' ' + JSON.stringify(headers))));
        request.once('error', reject);
        request.end();
      });
    },
    async close() { finish.resolve!(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
function decode(response: any) {
  if (response.headers['content-encoding'] === 'gzip') return zlib.gunzipSync(response.body);
  if (response.headers['content-encoding'] === 'br') return zlib.brotliDecompressSync(response.body);
  return response.body;
}

for (const position of ['before-compression', 'after-compression']) {
  test(position + ': precompressed gzip/br, dynamic gzip, HEAD, 304, Range and callbacks remain valid', async () => {
    const f = createFixture();
    const app = await application(f, position);
    try {
      const initial = tree(f.base);
      for (const [encoding, extension] of [['gzip', '.gz'], ['br', '.br']]) {
        const response: any = await app.get(undefined, { 'accept-encoding': encoding });
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], encoding);
        assert.deepEqual(response.body, io.fs.readFileSync(app.source + extension), 'serve the actual precompressed sibling');
        assert.deepEqual(decode(response), app.body);
        const head: any = await app.get(undefined, { 'accept-encoding': encoding }, 'HEAD');
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
      }
      assert.deepEqual(tree(f.base), initial, 'normal reads create no metadata');
      io.fs.unlinkSync(app.source + '.gz');
      io.fs.unlinkSync(app.source + '.br');
      const dynamic: any = await app.get(undefined, { 'accept-encoding': 'gzip' });
      assert.equal(dynamic.headers['content-encoding'], 'gzip');
      assert.deepEqual(decode(dynamic), app.body);
      const plain: any = await app.get(undefined, { 'accept-encoding': 'identity' });
      assert.deepEqual(plain.body, app.body);
      const cached: any = await app.get(undefined, { 'accept-encoding': 'identity', 'if-none-match': plain.headers.etag });
      assert.equal(cached.status, 304);
      assert.equal(cached.body.length, 0);
      const range: any = await app.get(undefined, { 'accept-encoding': 'identity', range: 'bytes=0-15' });
      assert.equal(range.status, 206);
      assert.deepEqual(range.body, app.body.subarray(0, 16));
      assert.match(range.headers['content-range'], /^bytes 0-15\//);
      const callback = await app.get('/data/callback.json', { 'accept-encoding': 'gzip' });
      assert.deepEqual(JSON.parse(decode(callback)), { copied: true });
      assert.equal((await app.get(undefined, { 'x-fixture-deny': '1' })).status, 403);
    } finally { await app.close(); f.cleanup(); }
  });

  test(position + ': explicit writeHead/flushHeaders cannot leak an in-flight response on conflict', async () => {
    const f = createFixture();
    const app = await application(f, position);
    try {
      let sent = false;
      const reading = app.get('/data/delayed.json', { 'accept-encoding': 'gzip' }, 'GET', () => { sent = true; });
      const res: any = await app.started.promise;
      const lease = acquireMaintenanceLease(f.options);
      lease.release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sent, false, 'headers must remain private until the read fence passes');
      assert.equal(res.headersSent, false);
      app.finish.resolve!();
      const rejected: any = await reading;
      assert.equal(rejected.status, 409);
      assert.equal(rejected.headers['content-encoding'], undefined);
      assert.equal(rejected.headers.etag, undefined);
      assert.match(rejected.headers['cache-control'], /no-store/);
      const payload = JSON.parse(rejected.body);
      assert.equal(payload.code, 'MAINTENANCE_CONFLICT');
      assert.equal(payload.old, undefined);
    } finally { await app.close(); f.cleanup(); }
  });

  for (const [encoding, extension] of [['identity', ''], ['gzip', '.gz'], ['br', '.br']]) {
    test(position + ': real ' + encoding + ' file stream is fenced across another process write and SIGKILL', async () => {
      const f: any = createFixture();
      const app = await application(f, position);
      const createReadStream = io.fs.createReadStream;
      const started = deferred();
      let paused: ReadStream;
      let streamClosed: any;
      let worker;
      let reading;
      try {
        const original = tree(f.options.rootDir, true);
        io.fs.createReadStream = (file, options) => {
          const selected = io.samePath(String(file), app.source + extension) && !paused;
          const stream = createReadStream(file, selected ? { ...options, highWaterMark: 8 } : options);
          if (selected) {
            paused = stream;
            streamClosed = once(stream, 'close');
            streamClosed.catch(() => {});
            stream.once('data', () => { stream.pause(); started.resolve!(); });
          }
          return stream;
        };
        let sent = false;
        reading = app.get(undefined, { 'accept-encoding': encoding }, 'GET', () => { sent = true; });
        reading.catch(() => {});
        await started.promise;
        f.options.readOpenTarget = app.source + extension;
        worker = await spawnWorker(f, 'stream-race');
        assert.equal(worker.message.status, 'ready');
        if (worker.message.writeBlocked) {
          assert.equal(process.platform, 'win32');
          assert.ok(['EPERM', 'EBUSY'].includes(worker.message.writeBlocked.code));
          assert.ok(io.samePath(worker.message.writeBlocked.target, app.source + extension));
        }
        assert.equal(io.fs.readFileSync(f.files[0], 'utf8'), 'partial-source', 'real source writes precede the checkpoint, even when Windows blocks replacement of an open product');
        const active: any = await app.get(undefined, { 'accept-encoding': 'gzip' });
        assert.equal(active.status, 409);
        assert.equal(JSON.parse(decode(active)).code, 'MAINTENANCE_BUSY');
        await worker.stop();
        assert.equal(sent, false, 'not even a success header is sent from the paused file');
        paused.resume();
        const rejected: any = await reading;
        await streamClosed;
        assert.equal(rejected.status, 409);
        assert.equal(rejected.headers['content-encoding'], undefined, 'discard compressed chunks and old encoding together');
        assert.equal(JSON.parse(rejected.body).code, 'MAINTENANCE_RECOVERY_REQUIRED');
        const stale: any = await app.get(undefined, { 'accept-encoding': 'gzip' });
        assert.equal(stale.status, 409);
        assert.equal(applyMaintenanceRecovery(f.options, previewMaintenanceRecovery(f.options)).ok, true);
        assert.deepEqual(tree(f.options.rootDir, true), original);
        const recovered: any = await app.get(undefined, { 'accept-encoding': encoding });
        assert.equal(recovered.status, 200);
        assert.deepEqual(decode(recovered), app.body);
      } finally {
        io.fs.createReadStream = createReadStream;
        if (paused) paused.destroy();
        if (worker) await worker.stop();
        await app.close();
        if (reading) await reading.catch(() => {});
        if (streamClosed) await streamClosed.catch(() => {});
        f.cleanup();
      }
    });
  }
}

test('actual gateway early barrier protects gzip/br and showcase across a real writer SIGKILL', async () => {
  const f: any = createFixture();
  const previousEnv = { AICS_DATA_ROOT: process.env.AICS_DATA_ROOT, AICS_APP_ROOT: process.env.AICS_APP_ROOT };
  let stack: any;
  let worker;
  try {
    process.env.AICS_DATA_ROOT = f.options.rootDir;
    process.env.AICS_APP_ROOT = f.options.rootDir;
    const body = Buffer.from(JSON.stringify({ neutral: 'gateway fixture content '.repeat(256) }));
    io.fs.writeFileSync(f.files[4], body);
    io.fs.writeFileSync(f.files[5], zlib.gzipSync(body));
    io.fs.writeFileSync(f.files[6], zlib.brotliCompressSync(body));
    const showcase = io.path.join(f.base, 'showcase');
    io.fs.mkdirSync(io.path.join(showcase, 'images'), { recursive: true });
    const image = io.path.join(showcase, 'images/sc001.jpg');
    io.fs.writeFileSync(image, 'neutral showcase fixture');
    f.options.showcaseRoot = showcase;
    f.options.additionalFiles = [image];
    stack = await (require('./gateway-test-stack') as typeof import('./gateway-test-stack')).start({
      runtimeRoot: f.options.runtimeRoot, cleanupRuntime: false,
      env: { AICS_APP_ROOT: f.options.rootDir, AICS_RESOURCE_CONFIG: '', AICS_RESOURCE_MANAGEMENT: '0' },
      configureConfig(config: any) {
        Object.assign(config, { ROOT_DIR: f.options.rootDir, RUNTIME_ROOT: f.options.runtimeRoot,
          ASSETS_ROOT: io.path.join(f.options.rootDir, 'assets'), LIVE2D_ROOT: io.path.join(f.options.rootDir, 'assets/live2d'),
          CHARACTER_REF_ROOT: '', SCENE_SHOWCASE_DIR: showcase, DESKTOP_PACKAGED: false,
          RESOURCE_CONFIG_PATH: '', RESOURCE_MANAGEMENT: false });
      },
    });
    const request = (url: string, encoding: string, headers: any = {}) => new Promise((resolve, reject) => {
      const req = http.get(stack.baseUrl + url, { agent: false, headers: { 'accept-encoding': encoding, ...headers } }, res => {
        const chunks: any = [];
        res.on('data', chunk => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(10000, () => req.destroy(new Error('gateway barrier fixture request timed out')));
      req.once('error', reject);
    });
    for (const encoding of ['identity', 'gzip', 'br']) {
      const response: any = await request('/data/scenes.json', encoding);
      assert.equal(response.status, 200);
      assert.deepEqual(decode(response), body);
      if (encoding !== 'identity') assert.deepEqual(response.body, io.fs.readFileSync(encoding === 'gzip' ? f.files[5] : f.files[6]));
    }
    assert.equal((await request('/scene-showcase/images/sc001.jpg', 'identity')).status, 200);
    const original = tree(f.options.rootDir, true);
    const originalShowcase = tree(showcase);
    worker = await spawnWorker(f);
    assert.equal(worker.message.status, 'ready');
    assert.equal((await request('/data/scenes.json', 'gzip', { Host: 'evil.invalid' })).status, 421, 'host authorization remains ahead of the barrier');
    for (const encoding of ['identity', 'gzip', 'br']) {
      const response: any = await request('/data/scenes.json', encoding);
      assert.equal(response.status, 409);
      assert.equal(JSON.parse(decode(response)).code, 'MAINTENANCE_BUSY');
    }
    assert.equal((await request('/scene-showcase/images/sc001.jpg', 'identity')).status, 409);
    await worker.stop();
    for (const encoding of ['identity', 'gzip', 'br']) {
      const response: any = await request('/data/scenes.json', encoding);
      assert.equal(response.status, 409);
      assert.equal(JSON.parse(decode(response)).code, 'MAINTENANCE_RECOVERY_REQUIRED');
    }
    assert.equal((await request('/scene-showcase/images/sc001.jpg', 'identity')).status, 409);
    const result = applyMaintenanceRecovery(f.options, previewMaintenanceRecovery(f.options));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(tree(f.options.rootDir, true), original);
    assert.deepEqual(tree(showcase), originalShowcase);
    for (const encoding of ['gzip', 'br']) assert.deepEqual(decode(await request('/data/scenes.json', encoding)), body);
    assert.equal((await request('/scene-showcase/images/sc001.jpg', 'identity')).status, 200);
  } finally {
    if (worker) await worker.stop();
    if (stack) { await stack.gateway.services.resources.close(); await stack.close(); }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    f.cleanup();
  }
});
