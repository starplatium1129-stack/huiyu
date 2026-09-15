'use strict';

const { test } = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { fs, path, assert, write, snapshot, fixture, code } = require('./resource-install-fixtures');
const { createResourceDownloader } = require('../lib/resource-download');
const { killAt } = require('./resource-install-process');

async function fixtureHttp(t) {
  const f = fixture(t, { large: true });
  const files = new Map();
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, prefix + entry.name + '/');
      else files.set(prefix + entry.name, fs.readFileSync(file));
    }
  };
  walk(f.packs, '/');
  const state = { mode: 'normal', requests: [], etag: '"fixture-v1"' };
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, range: req.headers.range, ifRange: req.headers['if-range'] });
    let bytes = files.get(req.url);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    const metadata = req.url.endsWith('.json');
    const big = req.url.endsWith('/assets/new.bin');
    if (metadata && state.mode === 'redirect') {
      res.writeHead(302, { location: '/not-approved' }); res.end(); return;
    }
    if (metadata && state.mode === 'bad-metadata') bytes = Buffer.concat([bytes, Buffer.from('\n')]);
    if (metadata && state.mode === 'oversize-metadata') {
      res.writeHead(200, { 'content-length': 17 * 1024 * 1024 }); res.end(); return;
    }
    if (big && state.mode === 'timeout') return;
    if (big && state.mode === 'corrupt') bytes = Buffer.alloc(bytes.length, 88);
    let offset = 0;
    let status = 200;
    const headers = { etag: state.etag, 'content-type': 'application/octet-stream' };
    if (big && req.headers.range && state.mode !== 'ignore-range' && state.mode !== 'if-range-restart') {
      offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range)?.[1]);
      status = 206;
      const start = state.mode === 'bad-range' ? offset + 1 : offset;
      headers['content-range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
    }
    if (big && state.mode === 'encoded') headers['content-encoding'] = 'gzip';
    if (big && state.mode === 'not-found') { res.writeHead(404); res.end(); return; }
    headers['content-length'] = bytes.length - offset;
    res.writeHead(status, headers);
    if (big && state.mode === 'disconnect-once') {
      state.mode = 'normal';
      res.write(bytes.subarray(offset, offset + 128 * 1024));
      const timeout = setTimeout(() => res.destroy(), 25);
      res.on('close', () => clearTimeout(timeout));
      return;
    }
    if (!big) { res.end(bytes); return; }
    let cursor = offset;
    let timer;
    const send = () => {
      if (res.destroyed) return;
      if (cursor >= bytes.length) { res.end(); return; }
      const end = Math.min(cursor + 64 * 1024, bytes.length);
      const drained = res.write(bytes.subarray(cursor, end));
      cursor = end;
      if (drained) timer = setTimeout(send, 1);
      else res.once('drain', () => { timer = setTimeout(send, 1); });
    };
    res.on('close', () => clearTimeout(timer));
    send();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  f.policy.sources.fixture = { kind: 'http', approved: true, loopbackFixture: true,
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/' };
  for (const id of ['full', 'delta']) f.policy.releases[id].sourceId = 'fixture';
  f.download = (extra = {}) => createResourceDownloader(f.options(extra));
  return { ...f, state, files };
}
async function cancelPartial(f) {
  const controller = new AbortController();
  await assert.rejects(f.download({ onEvent: e => {
    if (e.phase === 'download-progress' && e.path === 'assets/new.bin') controller.abort();
  } }).download({ releaseId: 'full', signal: controller.signal }), code('CANCELLED'));
}
const assetRequests = f => f.state.requests.filter(request => request.url.endsWith('/assets/new.bin'));

test('loopback download produces a verified offline package; install remains explicit and repeat has no network', async t => {
  const f = await fixtureHttp(t);
  const downloaded = await f.download().download({ releaseId: 'full' });
  assert.equal(downloaded.installed, false);
  assert.equal((await f.installer().status()).state.current, null);
  const count = f.state.requests.length;
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'already-downloaded');
  assert.equal(f.state.requests.length, count);
  assert.equal((await f.installer().install({ releaseId: 'full' })).action, 'installed');
  assert.equal((await f.installer().status()).verifiedFiles, 3);
});

