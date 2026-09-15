'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { report, parse, state } = require('../maintenance/audit-delivery');
const { formatReport } = require('../lib/delivery-report-format');
const commit = 'a'.repeat(40), hash = 'b'.repeat(64);
test('比较同提交同构建；重复参数、状态隔离及组合检查零写入', t => {
  const f = gitFixture(t);
  f.d.commit = f.head; f.write('evidence.json', f.d);
  f.write('other.json', { ...f.d, environment: { platform: 'other' }, installation: { status: 'passed' } });
  const before = snapshotTree(f.root);
  const r = report(parse(['--root', f.root, '--evidence', 'evidence.json', '--compare-evidence', 'other.json', '--compare-evidence', 'other.json', '--check-head', '--check-worktree', '--verify-file', 'other.json']));
  assert.deepEqual(r.comparisons.map(v => v.status), ['matched', 'matched']);
  assert.equal(r.repositoryHead.status, 'matched');
  assert.equal(r.repositoryWorktree.status, 'dirty');
  assert.ok(r.pending.some(v => v.field === 'installation'));
  assert.equal(r.verifiedFiles[0].status, 'exists');
  assert.deepEqual(snapshotTree(f.root), before);
  assert.equal(f.run().comparisons, undefined);
});
test('比较所有共有标识，旧 commit/build、缺 commit/build 与源哈希失败关闭', t => {
  const f = fixture(t);
  for (const d of [
    { ...f.d, commit: 'd'.repeat(40) },
    { ...f.d, build: { manifestSha256: 'e'.repeat(64) } },
    { ...f.d, commit: undefined },
    { ...f.d, build: { sourceSha256: hash } },
    { ...f.d, build: { otherSha256: hash } },
    { ...f.d, build: { manifestSha256: 'invalid' } },
  ]) {
    f.write('other.json', d);
    const r = f.run({ comparisons: ['other.json'] });
    assert.equal(r.exitCode, 1);
    assert.equal(r.comparisons[0].status, 'failed');
  }
  f.d.build.secondSha256 = hash; f.write('evidence.json', f.d);
  f.write('other.json', { ...f.d, build: { ...f.d.build, secondSha256: 'c'.repeat(64) } });
  assert.match(f.run({ comparisons: ['other.json'] }).comparisons[0].message, /secondSha256/);
});
test('比较支持双向一层回执关联，拒绝冲突和不支持的关联格式', t => {
  const f = fixture(t);
  f.write('other.json', { ...f.d, commit: undefined });
  f.write('receipt.json', { commit, evidence: 'other.json' });
  assert.equal(f.run({ comparisons: ['receipt.json'] }).comparisons[0].status, 'matched');
  f.write('other.json', { ...f.d, delivery: { receipt: 'receipt.json' } });
  assert.equal(f.run({ comparisons: ['other.json'] }).comparisons[0].status, 'matched');
  f.write('receipt.json', { commit: 'd'.repeat(40), evidence: 'other.json' });
  assert.equal(f.run({ comparisons: ['other.json'] }).exitCode, 1);
  f.write('other.json', { schemaVersion: 2, commit });
  assert.equal(f.run({ comparisons: ['receipt.json'] }).exitCode, 1);
});
test('比较 CLI 标识匹配仍保留旧无追踪验收 unknown，别名构建独立', t => {
  const f = fixture(t);
  for (const key of ['installation', 'deviceAcceptance', 'modelAcceptance']) f.d[key] = { status: 'passed', report: 'fixture.log' };
  f.d.build = { distIndexSha256: hash };
  f.write('evidence.json', f.d);
  f.write('other.json', { schemaVersion: 1, commit: commit.toUpperCase(), browser: { distIndexSha256BeforeAndAfter: hash.toUpperCase() } });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../workflow.js'), 'audit:delivery', '--root', f.root, '--evidence', 'evidence.json', '--compare-evidence', 'other.json', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3, result.stderr);
  const r = JSON.parse(result.stdout);
  assert.equal(r.comparisons[0].status, 'matched');
  assert.equal(r.freshness.status, 'unknown');
  assert.equal(r.freshness.gates.deviceAcceptance.effectiveStatus, 'unknown');
});
test('比较拒绝缺失、坏 JSON、绝对/父目录/junction 越界；help/plan 不读', t => {
  const f = fixture(t), other = fixture(t);
  fs.writeFileSync(path.join(f.root, 'bad.json'), '{');
  fs.symlinkSync(other.root, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of ['missing.json', 'bad.json', '../evidence.json', path.join(f.root, 'evidence.json'), 'escape/evidence.json']) {
    assert.equal(f.run({ comparisons: [file] }).exitCode, 1);
  }
  for (const flag of ['--help', '--plan']) {
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../workflow.js'), 'audit:delivery', '--root', 'absent-root', '--evidence', 'missing.json', '--compare-evidence', 'missing.json', flag], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});
function gitFixture(t) {
  const f = fixture(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: f.root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '--template=');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'fixture');
  return { ...f, git, head: git('rev-parse', '--verify', 'HEAD^{commit}') };
}
function snapshotTree(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).sort().map(name => {
    const p = path.join(root, name);
    return [name, fs.statSync(p).isDirectory() ? null : fs.readFileSync(p).toString('hex')];
  }));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = { schemaVersion: 1, commit, baseline: 'c'.repeat(40), scope: 'isolated office CPU', environment: { platform: 'win32', node: 'v24.18.0' }, build: { manifestSha256: hash }, fullGate: { status: 'passed', log: 'gate.log' } };
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  write('evidence.json', d);
  return { root, d, write, run: (extra = {}) => report({ root, evidence: 'evidence.json', require: [], builds: [], ...extra }) };
}
test('同提交跨两个隔离环境交接；办公机通过不等于设备通过，零写入', t => {
  const office = fixture(t), main = fixture(t);
  const before = fs.readFileSync(path.join(office.root, 'evidence.json'));
  const r = office.run({ commit, builds: [`build.manifestSha256=${hash}`] });
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.pending.map(v => v.field), ['tracking', 'fullGate', 'installation', 'deviceAcceptance', 'modelAcceptance']);
  assert.ok(r.recommendations.every(v => v.executed === false));
  assert.deepEqual(fs.readFileSync(path.join(office.root, 'evidence.json')), before);
  main.d.scope = 'isolated main-machine record fixture';
  for (const key of ['installation', 'deviceAcceptance', 'modelAcceptance']) main.d[key] = { status: 'passed', report: `${key}.log` };
  main.write('evidence.json', main.d);
  assert.equal(main.run({ commit, builds: [`build.manifestSha256=${hash}`] }).exitCode, 3);
  assert.equal(main.run().freshness.gates.fullGate.effectiveStatus, 'unknown');
  main.d.build.manifestSha256 = 'd'.repeat(64);
  main.write('evidence.json', main.d);
  assert.equal(main.run({ builds: [`build.manifestSha256=${hash}`] }).exitCode, 1);
});
test('unknown/unrun/failed/passed 不混用；数字及宽泛 prose 不当作通过', () => {
  for (const s of ['unknown', 'unrun', 'failed', 'passed']) assert.equal(state({ status: s }), s);
  assert.equal(state({ passed: 42 }), 'unknown');
  assert.equal(state({ status: 'passed for changed surfaces' }), 'unknown');
  assert.equal(state({ status: 'passed', failed: 1 }), 'failed');
  assert.equal(state({ status: 'passed', result: 'unrun' }), 'failed');
  assert.equal(state({ status: 'passed', skipped: 1 }), 'pending');
});
test('必要门禁缺失/失败与引用缺失分开报告', t => {
  const f = fixture(t);
  assert.equal(f.run({ require: ['checks.missing'] }).pending[0].status, 'unknown');
  f.d.fullGate.status = 'failed'; f.write('evidence.json', f.d);
  assert.equal(f.run().exitCode, 1);
  f.d.fullGate = { status: 'passed' }; f.write('evidence.json', f.d);
  assert.ok(f.run().pending.some(v => v.field === 'fullGate'));
});
test('单项旧提交或旧构建验收不覆盖当前交付', t => {
  const f = fixture(t);
  f.d.deviceAcceptance = { status: 'passed', report: 'device.log', commit: 'd'.repeat(40), build: { manifestSha256: 'e'.repeat(64) } };
  f.write('evidence.json', f.d);
  assert.equal(f.run().errors.length, 2);
});
test('已有无版本回执解析关联证据；基线/远端/状态冲突拒绝', t => {
  const f = fixture(t);
  const receipt = { commit, baseline: f.d.baseline, evidence: 'evidence.json', remoteCommit: commit, pushExitCode: 0, fullGate: { status: 'passed' } };
  f.write('delivery-receipt.json', receipt);
  assert.equal(f.run({ evidence: 'delivery-receipt.json' }).errors.length, 0);
  receipt.fullGate.status = 'unrun'; receipt.remoteCommit = 'd'.repeat(40); receipt.baseline = 'e'.repeat(40);
  f.write('delivery-receipt.json', receipt);
  assert.equal(f.run({ evidence: 'delivery-receipt.json' }).errors.length, 3);
});
test('基线、日期、源哈希及 deployment 不冒充最终提交/构建/安装验收', t => {
  const f = fixture(t);
  delete f.d.commit; delete f.d.build;
  f.d.sourceHashes = { 'source.js': hash }; f.d.deployment = { mismatch: [], checkedAt: '2026-09-13' };
  f.write('evidence.json', f.d);
  const r = f.run();
  assert.ok(['commit', 'build', 'installation'].every(k => r.pending.some(v => v.field === k)));
  assert.equal(f.run({ commit }).exitCode, 1);
});
test('隔离 root 拒绝越界及损坏输入，帮助/预览不读取证据', t => {
  const f = fixture(t), other = fixture(t);
  assert.equal(f.run({ evidence: path.join(other.root, 'evidence.json') }).exitCode, 1);
  f.write('bad.json', []);
  assert.equal(f.run({ evidence: 'bad.json' }).exitCode, 1);
  assert.throws(() => parse([]));
  assert.throws(() => parse(['--evidence', '--json']));
  assert.throws(() => parse(['--evidence', 'x', '--expect-build', 'bad']));
  for (const args of [['--help'], ['--evidence', 'missing.json', '--plan']]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../workflow.js'), 'audit:delivery', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../workflow.js'), 'audit:delivery', '--root', f.root, '--evidence', 'evidence.json', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).status, 'pending');
});

