'use strict';

/**
 * scripts/tests/test-resource-pack-verify.js — 增量候选包兼容核验隔离夹具测试（G15）
 *
 * 全部读写限定在 os.tmpdir() 临时夹具内；候选包由 G13 导出器（stageResourcePackDelta）
 * 在夹具内生成后按需篡改，不触碰生产数据、不导出真实资产、不执行复制内容、不构建 dist。
 * 「旧资产零访问」「零写入」用记录型 fs 证明：核验全程不得 stat/read 基线资产，不得出现
 * 任何写操作。运行：node scripts/tests/test-resource-pack-verify.js
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const { verifyDeltaPack, verifyDeltaPackContent }: typeof import('../lib/resource-pack-verify') = require('../lib/resource-pack-verify');
const { stageResourcePackDelta }: typeof import('../lib/resource-pack-delta') = require('../lib/resource-pack-delta');
const { stageResourcePack }: typeof import('../lib/resource-pack') = require('../lib/resource-pack');
const { generateManifest }: typeof import('../lib/resource-manifest') = require('../lib/resource-manifest');

const repo = path.resolve(__dirname, '..', '..');
const PACKS_REL = 'scripts/archive/resource-packs';
const OLD_MANIFEST = 'artifacts/old.json';
const NEW_MANIFEST = 'artifacts/new.json';

function packRel(name: any) {
  return `${PACKS_REL}/${name}`;
}

/** 记录型 fs：调用穿透真实 fs 并记录目标路径；hooks 可替换个别操作。 */
function recordingIo(hooks = {}) {
  const calls: any = [];
  const io = Object.create(fs);
  for (const op of ['statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'readFileSync', 'mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync', 'rmSync', 'unlinkSync']) {
    io[op] = (...args) => {
      calls.push({ op, target: String(args[0]) });
      const hook = hooks[op];
      if (hook) return hook(...args);
      return fs[op](...args);
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
function snapshot(dir: any) {
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
 *  （unchanged）、golf.txt 已删除（removed）、charlie.txt 新增（added）
 */
function buildTwoStateFixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-verify-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'assets/dir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A');
  fs.writeFileSync(path.join(root, 'assets/dir/bravo.bin'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(root, 'assets/golf.txt'), 'G');
  fs.writeFileSync(path.join(root, OLD_MANIFEST), JSON.stringify(generateManifest({ root })));
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A2-changed');
  fs.writeFileSync(path.join(root, 'assets/charlie.txt'), 'hello charlie');
  fs.rmSync(path.join(root, 'assets/golf.txt'));
  fs.writeFileSync(path.join(root, NEW_MANIFEST), JSON.stringify(generateManifest({ root })));
  return { base, root, outside: path.join(base, 'outside') };
}

/** 仅删除夹具：v1 有 alpha+golf，v2 只剩 alpha。 */
function buildRemovalFixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-verify-rm-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A');
  fs.writeFileSync(path.join(root, 'assets/golf.txt'), 'GOLD');
  fs.writeFileSync(path.join(root, OLD_MANIFEST), JSON.stringify(generateManifest({ root })));
  fs.rmSync(path.join(root, 'assets/golf.txt'));
  fs.writeFileSync(path.join(root, NEW_MANIFEST), JSON.stringify(generateManifest({ root })));
  return { base, root };
}

/** 零差异夹具：old/new 内容身份相同（仅 generatedAt 不同）。 */
function buildZeroDiffFixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-verify-zero-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A');
  fs.writeFileSync(path.join(root, OLD_MANIFEST), JSON.stringify(generateManifest({ root })));
  fs.writeFileSync(path.join(root, NEW_MANIFEST), JSON.stringify(generateManifest({ root })));
  return { base, root };
}

/** 在夹具内用 G13 导出器生成候选包（仅 Windows，与现有 pack 测试同一平台假设）。 */
function exportDeltaPack(root: any, name: any, { base = OLD_MANIFEST, manifest = NEW_MANIFEST } = {}) {
  const result = stageResourcePackDelta({ root, name, manifestPath: manifest, baseManifestPath: base });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.destinationCreated, true);
  return result;
}

/** 以 mutator 变换候选包内元数据文件；mutator 可返回新对象或就地修改后返回 undefined。 */
function editPackJson(packAbs: any, name: any, mutator: any) {
  const file = path.join(packAbs, name);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = mutator(parsed);
  fs.writeFileSync(file, JSON.stringify(result === undefined ? parsed : result));
}

function verify(root: any, base: any, pack: any, io?: any) {
  return verifyDeltaPack({ root, baseManifestPath: base, packPath: pack, ...(io ? { io } : {}) });
}

function cli(args: any) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts', 'maintenance', 'verify-resource-pack.js'), ...args], { encoding: 'utf8' });
}

