'use strict';

/**
 * scripts/tests/test-resource-pack-delta.js — 增量资源候选包隔离夹具测试（G13）
 *
 * 全部读写限定在 os.tmpdir() 临时夹具内；夹具自建状态演进而非真实素材；不触碰生产
 * 数据、不导出真实资产、不执行复制内容、不构建 dist。旧清单「仅结构核验、不读取其
 * 磁盘资产」的边界用记录型 fs 证明（removed 路径零 fs 访问；旧清单条目与新磁盘内容
 * 不一致时计划仍可行，证明未对旧清单做磁盘核验）。
 * 运行：node scripts/tests/test-resource-pack-delta.js
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const { manifestContentIdentity, planResourcePackDelta, stageResourcePackDelta }: typeof import('../lib/resource-pack-delta') = require('../lib/resource-pack-delta');
const { generateManifest, verifyManifest }: typeof import('../lib/resource-manifest') = require('../lib/resource-manifest');

const repo = path.resolve(__dirname, '..', '..');
const PACKS_REL = path.join('scripts', 'archive', 'resource-packs');

/** 记录型 fs：调用穿透真实 fs 并记录目标路径；hooks 可替换个别操作（模拟元数据写坏等）。 */
function recordingIo(hooks: any = {}) {
  const calls: any = [];
  const io = Object.create(fs);
  for (const op of ['statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'readFileSync', 'mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync']) {
    io[op] = (...args) => {
      calls.push({ op, target: String(args[0]) });
      const hook = hooks[op];
      if (hook) return hook(...args);
      return (fs as Record<string, any>)[op](...args);
    };
  }
  return { io, calls };
}

function insideRoot(rootReal: any, target: any) {
  const rel = path.relative(rootReal, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function assertNoAccessOutside(calls: any, rootReal: any) {
  for (const call of calls) {
    assert.ok(insideRoot(rootReal, path.resolve(call.target)), `${call.op} 越界访问了 ${call.target}`);
  }
}

/** 快照目录内容（不跟随链接）。仅用于本测试创建的夹具目录。 */
function snapshot(dir: any): any {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [[p, '<link>']];
    return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
}

/**
 * 两状态夹具：
 *  v1（旧清单 artifacts/old.json）：alpha.txt('A')、dir/bravo.bin(4 字节)、golf.txt('G')
 *  v2（新清单 artifacts/new.json）：alpha.txt 改为 'A2-changed'（changed）、bravo 不变
 *  （unchanged）、golf.txt 已从磁盘删除（removed）、charlie.txt 新增（added）
 * 旧清单的 alpha 记录与当前磁盘内容不一致、golf 已不存在：若误对旧清单做磁盘核验，
 * 增量计划会失败——plan.ok 为真本身即证明旧清单未做磁盘核验。
 */
function buildDeltaFixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-delta-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'assets/dir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A');
  fs.writeFileSync(path.join(root, 'assets/dir/bravo.bin'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(root, 'assets/golf.txt'), 'G');
  fs.writeFileSync(path.join(root, 'artifacts/old.json'), JSON.stringify(generateManifest({ root })));
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A2-changed');
  fs.writeFileSync(path.join(root, 'assets/charlie.txt'), 'hello charlie');
  fs.rmSync(path.join(root, 'assets/golf.txt'));
  fs.writeFileSync(path.join(root, 'artifacts/new.json'), JSON.stringify(generateManifest({ root })));
  return { base, root, oldManifest: 'artifacts/old.json', newManifest: 'artifacts/new.json' };
}

/** 仅删除的夹具：v1 有 alpha+golf，v2 只剩 alpha（golf 已删除）。 */
function buildRemovalFixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-delta-rm-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A');
  fs.writeFileSync(path.join(root, 'assets/golf.txt'), 'GOLD');
  fs.writeFileSync(path.join(root, 'artifacts/old.json'), JSON.stringify(generateManifest({ root })));
  const oldGolf = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/old.json'), 'utf8')).entries.find((e: any) => e.path === 'assets/golf.txt');
  fs.rmSync(path.join(root, 'assets/golf.txt'));
  fs.writeFileSync(path.join(root, 'artifacts/new.json'), JSON.stringify(generateManifest({ root })));
  return { base, root, oldGolf };
}

function destPath(root: any, name: any) {
  return path.join(root, PACKS_REL, name);
}

function cli(args: any) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts', 'maintenance', 'stage-resource-pack.js'), ...args], { encoding: 'utf8' });
}