test('显式文件匹配、重复参数、大小写哈希及零写入；不自动读取日志引用', t => {
  const f = fixture(t);
  f.write('artifact=one.bin', { payload: '本地文件' });
  const snapshot = () => Object.fromEntries(fs.readdirSync(f.root).map(name => [name, fs.readFileSync(path.join(f.root, name)).toString('hex')]));
  const before = snapshot();
  const digest = createHash('sha256').update(fs.readFileSync(path.join(f.root, 'artifact=one.bin'))).digest('hex');
  const options = parse(['--root', f.root, '--evidence', 'evidence.json', '--verify-file', 'artifact=one.bin', '--verify-file', 'evidence.json', '--expect-file-sha256', `artifact=one.bin=${digest.toUpperCase()}`, '--expect-file-sha256', `artifact=one.bin=${digest}`]);
  const r = report(options);
  assert.deepEqual(r.verifiedFiles.map(v => v.status), ['exists', 'exists', 'matched', 'matched']);
  assert.equal(r.verifiedFiles[2].actualSha256, digest);
  assert.equal(r.errors.length, 0);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(f.run().verifiedFiles, []); // gate.log is absent but not selected.
  assert.deepEqual(snapshot(), before);
});

test('错哈希、缺文件与目录分别报错，继续报告全部显式目标', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'folder'));
  const r = f.run({ verifyFiles: ['missing.log', 'folder'], fileHashes: [`evidence.json=${'0'.repeat(64)}`, `missing.bin=${hash}`] });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.verifiedFiles.map(v => v.status), ['missing', 'not-file', 'mismatch', 'missing']);
  assert.equal(r.errors.length, 4);
  assert.match(r.verifiedFiles[2].actualSha256, /^[a-f\d]{64}$/);
});

