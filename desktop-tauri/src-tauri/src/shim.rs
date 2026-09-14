pub const COMPANION_SHIM_JS: &str = r#"
;(() => {
  if (window.companionDesktop) return
  const waitForTauri = () => new Promise((resolve, reject) => {
    if (window.__TAURI__) { resolve(window.__TAURI__); return }
    const started = Date.now()
    const timer = setInterval(() => {
      if (window.__TAURI__) { clearInterval(timer); resolve(window.__TAURI__); return }
      if (Date.now() - started >= 6000) { clearInterval(timer); reject(new Error('TAURI_API_UNAVAILABLE')) }
    }, 25)
  })
  const invoke = (...args) => waitForTauri().then((api) => api.core.invoke(...args))
  const listen = (...args) => waitForTauri().then((api) => api.event.listen(...args))
    const enableNativeLive2D = location.pathname.replace(/\/+$/, '') === '/companion'
    let nextId = 0
    const subs = new Map()
    const on = (event, cb) => {
      const id = ++nextId
      const entry = { cancelled: false, unsubscribe: null }
      subs.set(id, entry)
      listen(event, (e) => cb(e.payload)).then((un) => {
        if (entry.cancelled) { try { un() } catch {} }
        else entry.unsubscribe = un
      }).catch(() => {
        if (subs.get(id) === entry) subs.delete(id)
      })
      return id
    }
    const off = (id) => {
      const entry = subs.get(id)
      if (entry) {
        entry.cancelled = true
        if (entry.unsubscribe) { try { entry.unsubscribe() } catch {} }
      }
      subs.delete(id)
    }
    const reportError = (where, e) => {
      waitForTauri().then((api) => api.event.emit('aics:shim-diagnose', String(where) + ': ' + String(e && e.message || e))).catch(() => {})
    }
    // 启动自检：invoke 链路是否可用
    invoke('get_state').then(() => { console.log('[desktop] invoke ok') }).catch((e) => reportError('invoke self-check', e))

    // WebView2 不支持 -webkit-app-region，用 tauri 的 data-tauri-drag-region
    // 事件委托实现标题栏拖拽（页面零改动：按现有 class 注入属性）。
    const applyDragRegions = () => {
      document.querySelectorAll('header.desktop-titlebar').forEach((el) => {
        if (!el.hasAttribute('data-tauri-drag-region')) {
          el.setAttribute('data-tauri-drag-region', '')
        }
        const controls = el.querySelector('.titlebar-controls')
        if (controls && !controls.hasAttribute('data-tauri-drag-region')) {
          controls.setAttribute('data-tauri-drag-region', 'false')
        }
      })
    }
    const tryApply = () => {
      if (document.readyState === 'loading') return
      applyDragRegions()
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyDragRegions)
    } else {
      applyDragRegions()
    }
    const mo = new MutationObserver(() => { if (!document.querySelector('header.desktop-titlebar')) return; tryApply(); mo.disconnect() })
    try { mo.observe(document, { childList: true, subtree: true }) } catch (e) { reportError('mutation-observe', e) }
    setTimeout(() => { tryApply(); mo.disconnect() }, 8000)

    window.companionDesktop = {
    isDesktop: true,
    hide: () => invoke('hide'),
    quit: () => invoke('quit'),
    openAtelier: (pathname = '/') => invoke('open_atelier', { pathname }).catch((e) => {
      console.error('[companionDesktop] open_atelier failed:', e)
      reportError('open_atelier', e)
      return null
    }),
    openChat: () => invoke('open_companion_chat').catch((e) => {
      console.error('[companionDesktop] open_chat failed:', e)
      reportError('open_chat', e)
      return null
    }),
    toggleChat: () => invoke('toggle_companion_chat').catch((e) => {
      console.error('[companionDesktop] toggle_chat failed:', e)
      reportError('toggle_chat', e)
      return null
    }),
    hideChatWindow: () => invoke('hide_companion_chat').catch((e) => {
      console.error('[companionDesktop] hide_chat failed:', e)
      reportError('hide_chat', e)
      return null
    }),
    chatRelay: (payload) => invoke('chat_relay', { payload }).catch((e) => {
      console.error('[companionDesktop] chat_relay failed:', e)
      reportError('chat_relay', e)
      return null
    }),
    setIgnoreMouseEvents: (ignore) => invoke('set_ignore_mouse_events_cmd', { ignore }),
    setLive2dEnabled: (enabled) => invoke('set_live2d_enabled', { enabled }),
    getState: () => invoke('get_state'),
    toggleAlwaysOnTop: () => invoke('toggle_always_on_top'),
    getSettings: () => invoke('get_settings'),
    isPackaged: () => invoke('is_packaged'),
    setAutostart: (enabled) => invoke('set_autostart', { enabled }),
    pickFiles: () => invoke('pick_files'),
    saveImage: (payload) => invoke('save_image', { data: Array.from(payload.data), name: payload.name }),
    openWorkspace: () => invoke('open_workspace'),
    openRuntime: () => invoke('open_runtime'),
    openLog: () => invoke('open_log'),
    getWorkspace: () => invoke('get_workspace'),
    setWorkspace: (root) => invoke('set_workspace', { root }),
    notify: (title, body) => invoke('notify', { title, body }),
    setProgress: (progress) => invoke('set_progress', { progress }),
    runTool: (name, args, options = {}) => fetch('/api/desktop-tools', {
      method: 'POST',
      signal: options.signal,
      headers: { 'Content-Type': 'application/json' },
      // adultEnabled：网关 fail-closed 双门的传输层授权信号；桌面壳即本机用户（Tauri WebView 为 tauri.localhost），
      // 无条件授信，与 src/utils/runtimeEnvironment.ts 的 Tauri 兼容逻辑同源。
      body: JSON.stringify({ name, args, adultEnabled: true }),
    }).then((r) => r.json()).catch((e) => {
      if (options.signal && options.signal.aborted) throw e
      return { ok: false, output: String(e) }
    }),
    onFileDrop: () => 0,
    offFileDrop: () => {},
    onResume: (cb) => on('aics:resume', cb), offResume: off,
    onShown: (cb) => on('aics:shown', cb), offShown: off,
    onChatCommand: (cb) => on('aics:chat-command', cb), offChatCommand: off,
    onVisibilityChanged: (cb) => on('aics:visibility', cb), offVisibilityChanged: off,
    onWindowBoundsChanged: (cb) => on('aics:window-bounds', cb), offWindowBoundsChanged: off,
    onPowerModeChanged: (cb) => on('aics:power-mode', cb), offPowerModeChanged: off,
    onInteractionModeChanged: (cb) => on('aics:interaction-mode', cb), offInteractionModeChanged: off,
    onClipboardImage: (cb) => on('aics:clipboard-image', cb), offClipboardImage: off,
    onClipboardText: (cb) => on('aics:clipboard-text', cb), offClipboardText: off,
    onGlobalMouse: (cb) => on('aics:global-mouse', cb), offGlobalMouse: off,
    minimizeWindow: () => invoke('window_minimize'),
    toggleMaximizeWindow: () => invoke('window_maximize_toggle'),
    closeWindow: () => invoke('window_close'),
    getWindowState: () => invoke('get_window_state'),
    getWindowZoom: () => invoke('window_zoom_get'),
    setWindowZoom: (value) => invoke('window_zoom_set', { value }),
    onMaximizedChanged: (cb) => on('aics:maximized', cb), offMaximizedChanged: off,
  }

  // Live2D 原生 overlay 桥只注入 Companion。Atelier 与普通 Web 页面保持
  // browser backend，避免两个窗口争用同一个全局 overlay。
  if (enableNativeLive2D) window.aicsLive2dNative = {
    isNativeLive2D: true,
    supportsTextureQuality: true,
    setCharacter: (modelPath, options) => invoke('aics_live2d_set_character', { modelPath, character: options && options.character, textureScale: options && options.textureScale }),
    setFrame: (frame) => invoke('aics_live2d_set_frame', {
      rect: frame.rect,
      visible: frame.visible,
      opacity: frame.opacity != null ? frame.opacity : null,
    }),
    setMaxFps: (fps) => invoke('aics_live2d_set_max_fps', { fps }),
    playMotion: (group, index, priority) => invoke('aics_live2d_play_motion', { group, index: index != null ? index : null, priority: priority != null ? priority : null }),
    setExpression: (name) => invoke('aics_live2d_set_expression', { name }),
    setMouthLevel: (level) => invoke('aics_live2d_set_mouth_level', { level }),
    setEmotion: (name, intensity) => invoke('aics_live2d_set_emotion', { name, intensity }),
    setGaze: (x, y) => invoke('aics_live2d_set_gaze', { x, y }),
    hitTest: (x, y) => invoke('aics_live2d_hit_test', { x, y }),
    destroy: () => invoke('aics_live2d_destroy'),
    onReady: (cb) => {
      let id = 0
      let called = false
      const once = () => {
        if (called) return
        called = true
        cb()
        off(id)
      }
      id = on('aics:live2d:ready', once)
      // ready 事件在订阅前可能已发出（connect 先 await setCharacter 后订阅），
      // 先查状态；返回真实订阅 id，destroy 可以注销 pending listener。
      invoke('aics_live2d_get_state').then((s) => {
        if (s && s.ready) once()
      }).catch(() => {})
      return id
    },
    onMotionStarted: (cb) => on('aics:live2d:motion-started', cb),
    onMotionFailed: (cb) => on('aics:live2d:motion-failed', cb),
    onHitTest: (cb) => on('aics:live2d:hit-test', cb),
    onEntranceFinished: (cb) => on('aics:live2d:entrance-finished', cb),
    onStopped: (cb) => on('aics:live2d:stopped', cb),
    off: (id) => off(id),
  }
})()
"#;
