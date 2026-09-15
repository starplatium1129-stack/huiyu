'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { once }: typeof import('node:events') = require('node:events');
const zlib: typeof import('node:zlib') = require('node:zlib');
const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
const { acquireMaintenanceLease, inspectMaintenanceLease }: typeof import('../lib/maintenance-lease') = require('../lib/maintenance-lease');
const { previewMaintenanceRecovery, applyMaintenanceRecovery }: typeof import('../lib/maintenance-recovery') = require('../lib/maintenance-recovery');
const { tree }: typeof import('./maintenance-recovery-fixture') = require('./maintenance-recovery-fixture');
const { seed, start }: typeof import('./maintenance-transaction-route-fixture') = require('./maintenance-transaction-route-fixture');
const stateUrl = '/api/maintenance/scenes-state';
const changesUrl = '/api/maintenance/scenes/changes';

function changes(f: any, version: any) {
  return { baseVersion: version, changeSet: { version: 1,
    scenes: { upsert: [{ ...f.scenes[0], id: 'sc002', title: 'New neutral fixture' }], remove: [] },
    blueprints: { upsert: [{ ...f.blueprints[0], id: 'fixture_c', characterId: 'gamma' }], remove: ['fixture_b'] },
  } };
}

test('neutral HTTP preview is zero-write; save updates source, products, compression and version', async () => {
  const f = seed();
  const app = await start(f);
  try {
    const before = tree(f.options.rootDir);
    const state = await app.request(stateUrl);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const delta = changes(f, state.body.version);
    const preview = await app.request('/api/maintenance/scenes/preview', delta);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(tree(f.options.rootDir), before);
    const saved = await app.request(changesUrl, delta);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.count, 2);
    assert.equal(inspectMaintenanceLease(f.options).status, 'free');
    assert.equal(io.fs.existsSync(io.path.join(f.options.rootDir, 'data/scenes/nene-core.json')), false);
    for (const file of ['data/scenes/nene-core.1.json', 'data/scenes/nene-core.2.json', 'data/blueprints/fixture-c.json']) assert.ok(io.fs.existsSync(io.path.join(f.options.rootDir, file)), file);
    for (const file of ['data/blueprints/fixture-b.json', 'data/blueprints/fixture-b.json.gz', 'data/blueprints/fixture-b.json.br']) assert.equal(io.fs.existsSync(io.path.join(f.options.rootDir, file)), false, file);
    for (const name of ['scenes.json', 'scene-blueprints.json']) {
      const bytes = io.fs.readFileSync(io.path.join(f.options.rootDir, 'data', name));
      assert.deepEqual(zlib.gunzipSync(io.fs.readFileSync(io.path.join(f.options.rootDir, 'data', name + '.gz'))), bytes);
      assert.deepEqual(zlib.brotliDecompressSync(io.fs.readFileSync(io.path.join(f.options.rootDir, 'data', name + '.br'))), bytes);
    }
    assert.equal((await app.request(stateUrl)).body.version, saved.body.version);
    assert.equal((await app.request(changesUrl, delta)).status, 409, 'old baseline still conflicts');
    assert.equal(tree(f.options.rootDir)['data/untouched.txt'], before['data/untouched.txt']);
  } finally { await app.stop(); f.cleanup(); }
});

test('late HTTP failure rolls back precise new/deleted paths and preserves an unrelated new file', async () => {
  const f = seed();
  const app = await start(f, 'failure');
  try {
    const before = tree(f.options.rootDir, true);
    const state = await app.request(stateUrl);
    const result = await app.request(changesUrl, changes(f, state.body.version));
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.rolledBack, true);
    assert.equal(inspectMaintenanceLease(f.options).status, 'free');
    assert.deepEqual(tree(f.options.rootDir, true), { ...before, 'data/unrelated-new.txt': io.digest('preserve this concurrent file') });
  } finally { await app.stop(); f.cleanup(); }
});

