'use strict';
// Only the host supplies this script path. The real gateway still owns all data,
// authentication and draining; IPC merely ties its lifetime to the Electron host.
if (!process.send || !process.connected) process.exit(70);
let runtime, stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (runtime) runtime.shutdown();
  // Startup may still be opening the workspace. Once it finishes, drain it;
  // this deadline also bounds a failed asynchronous module initialization.
  setTimeout(() => process.exit(1), 15000).unref();
}
process.once('disconnect', () => { console.error('[electron:runtime] host disconnected; draining owned gateway'); stop(); });
process.once('exit', code => console.error('[electron:runtime] owned gateway exit=' + code));
process.on('message', message => { if (message?.type === 'shutdown') stop(); });
require(process.argv[2]).startGateway().then(value => {
  runtime = value;
  if (stopping || !process.connected) runtime.shutdown();
  else process.send({ type: 'listening' });
}).catch(error => { console.error('Owned gateway startup failed:', error.message); process.exit(1); });