test('往返：四类差异候选包核验通过，基线资产零访问、全程零写入、输入不变', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  const before = snapshot(fx.root);
  const oldBytes = fs.readFileSync(path.join(fx.root, OLD_MANIFEST));
  const packBefore = snapshot(path.join(fx.root, PACKS_REL, 'delta-ok'));

  const { io, calls } = recordingIo();
  const result = verify(fx.root, OLD_MANIFEST, packRel('delta-ok'), io);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.kind, 'resource-pack-delta-verification');
  assert.equal(result.compatibility.recomputedTotals.added, 1);
  assert.equal(result.compatibility.recomputedTotals.removed, 1);
  assert.equal(result.compatibility.recomputedTotals.changed, 1);
  assert.equal(result.compatibility.recomputedTotals.unchanged, 1);
  assert.equal(result.packVerification.ok, true, '候选实际字节核验通过');
  assert.equal(result.packVerification.verified, 2, '候选两个已列文件均通过字节核验');
  assert.ok(result.compatibility.identities.base.contentIdentity, '结果含基线身份');
  assert.notEqual(result.compatibility.identities.base.contentIdentity, result.compatibility.identities.target.contentIdentity);
  assert.ok(result.scope.coverageNote.includes('不是数字签名'), '结果声明正确性边界');

  assert.equal(calls.filter((c: any) => ['writeFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'rmSync', 'unlinkSync'].includes(c.op)).length, 0, '记录型 fs 证明零写入');
  const assetsAbs = path.join(fs.realpathSync(fx.root), 'assets');
  const baseAssetCalls = calls.filter((c: any) => {
    const resolved = path.resolve(c.target);
    return resolved === assetsAbs || resolved.startsWith(assetsAbs + path.sep);
  });
  assert.deepEqual(baseAssetCalls, [], '核验不得 stat/read 基线资产');
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  assert.deepEqual(snapshot(fx.root), before, '核验后 root 零变化');
  assert.deepEqual(snapshot(path.join(fx.root, PACKS_REL, 'delta-ok')), packBefore, '候选包内容不变');
  assert.equal(fs.readFileSync(path.join(fx.root, OLD_MANIFEST)).toString(), oldBytes.toString(), '基线清单未被改动');

  const r = cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.packVerification.verified, 2);
});

test('往返：零差异候选（零资产）核验通过且不称已安装更新', (t) => {
  const fx = buildZeroDiffFixture(t);
  exportDeltaPack(fx.root, 'zero-pack');
  const result = verify(fx.root, OLD_MANIFEST, packRel('zero-pack'));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.compatibility.recomputedTotals, { added: 0, removed: 0, changed: 0, unchanged: 1 });
  assert.equal(result.compatibility.candidate.actual.zeroAssets, true);
  assert.ok(result.notes.join('\n').includes('这不是已安装更新'), '零资产候选通过时明示非安装');
  const r = cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('zero-pack')]);
  assert.equal(r.status, 0, r.stderr);
});

test('往返：仅删除候选（零资产、removed 保留旧条目）核验通过', (t) => {
  const fx = buildRemovalFixture(t);
  exportDeltaPack(fx.root, 'rm-pack');
  const result = verify(fx.root, OLD_MANIFEST, packRel('rm-pack'));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.compatibility.recomputedTotals, { added: 0, removed: 1, changed: 0, unchanged: 1 });
  assert.equal(result.packVerification.verified, 0);
  const r = cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('rm-pack')]);
  assert.equal(r.status, 0, r.stderr);
});

