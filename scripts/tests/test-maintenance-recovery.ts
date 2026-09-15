'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { spawnSync, spawn, fork }: typeof import('node:child_process') = require('node:child_process');
const { once }: typeof import('node:events') = require('node:events');
const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
const { acquireMaintenanceLease, inspectMaintenanceLease, assertMaintenanceReadable, pidStatus }: typeof import('../lib/maintenance-lease') = require('../lib/maintenance-lease');
const { previewMaintenanceRecovery, applyMaintenanceRecovery }: typeof import('../lib/maintenance-recovery') = require('../lib/maintenance-recovery');
const { prepareMaintenanceTransaction, rollbackMaintenanceTransaction }: typeof import('../lib/maintenance-transaction') = require('../lib/maintenance-transaction');
const { runMaintenanceNode }: typeof import('../lib/maintenance-transaction-process') = require('../lib/maintenance-transaction-process');
const { createFixture, tree, spawnWorker }: typeof import('./maintenance-recovery-fixture') = require('./maintenance-recovery-fixture');
const { fs, path } = io;

async function crashed(fixture: any, mode = 'hold') {
  const worker = await spawnWorker(fixture, mode);
  assert.equal(worker.message.status, 'ready');
  await worker.stop();
  assert.equal(inspectMaintenanceLease(fixture.options).status, 'stale');
  return worker;
}
const recover = (fixture: any) => applyMaintenanceRecovery(fixture.options, previewMaintenanceRecovery(fixture.options));

test('free inspection and preview create no runtime; PID/nonce prevent reentry', () => {
  const f = createFixture();
  try {
    const before = tree(f.base);
    assertMaintenanceReadable(f.options);
    assert.equal(previewMaintenanceRecovery(f.options).executable, false);
    assert.deepEqual(tree(f.base), before);
    const lease = acquireMaintenanceLease(f.options);
    assert.equal(inspectMaintenanceLease(f.options).status, 'active');
    assert.throws(() => acquireMaintenanceLease(f.options), { code: 'MAINTENANCE_BUSY' });
    assert.throws(() => acquireMaintenanceLease({ ...f.options, runtimeRoot: path.join(f.base, 'another-runtime') }));
    assert.throws(() => assertMaintenanceReadable(f.options));
    assert.equal(previewMaintenanceRecovery(f.options).executable, false);
    lease.release();
    assert.equal(inspectMaintenanceLease(f.options).status, 'free');
  } finally { f.cleanup(); }
});

test('same PID with a different real lease nonce is never removed by the old handle', () => {
  const f = createFixture();
  try {
    const old = acquireMaintenanceLease(f.options);
    const ctx = io.context(f.options);
    fs.renameSync(ctx.leaseDir, path.join(ctx.stateDir, 'test-old-lease'));
    const fresh = acquireMaintenanceLease(f.options);
    assert.notEqual(old.nonce, fresh.nonce);
    assert.throws(() => old.release(), { code: 'MAINTENANCE_CONFLICT' });
    assert.equal(inspectMaintenanceLease(f.options).journal.nonce, fresh.nonce);
    fresh.release();
  } finally { f.cleanup(); }
});

test('two real processes race: exactly one writes; SIGKILL recovery restores all original bytes', async () => {
  const f = createFixture();
  const original = tree(f.options.rootDir, true);
  const workers = [];
  try {
    workers.push(...await Promise.all([spawnWorker(f), spawnWorker(f)]));
    assert.deepEqual(workers.map(worker => worker.message.status).sort(), ['blocked', 'ready']);
    const live = workers.find(worker => worker.message.status === 'ready');
    const before = tree(f.base);
    const blocked = previewMaintenanceRecovery(f.options);
    assert.equal(blocked.executable, false);
    assert.deepEqual(tree(f.base), before);
    await live.stop();
    fs.writeFileSync(path.join(f.options.rootDir, 'data/scenes/unrelated-new.json'), 'keep unrelated new bytes');
    const snapshot = tree(f.base);
    const plan = previewMaintenanceRecovery(f.options);
    assert.equal(plan.executable, true, JSON.stringify(plan.conflicts));
    assert.deepEqual(tree(f.base), snapshot, 'preview is zero-write');
    const result = applyMaintenanceRecovery(f.options, plan);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.undoBackup);
    assert.equal(inspectMaintenanceLease(f.options).status, 'free');
    const expected = { ...original, 'data/scenes/unrelated-new.json': io.digest('keep unrelated new bytes') };
    assert.deepEqual(tree(f.options.rootDir, true), expected);
    const next = acquireMaintenanceLease(f.options);
    next.release();
  } finally { for (const worker of workers) await worker.stop(); f.cleanup(); }
});

