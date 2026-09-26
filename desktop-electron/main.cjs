'use strict';
const { app, BrowserWindow, session, ipcMain, safeStorage, powerMonitor, screen } = require('electron');
const { installProbe } = require('./probe.cjs');
const { loadConfig } = require('./config.cjs');
const { installProtocol } = require('./protocol.cjs');
const { createPreferences } = require('./preferences.cjs');
const { createWindows } = require('./windows.cjs');
const { registerCommands } = require('./commands.cjs');
const { createRuntime } = require('./runtime-supervisor.cjs');
const { createNativeRenderer } = require('./live2d-client.cjs');
const config = loadConfig(process.argv);
app.setName('HUIYU Electron Comparison');
app.setPath('userData', config.userData);
app.setPath('sessionData', config.userData);
app.enableSandbox();
if (config.debugPort) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(config.debugPort));
}
let windows, runtime, native, shutdown;
app.on('before-quit', event => {
  if (config.probe) console.error('[electron:before-quit]', Boolean(shutdown));
  if (shutdown === true) return;
  event.preventDefault();
  if (shutdown) return;
  shutdown = (async () => {
    const results = await Promise.allSettled([native?.close(), runtime?.stop()]);
    for (const result of results) if (result.status === 'rejected') console.error('[electron:shutdown]', result.reason?.message);
    windows?.closeAll(); shutdown = true; app.quit();
  })();
});
app.on('window-all-closed', () => { if (!shutdown) app.quit(); });
app.whenReady().then(() => {
  installProtocol(session.defaultSession, config);
  const preferences = createPreferences(config, safeStorage);
  const onEvent = (name, payload) => {
    if (name.startsWith('aics:live2d:')) windows?.send('companion', name, payload);
    else windows?.broadcast(name, payload);
  };
  runtime = createRuntime({ config, onEvent });
  native = createNativeRenderer({ config, onEvent, getCompanionHwnd: () => windows?.nativeHandle() });
  windows = createWindows({ BrowserWindow, screen, session: session.defaultSession, config, preferences, onCompanionGone: () => native.stop() });
  registerCommands({ ipcMain, app, powerMonitor, windows, runtime, native, preferences, config });
  powerMonitor.on('resume', () => windows.broadcast('aics:resume', null));
  powerMonitor.on('on-battery', () => windows.broadcast('aics:power-mode', true));
  powerMonitor.on('on-ac', () => windows.broadcast('aics:power-mode', false));
  windows.start();
  // Window documents mount independently; runtime availability only updates the bootstrap descriptor.
  const startTimer = setTimeout(() => { if (!shutdown) void runtime.start().catch(error => console.error('[electron:runtime]', error.message)); }, config.runtimeStartDelayMs || 0);
  app.once('before-quit', () => clearTimeout(startTimer));
  if (config.probe === true) installProbe({ app, windows, runtime, native, cancelStartup: () => clearTimeout(startTimer) });
}).catch(error => { console.error('[electron:startup]', error.message); app.exit(1); });