test('错基线：换用新清单或其他清单作为基线即身份失配拒绝', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');

  const wrong = verify(fx.root, NEW_MANIFEST, packRel('delta-ok'));
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.some((e) => e.code === 'base-identity-mismatch'), JSON.stringify(wrong.errors));

  const parsed = JSON.parse(fs.readFileSync(path.join(fx.root, OLD_MANIFEST), 'utf8'));
  parsed.entries = parsed.entries.map((e: any, i: any) => (i === 0 ? { ...e, sha256: 'e'.repeat(64) } : e));
  fs.writeFileSync(path.join(fx.root, 'artifacts/flipped.json'), JSON.stringify(parsed));
  const flipped = verify(fx.root, 'artifacts/flipped.json', packRel('delta-ok'));
  assert.equal(flipped.ok, false);
  assert.ok(flipped.errors.some((e) => e.code === 'base-identity-mismatch'), JSON.stringify(flipped.errors));

  const r = cli(['--root', fx.root, '--base-manifest', NEW_MANIFEST, '--pack', packRel('delta-ok')]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).ok, false);
});

test('篡改 delta 目标身份/数量：重建结果与 delta.newManifest 不符即拒绝', (t) => {
  const cases = [
    ['identity', (d: any) => { d.newManifest.contentIdentity = 'f'.repeat(64); }, 'target-identity-mismatch'],
    ['entrycount', (d: any) => { d.newManifest.entryCount += 1; }, 'target-entrycount-mismatch'],
    ['totalbytes', (d: any) => { d.newManifest.totalBytes += 1; }, 'target-totalbytes-mismatch'],
  ];
  for (const [label, mutate, code] of cases) {
    const fx = buildTwoStateFixture(t);
    exportDeltaPack(fx.root, 'delta-ok');
    editPackJson(path.join(fx.root, PACKS_REL, 'delta-ok'), 'delta.json', mutate);
    const result = verify(fx.root, OLD_MANIFEST, packRel('delta-ok'));
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((e) => e.code === code), `${label}: ${JSON.stringify(result.errors)}`);
    const r = cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok')]);
    assert.equal(r.status, 1, label);
  }
});

test('removed 逐项核验：重复、不存在、身份不符、与候选重叠均拒绝', (t) => {
  const cases = [
    ['duplicate', ({ delta }: any) => { delta.removed.push({ ...delta.removed[0] }); }, 'duplicate-removed-path'],
    ['ghost', ({ delta }: any) => { delta.removed.push({ path: 'assets/ghost.txt', bytes: 1, sha256: 'a'.repeat(64) }); }, 'removed-not-in-baseline'],
    ['sha', ({ delta }: any) => { delta.removed[0].sha256 = 'f'.repeat(64); }, 'removed-identity-mismatch'],
    ['bytes', ({ delta }: any) => { delta.removed[0].bytes += 1; }, 'removed-identity-mismatch'],
    ['overlap', ({ root, packAbs, delta }: any) => {
      const bravo = JSON.parse(fs.readFileSync(path.join(root, OLD_MANIFEST), 'utf8')).entries.find((e: any) => e.path === 'assets/dir/bravo.bin');
      delta.removed.push({ ...delta.removed[0], path: 'assets/dir/bravo.bin' });
      const manifest = JSON.parse(fs.readFileSync(path.join(packAbs, 'manifest.json'), 'utf8'));
      manifest.entries.push({ ...bravo });
      fs.mkdirSync(path.join(packAbs, 'assets/dir'), { recursive: true });
      fs.writeFileSync(path.join(packAbs, 'assets/dir/bravo.bin'), Buffer.from([0, 1, 2, 255]));
      fs.writeFileSync(path.join(packAbs, 'manifest.json'), JSON.stringify(manifest));
      delta.candidate.files += 1;
      delta.candidate.bytes += bravo.bytes;
    }, 'removed-in-candidate'],
  ];
  for (const [label, mutate, code] of cases) {
    const fresh = buildTwoStateFixture(t);
    exportDeltaPack(fresh.root, 'delta-ok');
    const packAbs = path.join(fresh.root, PACKS_REL, 'delta-ok');
    const delta = JSON.parse(fs.readFileSync(path.join(packAbs, 'delta.json'), 'utf8'));
    mutate({ root: fresh.root, packAbs, delta });
    fs.writeFileSync(path.join(packAbs, 'delta.json'), JSON.stringify(delta));
    const result = verify(fresh.root, OLD_MANIFEST, packRel('delta-ok'));
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((e) => e.code === code), `${label}: ${JSON.stringify(result.errors)}`);
  }
});

