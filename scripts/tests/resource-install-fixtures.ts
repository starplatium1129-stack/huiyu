'use strict';

// Helpers use only uniquely owned os.tmpdir fixtures; not an independent test entry.
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { generateManifest }: typeof import('../lib/resource-manifest') = require('../lib/resource-manifest');
const { stageResourcePack }: typeof import('../lib/resource-pack') = require('../lib/resource-pack');
const { stageResourcePackDelta, manifestContentIdentity }: typeof import('../lib/resource-pack-delta') = require('../lib/resource-pack-delta');
const { packageIdentity }: typeof import('../lib/resource-install-policy') = require('../lib/resource-install-policy');
const { createResourceInstaller }: typeof import('../lib/resource-install') = require('../lib/resource-install');

function write(file: any, bytes: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function json(file: any) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function snapshot(root: any): any {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return [[target, '<link>']];
    return entry.isDirectory() ? snapshot(target) : [[target, fs.readFileSync(target).toString('hex')]];
  });
}
function approve(f: any, name: any, kind: any, targetManifest: any, sourceId = 'media') {
  const folder = path.join(f.packs, name);
  const raw = fs.readFileSync(path.join(folder, 'manifest.json'));
  const delta = kind === 'delta' ? fs.readFileSync(path.join(folder, 'delta.json')) : null;
  const entry = { approved: true, sourceId, path: name, kind,
    packageIdentity: packageIdentity(raw, delta), targetIdentity: manifestContentIdentity(targetManifest) };
  f.policy.releases[name] = entry;
  return entry;
}
function fixture(t: any, { large = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-resource-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const user = path.join(base, 'user');
  const program = path.join(base, 'program');
  const artwork = path.join(base, 'artwork');
  const packs = path.join(source, 'scripts/archive/resource-packs');
  fs.mkdirSync(user);
  write(path.join(program, 'server.js'), 'program sentinel');
  write(path.join(artwork, 'my-original.png'), 'artwork sentinel');
  write(path.join(source, 'assets/a.txt'), 'OLD');
  write(path.join(source, 'assets/keep.bin'), Buffer.from([0, 1, 2, 255]));
  write(path.join(source, 'assets/removed.txt'), 'REMOVED');
  const old = generateManifest({ root: source });
  write(path.join(source, 'old.json'), JSON.stringify(old));
  assert.equal(stageResourcePack({ root: source, name: 'base', manifestPath: 'old.json' }).ok, true);
  write(path.join(source, 'assets/a.txt'), 'NEW-CONTENT');
  write(path.join(source, 'assets/new.bin'), large ? Buffer.alloc(3 * 1024 * 1024, 37) : 'NEW ASSET');
  fs.unlinkSync(path.join(source, 'assets/removed.txt'));
  const next = generateManifest({ root: source });
  write(path.join(source, 'next.json'), JSON.stringify(next));
  assert.equal(stageResourcePack({ root: source, name: 'full', manifestPath: 'next.json' }).ok, true);
  assert.equal(stageResourcePackDelta({ root: source, name: 'delta', manifestPath: 'next.json', baseManifestPath: 'old.json' }).ok, true);
  const policy = { sources: { media: { kind: 'offline', root: packs, approved: true } }, releases: {} };
  const f: any = { base, source, user, program, artwork, packs, old, next, policy };
  approve(f, 'base', 'full', old);
  approve(f, 'full', 'full', next);
  approve(f, 'delta', 'delta', next);
  f.options = (extra = {}) => ({ userDataRoot: user, protectedRoots: [program, artwork], policy,
    access: { isLocalStudioHost: () => true, isAuthorized: () => true }, ...extra });
  f.installer = (extra = {}) => createResourceInstaller(f.options(extra));
  f.config = () => {
    const file = path.join(base, 'config.json');
    write(file, JSON.stringify({ userDataRoot: user, protectedRoots: [program, artwork], policy }));
    return file;
  };
  return f;
}
function code(expected: any) {
  return (error: any) => {
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(error.code), 'unexpected error: ' + error.code + ': ' + error.message);
    return true;
  };
}
export = { fs, path, assert, write, json, snapshot, approve, fixture, code };