test('real HTTP writer SIGKILL: other process read/save/preview/static and startup reject half data', async () => {
  const f = seed();
  const original = tree(f.options.rootDir, true);
  const writer = await start(f, 'pause');
  const reader = await start(f);
  try {
    const state = await reader.request(stateUrl);
    const delta = changes(f, state.body.version);
    const checkpoint = once(writer.child, 'message');
    const saving = writer.request(changesUrl, delta).catch(error => ({ networkError: error.message }));
    assert.equal((await checkpoint)[0].checkpoint, 'half-written');
    assert.equal(inspectMaintenanceLease(f.options).status, 'active');
    for (const [url, body] of [[stateUrl, undefined], ['/api/maintenance/scenes/preview', delta], [changesUrl, delta], ['/data/scenes.json', undefined]]) {
      const blocked = await reader.request(url, body);
      assert.equal(blocked.status, 409, JSON.stringify(blocked));
      assert.equal(blocked.body.code, 'MAINTENANCE_BUSY');
    }
    const boot = await start(f, 'startup');
    assert.equal(boot.message.started, false);
    assert.equal(boot.message.code, 'MAINTENANCE_BUSY');
    await boot.closed;
    const gzipBusy = await reader.request('/data/scenes.json', undefined, { 'accept-encoding': 'gzip' });
    assert.equal(gzipBusy.status, 409);
    assert.equal(gzipBusy.body.code, 'MAINTENANCE_BUSY');
    await writer.stop();
    await saving;
    assert.equal((await reader.request(stateUrl)).body.code, 'MAINTENANCE_RECOVERY_REQUIRED');
    assert.equal((await reader.request('/data/scenes.json', undefined, { 'accept-encoding': 'gzip' })).body.code, 'MAINTENANCE_RECOVERY_REQUIRED');
    const plan = previewMaintenanceRecovery(f.options);
    assert.equal(plan.executable, true, JSON.stringify(plan.conflicts));
    assert.ok(plan.entries.some((item: any) => item.source.endsWith('nene-core.2.json') && item.desired.exists === false));
    assert.equal(applyMaintenanceRecovery(f.options, plan).ok, true);
    assert.deepEqual(tree(f.options.rootDir, true), original);
    assert.equal((await reader.request(stateUrl)).status, 200);
    const restart = await start(f, 'startup');
    assert.equal(restart.message.started, true);
    await restart.closed;
  } finally { await writer.stop(); await reader.stop(); f.cleanup(); }
});

test('read fence discards a buffered response if a transaction completes during the read', async () => {
  const f = seed();
  const app = await start(f);
  try {
    const checkpoint = once(app.child, 'message');
    const reading = app.request('/data/delayed.json');
    assert.equal((await checkpoint)[0].checkpoint, 'stream-started');
    const lease = acquireMaintenanceLease(f.options);
    lease.release();
    app.child.send({ finish: true });
    const response = await reading;
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'MAINTENANCE_CONFLICT');
    assert.equal(response.body.old, undefined);
    assert.equal((await app.request('/data/scenes.json', undefined, { 'x-fixture-deny': 'true' })).status, 403);
    const allowed = await app.request('/data/scenes.json');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body[0].id, 'sc001');
  } finally { await app.stop(); f.cleanup(); }
});

test('packaged 501, forwarded-remote denial and pinned fields remain enforced', async () => {
  const f = seed();
  f.write('data/prompt-pinned-scenes.json', { scenes: { sc001: {} } });
  const app = await start(f);
  const packaged = await start(f, 'packaged');
  try {
    const before = tree(f.options.rootDir);
    assert.equal((await packaged.request(stateUrl)).status, 501);
    assert.equal((await packaged.request(changesUrl, {})).status, 501);
    assert.equal((await app.request(stateUrl, undefined, { 'x-forwarded-for': '203.0.113.8' })).status, 403);
    const state = await app.request(stateUrl);
    const pinned = { baseVersion: state.body.version, changeSet: { version: 1, scenes: { upsert: [{ ...f.scenes[0], prompt: 'changed protected field' }], remove: [] } } };
    const response = await app.request(changesUrl, pinned);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.match(response.body.error, /定稿保护/);
    assert.deepEqual(tree(f.options.rootDir), before);
  } finally { await app.stop(); await packaged.stop(); f.cleanup(); }
});