test('候选多余同内容项：与基线同路径同内容的条目不能冒充 changed（唯一失败原因）', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  const packAbs = path.join(fx.root, PACKS_REL, 'delta-ok');
  const bravo = JSON.parse(fs.readFileSync(path.join(fx.root, OLD_MANIFEST), 'utf8')).entries.find((e: any) => e.path === 'assets/dir/bravo.bin');
  editPackJson(packAbs, 'manifest.json', (m: any) => ({ ...m, entries: [...m.entries, { ...bravo }] }));
  fs.mkdirSync(path.join(packAbs, 'assets/dir'), { recursive: true });
  fs.writeFileSync(path.join(packAbs, 'assets/dir/bravo.bin'), Buffer.from([0, 1, 2, 255]));
  editPackJson(packAbs, 'delta.json', (d: any) => {
    d.candidate.files += 1;
    d.candidate.bytes += bravo.bytes;
  });
  const result = verify(fx.root, OLD_MANIFEST, packRel('delta-ok'));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
  assert.equal(result.errors[0].code, 'unchanged-as-changed');
  assert.equal(result.errors[0].path, 'assets/dir/bravo.bin');
  const r = cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok')]);
  assert.equal(r.status, 1);
});

test('候选实图损坏：元数据全部相符仍因实际字节核验失败而拒绝', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  fs.writeFileSync(path.join(fx.root, PACKS_REL, 'delta-ok', 'assets/alpha.txt'), 'TAMPERED!!');
  const result = verify(fx.root, OLD_MANIFEST, packRel('delta-ok'));
  assert.equal(result.ok, false);
  assert.ok(result.compatibility, '元数据层本身相符，compatibility 仍完整给出');
  assert.ok(result.errors.some((e) => e.source === 'pack-files' && e.code === 'hash-mismatch' && e.path === 'assets/alpha.txt'), JSON.stringify(result.errors));
  assert.equal(result.packVerification.ok, false);
  const r = cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok')]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).packVerification.errorCount > 0, true);
});

test('元数据坏/缺/不支持版本：全部内容级拒绝（退出 1），全包不能冒充增量', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  // 全包（无 delta.json）按增量核验 → missing-delta-json
  const full = stageResourcePack({ root: fx.root, name: 'full-pack', manifestPath: NEW_MANIFEST });
  assert.equal(full.ok, true, JSON.stringify(full.errors));
  const fullResult = verify(fx.root, OLD_MANIFEST, packRel('full-pack'));
  assert.equal(fullResult.ok, false);
  assert.ok(fullResult.errors.some((e) => e.code === 'missing-delta-json'), JSON.stringify(fullResult.errors));
  assert.equal(cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('full-pack')]).status, 1);

  const cases = [
    ['missing-delta', (packAbs: any) => fs.rmSync(path.join(packAbs, 'delta.json')), 'missing-delta-json'],
    ['broken-delta', (packAbs: any) => fs.writeFileSync(path.join(packAbs, 'delta.json'), '{ broken'), 'bad-delta-json'],
    ['schema', (packAbs: any) => editPackJson(packAbs, 'delta.json', (d: any) => ({ ...d, schemaVersion: 2 })), 'unsupported-delta-schema'],
    ['kind', (packAbs: any) => editPackJson(packAbs, 'delta.json', (d: any) => ({ ...d, kind: 'resource-manifest' })), 'bad-delta-kind'],
    ['totals', (packAbs: any) => editPackJson(packAbs, 'delta.json', (d: any) => ({ ...d, totals: null })), 'bad-delta-metadata'],
    ['removed-type', (packAbs: any) => editPackJson(packAbs, 'delta.json', (d: any) => ({ ...d, removed: 'nope' })), 'bad-delta-metadata'],
    ['candidate-type', (packAbs: any) => editPackJson(packAbs, 'delta.json', (d: any) => ({ ...d, candidate: [] })), 'bad-delta-metadata'],
  ];
  for (const [label, mutate, code] of cases) {
    const fresh = buildTwoStateFixture(t);
    exportDeltaPack(fresh.root, 'delta-ok');
    mutate(path.join(fresh.root, PACKS_REL, 'delta-ok'));
    const result = verify(fresh.root, OLD_MANIFEST, packRel('delta-ok'));
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((e) => e.code === code), `${label}: ${JSON.stringify(result.errors)}`);
    const r = cli(['--root', fresh.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok')]);
    assert.equal(r.status, 1, label);
  }

  const manifestCases = [
    ['missing-manifest', (packAbs: any) => fs.rmSync(path.join(packAbs, 'manifest.json')), 'missing-pack-manifest'],
    ['broken-manifest', (packAbs: any) => fs.writeFileSync(path.join(packAbs, 'manifest.json'), '{ broken'), 'bad-pack-manifest'],
  ];
  for (const [label, mutate, code] of manifestCases) {
    const fresh = buildTwoStateFixture(t);
    exportDeltaPack(fresh.root, 'delta-ok');
    mutate(path.join(fresh.root, PACKS_REL, 'delta-ok'));
    const result = verify(fresh.root, OLD_MANIFEST, packRel('delta-ok'));
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((e) => e.code === code), `${label}: ${JSON.stringify(result.errors)}`);
  }
});

