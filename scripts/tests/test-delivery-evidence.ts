'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');
const { fixture, tree, EVIDENCE_DIR }: typeof import('./delivery-fixture') = require('./delivery-fixture');
const { capture }: typeof import('../lib/delivery-handoff') = require('../lib/delivery-handoff');
const { snapshot, compareSnapshot }: typeof import('../lib/delivery-identity') = require('../lib/delivery-identity');
const { saveJson, fileEntry }: typeof import('../lib/delivery-paths') = require('../lib/delivery-paths');
const { formatReport }: typeof import('../lib/delivery-report-format') = require('../lib/delivery-report-format');

test('源码修改同 HEAD 自动失效，只影响依赖 source 的门禁；审计零写入', t => {
  const f = fixture(t); f.office();
  assert.equal(f.audit().freshness.status, 'fresh');
  f.write('src/main.js', 'changed without commit');
  const before = tree(f.root), r = f.audit();
  assert.equal(r.exitCode, 1); assert.equal(r.handoff.commit.status, 'matched');
  assert.equal(r.freshness.source.status, 'stale'); assert.equal(r.freshness.build.status, 'fresh');
  for (const field of ['checks.source', 'checks.office']) {
    assert.equal(r.freshness.gates[field].effectiveStatus, 'stale');
    assert.ok(!r.passed.some((e: any) => e.field === field));
  }
  assert.equal(r.freshness.gates['checks.bundle'].effectiveStatus, 'passed');
  assert.deepEqual(tree(f.root), before);
});
test('目录捕获未跟踪新增、忽略新增、删除与重命名，保持原 HEAD', t => {
  for (const change of ['untracked', 'ignored', 'deleted', 'renamed']) {
    const f = fixture(t); f.office();
    if (change === 'untracked') f.write('src/中文 new.js', 'new');
    if (change === 'ignored') f.write('src/ignored.js', 'ignored but selected');
    if (change === 'deleted') fs.unlinkSync(path.join(f.root, 'src/remove.js'));
    if (change === 'renamed') fs.renameSync(path.join(f.root, 'src/remove.js'), path.join(f.root, 'src/renamed.js'));
    const r = f.audit();
    assert.equal(r.exitCode, 1, change); assert.equal(r.handoff.commit.status, 'matched');
    assert.equal(r.freshness.source.status, 'stale');
    assert.ok(r.freshness.source.changes.some((e: any) => e.status === (change === 'deleted' ? 'removed' : 'added')));
  }
});
test('已 dirty 的快照仍按确切内容比较，再次 dirty 修改失效', t => {
  const f = fixture(t); f.write('src/main.js', 'dirty baseline');
  const doc = f.office(); assert.equal(doc.handoff.commit.worktree, 'dirty');
  assert.equal(f.audit().freshness.gates['checks.source'].effectiveStatus, 'passed');
  f.write('src/main.js', 'different dirty bytes');
  assert.equal(f.audit().freshness.gates['checks.source'].effectiveStatus, 'stale');
});
test('构建内容变化/新增/丢失自动拒绝旧构建门禁，纯源码门禁保持有效', t => {
  for (const change of ['modify', 'add', 'delete']) {
    const f = fixture(t); f.office();
    if (change === 'modify') f.write('dist/index.html', 'another build');
    if (change === 'add') f.write('dist/new.js', 'untracked build chunk');
    if (change === 'delete') fs.unlinkSync(path.join(f.root, 'dist/index.html'));
    const r = f.audit(); assert.equal(r.exitCode, 1);
    assert.equal(r.freshness.gates['checks.bundle'].effectiveStatus, 'stale');
    assert.equal(r.freshness.gates['checks.source'].effectiveStatus, 'passed');
    assert.ok(!r.passed.some((e: any) => e.field === 'checks.office'));
  }
});
test('明确文件缺失/目录缺失保留 missing，缺失基线永不算 fresh', t => {
  const f = fixture(t);
  for (const input of [[{ path: 'missing.js', kind: 'file' }], [{ path: 'missing-dir', kind: 'tree' }]]) {
    const value = snapshot(f.root, input);
    assert.equal(value.status, 'incomplete'); assert.equal(value.entries[0].status, 'missing');
    assert.equal(compareSnapshot(f.root, value).status, 'unavailable');
  }
  const captured = capture(f.root, { ...f.initial, build: [{ path: 'dist/missing.exe', kind: 'file' }] });
  saveJson(f.root, f.baselinePath, captured);
  assert.equal(f.audit(f.baselinePath).exitCode, 1);
  assert.throws(() => capture(f.root, { baseline: f.baselinePath }), /改变|不可用/);
});
test('丢失的明确构建文件与整个构建目录均使有效记录失效', t => {
  for (const kind of ['file', 'tree']) {
    const f = fixture(t);
    f.office({ build: [{ path: kind === 'file' ? 'dist/index.html' : 'dist', kind }] });
    fs.rmSync(path.join(f.root, 'dist'), { recursive: true });
    const r = f.audit(); assert.equal(r.exitCode, 1);
    assert.equal(r.freshness.build.status, 'unavailable');
    assert.equal(r.freshness.build.problems[0].status, 'missing');
    assert.equal(r.freshness.gates['checks.bundle'].effectiveStatus, 'stale');
  }
});
test('日志字节变化或丢失只使绑定结果陈旧，未绑定日志不被扫描', t => {
  for (const deleted of [true, false]) {
    const f = fixture(t); f.office();
    const log = `${EVIDENCE_DIR}/source.log`;
    if (deleted) fs.unlinkSync(path.join(f.root, log)); else f.write(log, 'different report');
    f.write('unrelated.log', 'outside chosen source/build');
    const r = f.audit(); assert.equal(r.exitCode, 1);
    assert.equal(r.freshness.source.status, 'fresh'); assert.equal(r.freshness.build.status, 'fresh');
    assert.equal(r.freshness.gates['checks.source'].effectiveStatus, 'stale');
    assert.equal(r.freshness.gates['checks.bundle'].effectiveStatus, 'passed');
  }
});
test('根目录输入排除证据及 .git；首次保存、后续报告和时间不导致永久陈旧', t => {
  const f = fixture(t);
  const document = f.office({ source: [{ path: '.', kind: 'tree' }] });
  f.write(`${EVIDENCE_DIR}/another.json`, { timestamp: Date.now() });
  fs.utimesSync(path.join(f.root, 'src/main.js'), new Date(0), new Date(0));
  const r = f.audit(); assert.equal(r.freshness.status, 'fresh'); assert.equal(r.exitCode, 3);
  assert.ok(!document.tracking.source.entries.some((e: any) => e.path.startsWith(EVIDENCE_DIR) || e.path.startsWith('.git/')));
  const again = capture(f.root, { ...f.initial, source: [{ path: '.', kind: 'tree' }] });
  assert.equal(again.tracking.source.sha256, document.tracking.source.sha256);
});
test('范围外文档及只含文档的新提交不使代码门禁陈旧，交接 commit 独立失配', t => {
  const f = fixture(t); f.office(); f.write('docs/note.md', 'documentation only');
  assert.equal(f.audit().freshness.status, 'fresh');
  f.git('add', '--', 'docs/note.md');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'docs fixture');
  const r = f.audit(); assert.equal(r.freshness.status, 'fresh'); assert.equal(r.handoff.commit.status, 'mismatch');
  assert.equal(r.freshness.gates['checks.source'].effectiveStatus, 'passed'); assert.equal(r.exitCode, 1);
});
test('字面越界、绝对路径、ADS、重复和覆盖重叠选择项拒绝', t => {
  const f = fixture(t);
  for (const name of ['../outside', 'src/../outside', 'C:relative', 'C:/absolute', '/absolute', '\\server\share', 'src/file:stream', 'src/file.']) {
    assert.throws(() => snapshot(f.root, [{ path: name, kind: 'file' }]), () => true, name);
  }
  for (const items of [
    [{ path: 'src', kind: 'tree' }, { path: 'src/main.js', kind: 'file' }],
    [{ path: 'src', kind: 'tree' }, { path: 'SRC', kind: 'tree' }],
  ]) assert.throws(() => snapshot(f.root, items), /重复|重叠/);
});
test('junction 越界与证据目录内部别名均失败关闭，不读取链接内容', t => {
  for (const aliasEvidence of [false, true]) {
    const f = fixture(t), other = fixture(t); f.office();
    const target = aliasEvidence ? path.join(f.root, EVIDENCE_DIR) : other.root;
    fs.symlinkSync(target, path.join(f.root, 'src/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = tree(other.root), r = f.audit();
    assert.equal(r.exitCode, 1); assert.equal(r.freshness.source.status, 'unavailable');
    assert.equal(r.freshness.source.problems[0].status, 'unsafe-or-unreadable');
    assert.ok(!r.freshness.source.current.entries.some((e: any) => e.path.startsWith('src/escape/')));
    assert.deepEqual(tree(other.root), before);
  }
});
test('显式证据目录/.git 输入拒绝；硬链接不能绕过证据排除', t => {
  const f = fixture(t); f.office();
  for (const name of [EVIDENCE_DIR, '.git', `${EVIDENCE_DIR}/office.json`]) assert.throws(() => snapshot(f.root, [{ path: name, kind: 'tree' }]));
  fs.linkSync(path.join(f.root, f.officePath), path.join(f.root, 'src/evidence-alias.json'));
  const r = f.audit(); assert.equal(r.exitCode, 1);
  assert.equal(r.freshness.source.problems[0].status, 'unsafe-or-unreadable');
});
test('证据保存限定专用目录并拒绝覆盖、父 junction 与文件硬链接', t => {
  const f = fixture(t), other = fixture(t);
  const value = capture(f.root, f.initial);
  for (const name of ['result.json', '../outside.json', `${EVIDENCE_DIR}/../outside.json`]) assert.throws(() => saveJson(f.root, name, value));
  saveJson(f.root, f.baselinePath, value);
  const before = tree(f.root); assert.throws(() => saveJson(f.root, f.baselinePath, value)); assert.deepEqual(tree(f.root), before);
  fs.symlinkSync(other.root, path.join(f.root, EVIDENCE_DIR, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const outside = tree(other.root);
  assert.throws(() => saveJson(f.root, `${EVIDENCE_DIR}/escape/write.json`, value), /junction/);
  assert.deepEqual(tree(other.root), outside);
  fs.linkSync(path.join(f.root, 'src/main.js'), path.join(f.root, 'linked.js'));
  assert.equal(fileEntry(f.root, 'linked.js').status, 'unsafe-or-unreadable');
});
test('无追踪旧通过声明明确 unknown，保留原始状态且证据零改写', t => {
  const f = fixture(t); const document = f.office();
  delete document.tracking; delete document.handoff;
  for (const field of ['installation', 'deviceAcceptance', 'modelAcceptance']) document[field] = { status: 'passed', report: 'old.log' };
  f.write('legacy.json', document); const before = tree(f.root);
  const r = f.audit('legacy.json', { require: ['checks.office'] }); assert.equal(r.exitCode, 3);
  assert.equal(r.freshness.status, 'unknown');
  for (const field of ['checks.office', 'installation', 'deviceAcceptance', 'modelAcceptance']) {
    assert.equal(r.freshness.gates[field].declaredStatus, 'passed');
    assert.equal(r.freshness.gates[field].effectiveStatus, 'unknown');
    assert.ok(!r.passed.some((e: any) => e.field === field));
  }
  assert.deepEqual(tree(f.root), before);
});
test('坏版本、身份摘要篡改、空依赖、错报告绑定不得继续通过', t => {
  const f = fixture(t), original = f.office();
  const mutations = [
    (d: any) => { d.tracking.schemaVersion = 999; },
    (d: any) => { d.tracking.source.sha256 = '0'.repeat(64); },
    (d: any) => { d.tracking.gates['checks.office'].dependsOn = []; },
    (d: any) => { d.checks.office.report = `${EVIDENCE_DIR}/source.log`; },
    (d: any) => { d.tracking.gates['checks.office'].identities.source = 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const d = structuredClone(original); mutate(d); f.write(f.officePath, d);
    const r = f.audit(); assert.equal(r.exitCode, 1); assert.ok(!r.passed.some((e: any) => e.field === 'checks.office'));
  }
});
test('新鲜度人类输出展示陈旧路径与各自环境、安装入口和主力待验', t => {
  const f = fixture(t); f.office(); f.write('src/new.js', 'new');
  const text = formatReport(f.audit());
  for (const expected of ['证据新鲜度: [已陈旧]', '[新增] src/new.js', 'environment.office', 'environment.main', 'deploy-desktop.bat', 'deviceAcceptance']) assert.ok(text.includes(expected), expected);
});