for (const mode of ['exit', 'preparing', 'committed', 'rolled-back']) {
  test('real process termination in phase ' + mode + ' has deterministic recovery', async () => {
    const f = createFixture();
    try {
      const original = tree(f.options.rootDir, true);
      const worker = await spawnWorker(f, mode);
      const after = tree(f.options.rootDir, true);
      if (mode === 'exit') await worker.closed;
      else await worker.stop();
      const result = recover(f);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(tree(f.options.rootDir, true), mode === 'committed' ? after : original);
      assert.equal(inspectMaintenanceLease(f.options).status, 'free');
    } finally { f.cleanup(); }
  });
}

test('current-byte conflict and altered plan reject before any writes', async () => {
  const f = createFixture();
  try {
    await crashed(f);
    const plan = previewMaintenanceRecovery(f.options);
    const altered = structuredClone(plan);
    altered.entries.push({ source: path.join(f.options.rootDir, 'data/unrelated.json'), current: {} });
    const before = tree(f.base);
    assert.throws(() => applyMaintenanceRecovery(f.options, altered));
    assert.deepEqual(tree(f.base), before);
    fs.writeFileSync(f.files[4], 'concurrent external edit');
    const edited = tree(f.base);
    assert.throws(() => applyMaintenanceRecovery(f.options, plan), { code: 'MAINTENANCE_CONFLICT' });
    assert.deepEqual(tree(f.base), edited);
    assert.equal(recover(f).ok, true);
  } finally { f.cleanup(); }
});

for (const corruption of ['journal', 'manifest', 'blob', 'unknown-file', 'legacy']) {
  test('rejects ' + corruption + ' corruption without source or metadata writes', async () => {
    const f = createFixture();
    try {
      const worker = await crashed(f);
      const backup = worker.message.backup;
      if (corruption === 'journal') fs.writeFileSync(path.join(io.context(f.options).leaseDir, 'journal.json'), '{broken');
      if (corruption === 'manifest') fs.appendFileSync(path.join(backup, 'manifest.json'), 'tampered');
      if (corruption === 'blob') fs.writeFileSync(path.join(backup, 'files/00000.bin'), 'tampered');
      if (corruption === 'unknown-file') fs.writeFileSync(path.join(backup, 'files/extra.bin'), 'unknown');
      if (corruption === 'legacy') fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ files: [{ source: f.files[0], existed: true, backup: '00000.bin' }] }));
      const before = tree(f.base);
      assert.equal(previewMaintenanceRecovery(f.options).executable, false);
      assert.throws(() => assertMaintenanceReadable(f.options));
      assert.deepEqual(tree(f.base), before);
    } finally { f.cleanup(); }
  });
}

test('junction on a target ancestor is rejected; outside and unrelated bytes survive', async () => {
  const f = createFixture();
  try {
    await crashed(f);
    const directory = path.join(f.options.rootDir, 'data/scenes');
    const moved = path.join(f.base, 'outside');
    fs.renameSync(directory, moved);
    fs.symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
    const before = tree(f.base);
    assert.equal(previewMaintenanceRecovery(f.options).executable, false);
    assert.deepEqual(tree(f.base), before);
    fs.unlinkSync(directory);
    fs.renameSync(moved, directory);
    assert.equal(recover(f).ok, true);
  } finally { f.cleanup(); }
});

