import assert = require('node:assert/strict');
import path = require('node:path');
import { test } from 'node:test';
import { inspectModuleBoundaries } from '../lib/domain-type-boundaries';

test('migrated artwork/generation types stay independent of state and presentation', () => {
  const report = inspectModuleBoundaries(path.resolve(__dirname, '../..'));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(report.violations, [], 'domain dependency violations');
  assert.deepEqual(report.unknown, [], 'unresolved/excluded imports require an explicit decision');
  assert.deepEqual(report.runtimeCycles, [], 'runtime dependency cycles');
});
