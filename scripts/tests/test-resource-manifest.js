'use strict';

/**
 * scripts/tests/test-resource-manifest.js — 资源清单生成/校验隔离夹具测试
 *
 * 全部读写限定在 os.tmpdir() 临时夹具；越界用例使用夹具自建的无敏感外部目录，
 * 并以记录型 fs 证明越界目标未被 stat/读取。不触碰生产数据、不构建 dist。
 * 运行：node scripts/tests/test-resource-manifest.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { generateManifest, verifyManifest, verifyManifestEntries, checkManifestPath } = require('../lib/resource-manifest');

const repo = path.resolve(__dirname, '..', '..');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** 记录型 fs：调用穿透真实 fs，同时记录目标路径，用于证明越界用例零越界访问。 */
function recordingFs() {
  const calls = [];
  const io = Object.create(fs);
  for (const op of ['statSync', 'readdirSync', 'realpathSync', 'readFileSync']) {
    io[op] = (...args) => {
      calls.push({ op, target: String(args[0]) });
      return fs[op](...args);
    };
  }
  return { io, calls };
}

function insideRoot(rootReal, target) {
  const rel = path.relative(rootReal, target);
  // 记录器允许 realpathSync(root) 本身（target === rootReal）；清单路径的严格
  // 内含判断由被测代码的 isInsideRoot 负责。
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function assertNoAccessOutside(calls, rootReal) {
  for (const call of calls) {
    assert.ok(insideRoot(rootReal, path.resolve(call.target)), `${call.op} 越界访问了 ${call.target}`);
  }
}

function buildFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-manifest-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'assets/dir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets/character-references'));
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A');
  fs.writeFileSync(path.join(root, 'assets/dir/bravo.bin'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(root, 'assets/dir/charlie.txt'), 'hello charlie');
  fs.writeFileSync(path.join(root, 'assets/x%20y.txt'), 'percent literal');
  fs.writeFileSync(path.join(root, 'assets/character-references/hidden.txt'), 'excluded');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  return { base, root, outside, secretAbs: path.join(outside, 'secret.txt') };
}

function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(root, e.name);
    if (e.isSymbolicLink()) return [[p, '<link>']];
    return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
}

function writeManifest(root, manifest) {
  const dir = path.join(root, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function cli(args) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts', 'maintenance', 'report-resource-manifest.js'), ...args], { encoding: 'utf8' });
}

test('生成清单路径稳定排序、字节与哈希正确，排除域不出现', (t) => {
  const fx = buildFixture(t);
  const first = generateManifest({ root: fx.root });
  const second = generateManifest({ root: fx.root });
  assert.deepEqual(second.entries, first.entries);
  assert.deepEqual(second.totals, first.totals);
  assert.deepEqual(first.entries.map((e) => e.path), ['assets/alpha.txt', 'assets/dir/bravo.bin', 'assets/dir/charlie.txt', 'assets/x%20y.txt']);
  assert.equal(first.totals.files, 4);
  assert.equal(first.entries[0].bytes, 1);
  assert.equal(first.entries[0].sha256, sha256('A'));
  assert.equal(first.entries[1].bytes, 4);
  assert.equal(first.entries[1].sha256, sha256(Buffer.from([0, 1, 2, 255])));
  assert.ok(first.scope.excluded.includes('assets/character-references'));
  assert.ok(!first.entries.some((e) => e.path.includes('character-references')));
  assert.equal(first.unverified.length, 0);
  assert.ok(first.generatedAt);
  assert.ok(first.scope.pathIdentity.includes('不声称跨重命名身份稳定'));
});

test('单文件内容改变仅影响该条目的字节与哈希', (t) => {
  const fx = buildFixture(t);
  const before = generateManifest({ root: fx.root });
  fs.writeFileSync(path.join(fx.root, 'assets/dir/bravo.bin'), Buffer.from([9, 9]));
  const after = generateManifest({ root: fx.root });
  const target = after.entries.find((e) => e.path === 'assets/dir/bravo.bin');
  assert.equal(target.bytes, 2);
  assert.equal(target.sha256, sha256(Buffer.from([9, 9])));
  assert.deepEqual(
    after.entries.filter((e) => e.path !== 'assets/dir/bravo.bin'),
    before.entries.filter((e) => e.path !== 'assets/dir/bravo.bin')
  );
});

test('生成→保存→校验往返通过，全程零源写入且无逐条目越界读取', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const before = snapshot(fx.root);
  const file = writeManifest(fx.root, manifest);
  const afterWrite = snapshot(fx.root);
  const { io, calls } = recordingFs();
  const result = verifyManifest({ root: fx.root, manifestPath: file, io });
  assert.equal(result.ok, true);
  assert.equal(result.totals.verified, 4);
  assert.equal(result.totals.errorCount, 0);
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  assert.deepEqual(snapshot(fx.root), afterWrite);
  fs.unlinkSync(file);
  assert.deepEqual(snapshot(fx.root), before);
});

