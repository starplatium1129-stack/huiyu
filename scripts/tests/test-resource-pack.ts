'use strict';

/**
 * scripts/tests/test-resource-pack.js — 离线资源候选包暂存导出隔离夹具测试（G10）
 *
 * 全部读写限定在 os.tmpdir() 临时夹具内；夹具自建 junction 指向夹具内部的 outside
 * 目录（无敏感文件），清理只删除本测试创建的临时根（rmSync 不跟随链接）。不触碰
 * 生产数据、不导出真实素材、不执行复制内容、不构建 dist。
 * 运行：node scripts/tests/test-resource-pack.js
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const { validatePackName, planResourcePack, stageResourcePack }: typeof import('../lib/resource-pack') = require('../lib/resource-pack');
const { generateManifest, verifyManifest }: typeof import('../lib/resource-manifest') = require('../lib/resource-manifest');

const repo = path.resolve(__dirname, '..', '..');
const PACKS_REL = path.join('scripts', 'archive', 'resource-packs');

/** 记录型 fs：调用穿透真实 fs 并记录目标路径；hooks 可替换个别操作（模拟源变化/故障）。 */
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

/** 快照目录内容（不跟随链接；链接只记占位）。仅用于本测试创建的夹具目录。 */
function snapshot(dir: any): any {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [[p, '<link>']];
    return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
}

function buildFixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'assets/dir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets/character-references'));
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/alpha.txt'), 'A');
  fs.writeFileSync(path.join(root, 'assets/dir/bravo.bin'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(root, 'assets/dir/charlie.txt'), 'hello charlie');
  fs.writeFileSync(path.join(root, 'assets/character-references/hidden.txt'), 'excluded');
  fs.writeFileSync(path.join(root, 'artifacts/manifest.json'), JSON.stringify(generateManifest({ root })));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  return { base, root, outside, assets: path.join(root, 'assets'), manifest: path.join(root, 'artifacts/manifest.json') };
}

function destPath(root: any, name: any) {
  return path.join(root, PACKS_REL, name);
}

function cli(args: any) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts', 'maintenance', 'stage-resource-pack.js'), ...args], { encoding: 'utf8' });
}

function writeManifestFile(root: any, manifest: any, name: any) {
  const file = path.join(root, 'artifacts', name);
  fs.writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return path.join(root, 'artifacts', name);
}

function mutateManifest(fx: any, mutator: any, name: any = 'bad.json') {
  const manifest = JSON.parse(fs.readFileSync(fx.manifest, 'utf8'));
  return writeManifestFile(fx.root, mutator(manifest), name);
}

test('包名校验：合法名接受，路径片段与特殊字符拒绝', () => {
  for (const good of ['pack1', 'Pack_2', 'a-b-c', 'x'.repeat(64)]) assert.equal(validatePackName(good), good);
  for (const bad of ['../evil', 'a/b', 'a\\b', '', '.', '..', 'has space', '中文名', '-'.repeat(65), null, 42]) {
    assert.throws(() => validatePackName(bad), /--name/, JSON.stringify(bad));
  }
});

test('预览零写入：不创建目标与 packs 目录，源夹具不变，计划含条目与核验摘要', (t) => {
  const fx = buildFixture(t);
  const before = snapshot(fx.root);
  const plan: any = planResourcePack({ root: fx.root, name: 'plan1', manifestPath: 'artifacts/manifest.json' });
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'resource-pack-plan');
  assert.equal(plan.mode, 'preview');
  assert.equal(plan.destination, ['scripts', 'archive', 'resource-packs', 'plan1'].join('/'));
  assert.equal(plan.manifestPath, 'artifacts/manifest.json');
  assert.deepEqual(plan.totals, { files: 3, bytes: 1 + 4 + 13 });
  assert.equal(plan.verification.verified, 3);
  assert.deepEqual(plan.entries.map((e: any) => e.path), ['assets/alpha.txt', 'assets/dir/bravo.bin', 'assets/dir/charlie.txt']);
  assert.equal(fs.existsSync(path.join(fx.root, 'scripts')), false, '预览不得创建 scripts 树');
  assert.deepEqual(snapshot(fx.root), before, '预览零写入');
});

