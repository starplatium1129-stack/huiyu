'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { fixture, temp, tree, EVIDENCE_DIR }: typeof import('./delivery-fixture') = require('./delivery-fixture');
const { capture }: typeof import('../lib/delivery-handoff') = require('../lib/delivery-handoff');
const { saveJson, sha256 }: typeof import('../lib/delivery-paths') = require('../lib/delivery-paths');
const { parse }: typeof import('../maintenance/capture-delivery') = require('../maintenance/capture-delivery');
const { report, state }: typeof import('../maintenance/audit-delivery') = require('../maintenance/audit-delivery');
const CLI = path.resolve(__dirname, '../maintenance/capture-delivery.js');
const AUDIT = path.resolve(__dirname, '../maintenance/audit-delivery.js');
const MAIN = ['installation', 'deviceAcceptance', 'modelAcceptance'];
const run = (args: any) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
function mainResults(root: any, fields = MAIN, baseline = `${EVIDENCE_DIR}/office.json`) {
  const value: any = { schemaVersion: 1, baselineSha256: sha256(fs.readFileSync(path.join(root, baseline))) };
  for (const field of fields) {
    const name = `${EVIDENCE_DIR}/${field}.log`;
    fs.writeFileSync(path.join(root, name), 'isolated acceptance fixture; no real installation, GPU or model call');
    value[field] = { status: 'passed', machine: 'main', report: name };
  }
  const file = `${EVIDENCE_DIR}/main-results.json`;
  fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  return file;
}
const audit = (root: any, evidence: any, extra = {}) => report({ root, evidence, require: [], builds: [], ...extra });
function writeResults(f: any, value: any) {
  f.write(f.resultPath, { schemaVersion: 1, baselineSha256: sha256(fs.readFileSync(path.join(f.root, f.baselinePath))), ...value });
}