test('校验发现文件缺失与字节/哈希不匹配', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const wrongSize = { ...manifest, entries: manifest.entries.map((e) => (e.path === 'assets/alpha.txt' ? { ...e, bytes: 99 } : e)) };
  const sizeError = verifyManifestEntries({ root: fx.root, manifest: wrongSize }).errors.find((e) => e.code === 'size-mismatch');
  assert.equal(sizeError.path, 'assets/alpha.txt');
  assert.equal(sizeError.expected, 99);
  assert.equal(sizeError.actual, 1);

  const wrongHash = { ...manifest, entries: manifest.entries.map((e) => (e.path === 'assets/alpha.txt' ? { ...e, sha256: 'f'.repeat(64) } : e)) };
  const hashError = verifyManifestEntries({ root: fx.root, manifest: wrongHash }).errors.find((e) => e.code === 'hash-mismatch');
  assert.equal(hashError.path, 'assets/alpha.txt');
  assert.equal(hashError.actual, sha256('A'));

  fs.unlinkSync(path.join(fx.root, 'assets/alpha.txt'));
  const result = verifyManifestEntries({ root: fx.root, manifest });
  const missing = result.errors.find((e) => e.code === 'missing');
  assert.equal(missing.path, 'assets/alpha.txt');
  assert.ok(result.errors.every((e) => e.code !== 'hash-mismatch'));
});

test('重复路径被拒绝且该路径计入失败', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const duplicated = { ...manifest, entries: [...manifest.entries, manifest.entries[0]] };
  const result = verifyManifestEntries({ root: fx.root, manifest: duplicated });
  assert.equal(result.ok, false);
  const dup = result.errors.find((e) => e.code === 'duplicate-path');
  assert.equal(dup.path, 'assets/alpha.txt');
  assert.equal(result.totals.listed, 5);
  assert.equal(result.totals.uniquePaths, 4);
  assert.equal(result.totals.verified, 3);
});

test('编码与原始越界路径先于 fs 访问被拒绝，不返回任何文件内容', (t) => {
  const fx = buildFixture(t);
  const cases = [
    'assets/..\\..\\outside-secret.txt',
    'assets/../../outside-secret.txt',
    'assets/characters%5c..%5c..%5coutside.txt',
    'assets/%2e%2e/%2e%2e/secret.txt',
    'assets/x%2Fy.txt',
    'assets/C:evil.txt',
    'assets/a\u0000b.txt',
    'data/characters.json',
    'assets/character-references/hidden.txt',
    'assets',
  ];
  for (const p of cases) {
    const check = checkManifestPath(p);
    assert.equal(check.ok, false, p);
    assert.ok(['illegal-path', 'out-of-scope'].includes(check.code), `${p} → ${check.code}`);
  }
  const manifest = { schemaVersion: 1, entries: cases.map((p) => ({ path: p, bytes: 1, sha256: sha256('A') })) };
  const { io, calls } = recordingFs();
  const result = verifyManifestEntries({ root: fx.root, manifest, io });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= cases.length);
  assert.ok(result.errors.every((e) => ['illegal-path', 'out-of-scope'].includes(e.code)));
  assert.ok(result.errors.every((e) => e.actual === undefined));
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  assert.ok(calls.every((c) => c.op !== 'readFileSync'), '越界用例不得读取任何文件内容');
});