/** 以 mutator 变换既有清单文件后另存为 root 内 artifacts/<name>。 */
function writeMutatedManifest(root: any, sourceRel: any, name: any, mutator: any) {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, sourceRel), 'utf8'));
  const file = path.join(root, 'artifacts', name);
  fs.writeFileSync(file, typeof mutator === 'string' ? mutator : JSON.stringify(mutator(parsed)));
  return `artifacts/${name}`;
}

test('增量预览：四类差异分类正确，候选只含 added/changed，预览零写入', (t) => {
  const fx = buildDeltaFixture(t);
  const before = snapshot(fx.root);
  const plan: any = planResourcePackDelta({ root: fx.root, name: 'dplan', manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.kind, 'resource-pack-delta-plan');
  assert.equal(plan.mode, 'preview');
  assert.deepEqual(plan.delta.totals, { added: 1, removed: 1, changed: 1, unchanged: 1 });
  assert.deepEqual(plan.entries.map((e: any) => e.path), ['assets/alpha.txt', 'assets/charlie.txt'], '候选只含 added/changed 且按路径稳定排序');
  const alpha = plan.entries.find((e: any) => e.path === 'assets/alpha.txt');
  assert.equal(alpha.bytes, 'A2-changed'.length, 'changed 条目携带新清单字节');
  assert.deepEqual(plan.delta.removed.map((r: any) => r.path), ['assets/golf.txt']);
  assert.equal(plan.delta.baseManifest.path, 'artifacts/old.json');
  assert.equal(plan.delta.newManifest.path, 'artifacts/new.json');
  assert.match(plan.delta.baseManifest.contentIdentity, /^[0-9a-f]{64}$/);
  assert.notEqual(plan.delta.baseManifest.contentIdentity, plan.delta.newManifest.contentIdentity);
  assert.deepEqual(plan.totals, { files: 2, bytes: 'A2-changed'.length + 'hello charlie'.length }, '候选合计只统计 added/changed');
  assert.equal(fs.existsSync(path.join(fx.root, 'scripts')), false, '预览不得创建 scripts 树');
  assert.deepEqual(snapshot(fx.root), before, '预览零写入');
});

test('增量导出：只复制 added/changed，unchanged/removed 不进包，manifest.json 可核验，delta.json 完整', (t) => {
  const fx = buildDeltaFixture(t);
  const assetsBefore = snapshot(path.join(fx.root, 'assets'));
  const oldBytes = fs.readFileSync(path.join(fx.root, fx.oldManifest));
  const result = cli(['--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', fx.oldManifest, '--name', 'delta-ok', '--apply']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.kind, 'resource-pack-delta-result');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.destinationCreated, true);
  assert.equal(parsed.stagingPath, null);
  assert.equal(parsed.baseManifestPath, 'artifacts/old.json');
  assert.equal(parsed.delta.totals.added, 1);

  const pack = destPath(fx.root, 'delta-ok');
  assert.deepEqual(fs.readdirSync(pack).sort(), ['assets', 'delta.json', 'manifest.json']);
  assert.equal(fs.readFileSync(path.join(pack, 'assets/alpha.txt'), 'utf8'), 'A2-changed');
  assert.equal(fs.readFileSync(path.join(pack, 'assets/charlie.txt'), 'utf8'), 'hello charlie');
  assert.equal(fs.existsSync(path.join(pack, 'assets/dir')), false, 'unchanged 不复制');
  assert.equal(fs.existsSync(path.join(pack, 'assets/golf.txt')), false, 'removed 不复制也不删除');
  const packManifest = JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8'));
  assert.equal(packManifest.totals.files, 2, '候选 manifest.json 只列实际复制条目');
  assert.equal(packManifest.scope.pack.baseManifestPath, 'artifacts/old.json');
  assert.ok(packManifest.scope.pack.note.includes('增量'), 'manifest.json 标明增量候选');
  assert.ok(packManifest.scope.coverageNote.includes('不代表基线全集'), '覆盖说明不冒充完整包');
  const verifyResult = verifyManifest({ root: pack, manifestPath: 'manifest.json' });
  assert.equal(verifyResult.ok, true);
  assert.equal(verifyResult.totals.verified, 2);
  const viaExistingCli = spawnSync(process.execPath, [path.join(repo, 'scripts', 'maintenance', 'report-resource-manifest.js'), '--root', pack, '--manifest', 'manifest.json'], { encoding: 'utf8' });
  assert.equal(viaExistingCli.status, 0, viaExistingCli.stderr);

  const deltaJson = JSON.parse(fs.readFileSync(path.join(pack, 'delta.json'), 'utf8'));
  assert.equal(deltaJson.kind, 'resource-pack-delta');
  assert.deepEqual(deltaJson.totals, { added: 1, removed: 1, changed: 1, unchanged: 1 });
  assert.deepEqual(deltaJson.removed.map((r: any) => r.path), ['assets/golf.txt']);
  assert.equal(deltaJson.candidate.files, 2);
  assert.equal(deltaJson.candidate.zeroAssets, false);
  assert.ok(deltaJson.candidate.note.includes('不是完整可安装包'), 'delta.json 明示增量产物边界');
  assert.ok(deltaJson.identityBasis.includes('generatedAt'), '身份口径说明不含生成时间');
  const oldManifest = JSON.parse(fs.readFileSync(path.join(fx.root, fx.oldManifest), 'utf8'));
  const newManifest = JSON.parse(fs.readFileSync(path.join(fx.root, fx.newManifest), 'utf8'));
  assert.equal(deltaJson.baseManifest.contentIdentity, manifestContentIdentity(oldManifest), 'base 身份与清单条目可复算一致');
  assert.equal(deltaJson.newManifest.contentIdentity, manifestContentIdentity(newManifest), 'new 身份与清单条目可复算一致');

  assert.deepEqual(snapshot(path.join(fx.root, 'assets')), assetsBefore, '源素材字节不变');
  assert.equal(fs.readFileSync(path.join(fx.root, fx.oldManifest)).toString(), oldBytes.toString(), '源清单未被改动');
});

