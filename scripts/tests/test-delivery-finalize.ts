'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { fixture, tree, EVIDENCE_DIR }: typeof import('./delivery-fixture') = require('./delivery-fixture');
const { capture }: typeof import('../lib/delivery-handoff') = require('../lib/delivery-handoff');
const { saveJson, sha256 }: typeof import('../lib/delivery-paths') = require('../lib/delivery-paths');
const { parse }: typeof import('../maintenance/capture-delivery') = require('../maintenance/capture-delivery');
const { formatReport }: typeof import('../lib/delivery-report-format') = require('../lib/delivery-report-format');
const CLI = path.resolve(__dirname, '../maintenance/capture-delivery.js');
const FINAL = `${EVIDENCE_DIR}/final.json`;
const MAIN = ['installation', 'deviceAcceptance', 'modelAcceptance'];
const run = (args: any) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
function commit(f: any, paths = ['src']) {
  f.git('add', '--', ...paths);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=.git/no-hooks', 'commit', '--allow-empty', '-m', 'isolated finalize fixture');
  return f.git('rev-parse', 'HEAD');
}
function tested(f: any, { bound = true, crlf = false, prepare = () => {} }: any = {}) {
  const a = f.git('rev-parse', 'HEAD');
  f.write('src/main.js', `module.exports = 42;${crlf ? '\r\n' : '\n'}`);
  prepare();
  const baseline = capture(f.root, f.initial); saveJson(f.root, f.baselinePath, baseline);
  // Actually execute a small isolated gate before committing; no shared build,
  // application, device, model or production fixture is involved.
  const check = spawnSync(process.execPath, ['-e', "const a=require('node:assert/strict'); a.equal(require('./src/main.js'),42); a.equal(require('node:fs').readFileSync('dist/index.html','utf8'),'<html>fixture</html>'); console.log('isolated source/build assertions passed');"],
    { cwd: f.root, encoding: 'utf8', windowsHide: true });
  assert.equal(check.status, 0, check.stderr);
  const log = `${EVIDENCE_DIR}/executed-gate.log`; f.write(log, check.stdout);
  const value: any = { schemaVersion: 1, baselineSha256: sha256(fs.readFileSync(path.join(f.root, f.baselinePath))), commit: a, checks: {} };
  for (const name of ['source', 'bundle', 'office']) value.checks[name] = { status: 'passed', commit: a, report: log };
  f.write(f.resultPath, value);
  if (bound) saveJson(f.root, f.officePath, capture(f.root, { baseline: f.baselinePath, record: f.resultPath }));
  return { a, baseline, log, evidence: bound ? f.officePath : f.baselinePath, record: bound ? undefined : f.resultPath };
}
function finalize(f: any, t: any, b: any) {
  return capture(f.root, { baseline: t.evidence, record: t.record, finalizeCommit: b });
}
function assertPending(f: any, file = FINAL) {
  const r = f.audit(file, { 'check-head': true });
  assert.equal(r.exitCode, 3, JSON.stringify(r.errors));
  assert.equal(r.repositoryHead.status, 'matched');
  assert.equal(r.handoff.finalization.status, 'matched');
  assert.equal(r.freshness.gates['checks.office'].effectiveStatus, 'passed');
  assert.ok(r.handoff.requiredMain.every((item: any) => item.status === 'pending'));
  return r;
}

test('dirty HEAD=A 实际运行隔离门禁后只提交到 B；finalize 保留原始结果与日志且零写入', t => {
  const f = fixture(t), data = tested(f), b = commit(f), before: any = tree(f.root);
  assert.notEqual(b, data.a); assert.equal(data.baseline.handoff.commit.worktree, 'dirty');
  assert.throws(() => capture(f.root, { baseline: data.evidence }), /HEAD/);
  const d = finalize(f, data, b);
  assert.deepEqual(tree(f.root), before);
  assert.equal(d.commit, b); assert.equal(d.finalization.finalCommit, b); assert.equal(d.finalization.baselineHead, data.a);
  assert.equal(d.finalization.baseline.path, f.baselinePath);
  assert.equal(d.finalization.gates['checks.office'].executionCommit, data.a);
  assert.equal(d.checks.office.commit, data.a);
  assert.equal(d.tracking.source.sha256, data.baseline.tracking.source.sha256);
  assert.equal(d.tracking.build.sha256, data.baseline.tracking.build.sha256);
  assert.equal(d.finalization.worktree.sourceIndex, 'matches-final-commit');
  saveJson(f.root, FINAL, d); const saved = tree(f.root), r = assertPending(f);
  assert.ok(formatReport(r).includes('baselineHead')); assert.deepEqual(tree(f.root), saved);
  for (const file of [f.baselinePath, f.resultPath, f.officePath, data.log]) assert.equal(tree(f.root)[file], before[file]);
});