test('基线清单坏 JSON 与坏路径：可定位拒绝且不读取坏路径资产', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  fs.writeFileSync(path.join(fx.root, 'artifacts/broken.json'), '{ not json');
  const badJson = verify(fx.root, 'artifacts/broken.json', packRel('delta-ok'));
  assert.equal(badJson.ok, false);
  assert.ok(badJson.errors.some((e) => e.code === 'bad-base-manifest' && e.source === 'base-manifest'), JSON.stringify(badJson.errors));

  const parsed = JSON.parse(fs.readFileSync(path.join(fx.root, OLD_MANIFEST), 'utf8'));
  parsed.entries.push({ path: 'assets/..\\evil.txt', bytes: 1, sha256: 'a'.repeat(64) });
  fs.writeFileSync(path.join(fx.root, 'artifacts/badpath.json'), JSON.stringify(parsed));
  const { io, calls } = recordingIo();
  const badPath = verify(fx.root, 'artifacts/badpath.json', packRel('delta-ok'), io);
  assert.equal(badPath.ok, false);
  assert.ok(badPath.errors.some((e) => e.source === 'base-manifest' && e.code === 'illegal-path' && String(e.path).includes('evil')), JSON.stringify(badPath.errors));
  assert.ok(calls.every((c: any) => !String(c.target).includes('evil')), '坏路径不得触发任何 fs 访问');
});

test('候选清单坏路径：结构拒绝，坏路径零 fs 访问', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  const packAbs = path.join(fx.root, PACKS_REL, 'delta-ok');
  editPackJson(packAbs, 'manifest.json', (m: any) => ({ ...m, entries: [...m.entries, { path: 'assets/..\\evil.txt', bytes: 1, sha256: 'a'.repeat(64) }] }));
  const { io, calls } = recordingIo();
  const result = verify(fx.root, OLD_MANIFEST, packRel('delta-ok'), io);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.source === 'pack-manifest' && e.code === 'illegal-path'), JSON.stringify(result.errors));
  assert.ok(calls.every((c: any) => !String(c.target).includes('evil')), '坏路径不得触发任何 fs 访问');
});

test('junction：候选目录逃逸 root 退出 2；候选内条目 junction 越界拒绝且不读链接目标', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  // 候选目录本身是指向 root 外的 junction：即使外部是完整可用的候选包也拒绝
  fs.mkdirSync(fx.outside, { recursive: true });
  const outsidePack = path.join(fx.outside, 'linked-pack');
  fs.cpSync(path.join(fx.root, PACKS_REL, 'delta-ok'), outsidePack, { recursive: true });
  fs.mkdirSync(path.join(fx.root, PACKS_REL), { recursive: true });
  fs.symlinkSync(outsidePack, path.join(fx.root, PACKS_REL, 'jlink'), 'junction');
  const outsideBefore = snapshot(fx.outside);
  const r = cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('jlink')]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('--pack'), r.stderr);
  assert.deepEqual(snapshot(fx.outside), outsideBefore, 'junction 目标零访问零变化');

  // 候选内条目是指向 root 外的 junction：磁盘核验拒绝且不读取目标内容
  const packAbs = path.join(fx.root, PACKS_REL, 'delta-ok');
  fs.symlinkSync(fx.outside, path.join(packAbs, 'assets', 'lnk'), 'junction');
  editPackJson(packAbs, 'manifest.json', (m: any) => ({ ...m, entries: [...m.entries, { path: 'assets/lnk', bytes: 5, sha256: 'a'.repeat(64) }] }));
  fs.writeFileSync(path.join(fx.outside, 'secret.txt'), 'outside secret');
  const { io, calls } = recordingIo();
  const result = verify(fx.root, OLD_MANIFEST, packRel('delta-ok'), io);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.source === 'pack-files' && e.code === 'realpath-outside-root' && e.path === 'assets/lnk'), JSON.stringify(result.errors));
  assert.ok(calls.every((c: any) => !String(c.target).includes('secret.txt')), 'junction 目标内容不得被读取');
  assert.equal(fs.readFileSync(path.join(fx.outside, 'secret.txt'), 'utf8'), 'outside secret', '外部夹具内容未被改动');
});

