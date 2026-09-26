import assert = require('node:assert/strict');
import path = require('node:path');
import fs = require('node:fs');
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { inspectModuleBoundaries, DOMAIN_TYPE_ROOTS } from '../lib/domain-type-boundaries';
import { inspectRefactorBoundaries, checkRefactorAllowlist, type RefactorAllowance } from '../lib/refactor-boundaries';
import { readRefactorAllowancesAtRef, refactorAllowanceRefs, REFACTOR_ALLOWLIST_PATH, type RefactorSeed } from '../lib/refactor-allowlist';

const root = path.resolve(__dirname, '../..');

test('artwork types and save use case stay independent of state and infrastructure', () => {
  const application = inspectRefactorBoundaries(root).files.filter(file => file.startsWith('src/application/'));
  const report = inspectModuleBoundaries(root, [...DOMAIN_TYPE_ROOTS, ...application]);
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(report.violations, [], 'domain dependency violations');
  assert.deepEqual(report.unknown, [], 'unresolved/excluded imports require an explicit decision');
  assert.deepEqual(report.runtimeCycles, [], 'runtime dependency cycles');
});

test('R0 dependency debt only shrinks from its sealed seed and approved Git history', () => {
  const seed: RefactorSeed = JSON.parse(fs.readFileSync(path.join(__dirname, 'refactor-boundary-seed.json'), 'utf8'));
  // The initial graph is review evidence, not an automatically renewable allowance budget.
  assert.equal(createHash('sha256').update(JSON.stringify(seed)).digest('hex'), 'cc6bee8f05ea2c501de66734871e5ff851d535bfbd06e58a069d4dbda9f129ee');
  const allowances: RefactorAllowance[] = JSON.parse(fs.readFileSync(path.join(root, REFACTOR_ALLOWLIST_PATH), 'utf8'));
  const report = inspectRefactorBoundaries(root);
  assert.deepEqual(report.unknown, [], 'unresolved imports must not evade R0 dependency rules');
  assert.deepEqual(checkRefactorAllowlist(report.violations, allowances, seed.entries), [], 'sealed R0 ceiling');
  for (const ref of refactorAllowanceRefs(process.env.AICS_HYGIENE_BASE_REF)) {
    const approved = readRefactorAllowancesAtRef(root, ref, seed);
    assert.deepEqual(checkRefactorAllowlist(report.violations, allowances, approved), [], `ratchet against ${ref}`);
  }
  console.log(`R0: ${report.files.length} production sources, ${report.edges.length} imports, ${allowances.length} exact legacy edges; no new violations`);
});
