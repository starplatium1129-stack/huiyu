'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const io = require('../lib/maintenance-recovery-fs');
const { previewMaintenanceRecovery, applyMaintenanceRecovery } = require('../lib/maintenance-recovery');
const { inspectMaintenanceLease, acquireMaintenanceLease, claimRecovery } = require('../lib/maintenance-lease');
const { createFixture, tree, spawnWorker } = require('./maintenance-recovery-fixture');
const { fs, path } = io;

async function crash(f) { const worker = await spawnWorker(f); await worker.stop(); return worker; }

for (const target of ['backup-directory', 'backup-file-hardlink', 'target-hardlink', 'plan-link']) {
  test('rejects ' + target + ' without changing source or outside bytes', async () => {
    const f = createFixture();
    try {
      const worker = await crash(f);
      const plan = previewMaintenanceRecovery(f.options);
      if (target === 'backup-directory') {
        const outside = path.join(f.base, 'outside-backup');
        fs.renameSync(worker.message.backup, outside);
        fs.symlinkSync(outside, worker.message.backup, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (target === 'backup-file-hardlink') fs.linkSync(path.join(worker.message.backup, 'files/00000.bin'), path.join(f.base, 'linked-blob'));
      if (target === 'target-hardlink') fs.linkSync(f.files[0], path.join(f.base, 'linked-target'));
      if (target === 'plan-link') {
        const source = path.join(f.base, 'plan.json');
        fs.writeFileSync(source, JSON.stringify(plan));
        fs.linkSync(source, path.join(f.base, 'plan-alias.json'));
        const before = tree(f.base);
        assert.throws(() => io.readJson(path.join(f.base, 'plan-alias.json')), { code: 'MAINTENANCE_PATH' });
        assert.deepEqual(tree(f.base), before);
      } else {
        const before = tree(f.base);
        assert.equal(previewMaintenanceRecovery(f.options).executable, false);
        assert.throws(() => applyMaintenanceRecovery(f.options, plan));
        assert.deepEqual(tree(f.base), before);
      }
    } finally { f.cleanup(); }
  });
}

test('explicit showcase root recovers only listed external files; omission and a replacement root are refused', async () => {
  const f = createFixture();
  try {
    const showcaseRoot = path.join(f.base, 'showcase');
    fs.mkdirSync(path.join(showcaseRoot, 'images'), { recursive: true });
    const manifest = path.join(showcaseRoot, 'manifest.json');
    const image = path.join(showcaseRoot, 'images/sc001.jpg');
    const unrelated = path.join(showcaseRoot, 'images/unrelated.jpg');
    fs.writeFileSync(manifest, '{"entries":[]}\r\n');
    fs.writeFileSync(image, 'neutral original image bytes');
    fs.writeFileSync(unrelated, 'unrelated image bytes');
    const original = tree(showcaseRoot);
    f.options = { ...f.options, showcaseRoot, additionalFiles: [manifest, image] };
    await crash(f);
    const omitted = { rootDir: f.options.rootDir, runtimeRoot: f.options.runtimeRoot };
    assert.equal(previewMaintenanceRecovery(omitted).executable, false);
    const plan = previewMaintenanceRecovery(f.options);
    assert.equal(plan.executable, true, JSON.stringify(plan.conflicts));
    const replaced = path.join(f.base, 'old-showcase');
    fs.renameSync(showcaseRoot, replaced);
    fs.cpSync(replaced, showcaseRoot, { recursive: true });
    assert.equal(previewMaintenanceRecovery(f.options).executable, false, 'same path and bytes do not authorize a different external root identity');
    fs.rmSync(showcaseRoot, { recursive: true });
    fs.renameSync(replaced, showcaseRoot);
    const result = applyMaintenanceRecovery(f.options, plan);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(tree(showcaseRoot), original);
  } finally { f.cleanup(); }
});

test('unlisted backup ID and root traversal never select arbitrary backups', async () => {
  const f = createFixture();
  try {
    await crash(f);
    for (const backupId of ['../../other', '/absolute', 'another-transaction']) {
      const before = tree(f.base);
      assert.equal(previewMaintenanceRecovery({ ...f.options, backupId }).executable, false);
      assert.deepEqual(tree(f.base), before);
    }
    const plan = previewMaintenanceRecovery(f.options);
    const other = createFixture();
    try { assert.throws(() => applyMaintenanceRecovery(other.options, plan)); }
    finally { other.cleanup(); }
  } finally { f.cleanup(); }
});

test('a real live recovery claim cannot be stolen by another recovery attempt', async () => {
  const f = createFixture();
  try {
    await crash(f);
    const plan = previewMaintenanceRecovery(f.options);
    const owner = claimRecovery(f.options, plan.journalSha256);
    const before = tree(f.base);
    assert.equal(inspectMaintenanceLease(f.options).status, 'active');
    assert.throws(() => acquireMaintenanceLease(f.options), { code: 'MAINTENANCE_BUSY' });
    assert.throws(() => applyMaintenanceRecovery(f.options, plan));
    assert.deepEqual(tree(f.base), before);
    owner.finish();
    assert.equal(applyMaintenanceRecovery(f.options, previewMaintenanceRecovery(f.options)).ok, true);
  } finally { f.cleanup(); }
});
