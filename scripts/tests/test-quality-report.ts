import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, writeQualityReport } from './quality-report';
const { runSuiteFiles }: typeof import('./run-quality-suite') = require('./run-quality-suite');
const { qualityTestMetadata }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');

test('failure diagnostics distinguish assertions, environment, compiler, build and outer timeout', () => {
  const failed = { status: 1 };
  assert.equal(classifyFailure(failed, 'AssertionError [ERR_ASSERTION]'), 'assertion');
  assert.equal(classifyFailure(failed, 'error TS2322: bad type'), 'typecheck');
  assert.equal(classifyFailure(failed, 'Build failed'), 'build');
  assert.equal(classifyFailure(failed, 'ERR_MODULE_NOT_FOUND'), 'environment');
  assert.equal(classifyFailure({ status: null, error: { code: 'ETIMEDOUT' } }, 'ERR_ASSERTION'), 'timeout');
  assert.equal(classifyFailure({ status: 0 }, 'all good'), undefined);
  assert.equal(qualityTestMetadata('unreviewed.js').parallelSafety, 'unreviewed');
});

test('runner preserves fail-fast not-run and explicit single-file timeout in machine-readable logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-quality-report-'));
  const previous = process.env.AICS_TEST_REPORT_DIR;
  try {
    const hang = path.join(root, 'hang.cjs');
    const passed = path.join(root, 'passed.cjs');
    fs.writeFileSync(hang, 'setTimeout(() => {}, 60000)');
    fs.writeFileSync(passed, 'console.log("fixture passed")');
    process.env.AICS_TEST_REPORT_DIR = root;
    assert.equal(runSuiteFiles([{ name: 'hang', file: hang, timeoutMs: 150 }, { name: 'later', file: passed }], { label: 'fixture', timeout: 5000 }), 1);
    const report = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root).find(f => f.endsWith('.json'))!), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.results[0].failureKind, 'timeout');
    assert.equal(report.results[0].timeoutMs, 150);
    assert.equal(report.results[1].status, 'not-run');
    assert.equal(fs.existsSync(path.join(root, report.logFile)), true);
    const targeted = writeQualityReport('targeted-retest', [{ name: 'later', status: 'passed', duration: 1 }], 1, root)!;
    assert.equal(JSON.parse(fs.readFileSync(targeted, 'utf8')).results.length, 1);
  } finally {
    if (previous === undefined) delete process.env.AICS_TEST_REPORT_DIR;
    else process.env.AICS_TEST_REPORT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('the existing contract pool honors per-file timeout and retains structured failure facts', async () => {
  const { runTestProcessPool }: typeof import('../lib/test-process-pool') = require('../lib/test-process-pool');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-quality-pool-'));
  try {
    const file = path.join(root, 'slow.cjs');
    fs.writeFileSync(file, 'setTimeout(() => {}, 60000)');
    const run = await runTestProcessPool([{ name: 'slow', file, timeoutMs: 75 }, { name: 'not-run', file }], { cwd: root, jobs: 1, timeoutMs: 5000 });
    assert.equal(run.results[0].timedOut, true);
    assert.equal(run.results[0].reason, 'TIMEOUT(75ms)');
    assert.equal(run.skipped, 1);
    assert.equal(qualityTestMetadata('test-maintenance-blueprint-transaction.js').parallelSafety, 'isolated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