test('正常导出：结构保留、原文件字节不变、导出后现有 verifyManifest 与 CLI 复核通过', (t) => {
  const fx = buildFixture(t);
  // 清单生成后新增未登记文件：导出不得补入
  fs.writeFileSync(path.join(fx.root, 'assets/extra.txt'), 'unlisted');
  const sourceBefore = snapshot(fx.assets);
  const manifestBefore = fs.readFileSync(fx.manifest);
  const result = cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'pack-ok', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.kind, 'resource-pack-result');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.destinationCreated, true);
  assert.equal(parsed.stagingPath, null);
  assert.equal(parsed.finalVerification.ok, true);
  assert.equal(parsed.finalVerification.verified, 3);

  const pack = destPath(fx.root, 'pack-ok');
  assert.equal(fs.readFileSync(path.join(pack, 'assets/alpha.txt'), 'utf8'), 'A');
  assert.deepEqual(fs.readFileSync(path.join(pack, 'assets/dir/bravo.bin')), Buffer.from([0, 1, 2, 255]));
  // 只复制清单已列条目：未登记文件与排除域不进包
  const packAssets = fs.readdirSync(path.join(pack, 'assets'));
  assert.deepEqual(packAssets.sort(), ['alpha.txt', 'dir'], '未列文件不补入');
  assert.equal(fs.existsSync(path.join(pack, 'assets/character-references')), false, '排除域不进包');
  assert.deepEqual(fs.readdirSync(pack).sort(), ['assets', 'manifest.json']);

  const packManifest = JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8'));
  assert.equal(packManifest.schemaVersion, 1);
  assert.equal(packManifest.totals.files, 3);
  assert.equal(packManifest.scope.pack.sourceManifestPath, 'artifacts/manifest.json');
  assert.ok(packManifest.scope.coverageNote.includes('不代表图片质量、内容审核或部署完成'), '输出措辞不声称质量/审核/部署完成');
  const verifyResult = verifyManifest({ root: pack, manifestPath: 'manifest.json' });
  assert.equal(verifyResult.ok, true);
  assert.equal(verifyResult.totals.verified, 3);
  const viaExistingCli = spawnSync(process.execPath, [path.join(repo, 'scripts', 'maintenance', 'report-resource-manifest.js'), '--root', pack, '--manifest', 'manifest.json'], { encoding: 'utf8' });
  assert.equal(viaExistingCli.status, 0, viaExistingCli.stderr);

  assert.deepEqual(snapshot(fx.assets), sourceBefore, '源素材字节不变');
  assert.equal(fs.readFileSync(fx.manifest).toString(), manifestBefore.toString(), '源清单未被改动');
});

test('同名目标拒绝：空目录、已有文件与链接形态均不覆盖', (t) => {
  const fx = buildFixture(t);
  fs.mkdirSync(destPath(fx.root, 'taken'), { recursive: true });
  for (const mode of [['--manifest', 'artifacts/manifest.json', '--name', 'taken'], ['--manifest', 'artifacts/manifest.json', '--name', 'taken', '--apply']]) {
    const r = cli(['--root', fx.root, ...mode]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    if (mode.includes('--apply')) assert.equal(parsed.destinationCreated, false);
    assert.ok(parsed.errors.some((e: any) => e.code === 'destination-exists'));
    assert.deepEqual(fs.readdirSync(destPath(fx.root, 'taken')), [], '既有空目录未被写入');
  }
  fs.writeFileSync(path.join(destPath(fx.root, 'taken'), 'keep.txt'), 'keep');
  const withFile = cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'taken', '--apply']);
  assert.equal(withFile.status, 1);
  assert.equal(fs.readFileSync(path.join(destPath(fx.root, 'taken'), 'keep.txt'), 'utf8'), 'keep', '旧包内容未被覆盖');

  fs.symlinkSync(fx.outside, destPath(fx.root, 'link-dest'), process.platform === 'win32' ? 'junction' : 'dir');
  const linkResult = cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'link-dest', '--apply']);
  assert.equal(linkResult.status, 1);
  // dest 本身是链接：祖先链检查先拒绝（link-in-destination-chain），同样不覆盖、不写入
  const linkErrors = JSON.parse(linkResult.stdout).errors.map((e: any) => e.code);
  assert.ok(linkErrors.some((c: any) => c === 'destination-exists' || c === 'link-in-destination-chain'), JSON.stringify(linkErrors));
  assert.equal(fs.readdirSync(fx.outside).sort().join(','), 'secret.txt', '链接目标未被写入');
});

