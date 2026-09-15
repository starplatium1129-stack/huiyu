'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const {
  formatViolation,
  loadDebtFixture,
  loadDebtFromGitRef,
  scanRepository,
}: typeof import('./repo-hygiene-core') = require('./repo-hygiene-core');

const root = path.resolve(__dirname, '..', '..');
const debtFixture = path.join(root, 'scripts', 'fixtures', 'repo-text-hygiene-debt.json');

function mergeAllowances(...groups) {
  const entries = new Map();
  for (const group of groups) {
    for (const entry of group) entries.set(`${entry.path}\0${entry.sha256}`, entry);
  }
  return [...entries.values()];
}

test('repository text hygiene scans index, worktree, and nonignored untracked files', async () => {
  const requestedBase = String(process.env.AICS_HYGIENE_BASE_REF || '').trim();
  const baselineRef = requestedBase && !/^0+$/.test(requestedBase)
    ? requestedBase
    : process.env.CI
      ? 'HEAD^'
      : '';
  const allowances = baselineRef
    ? await loadDebtFromGitRef(root, baselineRef)
    : mergeAllowances(await loadDebtFromGitRef(root, 'HEAD'), loadDebtFixture(debtFixture));
  const result = await scanRepository(root, { allowances });
  assert.ok(result.counts.index > 0, 'the absolute Git index must contain discoverable files');
  assert.ok(result.counts.worktree > 0, 'tracked worktree files must be discoverable');
  if (result.violations.length > 0) {
    const preview = result.violations.slice(0, 40).map(formatViolation).join('\n');
    assert.fail(`${result.violations.length} repository hygiene violations (first 40):\n${preview}`);
  }
});
