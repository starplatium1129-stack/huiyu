'use strict';

const { test } = require('node:test');
const { fs, path, assert, write, json, approve, fixture, code } = require('./resource-install-fixtures');
const { generateManifest } = require('../lib/resource-manifest');
const { stageResourcePackDelta } = require('../lib/resource-pack-delta');
const { killAt } = require('./resource-install-process');

test('zero-difference delta is a verified no-op; deletion-only delta installs an empty version', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  // Restore the source fixture baseline solely to generate the zero candidate with the real exporter.
  fs.rmSync(path.join(f.source, 'assets'), { recursive: true });
  fs.cpSync(path.join(f.packs, 'base/assets'), path.join(f.source, 'assets'), { recursive: true });
  write(path.join(f.source, 'same.json'), JSON.stringify(generateManifest({ root: f.source })));
  assert.equal(stageResourcePackDelta({ root: f.source, name: 'zero', manifestPath: 'same.json', baseManifestPath: 'old.json' }).ok, true);
  approve(f, 'zero', 'delta', f.old);
  const zero = await f.installer().install({ releaseId: 'zero' });
  assert.equal(zero.action, 'already-installed');
  assert.deepEqual(zero.state, old.state);
  fs.rmSync(path.join(f.source, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(f.source, 'assets'));
  const empty = generateManifest({ root: f.source });
  write(path.join(f.source, 'empty.json'), JSON.stringify(empty));
  assert.equal(stageResourcePackDelta({ root: f.source, name: 'empty', manifestPath: 'empty.json', baseManifestPath: 'old.json' }).ok, true);
  approve(f, 'empty', 'delta', empty);
  const removed = await f.installer().install({ releaseId: 'empty' });
  assert.equal((await f.installer().status()).verifiedFiles, 0);
  assert.equal(fs.existsSync(path.join(removed.installedRoot, 'assets/a.txt')), false);
  assert.equal(fs.existsSync(path.join(old.installedRoot, 'assets/a.txt')), true);
  assert.equal((await f.installer().install({ releaseId: 'empty' })).action, 'already-installed');
});

test('source modification after preflight is rejected and can resume after source repair', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const source = path.join(f.packs, 'delta/assets/a.txt');
  const original = fs.readFileSync(source);
  await assert.rejects(f.installer({ onEvent: e => {
    if (e.phase === 'journal') write(source, Buffer.alloc(original.length, 1));
  } }).install({ releaseId: 'delta' }), code('CONTENT_INVALID'));
  assert.deepEqual((await f.installer().status()).state, old.state);
  write(source, original);
  assert.equal((await f.installer().recover()).action, 'installed');
});

test('metadata write failure leaves owned temp files that recovery can safely discard', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const io = Object.create(fs);
  io.renameSync = (from, to) => {
    if (String(to).includes(path.join('tree', 'manifest.json'))) throw Object.assign(new Error('metadata publish interruption'), { code: 'EIO' });
    return fs.renameSync(from, to);
  };
  await assert.rejects(f.installer({ io }).install({ releaseId: 'delta' }), code('EIO'));
  const root = f.installer().root;
  const pending = json(path.join(root, 'pending.json'));
  assert.ok(fs.readdirSync(path.join(root, 'transactions', pending.id, 'tree')).some(name => name.endsWith('.tmp')));
  assert.deepEqual((await f.installer().status()).state, old.state);
  assert.equal((await f.installer().recover()).action, 'installed');
});

test('new-version readback corruption before activation can recover without touching old version', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const io = Object.create(fs);
  io.renameSync = (from, to) => {
    const result = fs.renameSync(from, to);
    if (String(to).endsWith(f.policy.releases.delta.targetIdentity)) write(path.join(to, 'assets/a.txt'), 'BAD');
    return result;
  };
  await assert.rejects(f.installer({ io }).install({ releaseId: 'delta' }), code('CONTENT_INVALID'));
  assert.deepEqual((await f.installer().status()).state, old.state);
  assert.equal((await f.installer().recover()).action, 'installed');
});

test('actual rollback pointer switching survives a killed process', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  await f.installer().install({ releaseId: 'delta' });
  await killAt(f.config(), 'switched', 'rollback');
  const recovered = await f.installer().recover();
  assert.equal(recovered.action, 'recovered');
  assert.deepEqual(recovered.state.current, old.state.current);
});