test('坏清单拒绝：核验失败/坏格式/不支持版本均不写入目标', (t) => {
  const fx = buildFixture(t);
  const cases = {
    'wrong-hash.json': (m: any) => ({ ...m, entries: m.entries.map((e: any) => (e.path === 'assets/alpha.txt' ? { ...e, sha256: 'f'.repeat(64) } : e)) }),
    'schema-v2.json': (m: any) => ({ ...m, schemaVersion: 2 }),
    'unverified.json': (m: any) => ({ ...m, unverified: [{ path: 'assets/lnk', kind: 'symlink', message: '不跟随' }] }),
    'duplicate.json': (m: any) => ({ ...m, entries: [...m.entries, m.entries[0]] }),
    'out-of-scope.json': (m: any) => ({ ...m, entries: [...m.entries, { path: 'data/characters.json', bytes: 2, sha256: 'a'.repeat(64) }] }),
    'illegal-path.json': (m: any) => ({ ...m, entries: [...m.entries, { path: 'assets/..\\evil.txt', bytes: 2, sha256: 'a'.repeat(64) }] }),
    'broken.json': '{ not json',
  };
  for (const [name, mutator] of Object.entries(cases)) {
    if (typeof mutator === 'function') mutateManifest(fx, mutator, name);
    else writeManifestFile(fx.root, mutator, name);
    const packName = `reject-${name.replace(/\.json$/, '')}`;
    for (const apply of [false, true]) {
      const r = cli(['--root', fx.root, '--manifest', `artifacts/${name}`, '--name', packName, ...(apply ? ['--apply'] : [])]);
      assert.equal(r.status, 1, `${name} apply=${apply}: ${r.stdout}${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false);
      assert.ok(parsed.errors.length > 0);
      assert.equal(fs.existsSync(destPath(fx.root, packName)), false, `${name} 不得创建目标`);
    }
  }
  assert.equal(fs.existsSync(path.join(fx.root, 'scripts')), false, '全部拒绝后不创建 packs 目录');
});

test('排除域/越界/目标链 junction 拒绝：不写链接目标，不读取越界内容', (t) => {
  const fx = buildFixture(t);
  fs.mkdirSync(path.join(fx.root, 'scripts'), { recursive: true });
  fs.symlinkSync(fx.outside, path.join(fx.root, 'scripts', 'archive'), process.platform === 'win32' ? 'junction' : 'dir');
  const outsideBefore = snapshot(fx.outside);
  for (const apply of [false, true]) {
    const args = ['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'jailbreak', ...(apply ? ['--apply'] : [])];
    const r = cli(args);
    assert.equal(r.status, 1, `apply=${apply}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some((e: any) => e.code === 'link-in-destination-chain'), JSON.stringify(parsed.errors));
    if (apply) assert.equal(parsed.destinationCreated, false);
  }
  assert.deepEqual(snapshot(fx.outside), outsideBefore, '链接目标零写入');

  // 更深一层：resource-packs 本身是 junction 也拒绝
  const fx2 = buildFixture(t);
  fs.mkdirSync(path.join(fx2.root, 'scripts/archive'), { recursive: true });
  fs.symlinkSync(fx2.outside, path.join(fx2.root, 'scripts/archive/resource-packs'), process.platform === 'win32' ? 'junction' : 'dir');
  const r2 = cli(['--root', fx2.root, '--manifest', 'artifacts/manifest.json', '--name', 'deep-jailbreak', '--apply']);
  assert.equal(r2.status, 1);
  assert.ok(JSON.parse(r2.stdout).errors.some((e: any) => e.code === 'link-in-destination-chain'));
  assert.deepEqual(snapshot(fx2.outside), [[path.join(fx2.outside, 'secret.txt'), Buffer.from('outside secret').toString('base64')]], '深层 junction 目标零写入');
});

test('复制期间源变化：不发布最终包，暂存目录保留并明确标注', (t) => {
  const fx = buildFixture(t);
  const alpha = path.join(fx.root, 'assets', 'alpha.txt');
  let alphaReads = 0;
  const { io, calls } = recordingIo({
    readFileSync: (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(alpha)) {
        alphaReads++;
        if (alphaReads === 2) {
          fs.writeFileSync(alpha, 'Z'); // 同字节数篡改，模拟核验后、复制时源已变化
          return Buffer.from('Z');
        }
      }
      return fs.readFileSync(p, ...rest);
    },
  });
  const result = stageResourcePack({ root: fx.root, name: 'pack-change', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(alphaReads, 2, '核验与复制各读取一次');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: any) => e.path === 'assets/alpha.txt' && e.code === 'hash-mismatch'), JSON.stringify(result.errors));
  assert.equal(result.destinationCreated, false);
  assert.ok(result.stagingPath, '报告暂存目录路径');
  const stagingAbs = path.join(fx.root, result.stagingPath);
  assert.equal(fs.existsSync(stagingAbs), true, '失败候选暂存保留');
  assert.equal(fs.existsSync(destPath(fx.root, 'pack-change')), false, '最终包未发布');
  assert.ok(result.notes.join('\n').includes('不是可用候选包'));
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
});