test('one recovery write fails: undo backup restores the pre-recovery bytes', async () => {
  const f = createFixture();
  const rename = fs.renameSync;
  try {
    await crashed(f);
    const before = tree(f.options.rootDir, true);
    const plan = previewMaintenanceRecovery(f.options);
    let injected = false;
    fs.renameSync = (source, target) => {
      if (!injected && target === f.files[2]) { injected = true; throw new Error('fixture: disk write failed'); }
      return rename(source, target);
    };
    const result = applyMaintenanceRecovery(f.options, plan);
    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true, JSON.stringify(result));
    assert.equal(result.dataIntegrity, 'pre-recovery-restored');
    assert.deepEqual(tree(f.options.rootDir, true), before);
    fs.renameSync = rename;
    assert.equal(recover(f).ok, true);
  } finally { fs.renameSync = rename; f.cleanup(); }
});

test('rollback write failure is reported INCONSISTENT and preserves the recovery barrier', async () => {
  const f = createFixture();
  const rename = fs.renameSync;
  try {
    await crashed(f);
    const plan = previewMaintenanceRecovery(f.options);
    let initialRestored = false;
    fs.renameSync = (source, target) => {
      if (target === f.files[2] || (target === f.files[0] && initialRestored)) throw new Error('fixture: persistent disk fault');
      const result = rename(source, target);
      if (target === f.files[0]) initialRestored = true;
      return result;
    };
    const result = applyMaintenanceRecovery(f.options, plan);
    assert.equal(result.ok, false);
    assert.equal(result.dataIntegrity, 'INCONSISTENT');
    assert.equal(result.rolledBack, false);
    assert.throws(() => assertMaintenanceReadable(f.options));
    fs.renameSync = rename;
    assert.equal(recover(f).ok, true);
  } finally { fs.renameSync = rename; f.cleanup(); }
});

test('SIGKILL during recovery leaves a journal that a second recovery can resume', async () => {
  const f = createFixture();
  try {
    const original = tree(f.options.rootDir, true);
    await crashed(f);
    const planFile = path.join(f.options.rootDir, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(previewMaintenanceRecovery(f.options)));
    const child = fork(path.join(__dirname, 'maintenance-recovery-worker.js'), ['recover-crash', JSON.stringify(f.options)], { silent: true });
    const [code, signal] = await once(child, 'exit');
    assert.ok(code !== 0 || signal);
    assert.equal(inspectMaintenanceLease(f.options).journal.phase, 'recovering');
    assert.throws(() => assertMaintenanceReadable(f.options));
    assert.equal(recover(f).ok, true);
    fs.unlinkSync(planFile);
    assert.deepEqual(tree(f.options.rootDir, true), original);
  } finally { f.cleanup(); }
});

test('a real registered writer surviving owner SIGKILL prevents recovery until it exits', async () => {
  const f = createFixture();
  // A sibling avoids Windows Job Object teardown killing every descendant together.
  const participant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const closed = once(participant, 'exit');
  try {
    await once(participant, 'spawn');
    f.options.participantPid = participant.pid;
    const worker = await spawnWorker(f, 'participant');
    const pid = worker.message.participant;
    await worker.stop();
    assert.equal(pidStatus(pid), 'alive');
    assert.equal(inspectMaintenanceLease(f.options).status, 'active');
    assert.equal(previewMaintenanceRecovery(f.options).executable, false);
    participant.kill('SIGKILL');
    await closed;
    assert.equal(pidStatus(pid), 'dead');
    assert.equal(recover(f).ok, true);
  } finally { if (participant.exitCode === null && participant.signalCode === null) participant.kill('SIGKILL'); await closed; f.cleanup(); }
});