test('junction 越界在校验中被拒且不读取链接目标', (t) => {
  const fx = buildFixture(t);
  fs.symlinkSync(fx.outside, path.join(fx.root, 'assets', 'lnk'), process.platform === 'win32' ? 'junction' : 'dir');
  const secret = fs.readFileSync(fx.secretAbs);
  const manifest = { schemaVersion: 1, entries: [{ path: 'assets/lnk/secret.txt', bytes: secret.length, sha256: sha256(secret) }] };
  const before = snapshot(fx.outside);
  const { io, calls } = recordingFs();
  const result = verifyManifestEntries({ root: fx.root, manifest, io });
  const err = result.errors.find((e) => e.code === 'realpath-outside-root');
  assert.ok(err, JSON.stringify(result.errors));
  assert.equal(err.path, 'assets/lnk/secret.txt');
  assert.ok(!('actual' in err) && !('expected' in err));
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  assert.ok(calls.every((c) => c.op !== 'readFileSync'), 'junction 越界不得读取目标内容');
  assert.deepEqual(snapshot(fx.outside), before);
});

test('生成不跟随链接、不进入排除域，无法合规表示的文件名单列 unverified', (t) => {
  const fx = buildFixture(t);
  fs.symlinkSync(fx.outside, path.join(fx.root, 'assets', 'lnk'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(fx.root, 'assets', 'p%2Fq.txt'), 'smuggled name');
  const { io, calls } = recordingFs();
  const manifest = generateManifest({ root: fx.root, io });
  const paths = manifest.entries.map((e) => e.path);
  assert.ok(!paths.some((p) => p.startsWith('assets/lnk/')), '链接目标不得进入清单');
  assert.ok(!paths.includes('assets/p%2Fq.txt'));
  assert.ok(!paths.some((p) => p.includes('character-references')));
  const kinds = Object.fromEntries(manifest.unverified.map((u) => [u.path, u.kind]));
  assert.equal(kinds['assets/lnk'], 'symlink');
  assert.equal(kinds['assets/p%2Fq.txt'], 'unrepresentable-path');
  assert.ok(manifest.totals.unverified >= 2);
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  assert.ok(calls.every((c) => !String(c.target).includes('character-references')), '排除域不得被遍历或读取');
});

test('不支持 schemaVersion、坏条目与坏 JSON 不得无条件成功', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const v2 = verifyManifestEntries({ root: fx.root, manifest: { ...manifest, schemaVersion: 2 } });
  assert.equal(v2.ok, false);
  assert.equal(v2.errors[0].code, 'unsupported-schema');
  const badEntries = verifyManifestEntries({ root: fx.root, manifest: { schemaVersion: 1, entries: 'nope' } });
  assert.equal(badEntries.errors[0].code, 'bad-manifest');
  const badField = verifyManifestEntries({ root: fx.root, manifest: { schemaVersion: 1, entries: [{ path: 'assets/alpha.txt', bytes: '1', sha256: 'zz' }] } });
  assert.ok(badField.errors.some((e) => e.code === 'bad-entry'));
  assert.equal(badField.totals.verified, 0);

  fs.mkdirSync(path.join(fx.root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, 'artifacts/broken.json'), '{');
  assert.equal(cli(['--root', fx.root, '--manifest', 'artifacts/broken.json']).status, 1);
  fs.writeFileSync(path.join(fx.root, 'artifacts/v2.json'), JSON.stringify({ ...manifest, schemaVersion: 2 }));
  assert.equal(cli(['--root', fx.root, '--manifest', 'artifacts/v2.json']).status, 1);
});

test('help/plan 不读取目标；CLI 退出码契约成立', (t) => {
  const missing = path.join(os.tmpdir(), 'resource-manifest-nonexistent-root');
  for (const flag of ['--help', '--plan']) assert.equal(cli([flag, '--root', missing]).status, 0);
  assert.equal(cli(['--nope']).status, 2);
  assert.equal(cli(['--root', missing]).status, 2);

  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const file = writeManifest(fx.root, manifest);
  assert.equal(cli(['--root', fx.root, '--manifest', file]).status, 0);
  assert.equal(cli(['--root', fx.root, '--manifest', path.join(fx.base, 'outside', 'escape.json')]).status, 2);

  const before = snapshot(fx.root);
  assert.equal(cli(['--root', fx.root]).status, 0);
  assert.equal(JSON.parse(cli(['--root', fx.root]).stdout).kind, 'resource-manifest');
  assert.deepEqual(snapshot(fx.root), before);

  fs.symlinkSync(fx.outside, path.join(fx.root, 'assets', 'lnk2'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(cli(['--root', fx.root]).status, 1, '生成含未核验项退出 1');
});

test('工作流注册入口转发结果与直连一致', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const file = writeManifest(fx.root, manifest);
  const direct = cli(['--root', fx.root, '--manifest', file]);
  const viaWorkflow = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'audit:resource-manifest', '--root', fx.root, '--manifest', file], { encoding: 'utf8' });
  assert.equal(direct.status, 0);
  assert.equal(viaWorkflow.status, 0);
  assert.deepEqual(JSON.parse(viaWorkflow.stdout), JSON.parse(direct.stdout));
});