test('候选写入失败：不发布最终包，已复制候选保留在暂存目录', (t) => {
  const fx = buildFixture(t);
  const { io } = recordingIo({
    writeFileSync: (p: any, ...rest: any[]) => {
      if (String(p).endsWith(path.join('assets', 'dir', 'bravo.bin'))) throw Object.assign(new Error('模拟写入失败'), { code: 'EIO' });
      return fs.writeFileSync(p, ...rest);
    },
  });
  const result = stageResourcePack({ root: fx.root, name: 'pack-wfail', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: any) => e.path === 'assets/dir/bravo.bin' && e.code === 'write-error'));
  assert.equal(result.destinationCreated, false);
  const stagingAbs = path.join(fx.root, result.stagingPath);
  assert.equal(fs.existsSync(path.join(stagingAbs, 'assets/alpha.txt')), true, '已成功候选保留');
  assert.equal(fs.existsSync(path.join(stagingAbs, 'assets/dir/bravo.bin')), false);
  assert.equal(fs.existsSync(path.join(stagingAbs, 'manifest.json')), false, '残缺暂存不写包清单');
  assert.equal(fs.existsSync(destPath(fx.root, 'pack-wfail')), false);
});

test('发布冲突（rename 失败/目标冲突）：不报告成功，完整暂存保留', (t) => {
  const fx = buildFixture(t);
  const { io } = recordingIo({
    renameSync: () => {
      throw Object.assign(new Error('模拟目标冲突'), { code: 'EPERM' });
    },
  });
  const result = stageResourcePack({ root: fx.root, name: 'pack-conflict', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: any) => e.code === 'publish-failed'));
  assert.equal(result.destinationCreated, false);
  const stagingAbs = path.join(fx.root, result.stagingPath);
  assert.equal(fs.existsSync(path.join(stagingAbs, 'manifest.json')), true, '完整暂存保留');
  assert.equal(verifyManifest({ root: stagingAbs, manifestPath: 'manifest.json' }).ok, true, '暂存内容本身完整，但仍未发布');
  assert.equal(fs.existsSync(destPath(fx.root, 'pack-conflict')), false);
});

test('成功导出后同名重跑被拒绝（不覆盖旧包）', (t) => {
  const fx = buildFixture(t);
  const first = cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'once', '--apply']);
  assert.equal(first.status, 0, first.stderr);
  const packBefore = snapshot(destPath(fx.root, 'once'));
  const rerun = cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'once', '--apply']);
  assert.equal(rerun.status, 1);
  assert.ok(JSON.parse(rerun.stdout).errors.some((e: any) => e.code === 'destination-exists'));
  assert.deepEqual(snapshot(destPath(fx.root, 'once')), packBefore, '旧包未被动过');
});