test('旧清单仅结构核验：removed 旧资产零 fs 访问，旧记录与新磁盘不符不影响比较', (t) => {
  const fx = buildDeltaFixture(t);
  const { io, calls } = recordingIo();
  const plan: any = planResourcePackDelta({ root: fx.root, name: 'no-old-reads', manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest, io });
  assert.equal(plan.ok, true, '旧清单条目与磁盘不符（alpha 已改、golf 已删）仍可比较，证明未对旧清单做磁盘核验');
  const golfAbs = path.join(fx.root, 'assets', 'golf.txt');
  assert.ok(calls.every((c: any) => path.resolve(c.target) !== path.resolve(golfAbs)), 'removed 旧资产不得被 stat/read');
  const oldAlpha = JSON.parse(fs.readFileSync(path.join(fx.root, fx.oldManifest), 'utf8')).entries.find((e: any) => e.path === 'assets/alpha.txt');
  assert.notEqual(oldAlpha.sha256, plan.entries.find((e: any) => e.path === 'assets/alpha.txt').sha256, '夹具前提：changed 条目新旧哈希不同');
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
});

test('仅删除的差异：零资产候选，removed 记录保留旧 bytes/sha256，不删除任何资源', (t) => {
  const fx = buildRemovalFixture(t);
  const plan: any = planResourcePackDelta({ root: fx.root, name: 'rm-plan', manifestPath: 'artifacts/new.json', baseManifestPath: 'artifacts/old.json' });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.delta.totals, { added: 0, removed: 1, changed: 0, unchanged: 1 });
  assert.deepEqual(plan.entries, []);
  const result = cli(['--root', fx.root, '--manifest', 'artifacts/new.json', '--base-manifest', 'artifacts/old.json', '--name', 'rm-pack', '--apply']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pack = destPath(fx.root, 'rm-pack');
  assert.deepEqual(fs.readdirSync(pack).sort(), ['delta.json', 'manifest.json'], '仅删除差异产出零资产候选（无 assets 目录）');
  const deltaJson = JSON.parse(fs.readFileSync(path.join(pack, 'delta.json'), 'utf8'));
  assert.deepEqual(deltaJson.removed, [{ path: fx.oldGolf.path, bytes: fx.oldGolf.bytes, sha256: fx.oldGolf.sha256 }], 'removed 保留旧条目 bytes/sha256');
  assert.equal(deltaJson.candidate.zeroAssets, true);
  assert.equal(verifyManifest({ root: pack, manifestPath: 'manifest.json' }).ok, true, '零条目候选 manifest.json 仍可被现有 verifier 通过');
  assert.equal(fs.existsSync(path.join(fx.root, 'assets/alpha.txt')), true, '现存源资源不受影响');
  assert.equal(plan.notes.join('\n').includes('零资产候选'), true, '零资产候选有明确说明');
});

