'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const names = [
  'desktop_bootstrap', 'desktop_workspace_prepare', 'desktop_workspace_activate', 'desktop_workspace_enable_bundled',
  'window_zoom_get', 'window_zoom_set', 'chat_credential_read', 'chat_credential_write', 'hide', 'quit', 'open_atelier',
  'open_companion_chat', 'toggle_companion_chat', 'hide_companion_chat', 'set_chat_docked', 'get_chat_docked', 'chat_relay',
  'set_ignore_mouse_events_cmd', 'set_live2d_enabled', 'get_state', 'toggle_always_on_top', 'get_settings', 'is_packaged',
  'set_autostart', 'pick_files', 'save_image', 'open_workspace', 'open_runtime', 'open_log', 'get_workspace', 'set_workspace',
  'notify', 'set_progress', 'window_minimize', 'window_maximize_toggle', 'window_close', 'get_window_state',
  'desktop_update_check', 'desktop_update_install',
  'aics_live2d_set_character', 'aics_live2d_set_frame', 'aics_live2d_set_max_fps', 'aics_live2d_play_motion',
  'aics_live2d_set_expression', 'aics_live2d_set_mouth_level', 'aics_live2d_set_emotion', 'aics_live2d_set_gaze',
  'aics_live2d_hit_test', 'aics_live2d_destroy', 'aics_live2d_get_state',
];
const events = new Set(['aics:gateway-ready', 'aics:gateway-unavailable', 'aics:navigate', 'aics:chat-command', 'aics:resume',
  'aics:shown', 'aics:visibility', 'aics:window-bounds', 'aics:power-mode', 'aics:interaction-mode', 'aics:maximized',
  'aics:clipboard-image', 'aics:clipboard-text', 'aics:global-mouse', 'aics:live2d:ready', 'aics:live2d:motion-started',
  'aics:live2d:motion-failed', 'aics:live2d:hit-test', 'aics:live2d:entrance-finished', 'aics:live2d:stopped']);
// Closures bind each IPC name. The page cannot select an arbitrary channel or receive IpcRendererEvent.
const commands = Object.fromEntries(names.map(name => [name, args => ipcRenderer.invoke(`huiyu:${name}`, args)]));
const event = { async listen(name, listener) {
  if (!events.has(name) || typeof listener !== 'function') throw Error('UNSUPPORTED: event');
  const wrapped = (_event, message) => { if (message?.name === name) listener({ payload: message.payload }); };
  ipcRenderer.on('huiyu:event', wrapped);
  return () => ipcRenderer.removeListener('huiyu:event', wrapped);
} };
if (process.isMainFrame) contextBridge.exposeInMainWorld('__HUIYU_ELECTRON__', {
  commands, event, startDragging: () => ipcRenderer.invoke('huiyu:window_start_dragging'),
});
