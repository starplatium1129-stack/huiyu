import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

const io: typeof import('./maintenance-recovery-fs') = require('./maintenance-recovery-fs');
const { inspectMaintenanceLease, claimRecovery }: typeof import('./maintenance-lease') = require('./maintenance-lease');
const { readBackup, saveSnapshotBackup, restoreEntries }: typeof import('./maintenance-recovery-backup') = require('./maintenance-recovery-backup');

function previewMaintenanceRecovery(options) {
  const ctx = io.context(options);
  const state = inspectMaintenanceLease(options);
  const conflicts = [];
  if (state.status !== 'stale') conflicts.push({ code: state.status === 'active' ? 'MAINTENANCE_BUSY' : state.status === 'free' ? 'MAINTENANCE_NO_TRANSACTION' : 'MAINTENANCE_INVALID_JOURNAL', message: state.error || '恢复只允许已确认退出的事务' });
  const journal = state.journal;
  let backup = null;
  if (journal?.backup && state.status === 'stale') {
    try {
      backup = readBackup(options, journal.backup.id, journal.backup.sha256);
      if (options.backupId && options.backupId !== backup.id) throw io.failure('MAINTENANCE_CONFLICT', '所选备份不属于被恢复的事务');
    } catch (error) { conflicts.push({ code: runtimeErrorCode(error), message: runtimeErrorMessage(error) }); }
  } else if (options.backupId && options.backupId !== journal?.backup?.id) conflicts.push({ code: 'MAINTENANCE_CONFLICT', message: '备份与当前事务不匹配' });
  const terminal = journal && ['committed', 'rolled-back', 'recovered'].includes(journal.phase);
  const entries = [];
  for (const item of backup?.entries || []) {
    try {
      const current = io.fileState(item.file);
      const savedFinal = terminal ? journal.final?.find(entry => entry.source === item.file) : null;
      const desired = terminal ? savedFinal && { exists: savedFinal.exists, sha256: savedFinal.sha256, size: savedFinal.size } : item.expected;
      if (!desired || (terminal && !io.equal(current, desired))) conflicts.push({ code: 'MAINTENANCE_CONFLICT', message: '已完成事务的最终文件发生漂移：' + item.file });
      entries.push({ source: item.file, current, desired, action: terminal ? 'keep' : !item.exists ? 'remove-if-present' : 'restore' });
    } catch (error) { conflicts.push({ code: runtimeErrorCode(error), message: runtimeErrorMessage(error) }); }
  }
  if (journal && !journal.backup && journal.phase !== 'preparing' && !(journal.phase === 'recovered' && journal.noMutation)) conflicts.push({ code: 'MAINTENANCE_INVALID_JOURNAL', message: '事务缺少备份' });
  const plan = { schemaVersion: 1, kind: 'maintenance-recovery-plan', root: ctx.root, runtimeRoot: ctx.runtimeRoot,
    runtimeIdentity: io.safePath(ctx.runtimeRoot, 'directory') ? io.directoryIdentity(ctx.runtimeRoot) : null,
    showcaseIdentity: ctx.showcaseRoot ? io.directoryIdentity(ctx.showcaseRoot) : null,
    showcaseRoot: ctx.showcaseRoot, transactionId: journal?.nonce || null, journalSha256: state.journalSha256 || null,
    backupId: journal?.backup?.id || null, backupSha256: journal?.backup?.sha256 || null,
    action: terminal ? 'release-completed' : backup ? 'restore' : 'release-unstarted', entries, conflicts,
    executable: conflicts.length === 0, leaseStatus: state.status };
  // Even a preview of invalid/absent metadata is read-only; no key is created here.
  return plan.executable ? io.seal(plan, io.readKey(ctx)) : plan;
}

