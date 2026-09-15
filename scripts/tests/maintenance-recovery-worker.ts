import { errorCode as runtimeErrorCode } from '../lib/runtime-errors';
'use strict';

const cp: typeof import('node:child_process') = require('node:child_process');
const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
const { acquireMaintenanceLease }: typeof import('../lib/maintenance-lease') = require('../lib/maintenance-lease');
const { prepareMaintenanceTransaction }: typeof import('../lib/maintenance-transaction') = require('../lib/maintenance-transaction');
const { readBackup, restoreEntries }: typeof import('../lib/maintenance-recovery-backup') = require('../lib/maintenance-recovery-backup');
const { applyMaintenanceRecovery }: typeof import('../lib/maintenance-recovery') = require('../lib/maintenance-recovery');
const { names }: typeof import('./maintenance-recovery-fixture') = require('./maintenance-recovery-fixture');

const mode = process.argv[2];
const options = JSON.parse(process.argv[3]);
const files = names.map(name => io.path.join(options.rootDir, name)).concat(options.additionalFiles || []);
if (mode === 'recover-crash') {
  const rename = io.fs.renameSync;
  let crashed = false;
  io.fs.renameSync = (source, target) => {
    rename(source, target);
    if (!crashed && target === files[0]) { crashed = true; process.kill(process.pid, 'SIGKILL'); }
  };
  const result = applyMaintenanceRecovery(options, io.readJson(io.path.join(options.rootDir, 'plan.json')));
  process.stdout.write(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
let lease;
try { lease = acquireMaintenanceLease(options); }
catch (error) { process.send({ status: 'blocked', code: runtimeErrorCode(error) }, () => process.exit(0)); }
if (lease) {
  let backup;
  let participant;
  let writeBlocked = null;
  if (mode !== 'preparing') {
    backup = prepareMaintenanceTransaction(lease, options, io.snapshotFiles(files));
    try {
    io.atomicWrite(files[0], 'partial-source');
    io.atomicWrite(files[1], 'new-partial-file');
    io.removeFile(files[2]);
    io.atomicWrite(files[4], 'partial-product');
    io.atomicWrite(files[5], 'partial-compression');
    io.atomicWrite(files[7], 'DATA_VERSION = 999;');
    for (const file of options.additionalFiles || []) io.atomicWrite(file, 'partial-external-showcase', true);
    } catch (error) {
      // A Windows reader can deny atomic replacement of its open file. Pause
      // before rollback so SIGKILL still exercises the real partial transaction.
      if (mode !== 'stream-race' || process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(runtimeErrorCode(error))
        || !error.dest || !options.readOpenTarget || !io.samePath(error.dest, options.readOpenTarget)) throw error;
      writeBlocked = { code: runtimeErrorCode(error), target: error.dest };
    }
    if (mode === 'committed') lease.complete('committed');
    if (mode === 'rolled-back') {
      const original = readBackup(options, io.path.basename(backup));
      restoreEntries(options, original.entries, lease.assertOwned);
      lease.complete('rolled-back');
    }
    if (mode === 'participant') {
      participant = options.participantPid ? { pid: options.participantPid }
        : cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      lease.addParticipant(participant.pid);
    }
  }
  process.send({ status: 'ready', backup, nonce: lease.nonce, participant: participant?.pid, writeBlocked }, () => {
    if (mode === 'exit') process.exit(73);
  });
  setInterval(() => {}, 1000);
}