test('零差异：generatedAt 不影响身份与分类，输出零资产候选且不称已安装更新', (t) => {
  const fx = buildDeltaFixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(fx.root, fx.newManifest), 'utf8'));
  const withOtherTime = { ...manifest, generatedAt: '2000-01-01T00:00:00.000Z' };
  assert.equal(manifestContentIdentity(withOtherTime), manifestContentIdentity(manifest), '时间戳不影响内容身份');
  const samePath = writeMutatedManifest(fx.root, fx.newManifest, 'same.json', () => withOtherTime);
  const plan: any = planResourcePackDelta({ root: fx.root, name: 'zero', manifestPath: fx.newManifest, baseManifestPath: samePath });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.delta.totals, { added: 0, removed: 0, changed: 0, unchanged: 3 });
  assert.deepEqual(plan.entries, []);
  const result = cli(['--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', samePath, '--name', 'zero-pack', '--apply']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pack = destPath(fx.root, 'zero-pack');
  assert.deepEqual(fs.readdirSync(pack).sort(), ['delta.json', 'manifest.json']);
  const deltaJson = JSON.parse(fs.readFileSync(path.join(pack, 'delta.json'), 'utf8'));
  assert.equal(deltaJson.candidate.zeroAssets, true);
  assert.equal(deltaJson.candidate.files, 0);
  assert.ok(deltaJson.candidate.note.includes('不能当作已安装更新'), '零资产候选不冒充已安装更新');
  assert.equal(verifyManifest({ root: pack, manifestPath: 'manifest.json' }).ok, true);
});

test('坏旧/新清单：结构错误、坏 JSON、非空 unverified 均拒绝且零写入', (t) => {
  const fx = buildDeltaFixture(t);
  const cases = {
    'old-broken.json': ['base', '{ not json'],
    'old-schema.json': ['base', (m: any) => ({ ...m, schemaVersion: 2 })],
    'old-dup.json': ['base', (m: any) => ({ ...m, entries: [...m.entries, m.entries[0]] })],
    'old-unverified.json': ['base', (m: any) => ({ ...m, unverified: [{ path: 'assets/x', kind: 'symlink', message: '不跟随' }] })],
    'old-badpath.json': ['base', (m: any) => ({ ...m, entries: [...m.entries, { path: 'assets/..\\evil.txt', bytes: 1, sha256: 'a'.repeat(64) }] })],
    'new-broken.json': ['manifest', '{ not json'],
    'new-hash.json': ['manifest', (m: any) => ({ ...m, entries: m.entries.map((e: any) => (e.path === 'assets/alpha.txt' ? { ...e, sha256: 'f'.repeat(64) } : e)) })],
  };
  for (const [name, [slot, mutator]] of Object.entries(cases)) {
    const fileRel = writeMutatedManifest(fx.root, slot === 'base' ? fx.oldManifest : fx.newManifest, name, mutator);
    const packName = `rej-${name.replace(/\.json$/, '')}`;
    const args = slot === 'base'
      ? ['--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', fileRel, '--name', packName, '--apply']
      : ['--root', fx.root, '--manifest', fileRel, '--base-manifest', fx.oldManifest, '--name', packName, '--apply'];
    const r = cli(args);
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.length > 0);
    assert.equal(fs.existsSync(destPath(fx.root, packName)), false, `${name} 不得创建目标`);
  }
  assert.equal(fs.existsSync(path.join(fx.root, 'scripts')), false, '全部拒绝后不创建 packs 目录');
});

