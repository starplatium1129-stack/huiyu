import type { CompanionDesktopBridge } from '../../types/desktop.d.ts'
import { apiClient } from '../../api/client.ts'
import { hostApi, invokeHost as invoke, onHostEvent as on, offHostEvent as off } from './hostApi.ts'
import { getDesktopWindowRole } from './runtime.ts'

const capabilities: CompanionDesktopBridge = {
  isDesktop: true,
  readChatCredential: endpoint => invoke('chat_credential_read', { endpoint }),
  writeChatCredential: (endpoint, secret) => invoke('chat_credential_write', { endpoint, secret }),
  startDragging: () => hostApi()!.window.getCurrentWindow().startDragging(),
  hide: () => { void invoke('hide') }, quit: () => { void invoke('quit') },
  openAtelier: (pathname = '/') => { void invoke('open_atelier', { pathname }) },
  openChat: () => invoke('open_companion_chat'), toggleChat: () => invoke('toggle_companion_chat'),
  hideChatWindow: () => invoke('hide_companion_chat'),
  setChatDocked: docked => invoke('set_chat_docked', { docked }), getChatDocked: () => invoke('get_chat_docked'),
  chatRelay: payload => invoke('chat_relay', { payload }),
  onChatCommand: listener => on('aics:chat-command', listener), offChatCommand: off,
  setIgnoreMouseEvents: ignore => { void invoke('set_ignore_mouse_events_cmd', { ignore }) },
  setLive2dEnabled: enabled => { void invoke('set_live2d_enabled', { enabled }) },
  getState: () => invoke('get_state'), toggleAlwaysOnTop: () => invoke('toggle_always_on_top'),
  getSettings: () => invoke('get_settings'), isPackaged: () => invoke('is_packaged'),
  setAutostart: enabled => invoke('set_autostart', { enabled }), pickFiles: () => invoke('pick_files'),
  saveImage: payload => invoke('save_image', { data: Array.from(payload.data), name: payload.name }),
  openWorkspace: () => invoke('open_workspace'), openRuntime: () => invoke('open_runtime'), openLog: () => invoke('open_log'),
  getWorkspace: () => invoke('get_workspace'), setWorkspace: root => invoke('set_workspace', { root }),
  notify: (title, body) => { void invoke('notify', { title, body }) },
  setProgress: progress => { void invoke('set_progress', { progress }) },
  runTool: (name, args, options = {}) => apiClient.request('/api/desktop-tools', {
    method: 'POST', body: { name, args, adultEnabled: true }, signal: options.signal,
  }),
  onResume: listener => on('aics:resume', listener), offResume: off,
  onShown: listener => on('aics:shown', listener), offShown: off,
  onVisibilityChanged: listener => on('aics:visibility', listener), offVisibilityChanged: off,
  onWindowBoundsChanged: listener => on('aics:window-bounds', listener), offWindowBoundsChanged: off,
  onPowerModeChanged: listener => on('aics:power-mode', listener), offPowerModeChanged: off,
  onInteractionModeChanged: listener => on('aics:interaction-mode', listener), offInteractionModeChanged: off,
  onClipboardImage: listener => on<number[]>('aics:clipboard-image', bytes => listener(Uint8Array.from(bytes))), offClipboardImage: off,
  onClipboardText: listener => on('aics:clipboard-text', listener), offClipboardText: off,
  onGlobalMouse: listener => on('aics:global-mouse', listener), offGlobalMouse: off,
  minimizeWindow: () => { void invoke('window_minimize') }, toggleMaximizeWindow: () => { void invoke('window_maximize_toggle') },
  closeWindow: () => { void invoke('window_close') }, getWindowState: () => invoke('get_window_state'),
  onMaximizedChanged: listener => on('aics:maximized', listener), offMaximizedChanged: off,
}
const cssDragCapabilities: CompanionDesktopBridge = { ...capabilities, startDragging: undefined }
export function getDesktopCapabilities(): CompanionDesktopBridge | undefined {
  const host = hostApi()
  return host ? host.nativeDragRegions ? cssDragCapabilities : capabilities : undefined
}
export function onDesktopNavigate(listener: (path: string) => void): () => void {
  const id = on<string>('aics:navigate', path => { if (getDesktopWindowRole() === 'atelier' && /^\/(?:[a-zA-Z0-9-]+)?$/.test(path)) listener(path) })
  return () => off(id)
}
