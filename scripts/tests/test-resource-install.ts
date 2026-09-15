'use strict';

const test: typeof import('node:test')['test'] = require('node:test').test;
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { fs, path, write, json, snapshot, approve, fixture, code }: typeof import('./resource-install-fixtures') = require('./resource-install-fixtures');
const assert: typeof import('./resource-install-fixtures')['assert'] = require('./resource-install-fixtures').assert;
const { packageIdentity }: typeof import('../lib/resource-install-policy') = require('../lib/resource-install-policy');
const { manifestContentIdentity }: typeof import('../lib/resource-pack-delta') = require('../lib/resource-pack-delta');

test('full install, actual inventory, repeat idempotence, and app upgrade preserve resources/artwork', async t => {
  const f = fixture(t);
  const protectedBefore = [...snapshot(f.program), ...snapshot(f.artwork)];
  const installer = f.installer();
  const first = await installer.install({ releaseId: 'base' });
  assert.equal(first.action, 'installed');
  assert.equal((await installer.status()).verifiedFiles, 3);
  const repeat = await f.installer().install({ releaseId: 'base' });
  assert.equal(repeat.action, 'already-installed');
  assert.deepEqual(repeat.state, first.state);
  assert.deepEqual([...snapshot(f.program), ...snapshot(f.artwork)], protectedBefore);
  write(path.join(f.program, 'server.js'), 'updated program');
  assert.deepEqual((await f.installer().status()).state, first.state);
  assert.equal(fs.readFileSync(path.join(first.installedRoot, 'assets/a.txt'), 'utf8'), 'OLD');
});

test('delta copies changes, retains unchanged files, removes only from new version, supports rollback', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const next = await f.installer().install({ releaseId: 'delta' });
  assert.equal(fs.readFileSync(path.join(next.installedRoot, 'assets/a.txt'), 'utf8'), 'NEW-CONTENT');
  assert.equal(fs.existsSync(path.join(next.installedRoot, 'assets/removed.txt')), false);
  assert.equal(fs.readFileSync(path.join(old.installedRoot, 'assets/removed.txt'), 'utf8'), 'REMOVED');
  assert.notEqual(fs.statSync(path.join(old.installedRoot, 'assets/keep.bin')).ino, fs.statSync(path.join(next.installedRoot, 'assets/keep.bin')).ino);
  assert.equal((await f.installer().install({ releaseId: 'delta' })).action, 'already-installed');
  const rollback = await f.installer().rollback();
  assert.equal(rollback.state.current.identity, old.state.current.identity);
  assert.equal((await f.installer().install({ releaseId: 'full' })).state.current.identity, next.state.current.identity);
});

test('corrupt candidate bytes fail without changing installed state', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  write(path.join(f.packs, 'delta/assets/a.txt'), 'BAD-CONTENT');
  await assert.rejects(f.installer().install({ releaseId: 'delta' }), code('CONTENT_INVALID'));
  assert.deepEqual((await f.installer().status()).state, old.state);
});

test('manifest, receipt, extra files and actual baseline bytes are independently checked', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const asset = path.join(old.installedRoot, 'assets/a.txt');
  write(asset, 'BAD');
  await assert.rejects(f.installer().status(), code('CONTENT_INVALID'));
  await assert.rejects(f.installer().install({ releaseId: 'delta' }), code('CONTENT_INVALID'));
  write(asset, 'OLD');
  const manifestFile = path.join(old.installedRoot, 'manifest.json');
  const original = fs.readFileSync(manifestFile);
  const tampered = json(manifestFile);
  tampered.entries.pop();
  write(manifestFile, JSON.stringify(tampered));
  await assert.rejects(f.installer().status(), code('INSTALLED_TAMPERED'));
  write(manifestFile, original);
  write(path.join(old.installedRoot, 'assets/unlisted.txt'), 'extra');
  await assert.rejects(f.installer().status(), code('UNLISTED_FILE'));
  fs.unlinkSync(path.join(old.installedRoot, 'assets/unlisted.txt'));
  write(path.join(old.installedRoot, 'receipt.json'), '{}');
  await assert.rejects(f.installer().status(), code('INSTALLED_TAMPERED'));
});

test('independent approval rejects rewritten package metadata even with matching new hashes', async t => {
  const f = fixture(t);
  const manifestFile = path.join(f.packs, 'base/manifest.json');
  const modified = json(manifestFile);
  modified.entries[0].sha256 = 'f'.repeat(64);
  write(manifestFile, JSON.stringify(modified));
  await assert.rejects(f.installer().install({ releaseId: 'base' }), code('PACKAGE_UNAPPROVED'));
});

