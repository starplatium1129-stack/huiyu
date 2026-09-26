'use strict';
function unsupported(name) { throw Error(`UNSUPPORTED: ${name} is not implemented in the Electron comparison`); }
function boolean(value) { if (typeof value !== 'boolean') throw Error('Invalid boolean'); return value; }
function registerCommands({ ipcMain, app, powerMonitor, windows, runtime, native, preferences, config }) {
  const atelier = role => { if (role !== 'atelier') throw Error('FORBIDDEN: atelier owns workspace administration'); };
  const companion = role => { if (role !== 'companion') throw Error('FORBIDDEN: companion owns Live2D'); };
  const pet = () => { const window = windows.get('companion'); if (!window) throw Error('Companion window unavailable'); return window; };
  const show = role => { const window = windows.create(role); window.show(); window.focus(); };
  const handlers = {
    desktop_bootstrap: ({ role }) => runtime.bootstrap(role),
    desktop_workspace_prepare: ({ role }) => { atelier(role); return runtime.prepare(role); },
    desktop_workspace_activate: ({ role }, args) => { atelier(role); return runtime.activate(role, args); },
    desktop_workspace_enable_bundled: ({ role }) => { atelier(role); return runtime.enableBundled(role); },
    get_state: () => ({ alwaysOnTop: pet().isAlwaysOnTop(), ignoreMouseEvents: preferences.state.ignoreMouseEvents,
      visible: pet().isVisible(), onBatteryPower: powerMonitor.isOnBatteryPower(), live2dEnabled: preferences.state.live2dEnabled, bounds: windows.bounds() }),
    get_settings: () => ({ openAtLogin: false }),
    is_packaged: () => app.isPackaged,
    window_zoom_get: ({ window }) => window.webContents.getZoomFactor(),
    window_zoom_set: ({ role, window }, { value }) => {
      if (!Number.isFinite(value) || value < .75 || value > 2) throw Error('Invalid zoom');
      window.webContents.setZoomFactor(value); preferences.state.zoom[role] = value; preferences.save(); return value;
    },
    window_minimize: ({ window }) => window.minimize(),
    window_maximize_toggle: ({ window }) => window.isMaximized() ? window.unmaximize() : window.maximize(),
    window_close: ({ window }) => window.hide(),
    get_window_state: ({ window }) => ({ maximized: window.isMaximized(), focused: window.isFocused() }),
    hide: () => pet().hide(),
    quit: () => app.quit(),
    open_atelier: (_sender, { pathname = '/' }) => {
      if (typeof pathname !== 'string' || !/^\/(?:[a-zA-Z0-9-]+)?$/.test(pathname)) throw Error('Invalid atelier route');
      show('atelier'); windows.send('atelier', 'aics:navigate', pathname);
    },
    open_companion_chat: () => { show('companion-chat'); windows.dock(); },
    toggle_companion_chat: () => { const chat = windows.create('companion-chat'); if (chat.isVisible()) chat.hide(); else { show('companion-chat'); windows.dock(); } },
    hide_companion_chat: () => windows.get('companion-chat')?.hide(),
    get_chat_docked: () => preferences.state.chatDocked,
    set_chat_docked: (_sender, { docked }) => { preferences.state.chatDocked = boolean(docked); preferences.save(); windows.dock(); return docked; },
    toggle_always_on_top: () => {
      const value = !pet().isAlwaysOnTop(); pet().setAlwaysOnTop(value); preferences.state.alwaysOnTop = value; preferences.save(); return value;
    },
    set_ignore_mouse_events_cmd: (_sender, { ignore }) => {
      boolean(ignore); pet().setIgnoreMouseEvents(ignore, { forward: true }); preferences.state.ignoreMouseEvents = ignore;
      preferences.save(); windows.send('companion', 'aics:interaction-mode', ignore);
    },
    set_live2d_enabled: ({ role }, { enabled }) => { companion(role); preferences.state.live2dEnabled = boolean(enabled); preferences.save(); },
    chat_relay: ({ role }, { payload }) => {
      if (role !== 'companion-chat') throw Error('FORBIDDEN: chat relay sender');
      if (!payload || typeof payload !== 'object' || !['send', 'stop', 'switch-character'].includes(payload.command)) throw Error('Invalid chat relay');
      const limits = { text: 65_536, imageUrl: 16 * 1024 * 1024, character: 256, requestId: 128 };
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'command') continue;
        if (!Object.hasOwn(limits, key) || (value != null && (typeof value !== 'string' || value.length > limits[key]))) throw Error('Invalid chat relay field');
      }
      if (payload.command === 'send' && (!payload.text?.trim() || !payload.requestId)) throw Error('Chat send requires text and requestId');
      windows.send('companion', 'aics:chat-command', payload); return true;
    },
    chat_credential_read: (_sender, { endpoint }) => preferences.readCredential(endpoint),
    chat_credential_write: (_sender, { endpoint, secret }) => preferences.writeCredential(endpoint, secret),
    get_workspace: () => ({ root: config.aiRoot, exists: true }),
    set_progress: ({ window }, { progress }) => {
      if (progress !== null && (!Number.isFinite(progress) || progress < 0 || progress > 1)) throw Error('Invalid progress');
      window.setProgressBar(progress === null ? -1 : progress);
    },
  };
  for (const command of ['aics_live2d_set_character', 'aics_live2d_set_frame', 'aics_live2d_set_max_fps', 'aics_live2d_play_motion',
    'aics_live2d_set_expression', 'aics_live2d_set_mouth_level', 'aics_live2d_set_emotion', 'aics_live2d_set_gaze',
    'aics_live2d_hit_test', 'aics_live2d_destroy', 'aics_live2d_get_state']) {
    handlers[command] = ({ role }, args) => { companion(role); return native.call(command, args); };
  }
  for (const command of ['window_start_dragging', 'set_autostart', 'pick_files', 'save_image', 'open_workspace', 'open_runtime',
    'open_log', 'set_workspace', 'notify', 'desktop_update_check', 'desktop_update_install']) handlers[command] = () => unsupported(command);
  for (const [command, handler] of Object.entries(handlers)) ipcMain.handle(`huiyu:${command}`, (event, input) => {
    const sender = windows.authenticate(event);
    const args = input === undefined ? {} : input;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 17 * 1024 * 1024) throw Error('Invalid IPC arguments');
    return handler(sender, args);
  });
  return () => { for (const command of Object.keys(handlers)) ipcMain.removeHandler(`huiyu:${command}`); };
}
module.exports = { registerCommands };
