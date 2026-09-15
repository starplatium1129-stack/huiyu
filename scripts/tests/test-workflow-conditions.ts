'use strict';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
import type { WorkflowRun, WorkflowRegistry, WorkflowDefinition } from '../lib/workflow-types';
type TestContext = import('node:test').TestContext;
type WorkflowReportRegistry = import('../lib/workflow-types').RegisteredWorkflows;
const registryFixture = (value: any): WorkflowReportRegistry => value as WorkflowReportRegistry;
const { reportConditions, formatConditions, formatConditionRow, main }: typeof import('../maintenance/report-workflow-conditions') = require('../maintenance/report-workflow-conditions');
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-conditions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/entry.js'), 'throw new Error("must not run")');
  fs.writeFileSync(path.join(root, 'doc.md'), 'fixture');
  return root;
}
const definition = (): WorkflowDefinition & { run: WorkflowRun } => ({ cmd: ['node', 'scripts/entry.js'], docs: 'doc.md', run: { nature: ['read-only'], machine: ['node'], resume: 'na', evidence: 'scripts/entry.js:1', unknown: [] } });
test('conditions: reports metadata without executing entry', t => {
  const result = reportConditions({ root: fixture(t), registry: registryFixture({ 'test:a': definition() }), domain: 'test' });
  assert.equal(result.ok, true); assert.equal(result.commands[0].executionStatus, 'not-run');
});
test('conditions: missing entry, docs and malformed metadata fail closed', t => {
  const root = fixture(t);
  for (const override of [{ cmd: ['node', 'scripts/missing.js'] }, { docs: 'missing.md' }, { run: { nature: 'wrong' } }]) {
    assert.equal(reportConditions({ root, registry: registryFixture({ 'test:a': { ...definition(), ...override } }) }).ok, false);
  }
});
test('conditions: nested composite effects and missing steps are detected', t => {
  const root = fixture(t), registry = registryFixture({ 'test:a': { ...definition(), steps: ['test:b'] }, 'test:b': { ...definition(), steps: ['test:c'] }, 'test:c': definition() });
  registry['test:c'].run.nature = ['writes-source'];
  assert.deepEqual(reportConditions({ root, registry }).commands[0].composite.missingEffects, ['writes-source']);
  registry['test:b'].steps = ['missing'];
  assert.equal(reportConditions({ root, registry }).ok, false);
});
test('conditions: help and plan never spawn or inspect root', t => {
  const cp: typeof import('node:child_process') = require('node:child_process');
  for (const method of ['spawnSync', 'spawn', 'execSync', 'execFileSync']) t.mock.method(cp, method, () => assert.fail('child process'));
  const spied = ['realpathSync', 'statSync', 'readFileSync'].map(m => t.mock.method(fs, m, () => assert.fail('fs.' + m + ' must not be called by help/plan')));
  for (const flag of ['--help', '--plan']) assert.equal(main([flag, '--root', 'missing-root']), 0);
  for (const spy of spied) assert.equal(spy.mock.callCount(), 0);
});
test('conditions: JSON adds declared switches, notes and needs with stable defaults', t => {
  const root = fixture(t);
  const base = definition();
  const registry = {
    'test:a': { ...base, needs: 'ComfyUI http://127.0.0.1:8188', run: { ...base.run, switches: { '--json': ['read-only'], '--limit': ['external-model'] }, notes: ['note one', 'note two'] } },
    'test:b': definition(),
  };
  const snapshot = structuredClone(registry);
  const result = reportConditions({ root, registry });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.executionStatus, 'not-run');
  const a = result.commands.find((row: { name: string }) => row.name === 'test:a')!;
  assert.deepEqual(a.switches, { '--json': ['read-only'], '--limit': ['external-model'] });
  assert.deepEqual(a.notes, ['note one', 'note two']);
  assert.equal(a.needs, 'ComfyUI http://127.0.0.1:8188');
  assert.deepEqual(a.nature, ['read-only']);
  assert.equal(a.executionStatus, 'not-run');
  const b = result.commands.find((row: { name: string }) => row.name === 'test:b')!;
  assert.deepEqual(b.switches, {});
  assert.deepEqual(b.notes, []);
  assert.equal(b.needs, null);
  assert.deepEqual(registry, snapshot);
});
test('conditions: text output shows default, switches, needs, notes and unknowns per row', t => {
  const root = fixture(t);
  const base = definition();
  const registry = {
    'test:a': { ...base, needs: 'ComfyUI http://127.0.0.1:8188', run: { ...base.run, switches: { '--json': ['read-only'], '--limit': ['external-model'] }, notes: ['note one', 'note two'], unknown: ['unverified point'] } },
    'test:b': definition(),
  };
  const result = reportConditions({ root, registry });
  const a = formatConditionRow(result.commands[0]);
  assert.match(a, /^test:a: metadata valid; not-run$/m);
  assert.match(a, /^ {2}默认: read-only$/m);
  assert.match(a, /--json → read-only/);
  assert.match(a, /--limit → external-model/);
  assert.match(a, /^ {2}前置: ComfyUI http:\/\/127\.0\.0\.1:8188$/m);
  assert.match(a, /^ {2}说明: note one；note two$/m);
  assert.match(a, /^ {2}未知: unverified point$/m);
  const b = formatConditionRow(result.commands[1]);
  assert.match(b, /^test:b: metadata valid; not-run$/m);
  assert.doesNotMatch(b, /^ {2}开关:/m);
  assert.doesNotMatch(b, /^ {2}前置:/m);
  assert.doesNotMatch(b, /^ {2}说明:/m);
  assert.doesNotMatch(b, /^ {2}未知:/m);
  assert.equal(formatConditions(result), result.commands.map(formatConditionRow).join('\n'));
});
test('conditions: errors stay visible in text header while metadata renders', t => {
  const root = fixture(t);
  const base = definition();
  const result = reportConditions({ root, registry: { 'test:bad': { ...base, run: { ...base.run, nature: 'wrong' } } } });
  const row = formatConditionRow(result.commands[0]);
  assert.match(row, /^test:bad: test:bad: run\.nature 必须是数组/m);
  assert.match(row, /; not-run$/m);
});
test('conditions: batch single-dash switches render, node entries reject them', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'deploy-desktop.bat'), 'rem fixture: must never run');
  const batch = { cmd: ['deploy-desktop.bat', '-SkipBuild'], docs: 'doc.md', run: { nature: ['writes-release'], machine: ['windows'], switches: { '-SkipBuild': ['writes-source'], '-UseInstaller': ['writes-release'] }, resume: 'idempotent', evidence: 'deploy-desktop.bat:1', unknown: [] } };
  const ok = reportConditions({ root, registry: { 'deploy:fixture': batch } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.commands[0].switches['-SkipBuild'], ['writes-source']);
  assert.match(formatConditionRow(ok.commands[0]), /-SkipBuild → writes-source/);
  assert.match(formatConditionRow(ok.commands[0]), /-UseInstaller → writes-release/);
  const base = definition();
  const bad = reportConditions({ root, registry: { 'test:a': { ...base, run: { ...base.run, switches: { '-SkipBuild': ['read-only'] } } } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.commands[0].errors.some(error => error.includes('开关名必须以 -- 开头')));
});
test('conditions: illegal switch metadata is reported and copied as-is', t => {
  const root = fixture(t);
  const base = definition();
  const cases = [
    { switches: 'oops', error: 'run.switches 必须是对象' },
    { switches: { '--x': 'read-only' }, error: '开关 --x 的行为必须是数组' },
    { switches: { '--x': [] }, error: '开关 --x 的行为不能为空' },
    { switches: { '--x': ['teleport'] }, error: '开关 --x 未知行为 "teleport"' },
  ];
  for (const { switches, error } of cases) {
    const result = reportConditions({ root, registry: { 'test:a': { ...base, run: { ...base.run, switches } } } });
    assert.equal(result.ok, false);
    assert.ok(result.commands[0].errors.some(item => item.includes(error)), `missing "${error}" in ${JSON.stringify(result.commands[0].errors)}`);
    assert.deepEqual(result.commands[0].switches, switches);
  }
});
test('conditions: composite rows keep their own metadata, not children merged', t => {
  const root = fixture(t);
  const registry = {
    'test:full': { steps: ['test:a'], docs: 'doc.md', needs: 'gateway', run: { nature: ['read-only'], machine: ['node'], switches: { '--plan': ['preview'] }, resume: 'na', evidence: 'doc.md:1', unknown: [], notes: ['composite note'] } },
    'test:a': definition(),
  };
  const row = reportConditions({ root, registry }).commands.find((item: { name: string }) => item.name === 'test:full')!;
  assert.deepEqual(row.composite.steps, ['test:a']);
  assert.deepEqual(row.switches, { '--plan': ['preview'] });
  assert.deepEqual(row.notes, ['composite note']);
  assert.equal(row.needs, 'gateway');
  assert.equal(row.errors.length, 0);
});
test('conditions: --domain filtering and unknown domain rejection unchanged', t => {
  const root = fixture(t);
  const registry = { 'test:a': definition(), 'other:b': definition() };
  const filtered = reportConditions({ root, registry: registryFixture(registry), domain: 'test' });
  assert.deepEqual(filtered.commands.map(row => row.name), ['test:a']);
  assert.throws(() => reportConditions({ root, registry, domain: 'nope' }), /Unknown domain/);
});
test('conditions: main --json and text render the real registry read-only', t => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: any[]) => logs.push(args.join(' ')));
  assert.equal(main(['--json', '--domain', 'deploy']), 0);
  const parsed = JSON.parse(logs.join('\n'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.executionStatus, 'not-run');
  const deploy = parsed.commands.find((row: any) => row.name === 'deploy:desktop');
  assert.deepEqual(deploy.switches['-UseInstaller'], ['writes-release', 'delete', 'service']);
  assert.ok(Array.isArray(deploy.notes) && deploy.notes.length > 0);
  assert.equal(deploy.needs, null);
  logs.length = 0;
  assert.equal(main(['--domain', 'deploy']), 0);
  const text = logs.join('\n');
  assert.match(text, /deploy:desktop: metadata valid; not-run/);
  assert.match(text, /-UseInstaller → writes-release, delete, service/);
  assert.match(text, /^ {2}默认: writes-source, writes-product, writes-release, delete, service$/m);
  assert.match(text, /^ {2}说明: /m);
});