test('参数契约：base 缺 manifest 退出 2；base 越界/缺失退出 2；help/plan 零读取', (t) => {
  const fx = buildDeltaFixture(t);
  assert.equal(cli(['--root', fx.root, '--base-manifest', fx.oldManifest, '--name', 'x']).status, 2, '--base-manifest 缺 --manifest');
  assert.equal(cli(['--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', path.join(fx.base, 'outside.json'), '--name', 'x']).status, 2, 'base 清单在 root 外');
  assert.equal(cli(['--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', 'artifacts/missing.json', '--name', 'x']).status, 2, 'base 清单不存在');
  const missingRoot = path.join(os.tmpdir(), 'resource-pack-delta-nonexistent');
  for (const flag of ['--help', '--plan']) {
    const r = cli([flag, '--root', missingRoot, '--manifest', 'a.json', '--base-manifest', 'b.json', '--name', 'p', '--apply']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('--base-manifest'), '帮助包含增量模式说明');
    assert.ok(r.stdout.includes('不是完整可安装包'), '帮助明示增量产物边界');
  }
});

test('两个元数据任一写坏都不发布：暂存保留并给出明确错误码', (t) => {
  for (const [target, code] of [['manifest.json', 'manifest-write-mismatch'], ['delta.json', 'delta-write-mismatch']]) {
    const fx = buildDeltaFixture(t);
    const packName = `bad-${target.replace('.json', '')}`;
    const { io } = recordingIo({ writeFileSync: (p: any, value: any, ...rest: any[]) => {
      if (String(p).endsWith(target)) return fs.writeFileSync(p, '{corrupted', ...rest);
      return fs.writeFileSync(p, value, ...rest);
    } });
    const result = stageResourcePackDelta({ root: fx.root, name: packName, manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest, io });
    assert.equal(result.ok, false, target);
    assert.equal(result.destinationCreated, false, target);
    assert.ok(result.errors.some((e: any) => e.code === code), `${target}: ${JSON.stringify(result.errors)}`);
    assert.ok(result.stagingPath, `${target} 失败须报告暂存路径`);
    assert.equal(fs.existsSync(destPath(fx.root, packName)), false, `${target} 损坏不得发布最终包`);
  }
});