test('办公机 manifest 分开 commit/source/build/environment/install，HEAD 一致不消除主力待验', t => {
  const f = fixture(t), document = f.office();
  assert.equal(document.handoff.commit.commit, document.commit);
  assert.equal(document.handoff.source.sha256, document.tracking.source.sha256);
  assert.equal(document.handoff.build.sha256, document.build.manifestSha256);
  assert.equal(document.handoff.environment.office.machine, 'office');
  assert.equal(document.handoff.environment.main.status, 'pending');
  assert.equal(document.handoff.install.entry, 'deploy-desktop.bat');
  assert.deepEqual(document.handoff.requiredMain.map((v: any) => v.field), MAIN);
  const r = f.audit(f.officePath, { 'check-head': true });
  assert.equal(r.repositoryHead.status, 'matched'); assert.equal(r.exitCode, 3);
  assert.ok(r.handoff.requiredMain.every((v: any) => v.status === 'pending'));
});
test('完整 office→main 临时双仓交接：先保持 pending，再绑定显式主力夹具结果', t => {
  const f = fixture(t), office = f.office(), mainRoot = temp(t);
  fs.cpSync(f.root, mainRoot, { recursive: true });
  const before = tree(mainRoot);
  const received = capture(mainRoot, { baseline: f.officePath, machine: 'main' });
  assert.deepEqual(tree(mainRoot), before);
  assert.equal(received.commit, office.commit); assert.equal(received.environment.machine, 'main');
  assert.equal(received.handoff.environment.office.machine, 'office');
  assert.equal(received.handoff.environment.main.machine, 'main');
  assert.equal(received.tracking.gates['checks.office'].machine, 'office');
  const receivePath = `${EVIDENCE_DIR}/received.json`; saveJson(mainRoot, receivePath, received);
  const pending = audit(mainRoot, receivePath, { comparisons: [f.officePath] });
  assert.equal(pending.exitCode, 3); assert.equal(pending.comparisons[0].status, 'matched');
  assert.ok(pending.comparisons[0].sharedIds.includes('source.sha256'));
  const record = mainResults(mainRoot, MAIN, receivePath);
  const completed = capture(mainRoot, { baseline: receivePath, machine: 'main', record });
  const completedPath = `${EVIDENCE_DIR}/main.json`; saveJson(mainRoot, completedPath, completed);
  const after = tree(mainRoot), r = audit(mainRoot, completedPath);
  assert.equal(r.exitCode, 0, JSON.stringify(r.errors)); assert.equal(r.handoff.status, 'passed');
  assert.ok(r.handoff.requiredMain.every((v: any) => v.status === 'passed'));
  assert.deepEqual(tree(mainRoot), after); assert.equal(f.audit().exitCode, 3);
});
test('主力部分结果不补齐模型/设备，变更构建使已通过安装重新陈旧', t => {
  const f = fixture(t); f.office();
  const record = mainResults(f.root, ['installation']);
  const document = capture(f.root, { baseline: f.officePath, machine: 'main', record });
  const name = `${EVIDENCE_DIR}/partial.json`; saveJson(f.root, name, document);
  const pending = f.audit(name); assert.equal(pending.exitCode, 3);
  assert.equal(pending.freshness.gates.installation.effectiveStatus, 'passed');
  assert.equal(pending.freshness.gates.deviceAcceptance.effectiveStatus, 'pending');
  f.write('dist/index.html', 'changed after partial install fixture');
  const stale = f.audit(name); assert.equal(stale.exitCode, 1);
  assert.equal(stale.freshness.gates.installation.effectiveStatus, 'stale');
  assert.ok(!stale.passed.some((v: any) => v.field === 'installation'));
});
test('办公机不能登记主力通过，手改 manifest 也不会被 audit 接受', t => {
  const f = fixture(t), office = f.office(); const record = mainResults(f.root);
  assert.throws(() => capture(f.root, { baseline: f.officePath, record }), /办公机/);
  const main = capture(f.root, { baseline: f.officePath, record, machine: 'main' });
  main.handoff.stage = 'office'; main.environment = office.environment;
  f.write(`${EVIDENCE_DIR}/forged-office.json`, main);
  const r = f.audit(`${EVIDENCE_DIR}/forged-office.json`);
  assert.equal(r.exitCode, 1); assert.ok(!r.passed.some((v: any) => MAIN.includes(v.field)));
});
test('主力接收同 HEAD 旧构建或旧源码失败；未知 Git 环境不得补最终提交', t => {
  for (const name of ['src/main.js', 'dist/index.html']) {
    const f = fixture(t); f.office(); f.write(name, 'drift before handoff');
    assert.throws(() => capture(f.root, { baseline: f.officePath, machine: 'main' }), /改变|不可用/);
  }
  const f = fixture(t, false);
  const document = capture(f.root, f.initial); saveJson(f.root, f.baselinePath, document);
  assert.equal(document.handoff.commit.status, 'unknown'); assert.equal(document.commit, undefined);
  const r = f.audit(f.baselinePath); assert.equal(r.exitCode, 3); assert.equal(r.handoff.commit.status, 'unknown');
});
test('缺失/改变的阶段索引文件报错，阶段文件不能覆盖或自动扫描最新记录', t => {
  for (const field of ['previous', 'resultRecord']) {
    const f = fixture(t), document = f.office();
    const file = document.handoff[field].path;
    fs.unlinkSync(path.join(f.root, file));
    const r = f.audit(); assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((v: any) => v.field === 'handoff' && v.message.includes(field)));
  }
  const f = fixture(t); f.office(); f.write(f.resultPath, { schemaVersion: 1, replaced: true });
  assert.equal(f.audit().exitCode, 1);
  assert.throws(() => capture(f.root, { baseline: f.officePath }), /交接结构/);
});
test('旧无追踪记录不能后补当前哈希并继续通过；结果必须基于执行前快照', t => {
  const f = fixture(t), document = f.office();
  delete document.tracking; delete document.handoff;
  const old = `${EVIDENCE_DIR}/legacy.json`; f.write(old, document);
  assert.throws(() => capture(f.root, { baseline: old, record: f.resultPath }), /改变|不可用/);
  assert.throws(() => parse(['--record', f.resultPath]), /baseline/);
  f.write('src/main.js', 'changed after snapshot');
  assert.throws(() => capture(f.root, { baseline: f.baselinePath, record: f.resultPath }), /改变|不可用/);
});
test('空构建目录不生成有效产物证明', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, 'dist/index.html'));
  const document = capture(f.root, f.initial); saveJson(f.root, f.baselinePath, document);
  assert.equal(document.tracking.build.status, 'incomplete'); assert.equal(document.tracking.build.entries[0].status, 'empty');
  const r = f.audit(f.baselinePath); assert.equal(r.exitCode, 1); assert.equal(r.freshness.build.status, 'unavailable');
});
test('错提交、错构建、错机器、缺报告及未声明门禁的结果均拒绝', t => {
  const f = fixture(t);
  saveJson(f.root, f.baselinePath, capture(f.root, f.initial));
  const log = `${EVIDENCE_DIR}/gate.log`; f.write(log, 'fixture');
  const failures = [
    { commit: '0'.repeat(40) }, { build: { manifestSha256: '0'.repeat(64) } },
    { checks: { office: { status: 'passed' } } },
    { checks: { office: { status: 'passed', report: 'missing.log' } } },
    { checks: { office: { status: 'passed', report: log, machine: 'main' } } },
    { checks: { typo: { status: 'passed', report: log } } }, { checks: [] },
    { checks: { office: { status: 'passed', report: log, commit: '0'.repeat(40) } } },
  ];
  for (const value of failures) {
    writeResults(f, value);
    assert.throws(() => capture(f.root, { baseline: f.baselinePath, record: f.resultPath }));
  }
});
test('声明失败优先，数字数量/异常原型名不冒充通过', t => {
  for (const raw of ['__proto__', 'constructor', 'toString']) assert.equal(state({ status: raw }), 'unknown');
  const f = fixture(t); saveJson(f.root, f.baselinePath, capture(f.root, f.initial));
  const log = `${EVIDENCE_DIR}/failed.log`; f.write(log, 'isolated failure fixture');
  writeResults(f, { checks: { office: { status: 'passed', failed: 1, report: log }, source: { passed: 40 } } });
  assert.throws(() => capture(f.root, { baseline: f.baselinePath, record: f.resultPath }), /明确状态/);
  writeResults(f, { checks: { office: { status: 'passed', failed: 1, report: log }, source: { status: 'unknown', passed: 40 } } });
  const document = capture(f.root, { baseline: f.baselinePath, record: f.resultPath }); saveJson(f.root, f.officePath, document);
  const r = f.audit(); assert.equal(r.exitCode, 1); assert.equal(r.freshness.gates['checks.office'].effectiveStatus, 'failed');
  assert.equal(r.freshness.gates['checks.source'].effectiveStatus, 'unknown');
});
test('capture 默认只读包括 Git 索引；--save 仅创建专用记录且不覆盖', t => {
  const f = fixture(t), before = tree(f.root);
  const args = ['--root', f.root, '--scope', 'CLI isolated fixture', '--source-tree', 'src', '--build-tree', 'dist', '--gate', 'checks.source=source', '--json'];
  const dry = run(args); assert.equal(dry.status, 0, dry.stderr); assert.deepEqual(tree(f.root), before);
  const parsed = JSON.parse(dry.stdout); assert.equal(parsed.checks.source.status, 'unrun');
  assert.equal(fs.existsSync(path.join(f.root, EVIDENCE_DIR)), false);
  const saved = run([...args, '--save', f.baselinePath]); assert.equal(saved.status, 0, saved.stderr);
  const after = tree(f.root);
  assert.equal(run([...args, '--save', f.baselinePath]).status, 1); assert.deepEqual(tree(f.root), after);
  const cliAudit = spawnSync(process.execPath, [AUDIT, '--root', f.root, '--evidence', f.baselinePath, '--json'], { encoding: 'utf8' });
  assert.equal(cliAudit.status, 3); assert.equal(JSON.parse(cliAudit.stdout).freshness.status, 'fresh');
  assert.deepEqual(tree(f.root), after);
});
test('capture CLI baseline/result/main 可执行，实际 CLI 仍报告设备待验', t => {
  const f = fixture(t); f.office();
  const name = `${EVIDENCE_DIR}/cli-received.json`;
  const received = run(['--root', f.root, '--baseline', f.officePath, '--machine', 'main', '--save', name, '--json']);
  assert.equal(received.status, 0, received.stderr);
  assert.equal(JSON.parse(received.stdout).environment.machine, 'main');
  assert.equal(f.audit(name).exitCode, 3);
  const record = mainResults(f.root, ['installation'], name), partialPath = `${EVIDENCE_DIR}/cli-partial.json`;
  const partial = run(['--root', f.root, '--baseline', name, '--machine', 'main', '--record', record, '--save', partialPath]);
  assert.equal(partial.status, 0, partial.stderr); assert.equal(f.audit(partialPath).exitCode, 3);
});
test('help/plan 不访问 root、不启动 Git、不创建保存路径；非法参数退出 2', t => {
  const f = fixture(t), guard = path.join(f.root, 'guard.cjs');
  fs.writeFileSync(guard, "require('node:child_process').spawnSync = () => { throw Error('must not run Git'); }; const fs = require('node:fs'); const real = fs.realpathSync; fs.realpathSync = (value, ...rest) => { if (String(value).includes('absent-root')) throw Error('must not read root'); return real(value, ...rest); };");
  const before = tree(f.root);
  for (const flag of ['--help', '--plan']) {
    const result = spawnSync(process.execPath, ['--require', guard, CLI, '--root', path.join(f.root, 'absent-root'), '--baseline', `${EVIDENCE_DIR}/missing.json`, '--save', `${EVIDENCE_DIR}/new.json`, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(tree(f.root), before);
  for (const args of [[], ['--machine', 'bad'], ['--record', f.resultPath], ['--baseline', f.baselinePath, '--source-tree', 'src'], ['--baseline', f.baselinePath, '--save', 'outside.json']]) {
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
});
test('相同 commit/build 但不同 source 的版本化证据比较失败，不继承他机状态', t => {
  const f = fixture(t); f.office();
  f.write('src/main.js', 'different source same HEAD/build');
  const other = capture(f.root, f.initial), name = `${EVIDENCE_DIR}/different-source.json`; saveJson(f.root, name, other);
  const r = f.audit(name, { comparisons: [f.officePath] });
  assert.equal(r.exitCode, 1); assert.match(r.comparisons[0].message, /source.sha256/);
  assert.ok(r.handoff.requiredMain.every((v: any) => v.status === 'pending'));
});
test('未绑定或绑定另一快照的历史成功记录不能嫁接为当前通过', t => {
  const f = fixture(t); saveJson(f.root, f.baselinePath, capture(f.root, f.initial));
  const log = `${EVIDENCE_DIR}/old-success.log`; f.write(log, 'old success statement');
  for (const baselineSha256 of [undefined, 'f'.repeat(64)]) {
    f.write(f.resultPath, { schemaVersion: 1, baselineSha256, checks: { office: { status: 'passed', report: log } } });
    assert.throws(() => capture(f.root, { baseline: f.baselinePath, record: f.resultPath }), /baselineSha256/);
  }
});