test('HTTP delta download uses existing installed baseline and preserves old files', async t => {
  const f = await fixtureHttp(t);
  const old = await f.installer().install({ releaseId: 'base' });
  await f.download().download({ releaseId: 'delta' });
  const next = await f.installer().install({ releaseId: 'delta' });
  assert.equal(fs.existsSync(path.join(next.installedRoot, 'assets/removed.txt')), false);
  assert.equal(fs.existsSync(path.join(old.installedRoot, 'assets/removed.txt')), true);
  assert.ok(f.state.requests.every(request => !request.url.endsWith('/assets/keep.bin')));
});

test('cancel and resume send Range/If-Range and rehash final bytes', async t => {
  const f = await fixtureHttp(t);
  await cancelPartial(f);
  const result = await f.download().download({ releaseId: 'full' });
  const resumed = assetRequests(f).find(request => request.range);
  assert.match(resumed.range, /^bytes=[1-9]\d*-$/);
  assert.equal(resumed.ifRange, '"fixture-v1"');
  assert.equal(fs.statSync(path.join(result.packRoot, 'assets/new.bin')).size, 3 * 1024 * 1024);
});

test('ignored range restarts instead of appending a full response to partial data', async t => {
  const f = await fixtureHttp(t);
  await cancelPartial(f);
  f.state.mode = 'ignore-range';
  const downloaded = await f.download().download({ releaseId: 'full' });
  assert.equal(fs.statSync(path.join(downloaded.packRoot, 'assets/new.bin')).size, 3 * 1024 * 1024);
  assert.ok(assetRequests(f).some(request => request.range));
});

test('invalid Content-Range is rejected; valid retry recovers unchanged partial data', async t => {
  const f = await fixtureHttp(t);
  await cancelPartial(f);
  f.state.mode = 'bad-range';
  await assert.rejects(f.download().download({ releaseId: 'full' }), code('HTTP_RANGE'));
  f.state.mode = 'normal';
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
});

test('ETag mismatch in 206 is rejected; full 200 response safely replaces partial bytes', async t => {
  const f = await fixtureHttp(t);
  await cancelPartial(f);
  f.state.etag = '"fixture-v2"';
  await assert.rejects(f.download().download({ releaseId: 'full' }), code('HTTP_RANGE'));
  f.state.mode = 'if-range-restart';
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
});

test('disconnected response retains bytes and retries with a range', async t => {
  const f = await fixtureHttp(t);
  f.state.mode = 'disconnect-once';
  await assert.rejects(f.download().download({ releaseId: 'full' }));
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
  assert.ok(assetRequests(f).some(request => request.range));
});

test('killed download process resumes from durable partial bytes and reclaims its stale lock', async t => {
  const f = await fixtureHttp(t);
  await killAt(f.config(), 'download-progress', 'download', 'full');
  // The first progress event may be a small file; any completed/partial entry is revalidated.
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
  assert.equal((await f.installer().install({ releaseId: 'full' })).action, 'installed');
});

test('corrupt response never activates resources; retry succeeds without disturbing old install', async t => {
  const f = await fixtureHttp(t);
  const old = await f.installer().install({ releaseId: 'base' });
  f.state.mode = 'corrupt';
  await assert.rejects(f.download().download({ releaseId: 'full' }), code('CONTENT_INVALID'));
  assert.deepEqual((await f.installer().status()).state, old.state);
  f.state.mode = 'normal';
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
});

test('completed cache is checked against disk and repairs corrupt files on an explicit retry', async t => {
  const f = await fixtureHttp(t);
  const downloaded = await f.download().download({ releaseId: 'full' });
  write(path.join(downloaded.packRoot, 'assets/new.bin'), Buffer.alloc(3 * 1024 * 1024, 9));
  const count = assetRequests(f).length;
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
  assert.equal(assetRequests(f).length, count + 1);
});