function applyMaintenanceRecovery(options, signedPlan) {
  const ctx = io.context(options);
  const plan = io.unseal(signedPlan, io.readKey(ctx));
  if (plan.schemaVersion !== 1 || plan.kind !== 'maintenance-recovery-plan' || !plan.executable || plan.conflicts.length
    || !io.equal(plan.root, ctx.root) || plan.runtimeRoot !== ctx.runtimeRoot || plan.showcaseRoot !== ctx.showcaseRoot) throw io.failure('MAINTENANCE_INVALID_PLAN', '恢复计划无效或配置不匹配');
  const currentPlan = previewMaintenanceRecovery(options);
  if (!currentPlan.executable || !io.equal(plan, io.unseal(currentPlan, io.readKey(ctx)))) throw io.failure('MAINTENANCE_CONFLICT', '文件、journal 或进程状态已变化；请重新预览');
  const claim = claimRecovery(options, plan.journalSha256);
  let undo = null;
  const attempted = [];
  try {
    // Recheck the entire current-state vector after acquiring the recovery claim.
    for (const item of plan.entries) if (!io.equal(io.fileState(io.targetPath(ctx, item.source)), item.current)) throw io.failure('MAINTENANCE_CONFLICT', '恢复抢锁后当前字节发生变化：' + item.source);
    if (plan.action === 'restore') {
      const backup = readBackup(options, plan.backupId, plan.backupSha256);
      const snapshot = io.snapshotFiles(plan.entries.map(item => item.source));
      const undoDir = saveSnapshotBackup(snapshot, ctx.backupRoot, 'pre-recovery', options);
      undo = readBackup(options, io.path.basename(undoDir));
      claim.update({ phase: 'recovering', recovery: { pid: process.pid, nonce: claim.nonce, undo: { id: undo.id, sha256: undo.sha256 } } });
      for (let index = 0; index < backup.entries.length; index++) {
        const item = backup.entries[index];
        claim.assertOwned();
        if (!io.equal(io.fileState(io.targetPath(io.context(options), item.file)), plan.entries[index].current)) throw io.failure('MAINTENANCE_CONFLICT', '恢复过程中目标发生冲突：' + item.file);
        attempted.push(index);
        restoreEntries(options, [item], claim.assertOwned);
      }
      for (const item of backup.entries) if (!io.equal(io.fileState(item.file), item.expected)) throw io.failure('MAINTENANCE_INCONSISTENT', '恢复后全量字节核验失败');
    }
    const final = plan.entries.map(item => ({ source: item.source, ...io.fileState(item.source) }));
    claim.update({ phase: 'recovered', noMutation: plan.backupId === null, final });
    claim.releaseRecovered();
    return { ok: true, dataIntegrity: 'restored', transactionId: plan.transactionId, action: plan.action, undoBackup: undo?.id || null, restoredFiles: plan.action === 'restore' ? plan.entries.length : 0 };
  } catch (error) {
    const rollbackErrors = [];
    if (undo) {
      // Only touched targets are restored. Unrelated files and directories are never swept.
      for (const index of attempted.reverse()) {
        try { restoreEntries(options, [undo.entries[index]], claim.assertOwned); }
        catch (rollbackError) { rollbackErrors.push(runtimeErrorMessage(rollbackError)); }
      }
      for (const item of undo.entries) {
        try { if (!io.equal(io.fileState(item.file), item.expected)) rollbackErrors.push('恢复前字节未还原：' + item.file); }
        catch (rollbackError) { rollbackErrors.push(runtimeErrorMessage(rollbackError)); }
      }
    }
    try {
      if (undo) claim.update({ phase: rollbackErrors.length ? 'INCONSISTENT' : 'recovery-failed', recovery: {
        pid: process.pid, nonce: claim.nonce, undo: { id: undo.id, sha256: undo.sha256 }, error: runtimeErrorMessage(error),
        rollback: rollbackErrors.length ? 'INCONSISTENT' : 'pre-recovery-restored', rollbackErrors,
      } });
      claim.finish();
    } catch (journalError) { rollbackErrors.push(runtimeErrorMessage(journalError)); }
    return { ok: false, code: runtimeErrorCode(error) || 'MAINTENANCE_RECOVERY_FAILED', error: runtimeErrorMessage(error), rolledBack: rollbackErrors.length === 0,
      dataIntegrity: rollbackErrors.length ? 'INCONSISTENT' : 'pre-recovery-restored', recoveryRequired: true,
      undoBackup: undo?.id || null, rollbackErrors };
  }
}

export = { previewMaintenanceRecovery, applyMaintenanceRecovery };
