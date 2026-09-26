import type { BrowserContext, Page } from '@playwright/test'
import type { CompanionDesktopBridge } from '../../../src/types/desktop'
import type { Live2DNativeBridge } from '../../../src/types/live2dNative'

declare global {
  interface Window {
    desktopCapabilitiesFixture?: Partial<CompanionDesktopBridge>
    nativeCapabilitiesFixture?: Partial<Live2DNativeBridge>
    desktopProtocolFixture?: number
  }
}

/** Test-only host transport. Production consumers exercise named Tauri commands,
 * while individual scenarios keep their explicit window/credential callbacks. */
export async function installDesktopHostFixture(surface: Page | BrowserContext) {
  await surface.addInitScript(() => {
    let fixture = window.desktopCapabilitiesFixture
    const host = window as Window & { __TAURI__?: unknown }
    const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    const methods: Record<string, string> = {
      open_companion_chat: 'openChat', toggle_companion_chat: 'toggleChat', hide_companion_chat: 'hideChatWindow',
      set_ignore_mouse_events_cmd: 'setIgnoreMouseEvents', window_minimize: 'minimizeWindow',
      window_maximize_toggle: 'toggleMaximizeWindow', window_close: 'closeWindow',
      window_zoom_get: 'getWindowZoom', window_zoom_set: 'setWindowZoom',
      chat_credential_read: 'readChatCredential', chat_credential_write: 'writeChatCredential',
    }
    const events: Record<string, string> = {
      resume: 'onResume', shown: 'onShown', visibility: 'onVisibilityChanged', 'window-bounds': 'onWindowBoundsChanged',
      'power-mode': 'onPowerModeChanged', 'interaction-mode': 'onInteractionModeChanged',
      'clipboard-image': 'onClipboardImage', 'clipboard-text': 'onClipboardText', 'global-mouse': 'onGlobalMouse',
      maximized: 'onMaximizedChanged', 'chat-command': 'onChatCommand',
    }
    function install() {
      if (!fixture) { delete host.__TAURI__; return }
      host.__TAURI__ = {
        core: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'desktop_bootstrap') {
            const role = location.pathname === '/companion' ? 'companion' : location.pathname === '/companion-chat' ? 'companion-chat' : 'atelier'
            return { protocolVersion: window.desktopProtocolFixture ?? 1, windowRole: role, windowId: role,
              sourceProfileId: `profile-${'a'.repeat(64)}`, sourceOrigin: location.origin, bundledUiAvailable: false,
              connection: 'ready', runtime: { protocolVersion: 1, ownership: 'managed', runtimeEpoch: 'e2e-host', origin: location.origin, workspace: null } }
          }
          const native = command.startsWith('aics_live2d_')
          if (command === 'aics_live2d_get_state') return { ready: Boolean(window.nativeCapabilitiesFixture) }
          const name = native ? camel(command.slice('aics_live2d_'.length)) : methods[command] || camel(command)
          const target = (native ? window.nativeCapabilitiesFixture : fixture) as Record<string, unknown> | undefined
          const fn = target?.[name]
          if (typeof fn === 'function') {
            const values = command === 'aics_live2d_set_character' ? [args.modelPath, { character: args.character, textureScale: args.textureScale, adapter: args.adapter }]
              : command === 'aics_live2d_set_frame' || command === 'chat_relay' ? [args.rect === undefined ? args.payload : args]
                : Object.values(args)
            return fn(...values)
          }
          if (command === 'window_zoom_get') return 1
          if (command === 'get_window_state') return { maximized: false, focused: true }
          return undefined
        } },
        event: { listen: async (name: string, listener: (event: { payload: unknown }) => void) => {
          const native = name.startsWith('aics:live2d:')
          const key = name.replace(native ? 'aics:live2d:' : 'aics:', '')
          const method = native ? 'on' + key.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('') : events[key]
          const target = (native ? window.nativeCapabilitiesFixture : fixture) as Record<string, unknown> | undefined
          const fn = target?.[method]
          const id = typeof fn === 'function' ? fn((payload: unknown) => listener({ payload })) : undefined
          return () => { const off = target?.[native ? 'off' : method?.replace(/^on/, 'off')]; if (typeof off === 'function') off(id) }
        } },
        window: { getCurrentWindow: () => ({ startDragging: async () => fixture?.startDragging?.() }) },
      }
    }
    Object.defineProperty(window, 'desktopCapabilitiesFixture', { configurable: true, get: () => fixture,
      set: value => { fixture = value; install() } })
    install()
  })
}