test('全包模式兼容：无 --base-manifest 时行为与 G10 相同，结果无增量字段', (t) => {
  const fx = buildDeltaFixture(t);
  const result = cli(['--root', fx.root, '--manifest', fx.newManifest, '--name', 'fullmode', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.kind, 'resource-pack-result');
  assert.equal(parsed.totals.files, 3, '全包含新清单全部条目');
  assert.equal(parsed.baseManifestPath, undefined, '全包结果无 baseManifestPath');
  assert.equal(parsed.delta, undefined, '全包结果无 delta');
  const pack = destPath(fx.root, 'fullmode');
  assert.deepEqual(fs.readdirSync(pack).sort(), ['assets', 'manifest.json'], '全包不写 delta.json');
  assert.deepEqual(fs.readdirSync(path.join(pack, 'assets/dir')), ['bravo.bin']);
  assert.equal(verifyManifest({ root: pack, manifestPath: 'manifest.json' }).ok, true);
});

test('非 Windows：增量 apply 明确拒绝且零写入，预览可用', (t) => {
  const fx = buildDeltaFixture(t);
  const { io, calls } = recordingIo();
  const result = stageResourcePackDelta({ root: fx.root, name: 'unix', manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest, io, platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'unsupported-platform');
  assert.ok(calls.every((c: any) => !['mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync'].includes(c.op)));
  assert.equal(planResourcePackDelta({ root: fx.root, name: 'unix', manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest }).ok, true);
});

test('增量模式同名目标拒绝与全程零越界访问（记录型 fs 证明）', (t) => {
  const fx = buildDeltaFixture(t);
  fs.mkdirSync(destPath(fx.root, 'taken'), { recursive: true });
  const r = cli(['--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', fx.oldManifest, '--name', 'taken', '--apply']);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.errors.some((e: any) => e.code === 'destination-exists'));
  assert.equal(parsed.delta, null, '计划失败时 delta 为 null');
  assert.deepEqual(fs.readdirSync(destPath(fx.root, 'taken')), [], '既有目录未被写入');

  const { io, calls } = recordingIo();
  const staged = stageResourcePackDelta({ root: fx.root, name: 'audit-pack', manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest, io });
  assert.equal(staged.ok, true, JSON.stringify(staged.errors));
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  const writes = calls.filter((c: any) => ['writeFileSync', 'renameSync', 'mkdirSync', 'mkdtempSync'].includes(c.op));
  assert.ok(writes.length > 0, 'apply 确实发生了写入');
  for (const call of writes) {
    assert.ok(call.target.includes(path.join('scripts', 'archive', 'resource-packs')), `写入目标应限于候选目录: ${call.target}`);
  }
});

test('工作流注册转发增量模式（G13 独占注册）', (t) => {
  const fx = buildDeltaFixture(t);
  const viaWorkflow = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'resource:pack', '--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', fx.oldManifest, '--name', 'viaflow-delta', '--apply'], { encoding: 'utf8' });
  assert.equal(viaWorkflow.status, 0, viaWorkflow.stderr);
  const forwarded = JSON.parse(viaWorkflow.stdout);
  assert.equal(forwarded.kind, 'resource-pack-delta-result');
  assert.equal(forwarded.ok, true);
  assert.equal(forwarded.destinationCreated, true);
  assert.equal(verifyManifest({ root: destPath(fx.root, 'viaflow-delta'), manifestPath: 'manifest.json' }).ok, true);
  const preview = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'resource:pack', '--root', fx.root, '--manifest', fx.newManifest, '--base-manifest', fx.oldManifest, '--name', 'viaflow-delta2', '--plan'], { encoding: 'utf8' });
  assert.equal(preview.status, 0);
  assert.ok(preview.stderr.includes('[预览]'), 'runner 级 --plan 只打印，不执行');
  assert.equal(fs.existsSync(destPath(fx.root, 'viaflow-delta2')), false, '--plan 未创建目标');
});

test('发布后 delta 元数据损坏不得报告候选包验收成功', (t) => {
  const fx = buildDeltaFixture(t);
  const { io } = recordingIo({ renameSync: (from: any, to: any) => {
    fs.renameSync(from, to);
    fs.writeFileSync(path.join(to, 'delta.json'), '{}');
  } });
  const result: any = stageResourcePackDelta({ root: fx.root, name: 'after-publish', manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest, io });
  assert.equal(result.ok, false);
  assert.equal(result.destinationCreated, true);
  assert.equal(result.finalVerification.ok, false);
  assert.ok(result.errors.some((e: any) => e.code === 'delta-write-mismatch'));
});

test('内容身份对顺序、哈希大小写、生成时间和根位置稳定，对条目变化敏感', (t) => {
  const fx = buildDeltaFixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(fx.root, fx.newManifest), 'utf8'));
  const equivalent = { ...manifest, root: 'another-root', generatedAt: 'another-time', entries: [...manifest.entries].reverse().map((e) => ({ ...e, sha256: e.sha256.toUpperCase() })) };
  assert.equal(manifestContentIdentity(manifest), manifestContentIdentity(equivalent));
  for (const patch of [{ path: 'assets/renamed.txt' }, { bytes: 999 }, { sha256: '0'.repeat(64) }]) {
    const changed = { ...manifest, entries: manifest.entries.map((e: any, i: any) => i === 0 ? { ...e, ...patch } : e) };
    assert.notEqual(manifestContentIdentity(manifest), manifestContentIdentity(changed));
  }
});

test('unchanged 文件虽不复制仍须通过新清单完整磁盘核验', (t) => {
  const fx = buildDeltaFixture(t);
  fs.writeFileSync(path.join(fx.root, 'assets/dir/bravo.bin'), Buffer.from([9, 9, 9, 9]));
  const { io, calls } = recordingIo();
  const result = stageResourcePackDelta({ root: fx.root, name: 'bad-unchanged', manifestPath: fx.newManifest, baseManifestPath: fx.oldManifest, io });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: any) => e.code === 'hash-mismatch' && e.path === 'assets/dir/bravo.bin'));
  assert.ok(calls.every((c: any) => !['mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync'].includes(c.op)));
});
