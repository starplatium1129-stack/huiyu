'use strict';

// All writes below are fixture preparation/fault injection in unique temporary directories.
// The resolver receives an IO adapter which rejects every mutation and records every read.
const test: typeof import('node:test')['test'] = require('node:test').test;
const http: typeof import('node:http') = require('node:http');
const https: typeof import('node:https') = require('node:https');
const { fs, path, write, json, snapshot, approve, fixture, code }: typeof import('./resource-install-fixtures') = require('./resource-install-fixtures');
const assert: typeof import('./resource-install-fixtures')['assert'] = require('./resource-install-fixtures').assert;
const { stageResourcePack }: typeof import('../lib/resource-pack') = require('../lib/resource-pack');
const { generateManifest }: typeof import('../lib/resource-manifest') = require('../lib/resource-manifest');
const { emptyState }: typeof import('../lib/resource-install-state') = require('../lib/resource-install-state');
const { resolveInstalledResourceRoots }: typeof import('../lib/resource-install-resolver') = require('../lib/resource-install-resolver');
const { killAt }: typeof import('./resource-install-process') = require('./resource-install-process');

function readOnlyIo(onRead?: any) {
  const io = Object.create(fs);
  const reads: any = [];
  const writes: any = [];
  const opened = new Map();
  const denied = (op: any) => (...args) => { writes.push([op, ...args]); throw new Error('Unexpected mutation: ' + op); };
  for (const name of Object.keys(fs)) {
    if (/^(?:append|chmod|chown|copy|cp|fchmod|fchown|fdatasync|fsync|ftruncate|futimes|lchmod|lchown|link|lutimes|mkdir|mkdtemp|rename|rm|rmdir|symlink|truncate|unlink|utimes|write)/.test(name)) {
      io[name] = denied(name);
    }
  }
  io.createWriteStream = denied('createWriteStream');
  io.openSync = (file: any, flags: any, ...rest: any[]) => {
    if (flags !== 'r' && flags !== fs.constants.O_RDONLY) return denied('openSync')(file, flags);
    const fd = fs.openSync(file, flags, ...rest);
    opened.set(fd, String(file));
    return fd;
  };
  for (const name of ['lstatSync', 'statSync', 'realpathSync', 'readdirSync', 'readFileSync', 'readSync']) {
    io[name] = (...args) => {
      const file = typeof args[0] === 'number' ? opened.get(args[0]) : String(args[0]);
      reads.push({ op: name, file });
      const value = fs[name](...args);
      if (onRead) onRead(name, file);
      return value;
    };
  }
  return { io, reads, writes };
}
function tree(root: any) {
  const dirs: any = [];
  const visit = (dir: any) => {
    dirs.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(dir, entry.name));
    }
  };
  visit(root);
  return { dirs, files: snapshot(root) };
}
function checked(f: any, { options = {}, error, onRead, injectedMutation = false } = {}) {
  const adapter = readOnlyIo(onRead);
  const before = tree(f.base);
  const program = snapshot(f.program);
  const artwork = snapshot(f.artwork);
  let result;
  const run = () => { result = resolveInstalledResourceRoots({ ...f.options(), ...options, io: adapter.io }); };
  if (error) assert.throws(run, code(error));
  else run();
  assert.deepEqual(adapter.writes, []);
  assert.deepEqual(snapshot(f.program), program);
  assert.deepEqual(snapshot(f.artwork), artwork);
  if (!injectedMutation) assert.deepEqual(tree(f.base), before, 'read-only resolution changed files/directories');
  return { result, reads: adapter.reads };
}
function noNetwork(t: any) {
  const unexpected = () => { throw new Error('Resolver attempted a network request'); };
  t.mock.method(http, 'get', unexpected);
  t.mock.method(http, 'request', unexpected);
  t.mock.method(https, 'get', unexpected);
  t.mock.method(https, 'request', unexpected);
  t.mock.method(globalThis, 'fetch', unexpected);
}
function mediaPack(f: any) {
  const files = {
    'assets/characters/preview.webp': 'synthetic image fixture',
    'assets/characters/thumbs/preview.png': 'synthetic thumbnail fixture',
    'assets/live2d/example/texture.png': 'synthetic texture fixture',
    'assets/live2d/example/example.moc3': 'synthetic model fixture',
    'assets/live2d/example/example.model3.json': '{"FileReferences":{"Moc":"example.moc3"}}',
    'assets/live2d/example/example.physics3.json': '{}',
    'assets/live2d/example/idle.motion3.json': '{}',
    'assets/characters/design.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/characters/style.css': 'body { display: none; }',
    'assets/data/characters.json': '{"sourceDataMustNotBeImported":true}',
    'assets/live2d/example/arbitrary.json': '{}',
    'assets/characters/.hidden.png': 'hidden image fixture',
  };
  for (const [rel, bytes] of Object.entries(files)) write(path.join(f.source, rel), bytes);
  const manifest = generateManifest({ root: f.source });
  write(path.join(f.source, 'media.json'), JSON.stringify(manifest));
  assert.equal(stageResourcePack({ root: f.source, name: 'media', manifestPath: 'media.json' }).ok, true);
  approve(f, 'media', 'full', manifest);
  return manifest;
}

