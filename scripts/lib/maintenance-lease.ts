import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

const io: typeof import('./maintenance-recovery-fs') = require('./maintenance-recovery-fs');
const backups: typeof import('./maintenance-recovery-backup') = require('./maintenance-recovery-backup');
const { fs, path, crypto, failure } = io;
const phases = new Set(['preparing', 'writing', 'rolling-back', 'committed', 'rolled-back', 'recovering', 'recovery-failed', 'recovered', 'INCONSISTENT']);
const validPid = (pid: any) => Number.isSafeInteger(pid) && pid > 0;
const validNonce = (nonce: any) => typeof nonce === 'string' && /^[0-9a-f-]{36}$/.test(nonce);

function pidStatus(pid: any) {
  if (!validPid(pid)) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return runtimeErrorCode(error) === 'ESRCH' ? 'dead' : 'unknown'; }
}
function readLease(ctx: any) {
  if (!io.safePath(ctx.leaseDir, 'directory')) return null;
  const file = path.join(ctx.leaseDir, 'journal.json');
  const bytes = io.readBytes(file);
  const journal = io.unseal(io.readJson(file), io.readKey(ctx));
  if (journal.schemaVersion !== 1 || journal.kind !== 'maintenance-journal' || !validPid(journal.pid) || !validNonce(journal.nonce)
    || !io.equal(journal.root, ctx.root) || !io.samePath(journal.runtimeRoot || '', ctx.runtimeRoot)
    || !io.equal(journal.runtimeIdentity, io.directoryIdentity(ctx.runtimeRoot))
    || !phases.has(journal.phase) || !Array.isArray(journal.participants)
    || journal.participants.some((item: any) => !validPid(item.pid) || !['running', 'exited'].includes(item.state))) throw failure('MAINTENANCE_INVALID_JOURNAL', '维护 journal 格式或根身份无效');
  if (journal.phase !== 'preparing' && !(journal.phase === 'recovered' && journal.noMutation === true)
    && (!journal.backup || typeof journal.backup.id !== 'string' || !/^[0-9a-f]{64}$/.test(journal.backup.sha256))) throw failure('MAINTENANCE_INVALID_JOURNAL', '维护 journal 缺少已建立备份');
  return { journal, sha256: io.digest(bytes), directory: io.directoryIdentity(ctx.leaseDir) };
}
function ownerDead(journal: any) {
  return pidStatus(journal.pid) === 'dead' && journal.participants.every((item: any) => item.state === 'exited' || pidStatus(item.pid) === 'dead');
}
function recoveryOwners(ctx: any, journal: any) {
  const owners = [];
  let directory = path.join(ctx.leaseDir, 'recovery');
  for (let depth = 0; io.safePath(directory, 'directory'); depth++, directory = path.join(directory, 'next')) {
    if (depth >= 32) throw failure('MAINTENANCE_INVALID_JOURNAL', '恢复重入层数超过安全上限');
    const owner = io.unseal(io.readJson(path.join(directory, 'owner.json')), io.readKey(ctx));
    if (!validPid(owner.pid) || !validNonce(owner.nonce) || owner.transaction !== journal.nonce) throw failure('MAINTENANCE_INVALID_JOURNAL', '恢复锁身份无效');
    let finished = false;
    if (io.safePath(path.join(directory, 'finished.json'))) {
      const value = io.unseal(io.readJson(path.join(directory, 'finished.json')), io.readKey(ctx));
      if (value.nonce !== owner.nonce || value.transaction !== journal.nonce) throw failure('MAINTENANCE_INVALID_JOURNAL', '恢复结束标记无效');
      finished = true;
    }
    owners.push({ ...owner, directory, finished, process: pidStatus(owner.pid) });
  }
  return owners;
}
function inspectMaintenanceLease(options: any) {
  try {
    const ctx = io.context(options);
    const current = readLease(ctx);
    if (!current) return { status: 'free', recoveryRequired: false };
    const owners = recoveryOwners(ctx, current.journal);
    const activeRecovery = owners.find(owner => !owner.finished && owner.process !== 'dead');
    const active = !ownerDead(current.journal) || Boolean(activeRecovery);
    return { status: active ? 'active' : 'stale', recoveryRequired: true, journal: current.journal,
      journalSha256: current.sha256, recoveryOwner: activeRecovery ? { pid: activeRecovery.pid, nonce: activeRecovery.nonce } : null };
  } catch (error) { return { status: 'invalid', recoveryRequired: true, code: runtimeErrorCode(error) || 'MAINTENANCE_INVALID_JOURNAL', error: runtimeErrorMessage(error) }; }
}
function blocked(state: any) {
  const code = state.status === 'active' ? 'MAINTENANCE_BUSY' : state.status === 'invalid' ? 'MAINTENANCE_INVALID_JOURNAL' : 'MAINTENANCE_RECOVERY_REQUIRED';
  return Object.assign(failure(code, state.status === 'active' ? '维护事务仍在运行，请稍后重试' : '维护事务尚未完整结束，请先预览并执行恢复'), {
    transactionId: state.journal?.nonce, phase: state.journal?.phase, leaseStatus: state.status,
  });
}
function publishDirectory(ctx: any, destination: any, fileName: any, value: any) {
  const staging = path.join(ctx.stateDir, '.claim-' + crypto.randomUUID());
  io.ensureDirectory(staging);
  io.writeJson(path.join(staging, fileName), io.seal(value, io.readKey(ctx)));
  try {
    io.safePath(path.dirname(destination), 'directory', false);
    fs.renameSync(staging, destination);
    io.syncDirectory(path.dirname(destination));
  } catch (error) {
    // This directory was never published; remove only the exact files we created.
    try { io.removeFile(path.join(staging, fileName)); fs.rmdirSync(staging); } catch { /* Keep failed metadata for inspection. */ }
    throw error;
  }
}
function writeJournal(ctx: any, journal: any) {
  io.writeJson(path.join(ctx.leaseDir, 'journal.json'), io.seal({ ...journal, updatedAt: new Date().toISOString() }, io.readKey(ctx)));
}
function archiveLease(ctx: any, nonce: any) {
  const directory = path.join(ctx.stateDir, 'completed');
  io.ensureDirectory(directory);
  const target = path.join(directory, nonce);
  if (io.safePath(target, 'directory')) throw failure('MAINTENANCE_CONFLICT', '事务归档身份已存在');
  io.writeJson(path.join(ctx.stateDir, 'epoch.json'), io.seal({ nonce, root: ctx.root }, io.readKey(ctx)));
  // Rename the whole owned metadata directory. Never unlink a shared lock pathname.
  fs.renameSync(ctx.leaseDir, target);
  io.syncDirectory(ctx.stateDir);
  return target;
}