test('approved but incompatible delta metadata still fails existing baseline verifier', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const file = path.join(f.packs, 'delta/delta.json');
  const delta = json(file);
  delta.baseManifest.contentIdentity = 'f'.repeat(64);
  write(file, JSON.stringify(delta));
  approve(f, 'delta', 'delta', f.next);
  await assert.rejects(f.installer().install({ releaseId: 'delta' }), code('BASELINE_MISMATCH'));
  assert.deepEqual((await f.installer().status()).state, old.state);
});

test('cancellation persists progress, and recover rehashes/reuses completed files', async t => {
  const f = fixture(t, { large: true });
  const old = await f.installer().install({ releaseId: 'base' });
  const controller = new AbortController();
  await assert.rejects(f.installer({ onEvent: (e: any) => {
    if (e.phase === 'copied') controller.abort();
  } }).install({ releaseId: 'delta', signal: controller.signal }), code('CANCELLED'));
  assert.deepEqual((await f.installer().status()).state, old.state);
  const phases: any = [];
  const recovered = await f.installer({ onEvent: (e: any) => phases.push(e.phase) }).recover();
  assert.equal(recovered.state.current.identity, f.policy.releases.delta.targetIdentity);
  assert.ok(phases.includes('copy-reused'));
});

test('mid-file cancellation never exposes a partial installation', async t => {
  const f = fixture(t, { large: true });
  const controller = new AbortController();
  await assert.rejects(f.installer({ onEvent: (e: any) => {
    if (e.phase === 'copy-progress' && e.path === 'assets/new.bin') controller.abort();
  } }).install({ releaseId: 'full', signal: controller.signal }), code('CANCELLED'));
  assert.equal((await f.installer().status()).state.current, null);
  assert.equal((await f.installer().recover()).action, 'installed');
});

test('preflight disk shortage retains previous version', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  await assert.rejects(f.installer({ freeBytes: () => 0 }).install({ releaseId: 'delta' }), code('ENOSPC'));
  assert.deepEqual((await f.installer().status()).state, old.state);
});

test('injected ENOSPC while writing a resource is recoverable', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const io = Object.create(fs);
  const files = new Map();
  io.openSync = (file: any, ...args) => {
    const fd = fs.openSync(file, ...args); files.set(fd, String(file)); return fd;
  };
  io.writeSync = (fd: any, ...args) => {
    if (files.get(fd)?.endsWith('.part')) throw Object.assign(new Error('injected full disk'), { code: 'ENOSPC' });
    return fs.writeSync(fd, ...args);
  };
  await assert.rejects(f.installer({ io }).install({ releaseId: 'delta' }), code('ENOSPC'));
  assert.deepEqual((await f.installer().status()).state, old.state);
  assert.equal((await f.installer().recover()).action, 'installed');
});

test('post-switch failure restores old pointer, retains versions, then resumes', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  await assert.rejects(f.installer({ onEvent: (e: any) => {
    if (e.phase === 'switched') throw Object.assign(new Error('injected final check failure'), { code: 'INJECTED' });
  } }).install({ releaseId: 'delta' }), (e: any) => e.code === 'INJECTED' && e.rolledBack === true);
  assert.deepEqual((await f.installer().status()).state, old.state);
  assert.equal((await f.installer().recover()).action, 'installed');
  assert.equal(fs.existsSync(old.installedRoot), true);
});

test('current pointer write failure leaves a resumable prepared version', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const io = Object.create(fs);
  io.renameSync = (from: any, to: any) => {
    if (path.basename(to) === 'current.json') throw Object.assign(new Error('injected access failure'), { code: 'EACCES' });
    return fs.renameSync(from, to);
  };
  await assert.rejects(f.installer({ io }).install({ releaseId: 'delta' }), code('EACCES'));
  assert.deepEqual((await f.installer().status()).state, old.state);
  fs.renameSync(f.packs, f.packs + '-unplugged');
  assert.equal((await f.installer().recover()).action, 'installed');
});

test('concurrent imports conflict without stealing a live same-process lock', async t => {
  const f = fixture(t);
  let entered: any;
  let resume;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const running = f.installer({ onEvent: async (e: any) => { if (e.phase === 'journal') { entered(); await gate; } } }).install({ releaseId: 'base' });
  await started;
  try { await assert.rejects(f.installer().install({ releaseId: 'base' }), code('BUSY')); }
  finally { resume(); }
  assert.equal((await running).action, 'installed');
});

