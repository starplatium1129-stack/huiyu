'use strict';

/**
 * scripts/tests/test-resource-manifest.js — 资源清单生成/校验隔离夹具测试
 *
 * 全部读写限定在 os.tmpdir() 临时夹具；越界用例使用夹具自建的无敏感外部目录，
 * 并以记录型 fs 证明越界目标未被 stat/读取。不触碰生产数据、不构建 dist。
 * 运行：node scripts/tests/test-resource-manifest.js
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const { generateManifest, verifyManifest, verifyManifestEntries, checkManifestPath, compareManifests, compareManifestFiles }: typeof import('../lib/resource-manifest') = require('../lib/resource-manifest');

const repo = path.resolve(__dirname, '..', '..');
const sha256 = (value: any) => crypto.createHash('sha256').update(value).digest('hex');

/** 记录型 fs：调用穿透真实 fs，同时记录目标路径，用于证明越界用例零越界访问。 */
function recordingFs() {
  const calls: any = [];
  const io = Object.create(fs);
  for (const op of ['statSync', 'readdirSync', 'realpathSync', 'readFileSync']) {
    io[op] = (...args) => {
      calls.push({ op, target: String(args[0]) });
      return fs[op](...args);
    };
  }
  return { io, calls };
}

function insideRoot(rootReal: any, target: any) {
  const rel = path.relative(rootReal, target);
  // 记录器允许 realpathSync(root) 本身（target === rootReal）；清单路径的严格
  // 内含判断由被测代码的 isInsideRoot 负责。
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function assertNoAccessOutside(calls: any, rootReal: any) {
  for (const call of calls) {
    assert.ok(insideRoot(rootReal, path.resolve(call.target)), `${call.op} 越界访问了 ${call.target}`);
  }
}

function buildFixture(t: any) {
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

function snapshot(root: any) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(root, e.name);
    if (e.isSymbolicLink()) return [[p, '<link>']];
    return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
}

function writeManifest(root: any, manifest: any, name = 'manifest.json') {
  const dir = path.join(root, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function cli(args: any) {
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
  const sizeError: any = verifyManifestEntries({ root: fx.root, manifest: wrongSize }).errors.find((e: any) => e.code === 'size-mismatch');
  assert.equal(sizeError.path, 'assets/alpha.txt');
  assert.equal(sizeError.expected, 99);
  assert.equal(sizeError.actual, 1);

  const wrongHash = { ...manifest, entries: manifest.entries.map((e) => (e.path === 'assets/alpha.txt' ? { ...e, sha256: 'f'.repeat(64) } : e)) };
  const hashError: any = verifyManifestEntries({ root: fx.root, manifest: wrongHash }).errors.find((e: any) => e.code === 'hash-mismatch');
  assert.equal(hashError.path, 'assets/alpha.txt');
  assert.equal(hashError.actual, sha256('A'));

  fs.unlinkSync(path.join(fx.root, 'assets/alpha.txt'));
  const result = verifyManifestEntries({ root: fx.root, manifest });
  const missing: any = result.errors.find((e: any) => e.code === 'missing');
  assert.equal(missing.path, 'assets/alpha.txt');
  assert.ok(result.errors.every((e: any) => e.code !== 'hash-mismatch'));
});

test('重复路径被拒绝且该路径计入失败', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const duplicated = { ...manifest, entries: [...manifest.entries, manifest.entries[0]] };
  const result = verifyManifestEntries({ root: fx.root, manifest: duplicated });
  assert.equal(result.ok, false);
  const dup: any = result.errors.find((e: any) => e.code === 'duplicate-path');
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
  assert.ok(result.errors.every((e: any) => ['illegal-path', 'out-of-scope'].includes(e.code)));
  assert.ok(result.errors.every((e: any) => e.actual === undefined));
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  assert.ok(calls.every((c: any) => c.op !== 'readFileSync'), '越界用例不得读取任何文件内容');
});

test('junction 越界在校验中被拒且不读取链接目标', (t) => {
  const fx = buildFixture(t);
  fs.symlinkSync(fx.outside, path.join(fx.root, 'assets', 'lnk'), process.platform === 'win32' ? 'junction' : 'dir');
  const secret = fs.readFileSync(fx.secretAbs);
  const manifest = { schemaVersion: 1, entries: [{ path: 'assets/lnk/secret.txt', bytes: secret.length, sha256: sha256(secret) }] };
  const before = snapshot(fx.outside);
  const { io, calls } = recordingFs();
  const result = verifyManifestEntries({ root: fx.root, manifest, io });
  const err: any = result.errors.find((e: any) => e.code === 'realpath-outside-root');
  assert.ok(err, JSON.stringify(result.errors));
  assert.equal(err.path, 'assets/lnk/secret.txt');
  assert.ok(!('actual' in err) && !('expected' in err));
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  assert.ok(calls.every((c: any) => c.op !== 'readFileSync'), 'junction 越界不得读取目标内容');
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
  assert.ok(calls.every((c: any) => !String(c.target).includes('character-references')), '排除域不得被遍历或读取');
});

test('不支持 schemaVersion、坏条目与坏 JSON 不得无条件成功', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  const v2: any = verifyManifestEntries({ root: fx.root, manifest: { ...manifest, schemaVersion: 2 } });
  assert.equal(v2.ok, false);
  assert.equal(v2.errors[0].code, 'unsupported-schema');
  const badEntries: any = verifyManifestEntries({ root: fx.root, manifest: { schemaVersion: 1, entries: 'nope' } });
  assert.equal(badEntries.errors[0].code, 'bad-manifest');
  const badField = verifyManifestEntries({ root: fx.root, manifest: { schemaVersion: 1, entries: [{ path: 'assets/alpha.txt', bytes: '1', sha256: 'zz' }] } });
  assert.ok(badField.errors.some((e: any) => e.code === 'bad-entry'));
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
  // G7：差异比较参数同样经注册入口转发
  const sameFile = writeManifest(fx.root, manifest, 'workflow-diff-same.json');
  const viaWorkflowDiff = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'audit:resource-manifest', '--root', fx.root, '--manifest', file, '--compare-manifest', sameFile], { encoding: 'utf8' });
  assert.equal(viaWorkflowDiff.status, 0);
  const forwarded = JSON.parse(viaWorkflowDiff.stdout);
  assert.equal(forwarded.kind, 'resource-manifest-diff');
  assert.equal(forwarded.identical, true);
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
    const result: any = verifyManifestEntries({ root: fx.root, io, manifest: { schemaVersion: 1, entries: [{ path: rel, bytes: 8, sha256: sha256('excluded') }] } });
    assert.equal(result.ok, false, rel);
    assert.equal(result.errors[0].code, 'out-of-scope');
    assert.ok(calls.every((c: any) => c.op !== 'readFileSync'), rel);
    assert.ok(calls.filter((c: any) => c.op === 'statSync').every((c: any) => c.target === fs.realpathSync(fx.root)), '拒绝目标之前不得 stat 目标');
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
  assert.ok(calls.every((c: any) => !['readFileSync', 'readdirSync'].includes(c.op)));
  assert.equal(cli(['--root', root]).status, 2);
});

