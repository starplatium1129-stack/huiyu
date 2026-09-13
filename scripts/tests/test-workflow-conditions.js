'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reportConditions, main } = require('../maintenance/report-workflow-conditions');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-conditions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/entry.js'), 'throw new Error("must not run")');
  fs.writeFileSync(path.join(root, 'doc.md'), 'fixture');
  return root;
}
const definition = () => ({ cmd: ['node', 'scripts/entry.js'], docs: 'doc.md', run: { nature: ['read-only'], machine: ['node'], resume: 'na', evidence: 'scripts/entry.js:1', unknown: [] } });
test('conditions: reports metadata without executing entry', t => {
  const result = reportConditions({ root: fixture(t), registry: { 'test:a': definition() }, domain: 'test' });
  assert.equal(result.ok, true); assert.equal(result.commands[0].executionStatus, 'not-run');
});
test('conditions: missing entry, docs and malformed metadata fail closed', t => {
  const root = fixture(t);
  for (const override of [{ cmd: ['node', 'scripts/missing.js'] }, { docs: 'missing.md' }, { run: { nature: 'wrong' } }]) {
    assert.equal(reportConditions({ root, registry: { 'test:a': { ...definition(), ...override } } }).ok, false);
  }
});
test('conditions: nested composite effects and missing steps are detected', t => {
  const root = fixture(t), registry = { 'test:a': { ...definition(), steps: ['test:b'] }, 'test:b': { ...definition(), steps: ['test:c'] }, 'test:c': definition() };
  registry['test:c'].run.nature = ['writes-source'];
  assert.deepEqual(reportConditions({ root, registry }).commands[0].composite.missingEffects, ['writes-source']);
  registry['test:b'].steps = ['missing'];
  assert.equal(reportConditions({ root, registry }).ok, false);
});
test('conditions: help and plan never spawn or inspect root', t => {
  const cp = require('node:child_process');
  for (const method of ['spawnSync', 'spawn', 'execSync', 'execFileSync']) t.mock.method(cp, method, () => assert.fail('child process'));
  for (const flag of ['--help', '--plan']) assert.equal(main([flag, '--root', 'missing-root']), 0);
});
