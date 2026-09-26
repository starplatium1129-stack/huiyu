'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
// Electron's Windows GUI entry closes stdin before Node readers attach. A random
// local pipe is the opt-in test controller; no renderer receives its name/API.
function installProbe({ app, windows, runtime, native, cancelStartup }) {
  const endpoint = `\\\\.\\pipe\\huiyu-electron-${crypto.randomBytes(16).toString('hex')}`;
  let controller, exitDeadline;
  const server = net.createServer(socket => {
    if (controller) { socket.destroy(); return; }
    controller = socket; let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 65_536) { socket.destroy(); return; }
        void dispatch(line);
      }
      if (Buffer.byteLength(buffer) > 65_536) socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      exitDeadline = setTimeout(() => { console.error('[electron:probe] graceful shutdown deadline exceeded'); app.exit(1); }, 25_000);
      exitDeadline.unref(); app.quit();
    });
  });
  async function dispatch(line) {
    let id = null;
    try {
      const command = JSON.parse(line); id = command.id;
      let result;
      switch (command.op) {
        case 'status': result = { windows: windows.status(), runtime: runtime.state(), native: await native.diagnostics() }; break;
        case 'stop-runtime': cancelStartup(); await runtime.pause(); result = runtime.state(); break;
        case 'start-runtime': cancelStartup(); await runtime.start(); result = runtime.state(); break;
        case 'native-snapshot': result = { path: await native.snapshot(command.label) }; break;
        case 'kill-native-renderer': await native.terminateRenderer(); result = await native.diagnostics(); break;
        case 'crash-window': {
          const window = windows.get(command.role); if (!window) throw Error('Unknown role');
          window.webContents.forcefullyCrashRenderer(); result = { role: command.role }; break;
        }
        case 'reopen-window': windows.reopen(command.role); result = { role: command.role }; break;
        case 'exit': result = { exiting: true }; setImmediate(() => app.quit()); break;
        default: throw Error('Unsupported probe operation');
      }
      controller.write('HUIYU_PROBE ' + JSON.stringify({ id, result }) + '\n');
    } catch (error) { controller?.write('HUIYU_PROBE ' + JSON.stringify({ id, error: error.message }) + '\n'); }
  }
  server.on('error', error => { console.error('[electron:probe]', error.message); app.quit(); });
  server.listen(endpoint, () => process.stdout.write('HUIYU_PROBE_PIPE ' + endpoint + '\n'));
  app.once('before-quit', () => { server.close(); controller?.end(); });
  app.once('will-quit', () => clearTimeout(exitDeadline));
}
module.exports = { installProbe };
