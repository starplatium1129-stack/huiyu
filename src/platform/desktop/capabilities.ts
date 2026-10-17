import type { CompanionDesktopBridge } from '../../types/desktop.d.ts'
import { hostApi, invokeHost as invoke, onHostEvent as on, offHostEvent as off } from './hostApi.ts'
import { getDesktopWindowRole } from './runtime.ts'

const capabilities: CompanionDesktopBridge = {
  readChatCredential: endpoint => invoke('chat_credential_read', { endpoint }),
  writeChatCredential: (endpoint, secret) => invoke('chat_credential_write', { endpoint, secret }),
  startDragging: () => hostApi()!.window.getCurrentWindow().startDragging(),
  hide: () => { void invoke('hide') },
  openAtelier: (pathname = '/') => { void invoke('open_atelier', { pathname }) },
  openChat: () => invoke('open_companion_chat'),
  hideChatWindow: () => invoke('hide_companion_chat'),
  setChatDocked: docked => invoke('set_chat_docked', { docked }), getChatDocked: () => invoke('get_chat_docked'),
  chatRelay: payload => invoke('chat_relay', { payload }),
  onChatCommand: listener => on('aics:chat-command', listener), offChatCommand: off,
  setIgnoreMouseEvents: ignore => { void invoke('set_ignore_mouse_events_cmd', { ignore }) },
  setLive2dEnabled: enabled => { void invoke('set_live2d_enabled', { enabled }) },
  getState: () => invoke('get_state'), toggleAlwaysOnTop: () => invoke('toggle_always_on_top'),
  isPackaged: () => invoke('is_packaged'),
  saveImage: payload => {
    const host = hostApi()
    if (!host) return Promise.reject(new Error('桌面能力不可用'))
    const headers: Record<string, string> = {}
    if (payload.name !== undefined) headers['x-aics-image-name'] = btoa(String.fromCharCode(...new TextEncoder().encode(payload.name)))
    return host.core.invoke('save_image', payload.data, { headers })
  },
  openWorkspace: () => invoke('open_workspace'),
  pickWorkspace: root => invoke('pick_workspace', { root }),
  getWorkspace: () => invoke('get_workspace'), setWorkspace: async root => {
    const result = await invoke<Awaited<ReturnType<CompanionDesktopBridge['setWorkspace']>>>('set_workspace', { root })
    window.dispatchEvent(new Event('huiyu:ai-workspace-changed'))
    return result
  },
  restartForSetup: () => invoke('restart_for_setup'),
  notify: (title, body) => { void invoke('notify', { title, body }) },
  onResume: listener => on('aics:resume', listener), offResume: off,
  onShown: listener => on('aics:shown', listener), offShown: off,
  onVisibilityChanged: listener => on('aics:visibility', listener), offVisibilityChanged: off,
  onWindowBoundsChanged: listener => on('aics:window-bounds', listener), offWindowBoundsChanged: off,
  onPowerModeChanged: listener => on('aics:power-mode', listener), offPowerModeChanged: off,
  onInteractionModeChanged: listener => on('aics:interaction-mode', listener), offInteractionModeChanged: off,
  onClipboardImage: listener => on<number[]>('aics:clipboard-image', bytes => listener(Uint8Array.from(bytes))), offClipboardImage: off,
  onClipboardText: listener => on('aics:clipboard-text', listener), offClipboardText: off,
  onGlobalMouse: listener => on('aics:global-mouse', listener), offGlobalMouse: off,
  minimizeWindow: () => invoke('window_minimize'), toggleMaximizeWindow: () => invoke('window_maximize_toggle'),
  closeWindow: () => invoke('window_close'), getWindowState: () => invoke('get_window_state'),
  onMaximizedChanged: listener => on('aics:maximized', listener), offMaximizedChanged: off,
}
export function getDesktopCapabilities(): CompanionDesktopBridge | undefined {
  return hostApi() ? capabilities : undefined
}
export function onDesktopNavigate(listener: (path: string) => void): () => void {
  const id = on<string>('aics:navigate', path => { if (getDesktopWindowRole() === 'atelier' && /^\/(?:[a-zA-Z0-9-]+(?:\?[a-zA-Z0-9_.%=&+~-]{1,4096})?)?$/.test(path)) listener(path) })
  return () => off(id)
}