test('提交 B 后可直接 --baseline A --record A结果 --finalize-commit B；CLI 默认只读与专用保存', t => {
  const f = fixture(t), data = tested(f, { bound: false }), b = commit(f);
  const args = ['--root', f.root, '--baseline', data.evidence, '--record', data.record, '--finalize-commit', b.toUpperCase()];
  const before = tree(f.root), dry = run(args); assert.equal(dry.status, 0, dry.stderr); assert.deepEqual(tree(f.root), before);
  const d = JSON.parse(dry.stdout); assert.equal(d.finalization.baselineHead, data.a); assert.equal(d.checks.office.commit, data.a);
  const saved = run([...args, '--save', FINAL]); assert.equal(saved.status, 0, saved.stderr); assertPending(f);
  const after = tree(f.root); assert.equal(run([...args, '--save', FINAL]).status, 1); assert.deepEqual(tree(f.root), after);
});

test('源码/构建修改、新增、删除后不能 finalize；不创建交付文件', t => {
  for (const change of ['source', 'build', 'new', 'delete']) {
    const f = fixture(t), data = tested(f), b = commit(f);
    if (change === 'source') f.write('src/main.js', 'module.exports = 43;');
    if (change === 'build') f.write('dist/index.html', 'different build');
    if (change === 'new') f.write('src/new.js', 'new untested input');
    if (change === 'delete') fs.unlinkSync(path.join(f.root, 'src/remove.js'));
    const before = tree(f.root);
    assert.throws(() => finalize(f, data, b), /改变|不可用/); assert.deepEqual(tree(f.root), before);
    assert.equal(fs.existsSync(path.join(f.root, FINAL)), false);
  }
});

test('B 必须包含受审目录完整集合：未提交新增、删除和同字节不同提交源码均拒绝', t => {
  for (const variant of ['new', 'delete', 'bytes']) {
    const f = fixture(t), data = tested(f, { prepare() {
      if (variant === 'new') f.write('src/未跟踪 new.js', 'new');
      if (variant === 'delete') fs.unlinkSync(path.join(f.root, 'src/remove.js'));
    } });
    f.write('docs/note.md', 'docs only'); const b = commit(f, ['docs/note.md']);
    assert.throws(() => finalize(f, data, b), /源码集合|索引|blob/);
  }
});

test('索引已暂存另一版本、工作树仍为已测字节时拒绝 finalize', t => {
  const f = fixture(t), data = tested(f), b = commit(f);
  f.write('src/main.js', 'module.exports = 99;'); f.git('add', '--', 'src/main.js');
  f.write('src/main.js', 'module.exports = 42;\n'); const before = tree(f.root);
  assert.throws(() => finalize(f, data, b), /索引/); assert.deepEqual(tree(f.root), before);
});

test('assume-unchanged/skip-worktree 隐藏的修改不能冒充最终提交内容', t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const f = fixture(t); f.git('update-index', flag, '--', 'src/main.js');
    const data = tested(f);
    f.write('docs/note.md', 'docs'); const b = commit(f, ['docs/note.md']);
    assert.throws(() => finalize(f, data, b), /blob/);
  }
});

test('错 finalCommit、非祖先 HEAD、主力阶段与未知 Git 基线拒绝显式关联', t => {
  const f = fixture(t), data = tested(f), b = commit(f);
  for (const value of [data.a, '0'.repeat(40), 'HEAD', 'HEAD~1']) assert.throws(() => finalize(f, data, value));
  assert.throws(() => capture(f.root, { baseline: data.evidence, finalizeCommit: b, machine: 'main' }), /办公机/);
  f.git('checkout', '--orphan', 'unrelated'); const unrelated = commit(f);
  assert.throws(() => finalize(f, data, unrelated));
  const noGit = fixture(t, false), doc = capture(noGit.root, noGit.initial); saveJson(noGit.root, noGit.baselinePath, doc);
  assert.throws(() => capture(noGit.root, { baseline: noGit.baselinePath, finalizeCommit: b }), /HEAD/);
});

test('文档-only C 不过期 code gates；再次 finalize 保留 A、真实交接 C 与设备 pending', t => {
  const f = fixture(t), data = tested(f), b = commit(f);
  saveJson(f.root, FINAL, finalize(f, data, b)); assertPending(f);
  f.write('docs/note.md', 'docs only'); const c = commit(f, ['docs/note.md']);
  const old = f.audit(FINAL); assert.equal(old.exitCode, 1); assert.equal(old.handoff.commit.status, 'mismatch');
  assert.equal(old.freshness.gates['checks.office'].effectiveStatus, 'passed');
  const d = capture(f.root, { baseline: FINAL, finalizeCommit: c }), name = `${EVIDENCE_DIR}/final-c.json`;
  assert.equal(d.finalization.baselineHead, data.a); assert.equal(d.finalization.previousCommit, b);
  assert.equal(d.checks.office.commit, data.a); assert.equal(d.commit, c); saveJson(f.root, name, d); assertPending(f, name);
  const received = capture(f.root, { baseline: name, machine: 'main' }), receive = `${EVIDENCE_DIR}/received-c.json`;
  saveJson(f.root, receive, received); assertPending(f, receive);
});

