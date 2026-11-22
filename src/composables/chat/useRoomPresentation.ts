import { getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { ROOM_PRESENTATION_KEY as key } from '../../utils/storageKeys.ts'

/** Focused full room owns the animated presentation; the pet resumes when it leaves. */
export function useRoomPresentation(surface: 'room' | 'companion') {
  const suspended = ref(false)
  const id = Math.random().toString(36).slice(2)
  const heartbeat = 4000
  const expiry = heartbeat * 3
  let timer = 0, listening = false
  function update() {
    clearTimeout(timer)
    try {
      if (surface === 'room') {
        const active = !document.hidden && document.hasFocus()
        suspended.value = !active
        if (active) {
          localStorage.setItem(key, JSON.stringify({ id, ts: Date.now() }))
          timer = window.setTimeout(update, heartbeat)
        } else if (JSON.parse(localStorage.getItem(key) || 'null')?.id === id) localStorage.removeItem(key)
      } else {
        const record = JSON.parse(localStorage.getItem(key) || 'null')
        const remaining = Number(record?.ts ?? 0) + expiry - Date.now()
        suspended.value = remaining > 0
        // Storage events deliver renewals. A single wake-up covers an owner
        // that disappears without releasing the presentation.
        if (suspended.value && !document.hidden) timer = window.setTimeout(update, Math.min(expiry, remaining))
      }
    } catch { suspended.value = false }
  }
  function onStorage(event: StorageEvent) {
    if (event.key === key || event.key === null) update()
  }
  function start() {
    if (listening) return
    if (!getDesktopCapabilities()) { suspended.value = false; return }
    listening = true
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', update)
  }
  function stop() {
    if (!listening) return
    listening = false
    suspended.value = true
    clearTimeout(timer)
    window.removeEventListener('focus', update)
    window.removeEventListener('blur', update)
    window.removeEventListener('storage', onStorage)
    document.removeEventListener('visibilitychange', update)
    if (surface === 'room') {
      try { if (JSON.parse(localStorage.getItem(key) || 'null')?.id === id) localStorage.removeItem(key) } catch { /* unavailable */ }
    }
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onUnmounted(stop)
  return suspended
}