test('CLI 退出码契约：help/plan 零读取、参数错误与清单越界', (t) => {
  const missingRoot = path.join(os.tmpdir(), 'resource-pack-nonexistent-root');
  for (const flag of ['--help', '--plan']) {
    const r = cli([flag, '--root', missingRoot, '--manifest', 'x.json', '--name', 'p1', '--apply']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('--apply'));
  }
  assert.equal(cli(['--root', missingRoot, '--name', 'p1']).status, 2, '缺 --manifest');
  assert.equal(cli(['--root', missingRoot, '--manifest', 'x.json']).status, 2, '缺 --name');
  assert.equal(cli(['--nope']).status, 2, '未知参数');
  for (const bad of ['../evil', 'a/b', '']) {
    assert.equal(cli(['--root', missingRoot, '--manifest', 'x.json', '--name', bad]).status, 2, `包名 ${JSON.stringify(bad)}`);
  }

  const fx = buildFixture(t);
  assert.equal(cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'plan-cli']).status, 0, '预览成功');
  assert.equal(cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'plan-cli', '--apply']).status, 0, '导出成功');
  assert.equal(cli(['--root', path.join(fx.base, 'outside'), '--manifest', path.join(fx.root, 'artifacts', 'manifest.json'), '--name', 'escape']).status, 2, '清单越界（不在指定 root 内）');
  assert.equal(cli(['--root', fx.root, '--manifest', path.join(fx.outside, 'secret.txt'), '--name', 'escape2']).status, 2, '清单指向 root 外文件');
  assert.equal(cli(['--root', missingRoot, '--manifest', 'x.json', '--name', 'p1']).status, 2, 'root 不可用');
  assert.equal(JSON.parse(cli(['--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'plan-cli']).stdout).errors[0].code, 'destination-exists', '同名重跑预览也拒绝');
});

test('工作流注册入口转发 preview 与 --apply，runner 级 --plan 不执行', (t) => {
  const fx = buildFixture(t);
  const viaWorkflow = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'resource:pack', '--root', fx.root, '--manifest', 'artifacts/manifest.json', '--name', 'viaflow', '--apply'], { encoding: 'utf8' });
  assert.equal(viaWorkflow.status, 0, viaWorkflow.stderr);
  const forwarded = JSON.parse(viaWorkflow.stdout);
  assert.equal(forwarded.kind, 'resource-pack-result');
  assert.equal(forwarded.ok, true);
  assert.equal(forwarded.destinationCreated, true);
  assert.equal(verifyManifest({ root: destPath(fx.root, 'viaflow'), manifestPath: 'manifest.json' }).ok, true);

  const fx2 = buildFixture(t);
  const preview = spawnSync(process.execPath, [path.join(repo, 'scripts', 'workflow.js'), 'resource:pack', '--root', fx2.root, '--manifest', 'artifacts/manifest.json', '--name', 'viaflow2', '--plan'], { encoding: 'utf8' });
  assert.equal(preview.status, 0);
  assert.ok(preview.stderr.includes('[预览]'), 'runner 级 --plan 只打印，不执行');
  assert.equal(fs.existsSync(path.join(fx2.root, 'scripts')), false, '--plan 未创建任何目录');
});