test('missing configuration fails closed with no IO, including without options', () => {
  const adapter = readOnlyIo();
  for (const options of [undefined, null, [], { io: adapter.io }]) {
    assert.throws(() => resolveInstalledResourceRoots(options), code('CONFIG_REQUIRED'));
  }
  assert.deepEqual(adapter.reads, []);
  assert.deepEqual(adapter.writes, []);
});

test('local identity and explicit authorization are checked before configuration reads', t => {
  const f = fixture(t);
  for (const access of [undefined, {}, { isLocalStudioHost: true, isAuthorized: true },
    { isLocalStudioHost: () => false, isAuthorized: () => true },
    { isLocalStudioHost: () => true, isAuthorized: () => undefined },
    { isLocalStudioHost: () => true, isAuthorized: () => Promise.resolve(true) }]) {
    const adapter = readOnlyIo();
    assert.throws(() => resolveInstalledResourceRoots({ configPath: f.config(), access, io: adapter.io }), code('ACCESS_DENIED'));
    assert.deepEqual(adapter.reads, []);
    assert.deepEqual(adapter.writes, []);
  }
});

test('invalid configuration and absent user directory never initialize storage', t => {
  const f = fixture(t);
  for (const options of [{ policy: {} }, { protectedRoots: f.program }, { protectedRoots: ['relative'] },
    { userDataRoot: null }, { userDataRoot: 'relative' }]) checked(f, { options, error: 'CONFIG_REQUIRED' });
  checked(f, { options: { userDataRoot: path.join(f.base, 'missing-user') }, error: 'ENOENT' });
});

test('uninstalled library returns null synchronously without directories or locks', t => {
  noNetwork(t);
  const f = fixture(t);
  assert.equal(checked(f).result, null);
  assert.deepEqual(fs.readdirSync(f.user), []);
});

test('owned empty library returns null and does not recreate a missing lock directory', async t => {
  const f = fixture(t);
  await f.installer().recover();
  fs.rmdirSync(path.join(f.installer().root, 'locks'));
  assert.equal(checked(f).result, null);
  assert.equal(fs.existsSync(path.join(f.installer().root, 'locks')), false);
});

test('validated media snapshot has exact URL-relative allowlist, identity and immutable roots', async t => {
  noNetwork(t);
  const f = fixture(t);
  const manifest = mediaPack(f);
  const installed = await f.installer().install({ releaseId: 'media' });
  const { result, reads }: any = checked(f);
  assert.equal(result.status, 'verified');
  assert.equal(result.then, undefined);
  assert.equal(result.versionRoot, installed.installedRoot);
  assert.equal(result.assetsRoot, path.join(installed.installedRoot, 'assets'));
  assert.equal(result.identity, installed.state.current.identity);
  assert.equal(result.sequence, installed.state.sequence);
  assert.equal(result.verifiedFiles, manifest.entries.length);
  assert.deepEqual(result.relativePaths, [
    'assets/characters/preview.webp', 'assets/characters/thumbs/preview.png',
    'assets/live2d/example/example.moc3', 'assets/live2d/example/example.model3.json',
    'assets/live2d/example/example.physics3.json', 'assets/live2d/example/idle.motion3.json',
    'assets/live2d/example/texture.png',
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.relativePaths), true);
  const byteReads = new Set(reads.filter((read: any) => read.op === 'readFileSync').map((read: any) => read.file));
  for (const entry of manifest.entries) assert.ok(byteReads.has(path.join(result.versionRoot, entry.path)), entry.path);
  assert.ok(reads.every((read: any) => !read.file?.startsWith(f.source)), 'resolver read removable source data');
});