test('拒绝绝对路径、父目录逃逸及 junction/symlink 真实路径越界', t => {
  const f = fixture(t), other = fixture(t);
  fs.symlinkSync(other.root, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = f.run({ verifyFiles: [path.join(other.root, 'evidence.json'), '../outside', 'escape/evidence.json', 'C:relative'] });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.verifiedFiles.map(v => v.status), Array(4).fill('outside-root'));
  assert.ok(r.verifiedFiles.every(v => v.actualSha256 === undefined));
});

test('文件核验 CLI JSON；直接及工作流 help/plan 不访问不存在的 root 和目标', t => {
  const f = fixture(t);
  assert.throws(() => parse(['--evidence', 'x', '--expect-file-sha256', 'file=abc']));
  for (const entry of [['../maintenance/audit-delivery.js'], ['../workflow.js', 'audit:delivery']]) {
    for (const flag of ['--help', '--plan']) {
      const result = spawnSync(process.execPath, [path.resolve(__dirname, entry[0]), ...entry.slice(1), '--root', path.join(f.root, 'absent'), '--evidence', 'missing.json', '--verify-file', 'missing.log', '--expect-file-sha256', `missing.bin=${hash}`, flag], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../workflow.js'), 'audit:delivery', '--root', f.root, '--evidence', 'evidence.json', '--verify-file', 'missing.log', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).verifiedFiles[0].status, 'missing');
});

test('HEAD 匹配解析回执最终提交；dirty 工作树不算验收且整个仓库零写入', t => {
  const f = gitFixture(t);
  delete f.d.commit;
  f.write('evidence.json', f.d);
  f.write('receipt.json', { commit: f.head, evidence: 'evidence.json' });
  const before = snapshotTree(f.root);
  const r = f.run({ evidence: 'receipt.json', 'check-head': true });
  assert.equal(r.repositoryHead.status, 'matched');
  assert.equal(r.repositoryHead.commit, f.head);
  assert.equal(r.repositoryHead.evidenceCommit, f.head);
  assert.equal(r.exitCode, 3); // HEAD does not prove missing device acceptance.
  assert.ok(r.limitations.some(v => v.message.includes('不覆盖 dirty working tree')));
  assert.deepEqual(snapshotTree(f.root), before);
  assert.equal(f.run().repositoryHead, undefined);
});

test('HEAD 检查识别旧提交和缺少最终 commit，保留显式预期比较', t => {
  const f = gitFixture(t);
  f.d.commit = f.head; f.write('evidence.json', f.d);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'next');
  assert.equal(f.run({ 'check-head': true, commit: f.head }).repositoryHead.status, 'mismatch');
  delete f.d.commit; f.write('evidence.json', f.d);
  const r = f.run({ 'check-head': true });
  assert.equal(r.repositoryHead.status, 'missing-commit');
  assert.equal(r.exitCode, 1);
});

test('非 Git root 与 unborn HEAD 明确报错', t => {
  const f = fixture(t);
  assert.equal(f.run({ 'check-head': true }).repositoryHead.status, 'unavailable');
  const init = spawnSync('git', ['init', '--template='], { cwd: f.root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(f.run({ 'check-head': true }).exitCode, 1);
});

test('HEAD CLI 可解析；直接及工作流帮助/预览完全不启动子进程', t => {
  const f = gitFixture(t);
  f.d.commit = f.head; f.write('evidence.json', f.d);
  const cli = path.resolve(__dirname, '../maintenance/audit-delivery.js');
  const result = spawnSync(process.execPath, [cli, '--root', f.root, '--evidence', 'evidence.json', '--check-head', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).repositoryHead.status, 'matched');
  const guard = path.join(f.root, 'no-child.cjs');
  fs.writeFileSync(guard, "const cp = require('node:child_process'); for (const k of ['spawnSync','execSync','execFileSync','spawn','exec','execFile']) cp[k] = () => { throw Error('child process forbidden'); };");
  for (const entry of [cli, path.resolve(__dirname, '../workflow.js')]) {
    for (const flag of ['--help', '--plan']) {
      const args = [...(entry === cli ? [] : ['audit:delivery']), '--evidence', 'missing.json', '--root', 'missing-root', '--check-head', '--check-worktree', flag];
      const r = spawnSync(process.execPath, ['--require', guard, entry, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.length + r.stderr.length > 0);
    }
  }
});

function cleanWorktree(t) {
  const f = gitFixture(t);
  f.git('add', 'evidence.json');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'track evidence');
  return f;
}

test('worktree clean 与未提交修改、暂存修改独立报告，包含索引零写入', t => {
  const f = cleanWorktree(t);
  assert.equal(f.run().repositoryWorktree, undefined);
  const before = snapshotTree(f.root);
  assert.equal(f.run({ 'check-worktree': true }).repositoryWorktree.status, 'clean');
  const combined = f.run({ 'check-worktree': true, 'check-head': true });
  assert.equal(combined.repositoryWorktree.status, 'clean');
  assert.equal(combined.repositoryHead.status, 'mismatch');
  assert.equal(combined.exitCode, 1);
  assert.deepEqual(snapshotTree(f.root), before);
  f.d.scope = 'changed'; f.write('evidence.json', f.d);
  for (const staged of [false, true]) {
    if (staged) f.git('add', 'evidence.json');
    const dirtyBefore = snapshotTree(f.root);
    const r = f.run({ 'check-worktree': true });
    assert.equal(r.exitCode, 1);
    assert.equal(r.repositoryWorktree.status, 'dirty');
    assert.equal(r.repositoryWorktree.changedFiles[0].kind, 'uncommitted');
    assert.equal(r.repositoryWorktree.changedFiles[0].raw, `${staged ? 'M ' : ' M'} evidence.json`);
    assert.ok(r.errors.some(v => v.field === 'repositoryWorktree'));
    assert.deepEqual(snapshotTree(f.root), dirtyBefore);
  }
});

test('worktree 未跟踪嵌套与中文空格路径保留原始 porcelain', t => {
  const f = cleanWorktree(t);
  fs.mkdirSync(path.join(f.root, 'nested'));
  f.write('nested/中文 name.json', {});
  const before = snapshotTree(f.root);
  const r = f.run({ 'check-worktree': true });
  assert.equal(r.exitCode, 1);
  assert.equal(r.repositoryWorktree.changedFiles.length, 1);
  assert.equal(r.repositoryWorktree.changedFiles[0].kind, 'untracked');
  assert.ok(r.repositoryWorktree.rawPorcelain.includes(r.repositoryWorktree.changedFiles[0].raw));
  assert.deepEqual(snapshotTree(f.root), before);
});

test('worktree 非 Git unavailable；unborn 的未跟踪状态不依赖 HEAD', t => {
  const f = fixture(t);
  const r = f.run({ 'check-worktree': true });
  assert.equal(r.repositoryWorktree.status, 'unavailable');
  assert.equal(r.exitCode, 1);
  assert.equal(spawnSync('git', ['init', '--template='], { cwd: f.root }).status, 0);
  const unborn = f.run({ 'check-worktree': true, 'check-head': true });
  assert.equal(unborn.repositoryWorktree.status, 'dirty');
  assert.equal(unborn.repositoryHead.status, 'unavailable');
  assert.equal(unborn.exitCode, 1);
});

test('HEAD matched 与 worktree dirty 独立叠加；CLI 返回 1', t => {
  const f = gitFixture(t);
  f.d.commit = f.head; f.write('evidence.json', f.d);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../workflow.js'), 'audit:delivery', '--root', f.root, '--evidence', 'evidence.json', '--check-head', '--check-worktree', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const r = JSON.parse(result.stdout);
  assert.equal(r.repositoryHead.status, 'matched');
  assert.equal(r.repositoryWorktree.status, 'dirty');
});

test('worktree 命令失败及损坏状态 fail closed，校验精确只读命令', t => {
  const f = fixture(t);
  const cli = path.resolve(__dirname, '../maintenance/audit-delivery.js');
  for (const result of [{ status: 1, stderr: 'fixture failure' }, { status: 0, stdout: 'garbage\n' }, { status: 0, stdout: '\n' }, { status: 0, stdout: 'ZZ file\n' }, { status: 0 }]) {
    const guard = path.join(f.root, 'fake-git.cjs');
    fs.writeFileSync(guard, `require('node:child_process').spawnSync = (cmd, args, options) => {
      require('node:assert/strict').equal(cmd, 'git');
      require('node:assert/strict').deepEqual(args, ['status', '--porcelain=v1', '--untracked-files=all']);
      require('node:assert/strict').equal(options.env.GIT_OPTIONAL_LOCKS, '0');
      return ${JSON.stringify(result)};
    };`);
    const run = spawnSync(process.execPath, ['--require', guard, cli, '--root', f.root, '--evidence', 'evidence.json', '--check-worktree', '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const r = JSON.parse(run.stdout);
    assert.equal(r.repositoryWorktree.status, 'unavailable');
    assert.ok(r.errors.some(v => v.field === 'repositoryWorktree'));
  }
});

test('worktree 接受 Git 合法 type-change porcelain 状态', t => {
  const f = fixture(t);
  const cli = path.resolve(__dirname, '../maintenance/audit-delivery.js');
  const guard = path.join(f.root, 'type-change-git.cjs');
  fs.writeFileSync(guard, `require('node:child_process').spawnSync = (cmd, args, options) => {
    require('node:assert/strict').equal(cmd, 'git');
    require('node:assert/strict').deepEqual(args, ['status', '--porcelain=v1', '--untracked-files=all']);
    return { status: 0, stdout: ' T typed-file\\n', stderr: '' };
  };`);
  const result = spawnSync(process.execPath, ['--require', guard, cli, '--root', f.root, '--evidence', 'evidence.json', '--check-worktree', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.repositoryWorktree.status, 'dirty');
  assert.equal(report.repositoryWorktree.changedFiles[0].worktreeStatus, 'T');
});

// G4：人类可读输出。formatReport 只排版 report() 既有结果，不产生新判定。
test('人类输出三分桶各带文件/字段/原因，未知与未运行不混同', () => {
  const out = formatReport({
    schemaVersion: 1,
    errors: [{ file: 'a.json', field: 'fullGate', message: '记录状态: failed', status: 'failed' }],
    passed: [{ file: 'a.json', field: 'commit', message: 'a'.repeat(40) }],
    pending: [
      { file: 'a.json', field: 'installation', message: '记录状态: unknown', status: 'unknown' },
      { file: 'a.json', field: 'deviceAcceptance', message: '记录状态: unrun', status: 'unrun' },
    ],
    limitations: [{ message: '只比较 HEAD commit' }],
    recommendations: [{ name: 'audit:delivery', command: ['node', 'scripts/maintenance/audit-delivery.js'], nature: ['read-only'], executed: false }],
    status: 'failed', exitCode: 1,
  });
  assert.ok(out.startsWith('交付审计状态: 失败（退出码 1）'), out);
  assert.ok(out.includes('通过 1 ｜ 错误 1 ｜ 待验 2'));
  assert.ok(out.includes('待验 (2；未知 1、未运行 1):'));
  assert.ok(out.includes('[失败] a.json · fullGate — 记录状态: failed'));
  assert.ok(out.includes('[未知] a.json · installation — 记录状态: unknown'));
  assert.ok(out.includes('[未运行] a.json · deviceAcceptance — 记录状态: unrun'));
  assert.ok(out.includes(`a.json · commit — ${'a'.repeat(40)}`));
  assert.ok(out.includes('限制与未覆盖 (1):') && out.includes('- 只比较 HEAD commit'));
  assert.ok(out.includes('未执行推荐命令 (1):'));
  assert.ok(out.includes('audit:delivery（nature: read-only）: node scripts/maintenance/audit-delivery.js'));
});

test('未启用检查保持缺席，空集合不堆整段 JSON', () => {
  const out = formatReport({ schemaVersion: 1, errors: [], passed: [], pending: [], limitations: [], recommendations: [], status: 'pending', exitCode: 3 });
  assert.ok(out.startsWith('交付审计状态: 待验（退出码 3）'), out);
  assert.ok(out.includes('通过 0 ｜ 错误 0 ｜ 待验 0'));
  for (const banned of ['仓库 HEAD', '工作树', '证据比较', '显式文件核验', '证据记录', '限制与未覆盖', '未执行推荐命令', '错误 (', '通过 (', '待验 (', '{"', '[{']) {
    assert.ok(!out.includes(banned), banned);
  }
});

test('多文件比较失败与文件核验结果逐项可读并保留原因', () => {
  const out = formatReport({
    errors: [
      { file: 'drift.json', field: 'comparisons', message: '交付标识不匹配: build.manifestSha256' },
      { file: 'missing.log', field: 'verifiedFiles', message: 'ENOENT', status: 'missing' },
    ],
    passed: [{ file: 'same.json', field: 'comparisons', message: '共有最终提交及构建标识一致' }],
    pending: [],
    verifiedFiles: [
      { file: 'gate.log', realPath: 'gate.log', status: 'exists' },
      { file: 'missing.log', status: 'missing', message: 'ENOENT' },
    ],
    comparisons: [
      { file: 'same.json', status: 'matched', sharedIds: ['commit', 'build.manifestSha256'] },
      { file: 'drift.json', status: 'failed', sharedIds: ['commit'], message: '交付标识不匹配: build.manifestSha256' },
      { file: 'absent.json', status: 'failed', message: 'ENOENT' },
    ],
    status: 'failed', exitCode: 1,
  });
  assert.ok(out.includes('显式文件核验 (2):'));
  assert.ok(out.includes('[存在] gate.log'));
  assert.ok(out.includes('[缺失] missing.log — ENOENT'));
  assert.ok(out.includes('证据比较 (3):'));
  assert.ok(out.includes('[一致] same.json — 共有标识: commit, build.manifestSha256'));
  assert.ok(out.includes('[失败] drift.json — 交付标识不匹配: build.manifestSha256'));
  assert.ok(out.includes('[失败] absent.json — ENOENT'));
});

test('HEAD 与工作树结果可读，携带提交与改动摘要', () => {
  const out = formatReport({
    errors: [], passed: [], pending: [],
    repositoryHead: { root: '/r', commit: 'a'.repeat(40), status: 'matched', evidenceCommit: 'b'.repeat(40), message: '证据最终 commit 与仓库 HEAD 一致' },
    repositoryWorktree: {
      root: '/r', status: 'dirty', message: '存在未提交或未跟踪文件',
      changedFiles: [{ kind: 'uncommitted', pathPorcelain: 'evidence.json', raw: ' M evidence.json' }, { kind: 'untracked', pathPorcelain: 'new.txt', raw: '?? new.txt' }],
    },
    status: 'failed', exitCode: 1,
  });
  assert.ok(out.includes('仓库 HEAD: [一致] 证据最终 commit 与仓库 HEAD 一致'));
  assert.ok(out.includes(`HEAD ${'a'.repeat(12)}… · 证据 ${'b'.repeat(12)}…`));
  assert.ok(out.includes('工作树: [有改动] 存在未提交或未跟踪文件'));
  assert.ok(out.includes('[未提交] evidence.json'));
  assert.ok(out.includes('[未跟踪] new.txt'));
});

test('异常兜底：缺失定位、非对象报告与怪异值不抛错、不冒充通过', () => {
  const fallback = formatReport({ status: 'failed', errors: [{ message: 'boom' }], exitCode: 1 });
  assert.ok(fallback.startsWith('交付审计状态: 失败（退出码 1）'), fallback);
  assert.ok(fallback.includes('boom'));
  assert.ok(!fallback.includes('通过 ('));
  const circular = {}; circular.self = circular;
  for (const input of [null, undefined, 42, 'x', [], {}, circular]) {
    const out = formatReport(input);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
    assert.ok(!out.includes('通过 ('));
  }
  const pending = formatReport({ status: 'pending', pending: [{ file: 'e', field: 'commit', message: '基线提交不能证明最终交付提交', status: 'unknown' }], exitCode: 3 });
  assert.ok(pending.includes('交付审计状态: 待验（退出码 3）'));
  assert.ok(pending.includes('[未知] e · commit — 基线提交不能证明最终交付提交'));
});

test('CLI 默认输出与 --json 同源：JSON 结构值不变，状态与退出码一致', t => {
  const f = fixture(t);
  f.write('other.json', { ...f.d });
  f.write('gate.log', 'ok');
  const cli = path.resolve(__dirname, '../maintenance/audit-delivery.js');
  const args = ['--root', f.root, '--evidence', 'evidence.json', '--verify-file', 'gate.log', '--compare-evidence', 'other.json'];
  const jsonRun = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(jsonRun.stdout);
  assert.deepEqual(parsed, report(parse([...args, '--json'])));
  assert.equal(jsonRun.status, 3);
  const humanRun = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(humanRun.status, jsonRun.status);
  assert.ok(humanRun.stdout.includes('交付审计状态: 待验（退出码 3）'), humanRun.stdout);
  assert.ok(humanRun.stdout.includes('[未知] evidence.json · installation — 记录状态: unknown'));
  assert.ok(humanRun.stdout.includes('[存在] gate.log'));
  assert.ok(humanRun.stdout.includes('[一致] other.json'));
  assert.ok(!humanRun.stdout.includes('仓库 HEAD') && !humanRun.stdout.includes('工作树'));
  assert.ok(humanRun.stdout.includes('限制与未覆盖 (2):'));
  assert.ok(humanRun.stdout.includes('未执行推荐命令 (2):'));
  const brokenRun = spawnSync(process.execPath, [cli, '--root', path.join(f.root, 'absent'), '--evidence', 'missing.json'], { encoding: 'utf8' });
  assert.equal(brokenRun.status, 1);
  assert.ok(brokenRun.stdout.includes('交付审计状态: 失败（退出码 1）'), brokenRun.stdout);
  assert.ok(brokenRun.stdout.length > '交付审计状态: 失败（退出码 1）'.length);
});