test('纯函数直接核验内存对象：篡改 totals/candidate 与输入不变', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  const baseManifest = JSON.parse(fs.readFileSync(path.join(fx.root, OLD_MANIFEST), 'utf8'));
  const packManifest = JSON.parse(fs.readFileSync(path.join(fx.root, PACKS_REL, 'delta-ok', 'manifest.json'), 'utf8'));
  const delta = JSON.parse(fs.readFileSync(path.join(fx.root, PACKS_REL, 'delta-ok', 'delta.json'), 'utf8'));
  const baseSnapshot = JSON.stringify(baseManifest);
  const packSnapshot = JSON.stringify(packManifest);
  const deltaSnapshot = JSON.stringify(delta);

  const okResult = verifyDeltaPackContent({ baseManifest, packManifest, delta });
  assert.equal(okResult.ok, true, JSON.stringify(okResult.errors));
  assert.equal(okResult.compatibility.candidate.actual.files, 2);

  const totalsTampered = verifyDeltaPackContent({ baseManifest, packManifest, delta: { ...delta, totals: { ...delta.totals, added: 99 } } });
  assert.equal(totalsTampered.ok, false);
  assert.ok(totalsTampered.errors.some((e) => e.code === 'totals-mismatch' && e.kind === 'added'), JSON.stringify(totalsTampered.errors));

  const candidateTampered = verifyDeltaPackContent({ baseManifest, packManifest, delta: { ...delta, candidate: { ...delta.candidate, files: 5 } } });
  assert.equal(candidateTampered.ok, false);
  assert.ok(candidateTampered.errors.some((e) => e.code === 'candidate-mismatch' && e.field === 'files'), JSON.stringify(candidateTampered.errors));

  assert.equal(JSON.stringify(baseManifest), baseSnapshot, '纯函数不修改基线输入');
  assert.equal(JSON.stringify(packManifest), packSnapshot, '纯函数不修改候选清单输入');
  assert.equal(JSON.stringify(delta), deltaSnapshot, '纯函数不修改 delta 输入');
});

test('参数契约：缺参/未知参/越界/缺失目标退出 2；help/plan 零目标读取', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  assert.equal(cli(['--root', fx.root, '--pack', packRel('delta-ok')]).status, 2, '缺 --base-manifest');
  assert.equal(cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST]).status, 2, '缺 --pack');
  assert.equal(cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok'), '--extra']).status, 2, '未知参数');
  assert.equal(cli(['--root', fx.root, '--base-manifest', path.join(fx.base, 'outside.json'), '--pack', packRel('delta-ok')]).status, 2, '基线在 root 外');
  assert.equal(cli(['--root', fx.root, '--base-manifest', 'artifacts/missing.json', '--pack', packRel('delta-ok')]).status, 2, '基线不存在');
  assert.equal(cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', 'scripts/archive/resource-packs/nope']).status, 2, '候选目录不存在');
  assert.equal(cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', OLD_MANIFEST]).status, 2, '候选不是目录');
  assert.equal(cli(['--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', path.join(fx.base, 'elsewhere')]).status, 2, '候选在 root 外');

  const missingRoot = path.join(os.tmpdir(), 'resource-pack-verify-nonexistent');
  for (const flag of ['--help', '--plan']) {
    const r = cli([flag, '--root', missingRoot, '--base-manifest', 'a.json', '--pack', 'b']);
    assert.equal(r.status, 0, flag);
    assert.ok(r.stdout.includes('--base-manifest'), '帮助含基线参数说明');
    assert.ok(r.stdout.includes('delta.json'), '帮助说明增量候选要求');
    assert.ok(r.stdout.includes('零写入'), '帮助声明零写入');
  }
});

test('工作流注册转发 resource:verify-delta（G15 独占注册）', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'delta-ok');
  const viaWorkflow = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'resource:verify-delta', '--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok')], { encoding: 'utf8' });
  assert.equal(viaWorkflow.status, 0, viaWorkflow.stderr);
  const forwarded = JSON.parse(viaWorkflow.stdout);
  assert.equal(forwarded.kind, 'resource-pack-delta-verification');
  assert.equal(forwarded.ok, true);

  editPackJson(path.join(fx.root, PACKS_REL, 'delta-ok'), 'delta.json', (d: any) => ({ ...d, totals: { ...d.totals, changed: 99 } }));
  const failing = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'resource:verify-delta', '--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok')], { encoding: 'utf8' });
  assert.equal(failing.status, 1, failing.stdout);
  assert.equal(JSON.parse(failing.stdout).ok, false);

  const preview = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'resource:verify-delta', '--root', fx.root, '--base-manifest', OLD_MANIFEST, '--pack', packRel('delta-ok'), '--plan'], { encoding: 'utf8' });
  assert.equal(preview.status, 0);
  assert.ok(preview.stderr.includes('[预览]'), 'runner 级 --plan 只打印，不执行');
});