test('remote, unknown and unauthorized callers fail closed without storage writes', async t => {
  const f = fixture(t);
  for (const access of [undefined, {}, { isLocalStudioHost: () => false, isAuthorized: () => true },
    { isLocalStudioHost: () => true, isAuthorized: () => false }]) {
    await assert.rejects(f.installer({ access }).install({ releaseId: 'base' }), code('ACCESS_DENIED'));
  }
  assert.deepEqual(fs.readdirSync(f.user), []);
});

test('source trust and release approval are separate requirements', async t => {
  const f = fixture(t);
  f.policy.releases.base.approved = false;
  await assert.rejects(f.installer().install({ releaseId: 'base' }), code('APPROVAL_REQUIRED'));
  f.policy.releases.base.approved = true;
  f.policy.sources.media.approved = false;
  await assert.rejects(f.installer().install({ releaseId: 'base' }), code('SOURCE_REQUIRED'));
  assert.deepEqual(fs.readdirSync(f.user), []);
});

test('runtime authorization revocation interrupts import and preserves old version', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  let authorized = true;
  await assert.rejects(f.installer({ access: { isLocalStudioHost: () => true, isAuthorized: () => authorized },
    onEvent: (e: any) => { if (e.phase === 'copied') authorized = false; }
  }).install({ releaseId: 'delta' }), code('ACCESS_DENIED'));
  assert.deepEqual((await f.installer().status()).state, old.state);
});

test('unsafe manifest paths, Windows aliases, collisions and executable content are rejected', async t => {
  const f = fixture(t);
  const pack = path.join(f.packs, 'base');
  const paths = ['../server.js', 'assets/%2e%2e/escape', 'assets/x%2fy.png', 'assets/NUL.png',
    'assets/trailing.', 'assets/character-references/x.png', 'assets/update.exe', 'assets/a.js'];
  for (const bad of paths) {
    const value = { schemaVersion: 1, entries: [{ path: bad, bytes: 1, sha256: 'f'.repeat(64) }] };
    const raw = Buffer.from(JSON.stringify(value));
    write(path.join(pack, 'manifest.json'), raw);
    f.policy.releases.base.packageIdentity = packageIdentity(raw);
    f.policy.releases.base.targetIdentity = manifestContentIdentity(value);
    await assert.rejects(f.installer().install({ releaseId: 'base' }), code(['MANIFEST_INVALID', 'UNSAFE_PATH', 'EXECUTABLE_REJECTED']));
  }
  const value = { schemaVersion: 1, entries: ['assets/a.png', 'assets/A.png'].map(p => ({ path: p, bytes: 1, sha256: 'f'.repeat(64) })) };
  const raw = Buffer.from(JSON.stringify(value));
  write(path.join(pack, 'manifest.json'), raw);
  f.policy.releases.base.packageIdentity = packageIdentity(raw);
  await assert.rejects(f.installer().install({ releaseId: 'base' }), code('MANIFEST_INVALID'));
});

test('unlisted package files and invalid ownership roots are never adopted', async t => {
  const f = fixture(t);
  write(path.join(f.packs, 'base/extra.txt'), 'not declared');
  await assert.rejects(f.installer().install({ releaseId: 'base' }), code('UNLISTED_FILE'));
  const another = path.join(f.base, 'other-user');
  write(path.join(another, 'resource-library-v1/user-original.txt'), 'do not overwrite');
  await assert.rejects(f.installer({ userDataRoot: another }).install({ releaseId: 'base' }), code('UNOWNED_ROOT'));
  assert.equal(fs.readFileSync(path.join(another, 'resource-library-v1/user-original.txt'), 'utf8'), 'do not overwrite');
});

test('application and artwork roots cannot be selected as resource destinations', t => {
  const f = fixture(t);
  assert.throws(() => f.installer({ userDataRoot: f.program }), code('PROTECTED_ROOT'));
  assert.throws(() => f.installer({ userDataRoot: f.artwork }), code('PROTECTED_ROOT'));
});

test('CLI help is zero-read, preview writes nothing, explicit import and status work', t => {
  const f = fixture(t);
  const cli = path.resolve(__dirname, '../maintenance/manage-resource-install.js');
  const run = (args: any) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run(['--help', '--config', 'does-not-exist.json']).status, 0);
  const config = f.config();
  const preview = run(['import', '--config', config, '--release', 'base']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).mode, 'preview');
  assert.deepEqual(fs.readdirSync(f.user), []);
  const installed = run(['import', '--config', config, '--release', 'base', '--apply']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(run(['status', '--config', config]).status, 0);
  assert.equal(run(['import', '--config', config, '--release', 'base', '--url', 'http://127.0.0.1']).status, 2);
});