test('gated child runs as main only after durable PID registration; timeout waits for exit', async () => {
  const f = createFixture();
  try {
    const script = path.join(f.options.rootDir, 'fixture-child.js');
    const lease = acquireMaintenanceLease(f.options);
    const snapshot = io.snapshotFiles(f.files);
    prepareMaintenanceTransaction(lease, f.options, snapshot);
    fs.writeFileSync(script, "const fs = require('node:fs'); const path = require('node:path'); const root = process.env.AICS_DATA_ROOT; const journal = JSON.parse(fs.readFileSync(path.join(root, 'runtime/maintenance-transactions/lease/journal.json'))); if (require.main !== module || !journal.participants.some(p => p.pid === process.pid && p.state === 'running')) process.exit(82); fs.writeFileSync(path.join(root, 'data/scenes/group.json'), 'child-write');");
    const run = (args: any) => runMaintenanceNode(script, args, 300, { rootDir: f.options.rootDir, repoRoot: f.options.rootDir, lease });
    assert.equal((await run([])).status, 0);
    fs.appendFileSync(script, 'setInterval(() => {}, 1000);');
    await assert.rejects(() => run([]), /超时/);
    assert.ok(lease.assertOwned().participants.every((item: any) => item.state === 'exited'));
    assert.equal(rollbackMaintenanceTransaction(lease, f.options).ok, true);
    assert.equal(fs.readFileSync(f.files[0], 'utf8'), snapshot[0].content.toString());
  } finally { f.cleanup(); }
});

test('CLI defaults to zero-write preview and requires explicit apply plus plan', async () => {
  const f = createFixture();
  try {
    await crashed(f);
    const cli = path.resolve(__dirname, '../maintenance/recover-maintenance.js');
    const before = tree(f.base);
    const preview = spawnSync(process.execPath, [cli, '--root', f.options.rootDir], { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.deepEqual(tree(f.base), before);
    const planFile = path.join(f.base, 'plan.json');
    fs.writeFileSync(planFile, preview.stdout);
    assert.equal(spawnSync(process.execPath, [cli, '--root', f.options.rootDir, '--apply'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [cli, '--root', f.options.rootDir, '--recovery-plan', planFile], { encoding: 'utf8' }).status, 2);
    const described = spawnSync(process.execPath, [cli, '--root', f.options.rootDir, '--apply', '--recovery-plan', planFile, '--plan'], { encoding: 'utf8' });
    assert.equal(described.status, 0, described.stderr);
    assert.match(described.stdout, /description only/);
    assert.deepEqual(tree(f.base), { ...before, 'plan.json': io.digest(preview.stdout) });
    const applied = spawnSync(process.execPath, [cli, '--root', f.options.rootDir, '--apply', '--recovery-plan', planFile], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(JSON.parse(applied.stdout).ok, true);
  } finally { f.cleanup(); }
});

test('CLI --help and bare --plan do not inspect targets even with apply arguments', () => {
  const { main }: typeof import('../maintenance/recover-maintenance') = require('../maintenance/recover-maintenance');
  const operations = ['readFileSync', 'lstatSync', 'statSync', 'realpathSync', 'openSync', 'mkdirSync', 'renameSync'];
  const originals = new Map(operations.map(name => [name, fs[name]]));
  const stdout = process.stdout.write;
  let output = '';
  let accessed = false;
  try {
    for (const name of operations) fs[name] = () => { accessed = true; throw new Error('CLI description accessed filesystem: ' + name); };
    process.stdout.write = text => { output += text; return true; };
    for (const flag of ['--help', '--plan']) {
      assert.equal(main([flag]), 0);
      assert.equal(main(['--root', 'nonexistent-root', '--runtime-root', 'nonexistent-runtime', '--showcase-root', 'nonexistent-showcase',
        '--apply', '--recovery-plan', 'nonexistent-plan.json', flag]), 0);
    }
    assert.equal(accessed, false);
    assert.match(output, /--recovery-plan/);
    assert.match(output, /no operation is executed/);
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    process.stdout.write = stdout;
  }
});