test('trusted configPath works after removable media disappears; config cannot supply callbacks or IO', async t => {
  noNetwork(t);
  const f = fixture(t);
  mediaPack(f);
  const installed = await f.installer().install({ releaseId: 'media' });
  const configPath = f.config();
  const config = json(configPath);
  write(configPath, JSON.stringify({ ...config, access: { isAuthorized: true }, io: { bad: true } }));
  fs.rmSync(f.source, { recursive: true });
  const { result }: any = checked(f, { options: { userDataRoot: undefined, policy: undefined, configPath } });
  assert.equal(result.versionRoot, installed.installedRoot);
});

test('HTTP-approved installed resources resolve offline without requesting even metadata', async t => {
  noNetwork(t);
  const f = fixture(t);
  const installed = await f.installer().install({ releaseId: 'base' });
  f.policy.sources.media = { kind: 'http', approved: true, baseUrl: 'https://offline.invalid/resources/' };
  assert.equal(checked(f).result!.identity, installed.state.current.identity);
});

test('incomplete or unsafe HTTP source configuration fails closed without networking', async t => {
  noNetwork(t);
  const f = fixture(t);
  await f.installer().install({ releaseId: 'base' });
  for (const [baseUrl, error] of [[undefined, 'SOURCE_REQUIRED'], ['file:///resources/', 'UNSAFE_SOURCE'],
    ['http://untrusted.invalid/resources/', 'UNSAFE_SOURCE'], ['https://source.invalid/%ZZ/', 'SOURCE_REQUIRED']]) {
    f.policy.sources.media = { kind: 'http', approved: true, baseUrl };
    checked(f, { error });
  }
});

test('delta snapshot uses the reconstructed full installed manifest and preserves the old version', async t => {
  const f = fixture(t);
  const old = await f.installer().install({ releaseId: 'base' });
  const next = await f.installer().install({ releaseId: 'delta' });
  const { result }: any = checked(f);
  assert.equal(result.identity, next.state.current.identity);
  assert.equal(result.verifiedFiles, f.next.entries.length);
  assert.equal(fs.readFileSync(path.join(old.installedRoot, 'assets/a.txt'), 'utf8'), 'OLD');
  assert.equal(fs.readFileSync(path.join(result.versionRoot, 'assets/keep.bin')).length, 4);
});

test('empty installed manifest is verified but supplies no static mount', async t => {
  const f = fixture(t);
  const manifest = { schemaVersion: 1, entries: [], unverified: [] };
  write(path.join(f.source, 'empty.json'), JSON.stringify(manifest));
  assert.equal(stageResourcePack({ root: f.source, name: 'empty', manifestPath: 'empty.json' }).ok, true);
  approve(f, 'empty', 'full', manifest);
  await f.installer().install({ releaseId: 'empty' });
  const { result }: any = checked(f);
  assert.equal(result.status, 'verified');
  assert.equal(result.assetsRoot, null);
  assert.deepEqual(result.relativePaths, []);
  assert.equal(result.verifiedFiles, 0);
});

for (const corruption of ['same-size-bytes', 'missing-file', 'manifest', 'receipt', 'unlisted-file']) {
  test('rejects ' + corruption + ' without repairing or writing installed state', async t => {
    const f = fixture(t);
    const installed = await f.installer().install({ releaseId: 'base' });
    let error;
    if (corruption === 'same-size-bytes') { write(path.join(installed.installedRoot, 'assets/a.txt'), 'BAD'); error = 'CONTENT_INVALID'; }
    if (corruption === 'missing-file') { fs.unlinkSync(path.join(installed.installedRoot, 'assets/a.txt')); error = 'CONTENT_INVALID'; }
    if (corruption === 'manifest') {
      const file = path.join(installed.installedRoot, 'manifest.json');
      const value = json(file);
      value.entries[0].sha256 = '0'.repeat(64);
      write(file, JSON.stringify(value));
      error = 'INSTALLED_TAMPERED';
    }
    if (corruption === 'receipt') { write(path.join(installed.installedRoot, 'receipt.json'), '{}'); error = 'INSTALLED_TAMPERED'; }
    if (corruption === 'unlisted-file') { write(path.join(installed.installedRoot, 'assets/extra.png'), 'extra'); error = 'UNLISTED_FILE'; }
    checked(f, { error });
  });
}

