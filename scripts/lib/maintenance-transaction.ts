import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

const io: typeof import('./maintenance-recovery-fs') = require('./maintenance-recovery-fs');
const backups: typeof import('./maintenance-recovery-backup') = require('./maintenance-recovery-backup');
type Lease = ReturnType<typeof import('./maintenance-lease').acquireMaintenanceLease>;
type ContextOptions = Parameters<typeof io.context>[0];

function prepareMaintenanceTransaction(lease: Lease, options: ContextOptions, snapshot: ReturnType<typeof io.snapshotFiles>, label = 'content') {
  lease.assertOwned();
  const ctx = io.context(options);
  for (const item of snapshot) {
    const expected = { exists: item.exists, sha256: item.exists ? io.digest(item.content) : null, size: item.exists ? item.content.length : 0 };
    if (!io.equal(io.fileState(io.targetPath(ctx, item.file)), expected)) throw io.failure('MAINTENANCE_CONFLICT', '快照准备后文件已变化：' + item.file);
  }
  const directory = backups.saveSnapshotBackup(snapshot, ctx.backupRoot, label, options);
  lease.setBackup(directory);
  return directory;
}
function commitMaintenanceTransaction(lease: Lease) {
  lease.complete('committed');
  lease.release();
}
function rollbackMaintenanceTransaction(lease: Lease | null | undefined, options: ContextOptions) {
  if (!lease) return { ok: true };
  try {
    const journal = lease.assertOwned();
    if (journal.backup) {
      lease.beginRollback();
      const backup = backups.readBackup(options, journal.backup.id, journal.backup.sha256);
      backups.restoreEntries(options, backup.entries, lease.assertOwned);
      lease.complete('rolled-back');
    }
    lease.release();
    return { ok: true };
  } catch (error) {
    try { lease.markInconsistent(runtimeErrorMessage(error)); } catch { /* A lost or damaged lease stays blocked. */ }
    return { ok: false, error: runtimeErrorMessage(error), dataIntegrity: 'INCONSISTENT' };
  }
}
export = { prepareMaintenanceTransaction, commitMaintenanceTransaction, rollbackMaintenanceTransaction };