test('含未核验项的清单保留条目核验数量但整体退出失败', (t) => {
  const fx = buildFixture(t);
  fs.symlinkSync(fx.outside, path.join(fx.root, 'assets/link'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = generateManifest({ root: fx.root });
  assert.equal(manifest.unverified.length, 1);
  const result: any = verifyManifestEntries({ root: fx.root, manifest });
  assert.equal(result.ok, false);
  assert.equal(result.totals.verified, 4);
  assert.equal(result.errors[0].code, 'unverified-items');
  const file = writeManifest(fx.root, manifest);
  assert.equal(cli(['--root', fx.root, '--manifest', file]).status, 1);
  const malformed: any = verifyManifestEntries({ root: fx.root, manifest: { ...manifest, unverified: {} } });
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
  assert.ok(result.errors.every((e: any) => e.code === 'duplicate-path'));
});

// ——— G7：资源清单差异比较 ———

function manifestOf(entries: any, extra = {}) {
  return { schemaVersion: 1, kind: 'resource-manifest', generatedAt: '2026-01-01T00:00:00.000Z', ...extra, entries };
}

function ent(rel: any, content: any) {
  return { path: rel, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

test('G7 纯比较：新增/移除/改变/未改变按路径稳定输出，输入乱序不影响结果', () => {
  const oldEntries = [ent('assets/a.txt', 'A'), ent('assets/c.txt', 'C3'), ent('assets/dir/b.bin', 'BB'), ent('assets/gone.txt', 'GGGG')];
  const newEntries = [ent('assets/a.txt', 'A'), ent('assets/c.txt', 'CCCCCCCC'), ent('assets/dir/b.bin', 'BX'), ent('assets/new.txt', 'N')];
  const result: any = compareManifests({ oldManifest: manifestOf(oldEntries), newManifest: manifestOf(newEntries) });
  assert.equal(result.kind, 'resource-manifest-diff');
  assert.equal(result.ok, true);
  assert.equal(result.identical, false);
  assert.deepEqual(result.totals, { added: 1, removed: 1, changed: 2, unchanged: 1 });
  assert.deepEqual(result.added, [newEntries[3]]);
  assert.deepEqual(result.removed, [oldEntries[3]]);
  assert.deepEqual(result.changed.map((e: any) => e.path), ['assets/c.txt', 'assets/dir/b.bin']);
  assert.deepEqual(result.changed[0].before, { bytes: 2, sha256: sha256('C3') });
  assert.deepEqual(result.changed[0].after, { bytes: 8, sha256: sha256('CCCCCCCC') });
  assert.equal(result.changed[1].before.bytes, result.changed[1].after.bytes, '同大小改哈希也算内容改变');
  assert.equal(result.changed[1].before.sha256, sha256('BB'));
  assert.equal(result.changed[1].after.sha256, sha256('BX'));
  assert.ok(result.scope.coverageNote.includes('完整一致'), '范围说明区分已列条目一致与完整一致');

  const shuffled = compareManifests({
    oldManifest: manifestOf([...oldEntries].reverse(), { generatedAt: '2030-01-01T00:00:00.000Z' }),
    newManifest: manifestOf([newEntries[2], newEntries[0], newEntries[3], newEntries[1]], { generatedAt: '2000-01-01T00:00:00.000Z' }),
  });
  assert.deepEqual({ totals: shuffled.totals, added: shuffled.added, removed: shuffled.removed, changed: shuffled.changed }, { totals: result.totals, added: result.added, removed: result.removed, changed: result.changed }, 'generatedAt 与条目顺序不影响比较结果');
});

test('G7 纯比较：完全相同与空清单', () => {
  const entries = [ent('assets/a.txt', 'A'), ent('assets/dir/b.bin', 'BB')];
  const same = compareManifests({ oldManifest: manifestOf(entries), newManifest: manifestOf([...entries]) });
  assert.equal(same.ok, true);
  assert.equal(same.identical, true);
  assert.deepEqual(same.totals, { added: 0, removed: 0, changed: 0, unchanged: 2 });
  assert.deepEqual(same.added, []);
  assert.deepEqual(same.removed, []);
  assert.deepEqual(same.changed, []);

  const empty = compareManifests({ oldManifest: manifestOf([]), newManifest: manifestOf([]) });
  assert.equal(empty.ok, true);
  assert.equal(empty.identical, true);
  assert.deepEqual(empty.totals, { added: 0, removed: 0, changed: 0, unchanged: 0 });
  const fromEmpty = compareManifests({ oldManifest: manifestOf([]), newManifest: manifestOf([ent('assets/a.txt', 'A')]) });
  assert.deepEqual(fromEmpty.totals, { added: 1, removed: 0, changed: 0, unchanged: 0 });
  assert.deepEqual(fromEmpty.added, [ent('assets/a.txt', 'A')]);
  const toEmpty = compareManifests({ oldManifest: manifestOf([ent('assets/a.txt', 'A')]), newManifest: manifestOf([]) });
  assert.deepEqual(toEmpty.totals, { added: 0, removed: 1, changed: 0, unchanged: 0 });
  assert.deepEqual(toEmpty.removed, [ent('assets/a.txt', 'A')]);
});

test('G7 纯比较：冻结输入不修改，同哈希不同路径不猜重命名', () => {
  const oldEntry = Object.freeze(ent('assets/old.txt', 'same bytes'));
  const newEntry = Object.freeze(ent('assets/new.txt', 'same bytes'));
  const oldManifest = Object.freeze({ schemaVersion: 1, entries: Object.freeze([oldEntry]), unverified: Object.freeze([]) });
  const newManifest = Object.freeze({ schemaVersion: 1, entries: Object.freeze([newEntry]), unverified: Object.freeze([]) });
  const result = compareManifests({ oldManifest, newManifest });
  assert.equal(result.ok, true);
  assert.equal(result.identical, false);
  assert.deepEqual(result.totals, { added: 1, removed: 1, changed: 0, unchanged: 0 });
  assert.deepEqual(result.added, [newEntry]);
  assert.deepEqual(result.removed, [oldEntry]);
  assert.deepEqual(oldManifest.entries, [oldEntry]);
  assert.deepEqual(newManifest.entries, [newEntry]);
});

test('G7 纯比较：结构错误阻止差异计算并标明来源清单', () => {
  const good = manifestOf([ent('assets/a.txt', 'A')]);
  const cases = [
    ['old', manifestOf([ent('assets/a.txt', 'A')], { schemaVersion: 2 }), 'unsupported-schema'],
    ['new', manifestOf('nope'), 'bad-manifest'],
    ['new', manifestOf([{ path: 'assets/a.txt', bytes: '1', sha256: sha256('A') }]), 'bad-entry'],
    ['new', manifestOf([ent('assets/a.txt', 'A'), ent('assets/a.txt', 'B')]), 'duplicate-path'],
    ['old', manifestOf([ent('data/secret.txt', 'A')]), 'out-of-scope'],
    ['old', manifestOf([{ path: 'assets/..\\evil.txt', bytes: 1, sha256: sha256('A') }]), 'illegal-path'],
  ];
  for (const [side, bad, code] of cases) {
    const result: any = compareManifests({ oldManifest: side === 'old' ? bad : good, newManifest: side === 'new' ? bad : good });
    assert.equal(result.ok, false, code);
    const err = result.errors.find((e: any) => e.code === code);
    assert.ok(err, `${code} 应出现: ${JSON.stringify(result.errors)}`);
    assert.equal(err.side, side, code);
    assert.deepEqual(result.totals, { added: 0, removed: 0, changed: 0, unchanged: 0 }, code);
    assert.equal(result.identical, false, code);
  }
});

test('G7 纯比较：非空 unverified 保留已列条目差异但不构成完整一致结论', () => {
  const entries = [ent('assets/a.txt', 'A')];
  const unverifiedOld = manifestOf(entries, { unverified: [{ path: 'assets/link', kind: 'symlink', message: '不跟随' }] });
  const plain = manifestOf(entries);
  const sameListed: any = compareManifests({ oldManifest: unverifiedOld, newManifest: plain });
  assert.equal(sameListed.ok, false);
  const unv = sameListed.errors.find((e: any) => e.code === 'unverified-items');
  assert.ok(unv);
  assert.equal(unv.side, 'old');
  assert.equal(unv.count, 1);
  assert.equal(sameListed.identical, true);
  assert.deepEqual(sameListed.totals, { added: 0, removed: 0, changed: 0, unchanged: 1 });

  const diffListed = compareManifests({ oldManifest: unverifiedOld, newManifest: manifestOf([ent('assets/a.txt', 'A2')]) });
  assert.equal(diffListed.ok, false);
  assert.equal(diffListed.identical, false);
  assert.deepEqual(diffListed.totals, { added: 0, removed: 0, changed: 1, unchanged: 0 });
  assert.deepEqual(diffListed.changed.map((e) => e.path), ['assets/a.txt']);

  assert.equal(compareManifests({ oldManifest: plain, newManifest: manifestOf(entries, { unverified: [] }) }).ok, true, '空 unverified 数组不构成未核验项错误');
});

test('G7 文件级比较：只读取两份指定清单，不访问实际资产，输入保持不变', (t) => {
  const fx = buildFixture(t);
  const before = generateManifest({ root: fx.root });
  const oldFile = writeManifest(fx.root, before, 'diff-old.json');
  const oldJson = fs.readFileSync(oldFile, 'utf8');
  // 旧清单落盘后磁盘继续变化：删除已登记文件、修改另一文件——比较不依赖当前磁盘状态
  fs.unlinkSync(path.join(fx.root, 'assets/alpha.txt'));
  fs.writeFileSync(path.join(fx.root, 'assets/dir/bravo.bin'), 'changed!');
  const after = generateManifest({ root: fx.root });
  const newFile = writeManifest(fx.root, after, 'diff-new.json');
  const newJson = fs.readFileSync(newFile, 'utf8');

  const { io, calls } = recordingFs();
  const result: any = compareManifestFiles({ root: fx.root, manifestPath: oldFile, compareManifestPath: newFile, io });
  assert.equal(result.kind, 'resource-manifest-diff');
  assert.equal(result.ok, true);
  assert.equal(result.oldManifestPath, 'artifacts/diff-old.json');
  assert.equal(result.newManifestPath, 'artifacts/diff-new.json');
  assert.deepEqual(result.totals, { added: 0, removed: 1, changed: 1, unchanged: 2 });
  assert.deepEqual(result.removed.map((e: any) => e.path), ['assets/alpha.txt']);
  assert.deepEqual(result.changed.map((e: any) => e.path), ['assets/dir/bravo.bin']);
  assert.equal(result.changed[0].after.sha256, sha256('changed!'));

  const rootReal = fs.realpathSync(fx.root);
  const reads = calls.filter((c: any) => c.op === 'readFileSync').map((c: any) => path.resolve(c.target));
  assert.deepEqual(reads.sort(), [path.resolve(oldFile), path.resolve(newFile)].sort(), 'readFileSync 只指向两份清单');
  assert.ok(calls.every((c: any) => !path.resolve(c.target).startsWith(path.join(rootReal, 'assets'))), '比较不得访问 assets 下任何路径');
  assertNoAccessOutside(calls, rootReal);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), oldJson, '旧清单未被改动');
  assert.equal(fs.readFileSync(newFile, 'utf8'), newJson, '新清单未被改动');
});

test('G7 CLI：差异模式退出码契约、参数错误与 help/plan 零读取', (t) => {
  const fx = buildFixture(t);
  const manifest = generateManifest({ root: fx.root });
  writeManifest(fx.root, manifest, 'cli-old.json');
  writeManifest(fx.root, manifest, 'cli-same.json');
  const diffArgs = (a: any, b: any) => ['--root', fx.root, '--manifest', `artifacts/${a}`, '--compare-manifest', `artifacts/${b}`];

  const identical = cli(diffArgs('cli-old.json', 'cli-same.json'));
  assert.equal(identical.status, 0);
  const same = JSON.parse(identical.stdout);
  assert.equal(same.ok, true);
  assert.equal(same.identical, true);
  assert.deepEqual(same.totals, { added: 0, removed: 0, changed: 0, unchanged: 4 });

  fs.writeFileSync(path.join(fx.root, 'assets/alpha.txt'), 'AA');
  fs.unlinkSync(path.join(fx.root, 'assets/dir/charlie.txt'));
  fs.writeFileSync(path.join(fx.root, 'assets/new.txt'), 'fresh');
  const manifest2 = generateManifest({ root: fx.root });
  writeManifest(fx.root, manifest2, 'cli-new.json');
  const changed = cli(diffArgs('cli-old.json', 'cli-new.json'));
  assert.equal(changed.status, 0, '存在差异的比较本身成功');
  const diff = JSON.parse(changed.stdout);
  assert.equal(diff.ok, true);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.totals, { added: 1, removed: 1, changed: 1, unchanged: 2 });
  assert.deepEqual(diff.changed.map((e: any) => e.path), ['assets/alpha.txt']);
  assert.equal(diff.changed[0].before.sha256, sha256('A'));
  assert.equal(diff.changed[0].after.sha256, sha256('AA'));

  // 非空 unverified：已列条目一致也不得宣称完整一致（退出 1）
  fs.symlinkSync(fx.outside, path.join(fx.root, 'assets', 'lnk-diff'), process.platform === 'win32' ? 'junction' : 'dir');
  const withUnverified = generateManifest({ root: fx.root });
  assert.equal(withUnverified.unverified.length, 1);
  writeManifest(fx.root, withUnverified, 'cli-unv-a.json');
  writeManifest(fx.root, withUnverified, 'cli-unv-b.json');
  const unverifiedRun = cli(diffArgs('cli-unv-a.json', 'cli-unv-b.json'));
  assert.equal(unverifiedRun.status, 1);
  assert.equal(JSON.parse(unverifiedRun.stdout).identical, true);

  // 结构错误 → 1
  writeManifest(fx.root, { ...manifest, schemaVersion: 2 }, 'cli-v2.json');
  assert.equal(cli(diffArgs('cli-old.json', 'cli-v2.json')).status, 1);

  // 参数错误 → 2
  assert.equal(cli(['--root', fx.root, '--compare-manifest', 'artifacts/cli-new.json']).status, 2);
  assert.equal(cli(['--root', fx.root, '--manifest', 'artifacts/cli-old.json', '--compare-manifest']).status, 2);
  assert.equal(cli(['--root', fx.root, '--manifest', 'artifacts/cli-old.json', '--compare-manifest', path.join(fx.base, 'outside', 'escape.json')]).status, 2);

  // help/plan 带比较参数也不读取目标
  for (const flag of ['--help', '--plan']) {
    const help = cli([flag, '--root', path.join(os.tmpdir(), 'resource-manifest-nonexistent-g7'), '--manifest', 'x.json', '--compare-manifest', 'y.json']);
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('--compare-manifest'));
  }

  // 比较不改动两份输入清单
  assert.equal(fs.readFileSync(path.join(fx.root, 'artifacts/cli-old.json'), 'utf8'), JSON.stringify(manifest));
  assert.equal(fs.readFileSync(path.join(fx.root, 'artifacts/cli-new.json'), 'utf8'), JSON.stringify(manifest2));
});