test('source/release approval and pinned identities remain required for installed bytes', async t => {
  const f = fixture(t);
  await f.installer().install({ releaseId: 'base' });
  const original = structuredClone(f.policy);
  for (const [change, error] of [
    [(p: any) => { p.sources.media.approved = false; }, 'SOURCE_REQUIRED'],
    [(p: any) => { delete p.sources.media; }, 'SOURCE_REQUIRED'],
    [(p: any) => { p.releases.base.approved = false; }, 'APPROVAL_REQUIRED'],
    [(p: any) => { p.releases.base.packageIdentity = '0'.repeat(64); }, 'APPROVAL_REQUIRED'],
    [(p: any) => { p.releases.base.targetIdentity = '0'.repeat(64); }, 'APPROVAL_REQUIRED'],
  ]) {
    const policy = structuredClone(original);
    change(policy);
    checked(f, { options: { policy }, error });
  }
});

test('pending presence, including damaged or null journal, always blocks mounting', async t => {
  const f = fixture(t);
  await f.installer().install({ releaseId: 'base' });
  for (const pending of ['null', '{broken', '{}']) {
    write(path.join(f.installer().root, 'pending.json'), pending);
    checked(f, { error: 'PENDING_TRANSACTION' });
  }
});

test('a killed post-switch process is not treated as a finished installation by the resolver', async t => {
  const f = fixture(t);
  await f.installer().install({ releaseId: 'base' });
  await killAt(f.config(), 'switched');
  checked(f, { error: 'PENDING_TRANSACTION' });
  await f.installer().recover();
  assert.equal(checked(f).result!.identity, f.policy.releases.delta.targetIdentity);
});

test('writer and stale claim locks are never acquired, removed or reclaimed', async t => {
  const f = fixture(t);
  await f.installer().install({ releaseId: 'base' });
  const locks = path.join(f.installer().root, 'locks');
  for (const name of ['writer.json', 'claim-interrupted.json', 'reap-interrupted.json']) {
    write(path.join(locks, name), '{}');
    checked(f, { error: 'BUSY' });
    fs.unlinkSync(path.join(locks, name));
  }
  fs.rmdirSync(locks);
  assert.equal(checked(f).result!.status, 'verified');
  assert.equal(fs.existsSync(locks), false);
});

test('malformed, null, missing or contradictory current state is not mistaken for never installed', async t => {
  const f = fixture(t);
  await f.installer().install({ releaseId: 'base' });
  const current = path.join(f.installer().root, 'current.json');
  const original = json(current);
  for (const [bytes, error] of [['null', 'STATE_INVALID'], ['{', 'METADATA_INVALID'],
    [JSON.stringify({ ...original, sequence: 0 }), 'STATE_INVALID'],
    [JSON.stringify({ ...emptyState(), sequence: 2 }), 'STATE_INVALID']]) {
    write(current, bytes);
    checked(f, { error });
  }
  fs.unlinkSync(current);
  checked(f, { error: 'STATE_INVALID' });
});

test('explicit valid empty state is uninstalled; invalid store ownership is rejected', async t => {
  const f = fixture(t);
  await f.installer().recover();
  write(path.join(f.installer().root, 'current.json'), JSON.stringify(emptyState()));
  assert.equal(checked(f).result, null);
  write(path.join(f.installer().root, 'store.json'), '{}');
  checked(f, { error: 'UNOWNED_ROOT' });
});

test('installed asset junction and metadata hardlink fail closed before external content reads', async t => {
  const f = fixture(t);
  const installed = await f.installer().install({ releaseId: 'base' });
  const assets = path.join(installed.installedRoot, 'assets');
  const saved = path.join(f.base, 'saved-assets');
  fs.renameSync(assets, saved);
  fs.symlinkSync(f.artwork, assets, 'junction');
  const { reads } = checked(f, { error: 'UNSAFE_LINK' });
  assert.ok(reads.filter((read: any) => read.op === 'readFileSync').every((read: any) => !read.file.startsWith(f.artwork)));
  fs.unlinkSync(assets);
  fs.renameSync(saved, assets);
  fs.linkSync(path.join(installed.installedRoot, 'receipt.json'), path.join(f.base, 'receipt-alias.json'));
  checked(f, { error: 'UNSAFE_LINK' });
});

