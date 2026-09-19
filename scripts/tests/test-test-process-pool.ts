import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runTestProcessPool } from '../lib/test-process-pool';
import policy = require('./contract-test-policy');
import inventory = require('./quality-test-inventory');
const { CONTRACT_ISOLATION, contractJobs, planContractTests } = policy;
const { QUALITY_TEST_SUITES } = inventory;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-test-pool-'));
  const file = path.join(root, 'worker.cjs');
  fs.writeFileSync(file, `
const fs = require('node:fs'), path = require('node:path');
const [root, name, mode] = process.argv.slice(2);
fs.writeFileSync(path.join(root, name + '.started'), String(process.pid));
if (mode === 'fail') process.exit(7);
if (mode === 'output') { process.stdout.write('x'.repeat(4096)); process.exit(0); }
if (mode === 'tree') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true });
  fs.writeFileSync(path.join(root, name + '.child'), String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'wait') {
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(root, 'release'))) { clearInterval(timer); fs.writeFileSync(path.join(root, name + '.done'), 'done'); }
  }, 10);
} else fs.writeFileSync(path.join(root, name + '.done'), 'done');
`);
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, entry: (name: string, mode = 'done') => ({ name, file, args: [root, name, mode] }), exists: (name: string) => fs.existsSync(path.join(root, name)), release: () => fs.writeFileSync(path.join(root, 'release'), '') };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await delay(10); }
}

test('bounded concurrency runs every selected process once and waits for active owners', async t => {
  const f = fixture(t);
  const pending = runTestProcessPool([f.entry('one', 'wait'), f.entry('two', 'wait'), f.entry('three')], { cwd: f.root, jobs: 2, timeoutMs: 7000 });
  await until(() => f.exists('one.started') && f.exists('two.started'));
  assert.equal(f.exists('three.started'), false);
  f.release();
  const run = await pending;
  assert.equal(run.skipped, 0);
  assert.equal(run.results.length, 3);
  assert.ok(run.results.every(r => r.ok));
  assert.equal(new Set(run.results.map(r => r.name)).size, 3);
});
test('fail-fast stops new dispatch but lets an active fixture settle', async t => {
  const f = fixture(t);
  let failed = false;
  const pending = runTestProcessPool([f.entry('bad', 'fail'), f.entry('active', 'wait'), f.entry('unstarted')], {
    cwd: f.root, jobs: 2, timeoutMs: 7000, onResult: r => { if (!r.ok) failed = true; },
  });
  await until(() => failed && f.exists('active.started'));
  assert.equal(f.exists('unstarted.started'), false);
  f.release();
  const run = await pending;
  assert.equal(run.skipped, 1);
  assert.equal(run.results.find(r => r.name === 'bad')?.reason, 'exit 7');
  assert.ok(f.exists('active.done'));
});
test('--all keeps failures fatal while executing the rest', async t => {
  const f = fixture(t);
  const run = await runTestProcessPool([f.entry('bad', 'fail'), f.entry('next')], { cwd: f.root, jobs: 1, timeoutMs: 5000, keepGoing: true });
  assert.equal(run.skipped, 0);
  assert.deepEqual(run.results.map(r => r.ok), [false, true]);
});
test('timeout terminates an owned descendant and never reports success', async t => {
  const f = fixture(t);
  const run = await runTestProcessPool([f.entry('hung', 'tree')], { cwd: f.root, jobs: 1, timeoutMs: 1500 });
  assert.match(run.results[0].reason, /^TIMEOUT/);
  const pid = Number(fs.readFileSync(path.join(f.root, 'hung.child'), 'utf8'));
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});
test('abort kills the active owner and skips queued work', async t => {
  const f = fixture(t), controller = new AbortController();
  const pending = runTestProcessPool([f.entry('active', 'wait'), f.entry('next')], { cwd: f.root, jobs: 1, timeoutMs: 7000, signal: controller.signal });
  await until(() => f.exists('active.started'));
  controller.abort();
  const run = await pending;
  assert.equal(run.results[0].reason, 'INTERRUPTED');
  assert.equal(run.skipped, 1);
  assert.equal(run.interrupted, true);
});
test('output overflow and spawn errors are bounded failures', async t => {
  const f = fixture(t);
  const overflow = await runTestProcessPool([f.entry('large', 'output')], { cwd: f.root, jobs: 1, timeoutMs: 5000, maxOutputBytes: 64 });
  assert.match(overflow.results[0].reason, /^OUTPUT_LIMIT/);
  assert.equal(Buffer.byteLength(overflow.results[0].output), 64);
  const missing = await runTestProcessPool([f.entry('missing')], { cwd: path.join(f.root, 'missing'), jobs: 1, timeoutMs: 5000 });
  assert.equal(missing.results[0].ok, false);
});
test('unknown contracts stay serial; jobs=1 preserves order and inventory is unchanged', () => {
  const files = [...QUALITY_TEST_SUITES.contract, 'unknown-new-test.js'];
  const plan = planContractTests(files, 2);
  assert.deepEqual([...plan.parallel, ...plan.serial].sort(), [...files].sort());
  assert.ok(plan.serial.includes('unknown-new-test.js'));
  assert.deepEqual(planContractTests(files, 1), { parallel: [], serial: files });
  for (const name of Object.keys(CONTRACT_ISOLATION)) assert.ok(QUALITY_TEST_SUITES.contract.includes(name));
  for (const invalid of ['0', '5', '', 'NaN', '2.5', '2x']) assert.throws(() => contractJobs(invalid));
});