test('范围外 dirty 明确记录；所选源码已在 B，忽略的构建产物独立保留字节身份', t => {
  const f = fixture(t);
  f.git('rm', '--cached', '--', 'dist/index.html'); f.write('.gitignore', '/runtime/\n/dist/\n');
  commit(f, ['.gitignore']);
  const data = tested(f); f.write('docs/uncommitted.md', 'unrelated dirty docs'); const b = commit(f);
  const d = finalize(f, data, b); assert.equal(d.finalization.worktree.final, 'dirty');
  assert.equal(d.finalization.sourceProof.buildCommitCoverage, 'not-asserted');
  saveJson(f.root, FINAL, d); assertPending(f);
});

test('新增/删除实际提交后可 finalize，中文/空格/= 路径按字节核对', t => {
  const f = fixture(t), data = tested(f, { prepare() {
    f.write('src/中文 name=one.js', 'module.exports = 7;\n'); fs.unlinkSync(path.join(f.root, 'src/remove.js'));
  } }), b = commit(f), d = finalize(f, data, b);
  assert.ok(d.finalization.sourceProof.files.some((e: any) => e.path === 'src/中文 name=one.js'));
  assert.ok(!d.finalization.sourceProof.files.some((e: any) => e.path === 'src/remove.js'));
  saveJson(f.root, FINAL, d); assertPending(f);
});

test('Git 文本 CRLF/LF 映射单独证明；测试工作树原始字节不变', t => {
  const f = fixture(t); f.write('.gitattributes', '* text eol=crlf\n');
  const data = tested(f, { crlf: true }), b = commit(f, ['src', '.gitattributes']);
  const before = tree(f.root), d = finalize(f, data, b), file = d.finalization.sourceProof.files.find((e: any) => e.path === 'src/main.js');
  assert.equal(file.representation, 'git-crlf-to-lf'); assert.notEqual(file.blobSha256, file.sourceSha256);
  assert.equal(d.tracking.source.sha256, data.baseline.tracking.source.sha256); assert.deepEqual(tree(f.root), before);
  saveJson(f.root, FINAL, d); assertPending(f);
});

test('不运行自定义 Git filter，也不接受其隐式字节转换', t => {
  const f = fixture(t); f.write('.gitattributes', '* text eol=crlf filter=custom\n');
  const data = tested(f, { crlf: true }), b = commit(f, ['src', '.gitattributes']);
  f.git('config', 'filter.custom.clean', 'command-that-must-never-be-executed');
  const before = tree(f.root); assert.throws(() => finalize(f, data, b), /blob/); assert.deepEqual(tree(f.root), before);
});

test('finalize 元数据、结果索引或原日志被改动，audit 拒绝旧提交通过关联', t => {
  const f = fixture(t), data = tested(f), b = commit(f), d = finalize(f, data, b);
  for (const mutate of [
    (v: any) => { v.finalization.baselineHead = b; },
    (v: any) => { v.finalization.finalCommit = data.a; },
    (v: any) => { v.finalization.gates['checks.office'].executionCommit = b; },
    (v: any) => { v.finalization.sourceProof.files[0].oid = 'f'.repeat(40); },
    (v: any) => { v.finalization.evidence.sha256 = '0'.repeat(64); },
    (v: any) => { v.checks.office.status = 'passed'; v.checks.office.extra = 'changed result'; },
  ]) {
    const altered = structuredClone(d); mutate(altered); f.write(FINAL, altered);
    const r = f.audit(FINAL); assert.equal(r.exitCode, 1); assert.ok(!r.passed.some((v: any) => v.field === 'checks.office'));
  }
  f.write(FINAL, d); f.write(data.log, 'changed log');
  const r = f.audit(FINAL); assert.equal(r.exitCode, 1); assert.ok(!r.passed.some((v: any) => v.field === 'checks.office'));
  assert.throws(() => finalize(f, data, b), /陈旧|改变/);
});

test('finalize 不能把 pending 设备字段改成源 HEAD 的通过', t => {
  const f = fixture(t), data = tested(f), b = commit(f), d = finalize(f, data, b);
  for (const field of MAIN) d[field] = { status: 'passed', commit: data.a, report: data.log };
  f.write(FINAL, d); const r = f.audit(FINAL);
  assert.equal(r.exitCode, 1); assert.ok(!r.passed.some((v: any) => MAIN.includes(v.field)));
});

test('finalize help/plan 不读取目标或启动 Git；参数/路径错误无保存', t => {
  const f = fixture(t), guard = path.join(f.root, 'guard.cjs'), b = f.git('rev-parse', 'HEAD');
  f.write('guard.cjs', "require('node:child_process').spawnSync=()=>{throw Error('Git forbidden');};");
  for (const flag of ['--help', '--plan']) {
    const r = spawnSync(process.execPath, ['--require', guard, CLI, '--root', 'absent-root', '--baseline', f.baselinePath, '--finalize-commit', b, '--save', FINAL, flag], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  for (const args of [ ['--finalize-commit', b], ['--baseline', f.baselinePath, '--finalize-commit', 'HEAD'],
    ['--baseline', f.baselinePath, '--finalize-commit', b, '--machine', 'main'],
    ['--baseline', f.baselinePath, '--finalize-commit', b, '--save', '../escape.json'] ]) {
    assert.throws(() => parse(args)); assert.equal(run(args).status, 2);
  }
});