test('metadata fingerprint, metadata limits and redirects fail closed without following new locations', async t => {
  const f = await fixtureHttp(t);
  for (const [mode, expected] of [['bad-metadata', 'PACKAGE_UNAPPROVED'], ['oversize-metadata', 'HTTP_SIZE'], ['redirect', 'REDIRECT_REJECTED']]) {
    f.state.mode = mode;
    await assert.rejects(f.download().download({ releaseId: 'full' }), code(expected));
  }
  assert.ok(f.state.requests.every(request => request.url.endsWith('/manifest.json')));
  assert.equal((await f.installer().status()).state.current, null);
});

test('encoding, 404 and timeout do not report downloaded/installed success', async t => {
  const f = await fixtureHttp(t);
  for (const [mode, expected] of [['encoded', 'HTTP_ENCODING'], ['not-found', 'HTTP_STATUS'], ['timeout', 'HTTP_TIMEOUT']]) {
    f.state.mode = mode;
    await assert.rejects(f.download({ timeoutMs: 250 }).download({ releaseId: 'full' }), code(expected));
  }
  f.state.mode = 'normal';
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
});

test('missing approvals and unapproved non-loopback HTTP sources cause zero network requests', async t => {
  const f = await fixtureHttp(t);
  f.policy.releases.full.approved = false;
  await assert.rejects(f.download().download({ releaseId: 'full' }), code('APPROVAL_REQUIRED'));
  f.policy.releases.full.approved = true;
  f.policy.sources.fixture.baseUrl = 'http://unapproved.invalid/resources/';
  await assert.rejects(f.download().download({ releaseId: 'full' }), code('UNSAFE_SOURCE'));
  assert.equal(f.state.requests.length, 0);
  assert.deepEqual(fs.readdirSync(f.user), []);
});

test('download ENOSPC keeps installed resources and permits retry', async t => {
  const f = await fixtureHttp(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const io = Object.create(fs);
  const files = new Map();
  io.openSync = (file, ...args) => { const fd = fs.openSync(file, ...args); files.set(fd, String(file)); return fd; };
  io.writeSync = (fd, ...args) => {
    if (files.get(fd)?.endsWith('.part')) throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
    return fs.writeSync(fd, ...args);
  };
  await assert.rejects(f.download({ io }).download({ releaseId: 'full' }), code('ENOSPC'));
  assert.deepEqual((await f.installer().status()).state, old.state);
  assert.equal((await f.download().download({ releaseId: 'full' })).action, 'downloaded');
});

test('download and installation share a lock; cancellation releases it without losing the old install', async t => {
  const f = await fixtureHttp(t);
  const old = await f.installer().install({ releaseId: 'base' });
  let entered;
  let resume;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const controller = new AbortController();
  const running = f.download({ onEvent: async e => {
    if (e.phase === 'download-progress') { entered(); await gate; }
  } }).download({ releaseId: 'full', signal: controller.signal });
  const rejected = assert.rejects(running, code('CANCELLED'));
  await started;
  await assert.rejects(f.installer().install({ releaseId: 'base' }), code('BUSY'));
  controller.abort();
  resume();
  await rejected;
  assert.deepEqual((await f.installer().status()).state, old.state);
});

test('junction in download partial storage is rejected without writing artwork', async t => {
  const f = await fixtureHttp(t);
  await cancelPartial(f);
  const directory = path.join(f.download().root, 'downloads', f.policy.releases.full.packageIdentity);
  const parts = path.join(directory, 'parts');
  fs.renameSync(parts, parts + '-saved');
  fs.symlinkSync(f.artwork, parts, 'junction');
  const before = snapshot(f.artwork);
  await assert.rejects(f.download().download({ releaseId: 'full' }), code('UNSAFE_LINK'));
  assert.deepEqual(snapshot(f.artwork), before);
});
