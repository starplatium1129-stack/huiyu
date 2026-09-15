'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const { failure } = require('./maintenance-recovery-fs');

function runMaintenanceNode(script, args, timeoutMs, { rootDir, repoRoot, lease, trackChild = child => child, killChild = child => child.kill() }) {
  if (!lease) throw failure('MAINTENANCE_RECOVERY_REQUIRED', '维护子进程必须由持久化事务启动');
  lease.assertOwned();
  return new Promise((resolve, reject) => {
    const child = trackChild(cp.fork(path.join(__dirname, 'maintenance-transaction-child.js'), [path.resolve(repoRoot, script), ...args], {
      cwd: repoRoot, windowsHide: true, silent: true,
      env: { ...process.env, AICS_DATA_ROOT: rootDir, AICS_APP_ROOT: rootDir },
    }));
    let registered = false;
    let failureError = null;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      failureError = new Error(path.basename(script) + ' 执行超时');
      killChild(child);
      // Do not settle until close: rolling back while a child is alive is unsafe.
    }, timeoutMs || 120000);
    child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += String(chunk).slice(0, 65536 - stdout.length); });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += String(chunk).slice(0, 65536 - stderr.length); });
    child.once('message', message => {
      try {
        if (!message || message.type !== 'ready') throw new Error('维护子进程握手无效');
        lease.addParticipant(child.pid);
        registered = true;
        child.send({ type: 'start' }, error => { if (error) { failureError = error; killChild(child); } });
      } catch (error) { failureError = error; killChild(child); }
    });
    child.once('error', error => { failureError = error; });
    child.once('close', code => {
      clearTimeout(timer);
      try { if (registered) lease.participantExited(child.pid); }
      catch (error) { failureError = error; }
      if (failureError) reject(failureError);
      else resolve({ status: code, stdout, stderr });
    });
  });
}
module.exports = { runMaintenanceNode };