function acquireMaintenanceLease(options: any) {
  const ctx = io.context(options);
  const before = inspectMaintenanceLease(options);
  if (before.status !== 'free') throw blocked(before);
  io.ensureDirectory(ctx.runtimeRoot);
  io.readKey(ctx, true);
  const journal = { schemaVersion: 1, kind: 'maintenance-journal', root: ctx.root, runtimeRoot: ctx.runtimeRoot,
    runtimeIdentity: io.directoryIdentity(ctx.runtimeRoot),
    pid: process.pid, nonce: crypto.randomUUID(), phase: 'preparing', backup: null, participants: [], final: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try { publishDirectory(ctx, ctx.leaseDir, 'journal.json', journal); }
  catch (error) {
    const current = inspectMaintenanceLease(options);
    if (current.status !== 'free') throw blocked(current);
    throw error;
  }
  const identity = io.directoryIdentity(ctx.leaseDir);
  let released = false;
  function own() {
    if (released) throw failure('MAINTENANCE_CONFLICT', '维护 lease 已释放');
    const current = readLease(io.context(options));
    if (!current || current.journal.pid !== process.pid || current.journal.nonce !== journal.nonce || !io.equal(identity, current.directory)) throw failure('MAINTENANCE_CONFLICT', '维护锁 PID/nonce/目录身份已变化');
    return current.journal;
  }
  function update(patch: any) { const current = own(); writeJournal(ctx, { ...current, ...patch }); return own(); }
  const handle = {
    nonce: journal.nonce,
    assertOwned: own,
    setBackup(directory: any) {
      const current = own();
      if (current.phase !== 'preparing' || current.backup) throw failure('MAINTENANCE_CONFLICT', '事务备份只能建立一次');
      if (!io.samePath(path.dirname(directory), ctx.backupRoot)) throw failure('MAINTENANCE_PATH', '备份不在本事务 runtime 内');
      const backup = backups.readBackup(options, path.basename(directory));
      update({ phase: 'writing', backup: { id: backup.id, sha256: backup.sha256 } });
      return backup;
    },
    addParticipant(pid: any) {
      if (!validPid(pid) || pidStatus(pid) !== 'alive') throw failure('MAINTENANCE_CONFLICT', '子进程尚未可确认运行');
      const current = own();
      if (current.phase !== 'writing') throw failure('MAINTENANCE_CONFLICT', '必须先建立备份再启动写入子进程');
      update({ participants: [...current.participants.filter((item: any) => item.pid !== pid), { pid, state: 'running' }] });
    },
    participantExited(pid: any) { const current = own(); update({ participants: current.participants.map((item: any) => item.pid === pid ? { pid, state: 'exited' } : item) }); },
    assertQuiescent() {
      const current = own();
      if (current.participants.some((item: any) => item.state !== 'exited' && pidStatus(item.pid) !== 'dead')) throw failure('MAINTENANCE_BUSY', '子进程仍可能写盘，拒绝提交或回滚');
    },
    beginRollback() { handle.assertQuiescent(); update({ phase: 'rolling-back' }); },
    markInconsistent(message: any) { update({ phase: 'INCONSISTENT', error: String(message).slice(0, 2000) }); },
    complete(phase: any) {
      if (!['committed', 'rolled-back'].includes(phase)) throw failure('MAINTENANCE_ARGUMENT', '结束状态无效');
      handle.assertQuiescent();
      const current = own();
      if (!current.backup) { if (phase !== 'rolled-back') throw failure('MAINTENANCE_CONFLICT', '事务未建立备份'); return; }
      const backup = backups.readBackup(options, current.backup.id, current.backup.sha256);
      const final = backup.entries.map((item: any) => ({ source: item.file, ...io.fileState(item.file) }));
      if (phase === 'rolled-back' && final.some((item: any, index: any) => !io.equal({ exists: item.exists, sha256: item.sha256, size: item.size }, backup.entries[index].expected))) throw failure('MAINTENANCE_INCONSISTENT', '回滚后原始字节不匹配');
      update({ phase, final });
    },
    release() {
      const current = own();
      handle.assertQuiescent();
      if (!['preparing', 'committed', 'rolled-back'].includes(current.phase) || (current.phase === 'preparing' && current.backup)) throw failure('MAINTENANCE_RECOVERY_REQUIRED', '尚未确认提交或完整回滚，保留维护锁');
      archiveLease(ctx, current.nonce);
      released = true;
    },
  };
  return handle;
}

export = { acquireMaintenanceLease };