test('基线与候选分别合法但重建目标含 Windows 大小写冲突必须拒绝', { skip: process.platform !== 'win32' }, () => {
  const { manifestContentIdentity }: typeof import('../lib/resource-pack-delta') = require('../lib/resource-pack-delta');
  const entry = { path: 'assets/alpha.txt', bytes: 1, sha256: 'a'.repeat(64) };
  const added = { ...entry, path: 'assets/ALPHA.txt', sha256: 'b'.repeat(64) };
  const baseManifest = { schemaVersion: 1, entries: [entry] };
  const packManifest = { schemaVersion: 1, entries: [added] };
  const record = (entries: any) => ({ path: 'manifest.json', contentIdentity: manifestContentIdentity({ entries }), entryCount: entries.length, totalBytes: entries.length });
  const delta = { schemaVersion: 1, kind: 'resource-pack-delta', baseManifest: record([entry]), newManifest: record([entry, added]), totals: { added: 1, changed: 0, removed: 0, unchanged: 1 }, removed: [], candidate: { files: 1, bytes: 1, zeroAssets: false } };
  const result = verifyDeltaPackContent({ baseManifest, packManifest, delta });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'duplicate-path' && e.source === 'pack-delta'));
});

test('候选目录真实路径越界在 stat 和读取前拒绝', (t) => {
  const fx = buildTwoStateFixture(t);
  fs.mkdirSync(fx.outside, { recursive: true });
  fs.symlinkSync(fx.outside, path.join(fx.root, 'escaped-pack'), 'junction');
  const { io, calls } = recordingIo();
  assert.throws(() => verifyDeltaPack({ root: fx.root, baseManifestPath: OLD_MANIFEST, packPath: 'escaped-pack', io }), /root 外/);
  assert.ok(calls.filter((c: any) => c.op === 'statSync').every((c: any) => c.target === fs.realpathSync(fx.root)));
  assert.ok(calls.every((c: any) => c.op !== 'readFileSync'));
});

test('候选元数据真实路径离开包目录即使仍在 root 内也不得读取', (t) => {
  const fx = buildTwoStateFixture(t);
  exportDeltaPack(fx.root, 'metadata-scope');
  const packAbs = path.join(fx.root, packRel('metadata-scope'));
  for (const filename of ['manifest.json', 'delta.json']) {
    const target = path.join(packAbs, filename);
    const { io, calls } = recordingIo({ realpathSync: (p: any, ...rest) => {
      if (String(p) === target) return fs.realpathSync(path.join(fx.root, OLD_MANIFEST));
      return fs.realpathSync(p, ...rest);
    } });
    assert.throws(() => verifyDeltaPack({ root: fx.root, baseManifestPath: OLD_MANIFEST, packPath: packRel('metadata-scope'), io }), /root 外/);
    assert.ok(calls.every((c: any) => c.op !== 'readFileSync' || c.target !== target));
  }
});
