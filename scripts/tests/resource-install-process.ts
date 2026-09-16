'use strict';

const { fork }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');

// Shared fixture driver. Importing it never registers or executes another test suite.
function killAt(config: string, phase: string, action: any = 'install', releaseId: any = 'delta') {
  return new Promise((resolve, reject) => {
    const worker = fork(path.join(__dirname, 'resource-install-worker.js'), [config, phase, action, releaseId],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let reached = false;
    let stderr = '';
    worker.stderr!.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error('Worker did not reach ' + phase + ': ' + stderr)); }, 30000);
    worker.on('error', error => { clearTimeout(timeout); reject(error); });
    worker.on('message', (message: any) => {
      if (message.error) { worker.kill('SIGKILL'); reject(new Error(message.error + ': ' + message.message)); }
      else if (message.phase === phase) { reached = true; worker.kill('SIGKILL'); }
    });
    worker.on('exit', () => {
      clearTimeout(timeout);
      if (reached) resolve(undefined);
      else reject(new Error('Worker exited before ' + phase + ': ' + stderr));
    });
  });
}

export = { killAt };