test('排除域大小写与 root 内 junction 别名不能读取内容', (t) => {
  const fx = buildFixture(t);
  fs.symlinkSync(path.join(fx.root, 'assets/character-references'), path.join(fx.root, 'assets/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const cases = ['assets/alias/hidden.txt'];
  if (process.platform === 'win32') cases.push('assets/CHARACTER-REFERENCES/hidden.txt');
  fs.mkdirSync(path.join(fx.root, 'runtime'));
  fs.writeFileSync(path.join(fx.root, 'runtime/private.txt'), 'excluded');
  fs.symlinkSync(path.join(fx.root, 'runtime'), path.join(fx.root, 'assets/runtime-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  cases.push('assets/runtime-alias/private.txt');
  for (const rel of cases) {
    const { io, calls } = recordingFs();
    const result = verifyManifestEntries({ root: fx.root, io, manifest: { schemaVersion: 1, entries: [{ path: rel, bytes: 8, sha256: sha256('excluded') }] } });
    assert.equal(result.ok, false, rel);
    assert.equal(result.errors[0].code, 'out-of-scope');
    assert.ok(calls.every((c) => c.op !== 'readFileSync'), rel);
    assert.ok(calls.filter((c) => c.op === 'statSync').every((c) => c.target === fs.realpathSync(fx.root)), '拒绝目标之前不得 stat 目标');
  }
});

test('扫描根 junction 不跟随、不遍历、不哈希', (t) => {
  const fx = buildFixture(t);
  const root = path.join(fx.base, 'linked-root');
  fs.mkdirSync(path.join(root, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(root, 'payload/private.txt'), 'private');
  fs.symlinkSync(path.join(root, 'payload'), path.join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  const { io, calls } = recordingFs();
  assert.throws(() => generateManifest({ root, io }), /符号链接/);
  assert.ok(calls.every((c) => !['readFileSync', 'readdirSync'].includes(c.op)));
  assert.equal(cli(['--root', root]).status, 2);
});

test('含未核验项的清单保留条目核验数量但整体退出失败', (t) => {
  const fx = buildFixture(t);
  fs.symlinkSync(fx.outside, path.join(fx.root, 'assets/link'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = generateManifest({ root: fx.root });
  assert.equal(manifest.unverified.length, 1);
  const result = verifyManifestEntries({ root: fx.root, manifest });
  assert.equal(result.ok, false);
  assert.equal(result.totals.verified, 4);
  assert.equal(result.errors[0].code, 'unverified-items');
  const file = writeManifest(fx.root, manifest);
  assert.equal(cli(['--root', fx.root, '--manifest', file]).status, 1);
  const malformed = verifyManifestEntries({ root: fx.root, manifest: { ...manifest, unverified: {} } });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.errors[0].code, 'bad-manifest');
});

test('Windows 大小写别名不能重复计为已核验资源', { skip: process.platform !== 'win32' }, (t) => {
  const fx = buildFixture(t);
  const entries = ['assets/alpha.txt', 'assets/ALPHA.TXT'].map((rel) => ({ path: rel, bytes: 1, sha256: sha256('A') }));
  const result = verifyManifestEntries({ root: fx.root, manifest: { schemaVersion: 1, entries } });
  assert.equal(result.ok, false);
  assert.equal(result.totals.verified, 0);
  assert.equal(result.totals.failedPaths, 2);
  assert.ok(result.errors.every((e) => e.code === 'duplicate-path'));
});