test('夹具清理只删自建临时根，不递归清理链接目标', (t) => {
  // 依赖的性质：Node rmSync 删除 junction/symlink 本身而不进入目标。
  // 链接目标放在夹具自建的另一个临时目录（无敏感文件），同样由本测试显式清理。
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-links-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pack-target-'));
  t.after(() => {
    fs.rmSync(holder, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(target, 'kept.txt'), 'kept');
  fs.symlinkSync(target, path.join(holder, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.rmSync(holder, { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(target, 'kept.txt')), true, '清理链接不删除目标内容');
});

test('预览与成功导出全程零越界访问（记录型 fs 证明）', (t) => {
  const fx = buildFixture(t);
  const { io, calls } = recordingIo();
  const plan = planResourcePack({ root: fx.root, name: 'audit-plan', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(plan.ok, true);
  assert.equal(fs.existsSync(path.join(fx.root, 'scripts')), false, '预览未创建任何目录');
  const staged = stageResourcePack({ root: fx.root, name: 'audit-pack', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(staged.ok, true);
  assertNoAccessOutside(calls, fs.realpathSync(fx.root));
  const writes = calls.filter((c: any) => c.op === 'writeFileSync' || c.op === 'renameSync' || c.op === 'mkdirSync' || c.op === 'mkdtempSync');
  assert.ok(writes.length > 0, 'apply 确实发生了写入');
  for (const call of writes) {
    assert.ok(call.target.includes(path.join('scripts', 'archive', 'resource-packs')), `写入目标应限于候选目录: ${call.target}`);
  }
});

test('非 Windows 只读预览可用，apply 明确拒绝且零写入', (t) => {
  const fx = buildFixture(t);
  const { io, calls } = recordingIo();
  const result = stageResourcePack({ root: fx.root, name: 'unix', manifestPath: 'artifacts/manifest.json', io, platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'unsupported-platform');
  assert.ok(calls.every((c: any) => !['mkdirSync','mkdtempSync','writeFileSync','renameSync'].includes(c.op)));
  assert.equal(planResourcePack({ root: fx.root, name: 'unix', manifestPath: 'artifacts/manifest.json' }).ok, true);
});

test('清单磁盘写入损坏或合法但丢条目均不得发布', (t) => {
  for (const corrupt of ['{broken', JSON.stringify({ schemaVersion: 1, entries: [] })]) {
    const fx = buildFixture(t);
    const { io } = recordingIo({ writeFileSync: (p: any, value: any, ...rest: any[]) => {
      if (String(p).endsWith('manifest.json')) return fs.writeFileSync(p, corrupt, ...rest);
      return fs.writeFileSync(p, value, ...rest);
    } });
    const result = stageResourcePack({ root: fx.root, name: 'badmanifest', manifestPath: 'artifacts/manifest.json', io });
    assert.equal(result.ok, false);
    assert.equal(result.destinationCreated, false);
    assert.ok(result.stagingPath);
    assert.equal(fs.existsSync(destPath(fx.root, 'badmanifest')), false);
  }
});

test('候选副本读回内容损坏不得发布', (t) => {
  const fx = buildFixture(t);
  const { io } = recordingIo({ writeFileSync: (p: any, value: any, ...rest: any[]) => {
    return fs.writeFileSync(p, String(p).endsWith('alpha.txt') ? Buffer.from('Z') : value, ...rest);
  } });
  const result = stageResourcePack({ root: fx.root, name: 'badcopy', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(result.ok, false);
  assert.equal(result.destinationCreated, false);
  assert.ok(result.errors.some((e: any) => e.code === 'copy-verify-failed'));
});

test('源核验后内部目录变成排除域 junction，复制前拒绝读取', (t) => {
  const fx = buildFixture(t);
  const excluded = path.join(fx.root, 'assets/character-references');
  let swapped = false;
  const { io } = recordingIo({ mkdtempSync: (prefix: any) => {
    const dir = fs.mkdtempSync(prefix);
    fs.renameSync(path.join(fx.root, 'assets/dir'), path.join(excluded, 'saved-dir'));
    fs.symlinkSync(path.join(excluded, 'saved-dir'), path.join(fx.root, 'assets/dir'), process.platform === 'win32' ? 'junction' : 'dir');
    swapped = true;
    return dir;
  }, readFileSync: (p: any, ...rest: any[]) => {
    if (swapped && String(p).startsWith(path.join(fx.root, 'assets/dir') + path.sep)) throw new Error('排除目标被读取');
    return fs.readFileSync(p, ...rest);
  } });
  const result = stageResourcePack({ root: fx.root, name: 'changed-alias', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: any) => e.code === 'out-of-scope'));
  assert.equal(result.destinationCreated, false);
});

test('源核验期间目标祖先出现 junction，首次写入前拒绝', (t) => {
  const fx = buildFixture(t);
  let inserted = false;
  const { io, calls } = recordingIo({ readFileSync: (p: any, ...rest: any[]) => {
    const value = fs.readFileSync(p, ...rest);
    if (!inserted && String(p).endsWith(path.join('assets', 'dir', 'charlie.txt'))) {
      fs.mkdirSync(path.join(fx.root, 'scripts'));
      fs.symlinkSync(fx.outside, path.join(fx.root, 'scripts/archive'), process.platform === 'win32' ? 'junction' : 'dir');
      inserted = true;
    }
    return value;
  } });
  const before = snapshot(fx.outside);
  const result = stageResourcePack({ root: fx.root, name: 'changed-parent', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e: any) => e.code === 'link-in-destination-chain'));
  assert.ok(calls.every((c: any) => !['mkdirSync','mkdtempSync','writeFileSync','renameSync'].includes(c.op)));
  assert.deepEqual(snapshot(fx.outside), before);
});

test('Windows 发布瞬间出现同名空目录也不能被替换', { skip: process.platform !== 'win32' }, (t) => {
  const fx = buildFixture(t);
  const dest = destPath(fx.root, 'race');
  const { io } = recordingIo({ renameSync: (from: any, to: any) => {
    fs.mkdirSync(to);
    return fs.renameSync(from, to);
  } });
  const result = stageResourcePack({ root: fx.root, name: 'race', manifestPath: 'artifacts/manifest.json', io });
  assert.equal(result.ok, false);
  assert.equal(result.destinationCreated, false);
  assert.ok(result.errors.some((e: any) => e.code === 'publish-failed'));
  assert.deepEqual(fs.readdirSync(dest), []);
  assert.ok(result.stagingPath);
});
