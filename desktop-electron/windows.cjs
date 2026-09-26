'use strict';
const path = require('node:path');
const { ORIGIN, trustedDocument } = require('./protocol.cjs');
const ROLES = ['atelier', 'companion', 'companion-chat'];
function createWindows({ BrowserWindow, screen, session, config, preferences, onCompanionGone }) {
  const windows = new Map();
  const registry = new Map();
  let quitting = false;
  let expectedChatPosition;
  function send(role, name, payload) {
    const window = windows.get(role);
    if (window && !window.isDestroyed() && trustedDocument(window.webContents.getURL())) window.webContents.send('huiyu:event', { name, payload });
  }
  function broadcast(name, payload) { for (const role of ROLES) send(role, name, payload); }
  function bounds(role = 'companion') {
    const window = windows.get(role);
    return window && !window.isDestroyed() ? screen.dipToScreenRect(window, window.getBounds()) : null;
  }
  function dock() {
    const pet = windows.get('companion'), chat = windows.get('companion-chat');
    if (!preferences.state.chatDocked || !pet || !chat || !chat.isVisible() || chat.isMaximized()) return;
    const p = pet.getBounds(), c = chat.getBounds(), area = screen.getDisplayMatching(p).workArea;
    const desiredX = p.x + p.width + 12 + c.width <= area.x + area.width ? p.x + p.width + 12 : p.x - c.width - 12;
    const x = Math.max(area.x, Math.min(desiredX, area.x + area.width - c.width));
    const y = Math.max(area.y, Math.min(p.y + Math.round((p.height - c.height) / 2), area.y + area.height - c.height));
    if (x !== c.x || y !== c.y) { expectedChatPosition = { x, y }; chat.setPosition(x, y); }
  }
  function create(role) {
    if (!ROLES.includes(role)) throw Error('Invalid window role');
    if (windows.has(role)) return windows.get(role);
    const companion = role === 'companion';
    const window = new BrowserWindow({ title: `HUIYU Electron PoC - ${role}`, show: false,
      width: companion ? 540 : role === 'atelier' ? 1280 : 480, height: companion ? 760 : 820,
      x: companion ? 40 : role === 'atelier' ? 610 : 600, y: 60,
      frame: false, transparent: companion, backgroundColor: companion ? '#00000000' : '#171923',
      alwaysOnTop: companion && preferences.state.alwaysOnTop,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session, sandbox: true,
        contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
        backgroundThrottling: !companion, spellcheck: false, devTools: Boolean(config.debugPort) },
    });
    const webContentsId = window.webContents.id;
    windows.set(role, window); registry.set(webContentsId, { role, window });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!trustedDocument(url)) event.preventDefault(); });
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame || !trustedDocument(event.url)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => {
      if (config.probe) console.error('[electron:document-ready]', role);
      if (role === 'companion-chat') void window.webContents.insertCSS('.companion-chat-titlebar { app-region: drag; -webkit-app-region: drag; } .companion-chat-titlebar :is(button,a,input,textarea,select,[role="button"]) { app-region: no-drag; -webkit-app-region: no-drag; }');
      const zoom = preferences.state.zoom[role];
      if (Number.isFinite(zoom) && zoom >= .75 && zoom <= 2) window.webContents.setZoomFactor(zoom);
      if (config.show !== false && (config.show === true || role !== 'companion-chat')) window.show();
    });
    window.on('show', () => { send(role, 'aics:shown', null); send(role, 'aics:visibility', true); if (role === 'companion-chat') dock(); });
    window.on('hide', () => send(role, 'aics:visibility', false));
    window.on('maximize', () => send(role, 'aics:maximized', true));
    window.on('unmaximize', () => send(role, 'aics:maximized', false));
    for (const event of ['move', 'resize']) window.on(event, () => {
      if (event === 'move' && role === 'companion-chat' && preferences.state.chatDocked) {
        const current = window.getBounds();
        if (!expectedChatPosition || current.x !== expectedChatPosition.x || current.y !== expectedChatPosition.y) {
          preferences.state.chatDocked = false; preferences.save();
        }
      }
      send(role, 'aics:window-bounds', bounds(role)); if (companion) dock();
    });
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    window.webContents.on('render-process-gone', () => { if (companion) void onCompanionGone(); });
    window.on('closed', () => { registry.delete(webContentsId); windows.delete(role); if (companion) void onCompanionGone(); });
    if (companion) window.setIgnoreMouseEvents(preferences.state.ignoreMouseEvents, { forward: true });
    const route = role === 'atelier' ? '/' : `/${role}`;
    void window.loadURL(`${ORIGIN}/#${route}`).catch(error => {
      if (!quitting && !window.isDestroyed()) console.error('[electron:window]', role, error.message);
    });
    return window;
  }
  function authenticate(event) {
    const registered = registry.get(event.sender.id);
    if (!registered || registered.window.isDestroyed() || event.sender !== registered.window.webContents
      || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !trustedDocument(event.senderFrame.url)) throw Error('FORBIDDEN: untrusted IPC sender');
    return registered;
  }
  return { create, get: role => windows.get(role), send, broadcast, bounds, dock, authenticate,
    start() { for (const role of ROLES) create(role); },
    reopen(role) { if (!ROLES.includes(role)) throw Error('Invalid window role'); windows.get(role)?.destroy(); return create(role); },
    status() { return [...windows.entries()].map(([role, window]) => ({ role, id: window.webContents.id, visible: window.isVisible(), url: window.webContents.getURL(), bounds: bounds(role) })); },
    nativeHandle() { const bytes = windows.get('companion')?.getNativeWindowHandle(); return bytes ? Number(bytes.readBigUInt64LE()) : null; },
    closeAll() { quitting = true; for (const window of windows.values()) window.destroy(); },
  };
}
module.exports = { createWindows, ROLES };