test('unsafe state identity and source-data/script manifest paths never yield resource roots', async t => {
  const f = fixture(t);
  const installed = await f.installer().install({ releaseId: 'base' });
  const current = path.join(f.installer().root, 'current.json');
  write(current, JSON.stringify({ ...installed.state, current: { ...installed.state.current, identity: '../../artwork' } }));
  checked(f, { error: 'STATE_INVALID' });
  write(current, JSON.stringify(installed.state));
  const manifestFile = path.join(installed.installedRoot, 'manifest.json');
  const original = json(manifestFile);
  for (const [rel, error] of [['data/characters.json', 'MANIFEST_INVALID'], ['assets/../escape.png', 'MANIFEST_INVALID'],
    ['assets/character-references/secret.png', 'MANIFEST_INVALID'], ['assets/code.js', 'EXECUTABLE_REJECTED']]) {
    const value = structuredClone(original);
    value.entries[0].path = rel;
    write(manifestFile, JSON.stringify(value));
    checked(f, { error });
  }
});

test('dev runtime inside the repository and application/artwork destinations are protected', t => {
  const f = fixture(t);
  for (const userDataRoot of [path.resolve(__dirname, '../../runtime'), f.program, f.artwork]) {
    checked(f, { options: { userDataRoot }, error: 'PROTECTED_ROOT' });
  }
  const configPath = f.config();
  checked(f, { options: { configPath, userDataRoot: undefined, policy: undefined, protectedRoots: [f.user] }, error: 'PROTECTED_ROOT' });
  const alias = path.join(f.base, 'alias');
  fs.symlinkSync(f.user, alias, 'junction');
  checked(f, { options: { userDataRoot: alias }, error: 'UNSAFE_LINK' });
});

test('configuration file must be absolute, unambiguous, ordinary JSON without aliases', t => {
  const f = fixture(t);
  checked(f, { options: { configPath: f.config() }, error: 'CONFIG_REQUIRED' });
  const options = { userDataRoot: undefined, policy: undefined, configPath: 'relative.json' };
  checked(f, { options, error: 'CONFIG_REQUIRED' });
  options.configPath = path.join(f.base, 'config-directory');
  fs.mkdirSync(options.configPath);
  checked(f, { options, error: 'METADATA_INVALID' });
  options.configPath = f.config();
  write(options.configPath, 'null');
  checked(f, { options, error: 'CONFIG_REQUIRED' });
  write(options.configPath, '{');
  checked(f, { options, error: 'METADATA_INVALID' });
  f.config();
  fs.linkSync(options.configPath, path.join(f.base, 'config-alias.json'));
  checked(f, { options, error: 'UNSAFE_LINK' });
});

for (const fault of ['state-switch', 'pending-appears', 'lock-appears', 'manifest-changes', 'config-revoked', 'access-revoked']) {
  test('read-only snapshot rejects concurrent ' + fault, async t => {
    const f = fixture(t);
    const installed = await f.installer().install({ releaseId: 'base' });
    const configPath = f.config();
    let fired = false;
    let allowed = true;
    const options = { configPath, userDataRoot: undefined, policy: undefined,
      access: { isLocalStudioHost: () => true, isAuthorized: () => allowed } };
    const expected: any = { 'state-switch': 'STATE_CONFLICT', 'pending-appears': 'PENDING_TRANSACTION', 'lock-appears': 'BUSY',
      'manifest-changes': 'STATE_CONFLICT', 'config-revoked': 'CONFIG_CHANGED', 'access-revoked': 'ACCESS_DENIED' };
    checked(f, { options, error: expected[fault], injectedMutation: true, onRead: (op: any, file: any) => {
      if (fired || op !== 'readFileSync' || file !== path.join(installed.installedRoot, 'assets/a.txt')) return;
      fired = true;
      if (fault === 'state-switch') write(path.join(f.installer().root, 'current.json'), JSON.stringify({ ...installed.state, sequence: 2 }));
      if (fault === 'pending-appears') write(path.join(f.installer().root, 'pending.json'), '{}');
      if (fault === 'lock-appears') write(path.join(f.installer().root, 'locks/writer.json'), '{}');
      if (fault === 'manifest-changes') write(path.join(installed.installedRoot, 'manifest.json'), '{}');
      if (fault === 'config-revoked') { const config = json(configPath); config.policy.releases.base.approved = false; write(configPath, JSON.stringify(config)); }
      if (fault === 'access-revoked') allowed = false;
    } });
    assert.equal(fired, true);
  });
}
